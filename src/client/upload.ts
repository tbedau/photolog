// Upload page. The browser does all image processing: it decodes the photo
// (applying EXIF orientation and dropping all metadata), scales the master to
// at most 3200 px, encodes every derivative in parallel Web Workers, and then
// uploads the finished set. The server only validates and stores it.

import { derivativeHeight, masterSize, targetWidths } from "../shared/ladder";
import type { EncodeJob, EncodeResult } from "./encode-worker";
import { clearError, safeRedirect, showError } from "./shared";

const dropArea = document.getElementById("drop-area") as HTMLElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const prompt = dropArea.querySelector<HTMLElement>('[data-role="prompt"]')!;
const filenameEl = dropArea.querySelector<HTMLElement>('[data-role="filename"]')!;
const selectBtn = dropArea.querySelector<HTMLElement>('[data-role="select"]')!;
const checklist = dropArea.querySelector<HTMLElement>('[data-role="checklist"]')!;
const retryBtn = dropArea.querySelector<HTMLElement>('[data-role="retry"]')!;
const avifChips = checklist.querySelector<HTMLElement>('[data-role="avif-widths"]')!;
const jpegChips = checklist.querySelector<HTMLElement>('[data-role="jpeg-widths"]')!;

const WASM = { avif: dropArea.dataset.avifWasm!, jpeg: dropArea.dataset.jpegWasm! };
const ENCODER_URL = dropArea.dataset.encoder!;

type Step = "decode" | "original" | "avif" | "jpeg" | "upload" | "commit";
type State = "pending" | "active" | "done" | "error";

const setStep = (step: Step, state: State) => {
  const el = checklist.querySelector<HTMLElement>(`.upload-step[data-step="${step}"]`);
  if (el) el.dataset.state = state;
};

const renderChips = (container: HTMLElement, widths: number[]) => {
  container.textContent = "";
  for (const w of [...widths].sort((a, b) => b - a)) {
    const chip = document.createElement("span");
    chip.className = "upload-substep";
    chip.dataset.width = String(w);
    chip.dataset.state = "pending";
    chip.textContent = String(w);
    container.appendChild(chip);
  }
};

const setChip = (container: HTMLElement, width: number, state: State) => {
  const chip = container.querySelector<HTMLElement>(`.upload-substep[data-width="${width}"]`);
  if (chip) chip.dataset.state = state;
};

/** Marks the step that was running as failed, so it's clear where things stopped. */
const markFailure = () => {
  const active = checklist.querySelector<HTMLElement>('.upload-step[data-state="active"]');
  const pending = checklist.querySelector<HTMLElement>('.upload-step[data-state="pending"]');
  const el = active ?? pending;
  if (el) el.dataset.state = "error";
};

const resetIdle = () => {
  dropArea.dataset.state = "idle";
  avifChips.textContent = "";
  jpegChips.textContent = "";
  for (const step of checklist.querySelectorAll<HTMLElement>(".upload-step")) {
    step.dataset.state = "pending";
  }
  checklist.hidden = true;
  retryBtn.hidden = true;
  filenameEl.hidden = true;
  filenameEl.textContent = "";
  prompt.hidden = false;
  selectBtn.hidden = false;
  fileInput.value = "";
};

const fail = (message: string) => {
  markFailure();
  dropArea.dataset.state = "error";
  showError(message);
  retryBtn.hidden = false;
};

// ---------- Image processing ----------

/** Average colour of the image as #rrggbb, used as the loading placeholder. */
async function dominantColor(bitmap: ImageBitmap): Promise<string> {
  const size = 32;
  const small = await createImageBitmap(bitmap, {
    resizeWidth: size,
    resizeHeight: size,
    resizeQuality: "high",
  });
  const ctx = new OffscreenCanvas(size, size).getContext("2d")!;
  ctx.drawImage(small, 0, 0);
  small.close();
  const { data } = ctx.getImageData(0, 0, size, size);
  const sum = [0, 0, 0];
  for (let i = 0; i < data.length; i += 4) {
    sum[0] += data[i];
    sum[1] += data[i + 1];
    sum[2] += data[i + 2];
  }
  const n = data.length / 4;
  return "#" + sum.map((s) => Math.round(s / n).toString(16).padStart(2, "0")).join("");
}

interface Task {
  field: string;
  format: "avif" | "jpeg";
  width: number;
  height: number;
  onStart: () => void;
  onDone: () => void;
}

/** Runs encode tasks on a small pool of workers, largest first. */
async function encodeAll(master: ImageBitmap, tasks: Task[]): Promise<Map<string, Blob>> {
  const poolSize = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  const workers = Array.from({ length: Math.min(poolSize, tasks.length) }, () =>
    new Worker(ENCODER_URL, { type: "module" }),
  );
  const results = new Map<string, Blob>();
  const queue = [...tasks];
  let nextId = 0;

  const run = async (worker: Worker, task: Task) => {
    task.onStart();
    const bitmap = await createImageBitmap(master, {
      resizeWidth: task.width,
      resizeHeight: task.height,
      resizeQuality: "high",
    });
    const id = nextId++;
    const data = await new Promise<ArrayBuffer>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<EncodeResult>) => {
        if (event.data.id !== id) return;
        if ("error" in event.data) reject(new Error(event.data.error));
        else resolve(event.data.data);
      };
      worker.onerror = (e) => reject(new Error(e.message));
      const job: EncodeJob = { id, format: task.format, bitmap, wasm: WASM };
      worker.postMessage(job, [bitmap]);
    });
    const type = task.format === "avif" ? "image/avif" : "image/jpeg";
    results.set(task.field, new Blob([data], { type }));
    task.onDone();
  };

  try {
    await Promise.all(
      workers.map(async (worker) => {
        for (let task = queue.shift(); task; task = queue.shift()) {
          await run(worker, task);
        }
      }),
    );
  } finally {
    workers.forEach((w) => w.terminate());
  }
  return results;
}

