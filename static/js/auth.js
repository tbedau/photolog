/* Both auth surfaces — login + upload — share one tiny script. The previous
 * incarnation used htmx; for two endpoints that boiled down to a 16KB
 * dependency for swapping one error partial, so we hand-rolled the
 * replacement. Upload uses XHR so we can read `upload.progress` events for the
 * bytes-in-flight bar AND read the response body incrementally as the server
 * streams NDJSON phase events (fetch streams response in browsers, but its
 * request body is one-shot). Login uses fetch. */
(() => {
    const errorContainer = document.getElementById("error-container");

    const showError = (msg) => {
        if (!errorContainer) return;
        errorContainer.textContent = "";
        const div = document.createElement("div");
        div.className = "error-message";
        div.textContent = msg;
        errorContainer.appendChild(div);
    };

    const clearError = () => {
        if (errorContainer) errorContainer.textContent = "";
    };

    // Belt-and-suspenders: the server only ever returns `/upload` or `/`, but
    // accepting an arbitrary string from the response body and feeding it into
    // window.location would be an open-redirect waiting to happen if that
    // contract ever drifts. Allow only a single-leading-slash relative path.
    const safeRedirect = (value, fallback) => {
        if (typeof value !== "string") return fallback;
        if (!value.startsWith("/") || value.startsWith("//")) return fallback;
        return value;
    };

    // ---------- Login ----------
    const loginForm = document.getElementById("login-form");
    if (loginForm) {
        const submitBtn = loginForm.querySelector('button[type="submit"]');
        let inflight = false;

        loginForm.addEventListener("submit", async (event) => {
            event.preventDefault();
            if (inflight) return;
            inflight = true;
            clearError();
            submitBtn.disabled = true;

            try {
                const response = await fetch(loginForm.action, {
                    method: "POST",
                    body: new FormData(loginForm),
                    headers: { Accept: "application/json" },
                    credentials: "same-origin",
                });
                const data = await response.json().catch(() => null);
                if (response.ok && data && data.success) {
                    window.location.assign(safeRedirect(data.redirect, "/upload"));
                    return;
                }
                showError((data && data.error) || "Sign in failed.");
            } catch {
                showError("Network error. Try again.");
            } finally {
                inflight = false;
                submitBtn.disabled = false;
            }
        });
    }

    // ---------- Upload ----------
    const dropArea = document.getElementById("drop-area");
    const uploadForm = document.getElementById("upload-form");
    const fileInput = document.getElementById("file-input");
    if (!dropArea || !uploadForm || !fileInput) return;

    const prompt = dropArea.querySelector('[data-role="prompt"]');
    const filenameEl = dropArea.querySelector('[data-role="filename"]');
    const selectBtn = dropArea.querySelector('[data-role="select"]');
    const checklist = dropArea.querySelector('[data-role="checklist"]');
    const retryBtn = dropArea.querySelector('[data-role="retry"]');

    const stepEl = (name) =>
        checklist.querySelector(`.upload-step[data-step="${name}"]`);
    const setStepState = (name, state) => {
        const el = stepEl(name);
        if (el) el.dataset.state = state;
    };

    const avifWidthsEl = checklist.querySelector('[data-role="avif-widths"]');
    const jpegWidthsEl = checklist.querySelector('[data-role="jpeg-widths"]');

    const renderWidthChips = (container, widths) => {
        container.textContent = "";
        for (const w of widths) {
            const chip = document.createElement("span");
            chip.className = "upload-substep";
            chip.dataset.width = String(w);
            chip.dataset.state = "pending";
            chip.textContent = String(w);
            container.appendChild(chip);
        }
    };

    const setChipState = (container, width, state) => {
        const chip = container.querySelector(
            `.upload-substep[data-width="${width}"]`,
        );
        if (chip) chip.dataset.state = state;
    };

    const resetIdle = () => {
        dropArea.dataset.state = "idle";
        avifWidthsEl.textContent = "";
        jpegWidthsEl.textContent = "";
        for (const step of checklist.querySelectorAll(".upload-step")) {
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

    retryBtn.addEventListener("click", () => {
        clearError();
        resetIdle();
    });

    const handleEvent = (evt) => {
        if (!evt || typeof evt !== "object") return;
        switch (evt.phase) {
            case "decode":
                if (evt.status === "active") setStepState("decode", "active");
                else if (evt.status === "done") {
                    setStepState("decode", "done");
                    if (Array.isArray(evt.avif_widths)) {
                        renderWidthChips(avifWidthsEl, [...evt.avif_widths].sort((a, b) => b - a));
                    }
                    if (Array.isArray(evt.jpeg_widths)) {
                        renderWidthChips(jpegWidthsEl, [...evt.jpeg_widths].sort((a, b) => b - a));
                    }
                }
                break;
            case "original":
                if (evt.status === "active") setStepState("original", "active");
                else if (evt.status === "done") setStepState("original", "done");
                break;
            case "avif":
                setStepState("avif", "active");
                if (evt.width != null) {
                    setChipState(avifWidthsEl, evt.width, evt.status === "done" ? "done" : "active");
                }
                if (evt.status === "done") {
                    const remaining = avifWidthsEl.querySelectorAll(
                        '.upload-substep[data-state="pending"], .upload-substep[data-state="active"]',
                    );
                    if (remaining.length === 0) setStepState("avif", "done");
                }
                break;
            case "jpeg":
                setStepState("jpeg", "active");
                if (evt.width != null) {
                    setChipState(jpegWidthsEl, evt.width, evt.status === "done" ? "done" : "active");
                }
                if (evt.status === "done") {
                    const remaining = jpegWidthsEl.querySelectorAll(
                        '.upload-substep[data-state="pending"], .upload-substep[data-state="active"]',
                    );
                    if (remaining.length === 0) setStepState("jpeg", "done");
                }
                break;
            case "commit":
                setStepState("commit", evt.status === "done" ? "done" : "active");
                break;
            case "result":
                handleResult(evt);
                break;
            // "error" events are wrapped by the server into a "result" event
            // before reaching the client; we still handle a stray one for
            // defense-in-depth.
            case "error":
                handleResult({ success: false, error: evt.detail || "Upload failed." });
                break;
        }
    };

    // Mark whichever step is currently active as failed so the user can see
    // exactly where the pipeline stopped, instead of a generic "Processing
    // failed" with no signal about whether their file made it at all.
    const markActiveAsError = () => {
        const active = checklist.querySelector(
            '.upload-step[data-state="active"]',
        );
        if (active) {
            active.dataset.state = "error";
            return;
        }
        // Nothing active means we failed between steps — mark the next
        // pending step as the error site, or the first pending one.
        const pending = checklist.querySelector(
            '.upload-step[data-state="pending"]',
        );
        if (pending) pending.dataset.state = "error";
    };

    let resultHandled = false;
    const handleResult = (evt) => {
        if (resultHandled) return;
        resultHandled = true;
        if (evt.success) {
            dropArea.dataset.state = "done";
            setTimeout(() => {
                window.location.assign(safeRedirect(evt.redirect, "/"));
            }, 450);
            return;
        }
        markActiveAsError();
        dropArea.dataset.state = "error";
        showError(evt.error || "Upload failed.");
        retryBtn.hidden = false;
    };

    // The cap also lives server-side in POST /upload — this client check is
    // purely about UX (don't flash the checklist, don't send megabytes the
    // server will refuse). A direct curl still hits the server enforcement.
    const precheckCap = async () => {
        try {
            const resp = await fetch("/upload/precheck", {
                credentials: "same-origin",
                headers: { Accept: "application/json" },
            });
            if (resp.ok) return true;
            const body = await resp.json().catch(() => null);
            showError((body && body.error) || `Upload not allowed (HTTP ${resp.status}).`);
        } catch {
            showError("Network error. Try again.");
        }
        return false;
    };

    const startUpload = async (file) => {
        clearError();
        // File-input change events fire even on the file we just rejected,
        // so clear it now in case we bail on the precheck.
        fileInput.value = "";
        if (!(await precheckCap())) return;

        resultHandled = false;
        filenameEl.textContent = file.name;
        filenameEl.hidden = false;
        prompt.hidden = true;
        selectBtn.hidden = true;
        retryBtn.hidden = true;
        checklist.hidden = false;
        setStepState("upload", "active");
        dropArea.dataset.state = "uploading";

        const xhr = new XMLHttpRequest();
        xhr.open("POST", uploadForm.action);
        // Need responseText (text-mode) so we can parse NDJSON line-by-line
        // as chunks arrive. responseType "json" would only resolve after the
        // stream closes — which is exactly the wait the checklist removes.
        xhr.responseType = "text";
        xhr.setRequestHeader("Accept", "application/x-ndjson, application/json");

        let processedChars = 0;
        const drainBuffer = (final) => {
            const text = xhr.responseText || "";
            if (text.length <= processedChars) return;
            const newText = text.slice(processedChars);
            // Only consume up to the last complete line, unless this is the
            // final drain after `load` (no more chunks coming).
            const cutoff = final ? newText.length : newText.lastIndexOf("\n") + 1;
            if (cutoff === 0) return;
            const lines = newText.slice(0, cutoff).split("\n");
            processedChars += cutoff;
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                let parsed;
                try {
                    parsed = JSON.parse(trimmed);
                } catch {
                    continue;
                }
                handleEvent(parsed);
            }
        };

        // The spinner on the active row's icon is the only "bytes in flight"
        // signal we show — the user wanted no separate progress bar. We still
        // listen for upload load/error to tick the row's state forward.
        xhr.upload.addEventListener("load", () => {
            setStepState("upload", "done");
            dropArea.dataset.state = "processing";
        });
        xhr.upload.addEventListener("error", () => {
            setStepState("upload", "error");
        });

        xhr.addEventListener("progress", () => drainBuffer(false));

        xhr.addEventListener("load", () => {
            drainBuffer(true);
            if (resultHandled) return;

            // Non-streaming response (e.g. 429 rate-limit) — body is plain
            // JSON. The drain above will have parsed it only if the line
            // happened to end with a newline; either way, try one more parse
            // as a single JSON object.
            let body = null;
            try {
                body = JSON.parse((xhr.responseText || "").trim());
            } catch {
                body = null;
            }
            if (body && typeof body === "object") {
                if (body.success) {
                    handleResult({ success: true, redirect: body.redirect });
                    return;
                }
                if (body.error) {
                    handleResult({ success: false, error: body.error });
                    return;
                }
            }
            if (xhr.status >= 200 && xhr.status < 300) {
                handleResult({ success: true, redirect: "/" });
            } else {
                handleResult({
                    success: false,
                    error: `Upload failed (HTTP ${xhr.status || "error"}).`,
                });
            }
        });

        xhr.addEventListener("error", () => {
            if (!resultHandled) {
                handleResult({ success: false, error: "Network error while uploading." });
            }
        });
        xhr.addEventListener("abort", () => {
            if (!resultHandled) resetIdle();
        });

        const formData = new FormData();
        formData.append("file", file);
        xhr.send(formData);
    };

    // One click target for the whole zone. The synthetic click that
    // `fileInput.click()` re-dispatches has `target === fileInput`, so the
    // guard stops the handler from recursing.
    dropArea.addEventListener("click", (event) => {
        if (dropArea.dataset.state !== "idle") return;
        if (event.target === fileInput) return;
        if (event.target === retryBtn) return;
        fileInput.click();
    });

    dropArea.addEventListener("dragover", (event) => {
        event.preventDefault();
        if (dropArea.dataset.state !== "idle") return;
        dropArea.classList.add("auth__drop--dragging");
    });
    dropArea.addEventListener("dragleave", () => {
        dropArea.classList.remove("auth__drop--dragging");
    });
    dropArea.addEventListener("drop", (event) => {
        event.preventDefault();
        dropArea.classList.remove("auth__drop--dragging");
        if (dropArea.dataset.state !== "idle") return;
        const files = event.dataTransfer.files;
        if (files.length > 0) startUpload(files[0]);
    });

    fileInput.addEventListener("change", () => {
        if (fileInput.files.length > 0) startUpload(fileInput.files[0]);
    });
})();
