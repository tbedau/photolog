// Snap-scroll feed: tracks the visible slide, recedes the header past the
// cover photo, and adds an eased keyboard scroll.
const feed = document.getElementById("feed");
const slides = feed ? Array.from(feed.querySelectorAll<HTMLElement>(".slide")) : [];

if (feed && slides.length > 0) {
  let currentIdx = 0;

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        currentIdx = slides.indexOf(e.target as HTMLElement);
        document.body.classList.toggle("is-past-cover", currentIdx > 0);
      }
    },
    { root: feed, threshold: 0.6 },
  );
  slides.forEach((s) => io.observe(s));

  // Mandatory snap would yank each animation frame to a snap point, so it is
  // switched off while the eased scroll runs.
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
  let activeAnimation = 0;

  const scrollToSlide = (idx: number) => {
    idx = Math.max(0, Math.min(slides.length - 1, idx));
    const target = slides[idx].offsetTop;
    if (reducedMotion) {
      feed.scrollTop = target;
      return;
    }
    const start = feed.scrollTop;
    const distance = target - start;
    if (Math.abs(distance) < 1) return;
    const duration = 320;
    const startTime = performance.now();
    const mine = ++activeAnimation;
    feed.style.scrollSnapType = "none";
    const step = (now: number) => {
      if (mine !== activeAnimation) return;
      const t = Math.min(1, (now - startTime) / duration);
      feed.scrollTop = start + distance * easeOutCubic(t);
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        feed.scrollTop = target;
        feed.style.scrollSnapType = "";
      }
    };
    requestAnimationFrame(step);
  };

  document.addEventListener("keydown", (e) => {
    let next = currentIdx;
    if (["ArrowDown", "ArrowRight", "PageDown", "j"].includes(e.key)) next = currentIdx + 1;
    else if (["ArrowUp", "ArrowLeft", "PageUp", "k"].includes(e.key)) next = currentIdx - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = slides.length - 1;
    else return;
    if (next !== currentIdx) {
      e.preventDefault();
      scrollToSlide(next);
    }
  });
}