// ---------- Upload ----------

async function precheck(): Promise<boolean> {
  try {
    const res = await fetch("/upload/precheck", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (res.ok) return true;
    const body = await res.json().catch(() => null);
    showError(body?.error || `Upload not allowed (HTTP ${res.status}).`);
  } catch {
    showError("Network error. Try again.");
  }
  return false;
}

function send(form: FormData): Promise<{ ok: boolean; body: any; status: number }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/upload");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.addEventListener("load", () => {
      setStep("upload", "done");
      setStep("commit", "active");
    });
    xhr.addEventListener("load", () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {}
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, body, status: xhr.status });
    });
    xhr.addEventListener("error", () => resolve({ ok: false, body: null, status: 0 }));
    xhr.send(form);
  });
}

async function startUpload(file: File) {
  clearError();
  fileInput.value = "";
  if (!(await precheck())) return;

  filenameEl.textContent = file.name;
  filenameEl.hidden = false;
  prompt.hidden = true;
  selectBtn.hidden = true;
  retryBtn.hidden = true;
  checklist.hidden = false;
  dropArea.dataset.state = "processing";

  // Decode. createImageBitmap applies EXIF orientation and converts to sRGB;
  // re-encoding from pixels drops all metadata (location, camera serial, …).
  setStep("decode", "active");
  let source: ImageBitmap;
  try {
    source = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    fail("This browser can't read that file. Try a JPEG, PNG or HEIC export.");
    return;
  }
  const size = masterSize(source.width, source.height);
  const master =
    size.width === source.width && size.height === source.height
      ? source
      : await createImageBitmap(source, {
          resizeWidth: size.width,
          resizeHeight: size.height,
          resizeQuality: "high",
        });
  const ladders = targetWidths(size.width);
  const color = await dominantColor(master);
  renderChips(avifChips, ladders.avif);
  renderChips(jpegChips, ladders.jpeg);
  setStep("decode", "done");

  // Encode. Largest first, so the slowest jobs don't end up last on one worker.
  let avifLeft = ladders.avif.length;
  let jpegLeft = ladders.jpeg.length;
  const tasks: Task[] = [
    {
      field: "original",
      format: "jpeg",
      width: size.width,
      height: size.height,
      onStart: () => setStep("original", "active"),
      onDone: () => setStep("original", "done"),
    },
    ...[...ladders.avif].reverse().map((w): Task => ({
      field: `avif_${w}`,
      format: "avif",
      width: w,
      height: derivativeHeight(size, w),
      onStart: () => {
        setStep("avif", "active");
        setChip(avifChips, w, "active");
      },
      onDone: () => {
        setChip(avifChips, w, "done");
        if (--avifLeft === 0) setStep("avif", "done");
      },
    })),
    ...[...ladders.jpeg].reverse().map((w): Task => ({
      field: `jpeg_${w}`,
      format: "jpeg",
      width: w,
      height: derivativeHeight(size, w),
      onStart: () => {
        setStep("jpeg", "active");
        setChip(jpegChips, w, "active");
      },
      onDone: () => {
        setChip(jpegChips, w, "done");
        if (--jpegLeft === 0) setStep("jpeg", "done");
      },
    })),
  ];

  let files: Map<string, Blob>;
  try {
    files = await encodeAll(master, tasks);
  } catch (err) {
    console.error(err);
    fail("Encoding failed. Try again, or try another browser.");
    return;
  } finally {
    master.close();
    source.close();
  }

  // Upload.
  const form = new FormData();
  form.append(
    "meta",
    JSON.stringify({
      originalFilename: file.name,
      width: size.width,
      height: size.height,
      dominantColor: color,
    }),
  );
  for (const [field, blob] of files) form.append(field, blob, field);

  setStep("upload", "active");
  dropArea.dataset.state = "uploading";
  const { ok, body, status } = await send(form);
  if (!ok || !body?.success) {
    fail(body?.error || (status ? `Upload failed (HTTP ${status}).` : "Network error while uploading."));
    return;
  }
  setStep("commit", "done");
  dropArea.dataset.state = "done";
  setTimeout(() => location.assign(safeRedirect(body.redirect, "/")), 450);
}

// ---------- Wiring ----------

retryBtn.addEventListener("click", () => {
  clearError();
  resetIdle();
});

dropArea.addEventListener("click", (event) => {
  if (dropArea.dataset.state !== "idle") return;
  if (event.target === fileInput || event.target === retryBtn) return;
  fileInput.click();
});

dropArea.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (dropArea.dataset.state === "idle") dropArea.classList.add("auth__drop--dragging");
});
dropArea.addEventListener("dragleave", () => dropArea.classList.remove("auth__drop--dragging"));
dropArea.addEventListener("drop", (event) => {
  event.preventDefault();
  dropArea.classList.remove("auth__drop--dragging");
  if (dropArea.dataset.state !== "idle") return;
  const file = event.dataTransfer?.files[0];
  if (file) startUpload(file);
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) startUpload(file);
});
