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
  // Each worker holds several full-size copies of its image plus a wasm heap
  // that never shrinks. Phones and low-memory devices (iOS Safari allows
  // roughly 1–1.5 GB per tab) get two workers; desktops up to four.
  const deviceMemory = (navigator as { deviceMemory?: number }).deviceMemory ?? 8;
  const constrained = deviceMemory <= 4 || navigator.maxTouchPoints > 1;
  const cores = Math.max(1, (navigator.hardwareConcurrency || 2) - 1);
  const poolSize = Math.min(constrained ? 2 : 4, cores);
  // A worker that fails to load (e.g. the page was open across a deploy and
  // its script URL is gone) fails the whole batch instead of hanging.
  let rejectAll: (err: Error) => void = () => {};
  const loadFailure = new Promise<never>((_, reject) => (rejectAll = reject));
  loadFailure.catch(() => {});
  const workers = Array.from({ length: Math.min(poolSize, tasks.length) }, () => {
    const worker = new Worker(ENCODER_URL, { type: "module" });
    worker.addEventListener("error", (e) => rejectAll(new Error(e.message || "Encoder failed to load")));
    return worker;
  });
  const JOB_TIMEOUT_MS = 180_000;
  const results = new Map<string, Blob>();
  const queue = [...tasks];
  let nextId = 0;
  let failed = false;

  const run = async (worker: Worker, task: Task) => {
    if (failed) return;
    task.onStart();
    const bitmap = await createImageBitmap(master, {
      resizeWidth: task.width,
      resizeHeight: task.height,
      resizeQuality: "high",
    });
    const id = nextId++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const data = await Promise.race([
      loadFailure,
      new Promise<ArrayBuffer>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Encoding timed out")), JOB_TIMEOUT_MS);
        worker.onmessage = (event: MessageEvent<EncodeResult>) => {
          if (event.data.id !== id) return;
          if ("error" in event.data) reject(new Error(event.data.error));
          else resolve(event.data.data);
        };
        const job: EncodeJob = { id, format: task.format, bitmap, wasm: WASM };
        worker.postMessage(job, [bitmap]);
      }),
    ]).finally(() => clearTimeout(timer));
    const type = task.format === "avif" ? "image/avif" : "image/jpeg";
    results.set(task.field, new Blob([data], { type }));
    task.onDone();
  };

  try {
    await Promise.all(
      workers.map(async (worker) => {
        try {
          for (let task = queue.shift(); task && !failed; task = queue.shift()) {
            await run(worker, task);
          }
        } catch (err) {
          failed = true; // stop the other workers picking up new jobs
          throw err;
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

const UNREADABLE =
  "This browser can't read that file. JPEG and PNG work everywhere; HEIC and TIFF only in Safari.";

async function startUpload(file: File) {
  // Claim the drop area first, so a second drop during the precheck is ignored.
  dropArea.dataset.state = "processing";
  clearError();
  fileInput.value = "";
  if (!(await precheck())) {
    dropArea.dataset.state = "idle";
    return;
  }

  filenameEl.textContent = file.name;
  filenameEl.hidden = false;
  prompt.hidden = true;
  selectBtn.hidden = true;
  retryBtn.hidden = true;
  checklist.hidden = false;

  try {
    await processAndUpload(file);
  } catch (err) {
    // Anything unexpected (e.g. no OffscreenCanvas in an old browser) must
    // end in a visible error with a retry button, never a frozen checklist.
    console.error(err);
    fail("Something went wrong while processing the photo. Try again, or try another browser.");
  }
}

async function processAndUpload(file: File) {
  // Decode. createImageBitmap applies EXIF orientation and converts to sRGB;
  // re-encoding from pixels drops all metadata (location, camera serial, …).
  setStep("decode", "active");
  let source: ImageBitmap;
  try {
    source = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    fail(UNREADABLE);
    return;
  }
  const size = masterSize(source.width, source.height);
  let master: ImageBitmap;
  if (size.width === source.width && size.height === source.height) {
    master = source;
  } else {
    try {
      master = await createImageBitmap(source, {
        resizeWidth: size.width,
        resizeHeight: size.height,
        resizeQuality: "high",
      });
    } finally {
      // The full-resolution decode can be ~100 MB; release it right away.
      source.close();
    }
  }

  try {
    const ladders = targetWidths(size.width);
    const color = await dominantColor(master);
    renderChips(avifChips, ladders.avif);
    renderChips(jpegChips, ladders.jpeg);
    setStep("decode", "done");

    // The largest JPEG fallback is often pixel-identical to the master
    // (same size, same encoder settings); reuse it instead of encoding twice.
    const topJpeg = ladders.jpeg.at(-1)!;
    const reuseMaster = topJpeg === size.width && derivativeHeight(size, topJpeg) === size.height;

    // Largest first, so the slowest jobs don't end up last on one worker.
    let avifLeft = ladders.avif.length;
    let jpegLeft = ladders.jpeg.length;
    const jpegDone = (w: number) => {
      setChip(jpegChips, w, "done");
      if (--jpegLeft === 0) setStep("jpeg", "done");
    };
    const tasks: Task[] = [
      {
        field: "original",
        format: "jpeg",
        width: size.width,
        height: size.height,
        onStart: () => {
          setStep("original", "active");
          if (reuseMaster) {
            setStep("jpeg", "active");
            setChip(jpegChips, topJpeg, "active");
          }
        },
        onDone: () => {
          setStep("original", "done");
          if (reuseMaster) jpegDone(topJpeg);
        },
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
      ...[...ladders.jpeg]
        .reverse()
        .filter((w) => !(reuseMaster && w === topJpeg))
        .map((w): Task => ({
          field: `jpeg_${w}`,
          format: "jpeg",
          width: w,
          height: derivativeHeight(size, w),
          onStart: () => {
            setStep("jpeg", "active");
            setChip(jpegChips, w, "active");
          },
          onDone: () => jpegDone(w),
        })),
    ];

    let files: Map<string, Blob>;
    try {
      files = await encodeAll(master, tasks);
    } catch (err) {
      console.error(err);
      fail("Encoding failed. Try again, or try another browser.");
      return;
    }
    if (reuseMaster) files.set(`jpeg_${topJpeg}`, files.get("original")!);

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
  } finally {
    master.close();
  }
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
  if (file) void startUpload(file);
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void startUpload(file);
});
