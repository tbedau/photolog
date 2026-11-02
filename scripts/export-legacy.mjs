// One-off migration from the Python app. Reads a copy of its SQLite database
// and uploads folder (rsync'd into migration/) and writes:
//   migration/import.sql   rows for D1
//   migration/objects.tsv  "<R2 key>\t<local path>\t<content type>" per file
//
// `day` is the UTC date of the stored upload time, because that's what the
// old templates put into permalinks; keeping it keeps shared links working.
// Derivative widths come from the files on disk, which vary by upload era.
//
// Usage: node scripts/export-legacy.mjs [migration-dir]

import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dir = process.argv[2] ?? "migration";
const db = new DatabaseSync(join(dir, "data/photolog_data.db"), { readOnly: true });

const sql = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`);

const lines = ["DELETE FROM images;", "DELETE FROM users;"];
const objects = [];
const problems = [];

for (const u of db.prepare("SELECT id, username, hashed_password FROM user").all()) {
  lines.push(`INSERT INTO users (id, username, password_hash) VALUES (${sql(u.id)}, ${sql(u.username)}, ${sql(u.hashed_password)});`);
}

const images = db.prepare("SELECT * FROM image ORDER BY upload_date").all();
for (const img of images) {
  const folder = join(dir, "uploads", img.filename);
  let files;
  try {
    files = readdirSync(folder);
  } catch {
    problems.push(`row ${img.id}: missing folder ${img.filename}`);
    continue;
  }
  const widths = (ext) =>
    files
      .filter((f) => f.endsWith(ext) && /^\d+\./.test(f))
      .map((f) => Number.parseInt(f, 10))
      .sort((a, b) => a - b);
  const avif = widths(".avif");
  const jpeg = widths(".jpg");
  if (!files.includes("original.jpg") || avif.length === 0 || jpeg.length === 0) {
    problems.push(`row ${img.id}: incomplete set in ${img.filename}: ${files.join(", ")}`);
    continue;
  }
  if (img.width == null || img.height == null || img.dominant_color == null) {
    problems.push(`row ${img.id}: missing width/height/colour`);
    continue;
  }

  // "2026-10-18 16:54:50.559852" (naive UTC) → "2026-10-18T16:54:50.559Z"
  const [date, time] = img.upload_date.split(" ");
  const [hms, frac = ""] = time.split(".");
  const uploadedAt = `${date}T${hms}.${frac.padEnd(3, "0").slice(0, 3)}Z`;

  lines.push(
    "INSERT INTO images (id, storage_id, original_filename, uploaded_at, day, user_id, width, height, dominant_color, avif_widths, jpeg_widths) VALUES (" +
      [img.id, img.filename, img.original_filename, uploadedAt, date, img.user_id, img.width, img.height, img.dominant_color, JSON.stringify(avif), JSON.stringify(jpeg)]
        .map(sql)
        .join(", ") +
      ");",
  );
  for (const f of files) {
    const type = f.endsWith(".avif") ? "image/avif" : f.endsWith(".jpg") ? "image/jpeg" : null;
    if (!type) {
      problems.push(`row ${img.id}: skipping unexpected file ${f}`);
      continue;
    }
    objects.push(`${img.filename}/${f}\t${join(folder, f)}\t${type}`);
  }
}

// Entries no row points to: leftover loose files from the pre-2024 flat
// layout, which the old app no longer served either.
const referenced = new Set(images.map((i) => i.filename));
const orphans = readdirSync(join(dir, "uploads")).filter((d) => !referenced.has(d));

writeFileSync(join(dir, "import.sql"), lines.join("\n") + "\n");
writeFileSync(join(dir, "objects.tsv"), objects.join("\n") + "\n");
console.log(`${images.length} rows, ${objects.length} files, ${orphans.length} unreferenced uploads/ entries skipped (${orphans.join(", ")})`);
for (const p of problems) console.log("PROBLEM", p);
