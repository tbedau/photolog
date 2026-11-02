export function showError(msg: string): void {
  const container = document.getElementById("error-container");
  if (!container) return;
  container.textContent = "";
  const div = document.createElement("div");
  div.className = "error-message";
  div.textContent = msg;
  container.appendChild(div);
}

export function clearError(): void {
  const container = document.getElementById("error-container");
  if (container) container.textContent = "";
}

/** Only same-origin targets, so a response body can't redirect elsewhere. */
export function safeRedirect(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  try {
    // Resolving catches tricks like "/\\evil.com" that a prefix check misses.
    const url = new URL(value, location.origin);
    return url.origin === location.origin ? url.pathname + url.search + url.hash : fallback;
  } catch {
    return fallback;
  }
}
