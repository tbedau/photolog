(() => {
    const dropArea = document.getElementById('drop-area');
    const fileInput = document.getElementById('file-input');
    const form = document.getElementById('upload-form');
    if (!dropArea || !fileInput || !form) return;

    // One click target for everything: clicks on the "Select" button bubble up
    // here too, so we don't double-fire by also binding the button. The target
    // guard skips the synthetic click that `fileInput.click()` re-dispatches —
    // without it the call would recurse.
    dropArea.addEventListener('click', (e) => {
        if (e.target === fileInput) return;
        fileInput.click();
    });

    // Drag/drop is mouse-only — touch never fires these. We keep them as a
    // pure enhancement; the click handler above is the load-bearing path on
    // touch devices.
    dropArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropArea.classList.add('auth__drop--dragging');
    });

    dropArea.addEventListener('dragleave', () => {
        dropArea.classList.remove('auth__drop--dragging');
    });

    dropArea.addEventListener('drop', (e) => {
        e.preventDefault();
        dropArea.classList.remove('auth__drop--dragging');
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            fileInput.files = files;
            form.requestSubmit();
        }
    });

    fileInput.addEventListener('change', () => {
        if (fileInput.files.length > 0) {
            form.requestSubmit();
        }
    });
})();
