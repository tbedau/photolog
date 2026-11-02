import { assets } from "../generated/manifest";
import { longDate, monthLabel, permalink, shortDate } from "../lib/dates";
import { type ImageRow, picture } from "../lib/images";
import { Layout, PictureEl, PreloadPicture, SITE_TITLE, UiToggleScript } from "./layout";

// Mirrors the CSS column breakpoints of the archive grid.
const ARCHIVE_SIZES =
  "(min-width: 1100px) 20vw, (min-width: 800px) 25vw, (min-width: 520px) 33vw, 50vw";

export function FeedPage({ images }: { images: ImageRow[] }) {
  if (images.length === 0) {
    return (
      <Layout>
        <div class="feed-empty">No photos yet.</div>
      </Layout>
    );
  }
  return (
    <Layout head={<PreloadPicture p={picture(images[0])} />}>
      <main class="feed" id="feed">
        {images.map((image, i) => (
          <section class="slide" data-date={image.day}>
            <a class="slide__frame" href={permalink(image.day)}>
              <PictureEl
                p={picture(image)}
                sizes="100vw"
                class="slide__img"
                fetchpriority={i === 0 ? "high" : undefined}
                loading={i < 2 ? "eager" : "lazy"}
              />
            </a>
            <figcaption class="slide__caption">{longDate(image.day)}</figcaption>
          </section>
        ))}
        <section class="feed-end">
          <a class="feed-end__link" href="/archive">Archive</a>
        </section>
      </main>
      <script src={assets.feed}></script>
      <UiToggleScript />
    </Layout>
  );
}

export function ArchivePage({ images }: { images: ImageRow[] }) {
  const months: { label: string; images: ImageRow[] }[] = [];
  for (const image of images) {
    const label = monthLabel(image.day);
    if (months.at(-1)?.label !== label) months.push({ label, images: [] });
    months.at(-1)!.images.push(image);
  }
  return (
    <Layout title={`Archive — ${SITE_TITLE}`}>
      <main class="archive">
        {months.length === 0 && <div class="feed-empty">No photos in the archive yet.</div>}
        {months.map((month) => (
          <section class="archive__month">
            <h2 class="archive__label">{month.label}</h2>
            <div class="archive__grid">
              {month.images.map((image) => (
                <a class="thumb" href={permalink(image.day)}>
                  <PictureEl p={picture(image)} sizes={ARCHIVE_SIZES} loading="lazy" />
                  <time class="thumb__date" datetime={image.day}>
                    {shortDate(image.day)}
                  </time>
                </a>
              ))}
            </div>
          </section>
        ))}
      </main>
    </Layout>
  );
}

export function DetailPage(props: { image: ImageRow; prev: ImageRow | null; next: ImageRow | null }) {
  const { image, prev, next } = props;
  const p = picture(image);
  return (
    <Layout
      title={`${longDate(image.day)} — ${SITE_TITLE}`}
      head={
        <>
          <PreloadPicture p={p} />
          {/* Prefetch the neighbouring permalinks; each carries its own image preload. */}
          {prev && <link rel="prefetch" href={permalink(prev.day)} />}
          {next && <link rel="prefetch" href={permalink(next.day)} />}
        </>
      }
    >
      <section class="slide slide--detail">
        <div class="slide__frame">
          <PictureEl p={p} sizes="100vw" class="slide__img" fetchpriority="high" />
        </div>
        <figcaption class="slide__caption">{longDate(image.day)}</figcaption>
      </section>
      <UiToggleScript />
      {(prev || next) && (
        <>
          <nav class="detail-nav">
            {prev ? (
              <a class="detail-nav__link detail-nav__link--prev" href={permalink(prev.day)}>
                ← {shortDate(prev.day)}
              </a>
            ) : (
              <span></span>
            )}
            {next ? (
              <a class="detail-nav__link detail-nav__link--next" href={permalink(next.day)}>
                {shortDate(next.day)} →
              </a>
            ) : (
              <span></span>
            )}
          </nav>
          <script src={assets.detail}></script>
        </>
      )}
    </Layout>
  );
}

export function LoginPage() {
  return (
    <Layout title="Sign in — Photolog" head={<script src={assets.login} defer></script>}>
      <div class="auth">
        <form id="login-form" method="post" action="/token" class="auth__form" novalidate>
          <input type="text" id="username" name="username" placeholder="Username" required class="auth__input" autocomplete="username" />
          <input type="password" id="password" name="password" placeholder="Password" required class="auth__input" autocomplete="current-password" />
          <button type="submit" class="auth__button">Sign in</button>
        </form>
        <div id="error-container" class="error-container" aria-live="polite"></div>
      </div>
    </Layout>
  );
}

const STEPS: [step: string, label: string, chips?: string][] = [
  ["decode", "Reading image"],
  ["original", "Encoding master"],
  ["avif", "Encoding AVIF", "avif-widths"],
  ["jpeg", "Encoding JPEG fallbacks", "jpeg-widths"],
  ["upload", "Uploading"],
  ["commit", "Saving to library"],
];

export function UploadPage() {
  return (
    <Layout title="Upload — Photolog" head={<script type="module" src={assets.upload}></script>}>
      <div class="auth">
        <div
          id="drop-area"
          class="auth__drop"
          data-state="idle"
          data-encoder={assets["encode-worker"]}
          data-avif-wasm={assets.avif_enc}
          data-jpeg-wasm={assets.mozjpeg_enc}
        >
          <p class="auth__drop-text" data-role="prompt">Drag &amp; drop or</p>
          <p class="auth__drop-text auth__drop-filename" data-role="filename" hidden></p>
          {/* Decoding happens in the browser: JPEG and PNG work everywhere, HEIC and TIFF only in Safari. */}
          <input type="file" id="file-input" name="file" accept=".jpg,.jpeg,.png,.heic,.heif,.tif,.tiff,image/jpeg,image/png,image/heic,image/heif,image/tiff" hidden />
          <button type="button" class="auth__button" data-role="select">Select</button>
          <ul class="upload-checklist" data-role="checklist" hidden>
            {STEPS.map(([step, label, chips]) => (
              <li class="upload-step" data-step={step} data-state="pending">
                <span class="upload-step__icon" aria-hidden="true"></span>
                <span class="upload-step__label">{label}</span>
                {chips && <span class="upload-substeps" data-role={chips}></span>}
              </li>
            ))}
          </ul>
          <button type="button" class="auth__link-button upload-retry" data-role="retry" hidden>
            Try another
          </button>
        </div>
        <div id="error-container" class="error-container" aria-live="polite"></div>
        <form method="post" action="/logout" class="auth__footer">
          <button type="submit" class="auth__link-button">Log out</button>
        </form>
      </div>
    </Layout>
  );
}
