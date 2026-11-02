// Stores a photo that the browser has already encoded (see src/client/upload.ts).
//
// The request is multipart/form-data with:
//   meta          JSON: { originalFilename, width, height, dominantColor }
//   original      JPEG master, longest edge ≤ 3200
//   avif_{width}  one AVIF per width in targetWidths(width).avif
//   jpeg_{width}  one JPEG per width in targetWidths(width).jpeg
//
// The server recomputes the width ladders from the master size, so a client
// can't store a set with missing or unexpected sizes.

import { MAX_DIMENSION, targetWidths } from "../../shared/ladder";
import type { Env, User } from "../env";
import { todayInBerlin } from "./dates";

export const MAX_UPLOADS_PER_DAY = 1;
const MAX_PART_BYTES = 15 * 1024 * 1024;
const IMMUTABLE = "public, max-age=31536000, immutable";

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 429 | 500 = 400,
  ) {
    super(message);
  }
}

interface Meta {
  originalFilename: string;
  width: number;
  height: number;
  dominantColor: string;
}

function parseMeta(raw: string | File | null): Meta {
  if (typeof raw !== "string") throw new UploadError("Missing upload metadata.");
  let meta: unknown;
  try {
    meta = JSON.parse(raw);
  } catch {
    throw new UploadError("Malformed upload metadata.");
  }
  const m = meta as Partial<Meta>;
  const dimension = (n: unknown) =>
    Number.isInteger(n) && (n as number) >= 2 && (n as number) <= MAX_DIMENSION;
  if (
    typeof m.originalFilename !== "string" ||
    m.originalFilename.length === 0 ||
    m.originalFilename.length > 255 ||
    !dimension(m.width) ||
    !dimension(m.height) ||
    typeof m.dominantColor !== "string" ||
    !/^#[0-9a-f]{6}$/.test(m.dominantColor)
  ) {
    throw new UploadError("Invalid upload metadata.");
  }
  return m as Meta;
}

const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
// ISO-BMFF: bytes 4–7 are "ftyp", followed by the "avif" brand.
const isAvif = (b: Uint8Array) =>
  String.fromCharCode(...b.subarray(4, 12)) === "ftypavif";

async function readPart(
  form: FormData,
  name: string,
  check: (b: Uint8Array) => boolean,
): Promise<ArrayBuffer> {
  const part = form.get(name);
  if (!(part instanceof File)) throw new UploadError(`Missing file ${name}.`);
  if (part.size === 0 || part.size > MAX_PART_BYTES) {
    throw new UploadError(`File ${name} has an invalid size.`);
  }
  const bytes = await part.arrayBuffer();
  if (!check(new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength)))) {
    throw new UploadError(`File ${name} is not the expected format.`);
  }
  return bytes;
}

/** Error message if the user is at the daily cap, else null. */
export async function dailyCapError(env: Env, user: User): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM images WHERE user_id = ? AND day = ?",
  )
    .bind(user.id, todayInBerlin())
    .first<{ n: number }>();
  if ((row?.n ?? 0) >= MAX_UPLOADS_PER_DAY) {
    return `You have reached your daily upload limit of ${MAX_UPLOADS_PER_DAY} image(s).`;
  }
  return null;
}

export async function storeUpload(env: Env, user: User, form: FormData): Promise<string> {
  const capError = await dailyCapError(env, user);
  if (capError) throw new UploadError(capError, 429);

  const meta = parseMeta(form.get("meta"));
  const ladders = targetWidths(meta.width);

  const files: { key: string; body: ArrayBuffer; type: string }[] = [];
  files.push({ key: "original.jpg", body: await readPart(form, "original", isJpeg), type: "image/jpeg" });
  for (const w of ladders.avif) {
    files.push({ key: `${w}.avif`, body: await readPart(form, `avif_${w}`, isAvif), type: "image/avif" });
  }
  for (const w of ladders.jpeg) {
    files.push({ key: `${w}.jpg`, body: await readPart(form, `jpeg_${w}`, isJpeg), type: "image/jpeg" });
  }

  const storageId = crypto.randomUUID().replaceAll("-", "");
  const keys = files.map((f) => `${storageId}/${f.key}`);

  try {
    await Promise.all(
      files.map((f, i) =>
        env.PHOTOS.put(keys[i], f.body, {
          httpMetadata: { contentType: f.type, cacheControl: IMMUTABLE },
        }),
      ),
    );
    await env.DB.prepare(
      `INSERT INTO images
         (storage_id, original_filename, uploaded_at, day, user_id, width, height,
          dominant_color, avif_widths, jpeg_widths)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        storageId,
        meta.originalFilename,
        new Date().toISOString(),
        todayInBerlin(),
        user.id,
        meta.width,
        meta.height,
        meta.dominantColor,
        JSON.stringify(ladders.avif),
        JSON.stringify(ladders.jpeg),
      )
      .run();
  } catch (err) {
    // Don't leave a half-written set in R2 that no row points to.
    await env.PHOTOS.delete(keys).catch(() => {});
    console.error("upload_store_failed", err);
    throw new UploadError("The photo was processed but could not be saved.", 500);
  }

  return storageId;
}
