// "h" hides the header, captions and navigation; the choice lasts for the tab.
const STORE = "photolog-ui-hidden";
if (sessionStorage.getItem(STORE) === "1") document.body.classList.add("ui-hidden");

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if ((e.target as Element | null)?.closest?.("input, textarea")) return;
  if (e.key !== "h" && e.key !== "H") return;
  e.preventDefault();
  const hidden = document.body.classList.toggle("ui-hidden");
  sessionStorage.setItem(STORE, hidden ? "1" : "0");
});
