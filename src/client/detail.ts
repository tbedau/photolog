// Arrow keys step through the timeline.
const prev = document.querySelector<HTMLAnchorElement>(".detail-nav__link--prev");
const next = document.querySelector<HTMLAnchorElement>(".detail-nav__link--next");

document.addEventListener("keydown", (e) => {
  const link = e.key === "ArrowLeft" ? prev : e.key === "ArrowRight" ? next : null;
  if (!link) return;
  e.preventDefault();
  location.href = link.href;
});
