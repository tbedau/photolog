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

/** Only same-site relative paths, so a response body can't redirect elsewhere. */
export function safeRedirect(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return fallback;
  }
  return value;
}
