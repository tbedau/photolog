import type { Child } from "hono/jsx";
import { assets } from "../generated/manifest";
import type { Picture } from "../lib/images";

export const SITE_TITLE = "Tillmann Bedau — Photolog";

export function Layout(props: { title?: string; head?: Child; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{props.title ?? SITE_TITLE}</title>
        <meta name="description" content="A daily photo log by Tillmann Bedau." />
        <link rel="stylesheet" href={assets.styles} />
        <link rel="icon" type="image/png" href="/static/favicon/favicon-96x96.png" sizes="96x96" />
        <link rel="icon" type="image/svg+xml" href="/static/favicon/favicon.svg" />
        <link rel="shortcut icon" href="/static/favicon/favicon.ico" />
        <link rel="apple-touch-icon" sizes="180x180" href="/static/favicon/apple-touch-icon.png" />
        <meta name="apple-mobile-web-app-title" content="Photolog" />
        <link rel="manifest" href="/static/favicon/site.webmanifest" />
        {props.head}
      </head>
      <body>
        <a class="header-side header-side--left" href="/">Photolog</a>
        <a class="mark" href="/">Tillmann Bedau</a>
        <a class="header-side header-side--right" href="/archive">Archive</a>
        {props.children}
      </body>
    </html>
  );
}

/** Restores and toggles the hidden-UI mode ("h" key). Render where it should run. */
export const UiToggleScript = () => <script src={assets.ui}></script>;

/** Preloads the AVIF derivatives of the photo that will be the largest paint. */
export const PreloadPicture = ({ p }: { p: Picture }) => (
  <link
    rel="preload"
    as="image"
    imagesrcset={p.avifSrcset}
    imagesizes="100vw"
    type="image/avif"
    fetchpriority="high"
  />
);

export function PictureEl(props: {
  p: Picture;
  sizes: string;
  class?: string;
  loading?: "lazy" | "eager";
  fetchpriority?: "high";
}) {
  const { p } = props;
  return (
    <picture>
      <source type="image/avif" srcset={p.avifSrcset} sizes={props.sizes} />
      <img
        class={props.class}
        src={p.fallbackSrc}
        srcset={p.jpegSrcset}
        sizes={props.sizes}
        width={p.width}
        height={p.height}
        alt=""
        loading={props.loading}
        fetchpriority={props.fetchpriority}
        decoding="async"
        style={`--dom:${p.dominantColor}`}
      />
    </picture>
  );
}
