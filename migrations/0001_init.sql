-- Photolog schema (D1).
--
-- `day` is the calendar date a photo belongs to (YYYY-MM-DD). It drives the
-- permalink /YYYY/MM/DD, the archive grouping and the one-upload-per-day cap.
-- New uploads use the Europe/Berlin date; rows migrated from the Python app
-- keep the date its permalinks used, so shared links stay valid.
--
-- `avif_widths` / `jpeg_widths` are JSON arrays of the derivative widths
-- stored in R2 under `{storage_id}/{width}.{avif|jpg}`, next to
-- `{storage_id}/original.jpg`.

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL
);

CREATE TABLE images (
  id INTEGER PRIMARY KEY,
  storage_id TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  day TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users (id),
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  dominant_color TEXT NOT NULL,
  avif_widths TEXT NOT NULL,
  jpeg_widths TEXT NOT NULL
);

CREATE INDEX images_uploaded_at ON images (uploaded_at);
CREATE INDEX images_day ON images (day, uploaded_at);
