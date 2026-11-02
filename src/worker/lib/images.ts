import type { Env } from "../env";

export interface ImageRow {
  id: number;
  storage_id: string;
  uploaded_at: string;
  day: string;
  width: number;
  height: number;
  dominant_color: string;
  avif_widths: string;
  jpeg_widths: string;
}

export interface Picture {
  avifSrcset: string;
  jpegSrcset: string;
  fallbackSrc: string;
  width: number;
  height: number;
  dominantColor: string;
}

const COLUMNS =
  "id, storage_id, uploaded_at, day, width, height, dominant_color, avif_widths, jpeg_widths";

/** srcset/size data for one `<picture>`, from the widths stored with the row. */
export function picture(image: ImageRow): Picture {
  const avif: number[] = JSON.parse(image.avif_widths);
  const jpeg: number[] = JSON.parse(image.jpeg_widths);
  const srcset = (widths: number[], ext: string) =>
    widths.map((w) => `/i/${image.storage_id}/${w}.${ext} ${w}w`).join(", ");
  return {
    avifSrcset: srcset(avif, "avif"),
    jpegSrcset: srcset(jpeg, "jpg"),
    // Last-resort `src`: the smallest JPEG, for clients that ignore srcset.
    fallbackSrc: `/i/${image.storage_id}/${jpeg[0]}.jpg`,
    width: image.width,
    height: image.height,
    dominantColor: image.dominant_color,
  };
}

export async function latestImages(env: Env, limit: number): Promise<ImageRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM images ORDER BY uploaded_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all<ImageRow>();
  return results;
}

export async function allImages(env: Env): Promise<ImageRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM images ORDER BY day DESC, uploaded_at DESC`,
  ).all<ImageRow>();
  return results;
}

/** The photo for `day` plus its neighbours on the timeline, in one round trip. */
export async function imageForDay(
  env: Env,
  day: string,
): Promise<{ image: ImageRow | null; prev: ImageRow | null; next: ImageRow | null }> {
  const [current, prev, next] = await env.DB.batch<ImageRow>([
    env.DB.prepare(
      `SELECT ${COLUMNS} FROM images WHERE day = ? ORDER BY uploaded_at DESC LIMIT 1`,
    ).bind(day),
    env.DB.prepare(
      `SELECT ${COLUMNS} FROM images WHERE day < ? ORDER BY day DESC, uploaded_at DESC LIMIT 1`,
    ).bind(day),
    env.DB.prepare(
      `SELECT ${COLUMNS} FROM images WHERE day > ? ORDER BY day ASC, uploaded_at DESC LIMIT 1`,
    ).bind(day),
  ]);
  return {
    image: current.results[0] ?? null,
    prev: prev.results[0] ?? null,
    next: next.results[0] ?? null,
  };
}

export async function imageByStorageId(env: Env, storageId: string): Promise<ImageRow | null> {
  return env.DB.prepare(`SELECT ${COLUMNS} FROM images WHERE storage_id = ?`)
    .bind(storageId)
    .first<ImageRow>();
}
