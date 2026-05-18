/* Both auth surfaces — login + upload — share one tiny script. The previous
 * incarnation used htmx; for two endpoints that boiled down to a 16KB
 * dependency for swapping one error partial, so we hand-rolled the
 * replacement. Upload uses XHR so we can read `upload.progress` events
 * (fetch streams response, not request, in browsers). Login uses fetch. */
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
    const progressEl = dropArea.querySelector('[data-role="progress"]');
    const track = dropArea.querySelector('[data-role="track"]');
    const fill = dropArea.querySelector('[data-role="fill"]');
    const statusEl = dropArea.querySelector('[data-role="status"]');

    const setState = (state) => {
        dropArea.dataset.state = state;
    };

    const resetIdle = () => {
        setState("idle");
        fill.style.width = "0%";
        track.classList.remove("upload-progress__track--indeterminate");
        progressEl.hidden = true;
        filenameEl.hidden = true;
        filenameEl.textContent = "";
        prompt.hidden = false;
        selectBtn.hidden = false;
        fileInput.value = "";
    };

    const startUpload = (file) => {
        clearError();
        filenameEl.textContent = file.name;
        filenameEl.hidden = false;
        prompt.hidden = true;
        selectBtn.hidden = true;
        progressEl.hidden = false;
        statusEl.textContent = "Uploading…";
        fill.style.width = "0%";
        track.classList.remove("upload-progress__track--indeterminate");
        setState("uploading");

        const xhr = new XMLHttpRequest();
        xhr.open("POST", uploadForm.action);
        xhr.responseType = "json";
        xhr.setRequestHeader("Accept", "application/json");

        // Bytes-in-flight. Once this hits 100% the request has been fully
        // delivered to the server; the response arrives later, after image
        // encoding finishes.
        xhr.upload.addEventListener("progress", (e) => {
            if (!e.lengthComputable) return;
            const pct = Math.min(100, (e.loaded / e.total) * 100);
            fill.style.width = pct.toFixed(1) + "%";
        });

        // Upload bytes are done — server is now busy fanning out AVIF + JPEG
        // derivatives, which can easily take several seconds for a 24-megapixel
        // source. Swap the determinate bar for an indeterminate slider so the
        // page never feels frozen.
        xhr.upload.addEventListener("load", () => {
            fill.style.width = "100%";
            statusEl.textContent = "Processing…";
            track.classList.add("upload-progress__track--indeterminate");
            setState("processing");
        });

        xhr.addEventListener("load", () => {
            const data = xhr.response;
            if (xhr.status >= 200 && xhr.status < 300 && data && data.success) {
                track.classList.remove("upload-progress__track--indeterminate");
                fill.style.width = "100%";
                statusEl.textContent = "Done.";
                setState("done");
                // Brief beat so the user actually registers the success state
                // before the page swaps.
                setTimeout(() => {
                    window.location.assign(safeRedirect(data.redirect, "/"));
                }, 450);
                return;
            }
            const msg = (data && data.error) || "Upload failed.";
            showError(msg);
            resetIdle();
        });

        xhr.addEventListener("error", () => {
            showError("Network error while uploading.");
            resetIdle();
        });
        xhr.addEventListener("abort", () => {
            resetIdle();
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
