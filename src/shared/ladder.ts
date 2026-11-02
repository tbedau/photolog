// Derivative sizes, shared by the browser encoder and the upload validator so
// the two can't drift.

/** Longest edge of the stored master. Larger sources are scaled down. */
export const MAX_DIMENSION = 3200;

/** AVIF widths: viewport-sized feed slides and the 2–5 column archive grid. */
export const AVIF_WIDTHS = [320, 640, 1280, 1920, 3200] as const;

/** JPEG fallbacks for browsers without AVIF. */
export const JPEG_WIDTHS = [1280, 3200] as const;

/**
 * Width ladders for a master of the given width, ascending. Never upscales.
 * The cap is rounded down to even: AVIF 4:2:0 pads the chroma plane at odd
 * sizes and the padding shows as a green fringe on the right edge.
 */
export function targetWidths(masterWidth: number): { avif: number[]; jpeg: number[] } {
  const cap = masterWidth - (masterWidth & 1);
  const ladder = (widths: readonly number[]) =>
    [...new Set(widths.map((w) => Math.min(w, cap)))].sort((a, b) => a - b);
  return { avif: ladder(AVIF_WIDTHS), jpeg: ladder(JPEG_WIDTHS) };
}

/** Master size for a source image: longest edge capped at MAX_DIMENSION. */
export function masterSize(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= MAX_DIMENSION) return { width, height };
  const scale = MAX_DIMENSION / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** Height of a derivative at `width`, rounded down to even (see targetWidths). */
export function derivativeHeight(master: { width: number; height: number }, width: number): number {
  const h = Math.max(2, Math.round((master.height * width) / master.width));
  return h - (h & 1);
}
