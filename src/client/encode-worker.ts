// Web Worker that turns one resized ImageBitmap into an AVIF or JPEG file.
// Several of these run in parallel (see upload.ts); each loads the encoders
// it needs once and keeps them for later jobs.

import encodeAvif, { init as initAvif } from "@jsquash/avif/encode";
import encodeJpeg, { init as initJpeg } from "@jsquash/jpeg/encode";

export interface EncodeJob {
  id: number;
  format: "avif" | "jpeg";
  bitmap: ImageBitmap;
  wasm: { avif: string; jpeg: string };
}

export type EncodeResult = { id: number; data: ArrayBuffer } | { id: number; error: string };

// libaom AVIF at quality 65. `denoiseLevel` turns on film-grain synthesis:
// grain is modelled and re-synthesised on decode instead of being smoothed
// away, which matters for the film scans on the site.
const AVIF_OPTIONS = { quality: 65, speed: 6, subsample: 1, denoiseLevel: 8 };
const JPEG_OPTIONS = { quality: 85, progressive: true, optimize_coding: true };

// @jsquash/avif switches to its multi-threaded build when SharedArrayBuffer is
// available, which needs a cross-origin-isolated page (COOP + COEP). The site
// sends COOP but not COEP, so the single-threaded avif_enc.wasm that
// scripts/build.mjs ships is the one used. Adding COEP would require shipping
// avif_enc_mt.wasm and its worker script too.
const ready: Partial<Record<EncodeJob["format"], Promise<unknown>>> = {};

function load(format: EncodeJob["format"], url: string): Promise<unknown> {
  ready[format] ??= WebAssembly.compileStreaming(fetch(url)).then((module) =>
    format === "avif" ? initAvif(module) : initJpeg(module),
  );
  return ready[format]!;
}

function pixels(bitmap: ImageBitmap): ImageData {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

self.onmessage = async (event: MessageEvent<EncodeJob>) => {
  const { id, format, bitmap, wasm } = event.data;
  try {
    await load(format, wasm[format]);
    const image = pixels(bitmap);
    const data =
      format === "avif"
        ? await encodeAvif(image, AVIF_OPTIONS)
        : await encodeJpeg(image, JPEG_OPTIONS);
    (self as unknown as Worker).postMessage({ id, data } satisfies EncodeResult, [data]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) } satisfies EncodeResult);
  }
};
