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

/**
 * A JPEG without an EXIF (APP1 "Exif") segment. The browser re-encodes from
 * pixels, so EXIF here means the file bypassed that step and may carry GPS
 * data; the published original.jpg must never contain it.
 */
function isCleanJpeg(b: Uint8Array): boolean {
  if (b[0] !== 0xff || b[1] !== 0xd8) return false;
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    if (marker === 0xda) return true; // start of scan: headers are over
    const length = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xe1 && String.fromCharCode(...b.subarray(i + 4, i + 8)) === "Exif") return false;
    i += 2 + length;
  }
  return i > 2;
}

// ISO-BMFF: bytes 4–7 are "ftyp", followed by the "avif" brand.
const isAvif = (b: Uint8Array) => String.fromCharCode(...b.subarray(4, 12)) === "ftypavif";

/**
 * Checks one part's size and header. Returns the File itself so it streams to
 * R2 without another in-memory copy.
 */
async function checkPart(
  form: FormData,
  name: string,
  check: (head: Uint8Array) => boolean,
): Promise<File> {
  const part = form.get(name);
  if (!(part instanceof File)) throw new UploadError(`Missing file ${name}.`);
  if (part.size === 0 || part.size > MAX_PART_BYTES) {
    throw new UploadError(`File ${name} has an invalid size.`);
  }
  const head = new Uint8Array(await part.slice(0, 64 * 1024).arrayBuffer());
  if (!check(head)) throw new UploadError(`File ${name} is not the expected format.`);
  return part;
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

  const files: { key: string; body: File; type: string }[] = [];
  files.push({ key: "original.jpg", body: await checkPart(form, "original", isCleanJpeg), type: "image/jpeg" });
  for (const w of ladders.avif) {
    files.push({ key: `${w}.avif`, body: await checkPart(form, `avif_${w}`, isAvif), type: "image/avif" });
  }
  for (const w of ladders.jpeg) {
    files.push({ key: `${w}.jpg`, body: await checkPart(form, `jpeg_${w}`, isCleanJpeg), type: "image/jpeg" });
  }

  const storageId = crypto.randomUUID().replaceAll("-", "");
  const keys = files.map((f) => `${storageId}/${f.key}`);
  const day = todayInBerlin();
  const cleanUp = () => env.PHOTOS.delete(keys).catch(() => {});

  // Wait for every write to settle before any cleanup, so a slow put can't
  // land after the delete and leave an orphan.
  const puts = await Promise.allSettled(
    files.map((f, i) =>
      env.PHOTOS.put(keys[i], f.body, {
        httpMetadata: { contentType: f.type, cacheControl: IMMUTABLE },
      }),
    ),
  );
  if (puts.some((p) => p.status === "rejected")) {
    console.error("upload_r2_failed", puts.find((p) => p.status === "rejected"));
    await cleanUp();
    throw new UploadError("The photo was processed but could not be saved.", 500);
  }

  // The cap is re-checked inside the INSERT, so two concurrent uploads can't
  // both get through.
  let inserted: D1Result;
  try {
    inserted = await env.DB.prepare(
      `INSERT INTO images
         (storage_id, original_filename, uploaded_at, day, user_id, width, height,
          dominant_color, avif_widths, jpeg_widths)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
       WHERE (SELECT COUNT(*) FROM images WHERE user_id = ?5 AND day = ?4) < ?11`,
    )
      .bind(
        storageId,
        meta.originalFilename,
        new Date().toISOString(),
        day,
        user.id,
        meta.width,
        meta.height,
        meta.dominantColor,
        JSON.stringify(ladders.avif),
        JSON.stringify(ladders.jpeg),
        MAX_UPLOADS_PER_DAY,
      )
      .run();
  } catch (err) {
    console.error("upload_d1_failed", err);
    await cleanUp();
    throw new UploadError("The photo was processed but could not be saved.", 500);
  }
  if (inserted.meta.changes === 0) {
    await cleanUp();
    throw new UploadError(
      `You have reached your daily upload limit of ${MAX_UPLOADS_PER_DAY} image(s).`,
      429,
    );
  }

  return storageId;
}
