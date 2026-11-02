import { clearError, safeRedirect, showError } from "./shared";

const form = document.getElementById("login-form") as HTMLFormElement | null;

if (form) {
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  let inflight = false;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (inflight) return;
    inflight = true;
    clearError();
    submit.disabled = true;
    try {
      const res = await fetch(form.action, {
        method: "POST",
        body: new FormData(form),
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        location.assign(safeRedirect(data.redirect, "/upload"));
        return;
      }
      showError(data?.error || "Sign in failed.");
    } catch {
      showError("Network error. Try again.");
    } finally {
      inflight = false;
      submit.disabled = false;
    }
  });
}
