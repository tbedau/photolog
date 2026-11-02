# Photolog

A minimal site for sharing one photo a day. Visitors scroll a snap-scroll feed
of recent photos, browse the full archive by month, and share a photo through
its date permalink (`/2026/10/18`). One signed-in user uploads.

Running at [photolog.tillmannbedau.com](https://photolog.tillmannbedau.com).

## How it works

- **Cloudflare Worker** ([Hono](https://hono.dev), server-rendered JSX, no
  client framework). Public pages are cached at the edge for 5 minutes;
  signed-in requests bypass the cache.
- **D1** holds photo metadata and the user (`migrations/`).
- **R2** holds the image files under `{storage_id}/original.jpg` and
  `{storage_id}/{width}.{avif|jpg}`, served from `/i/…` with immutable caching.
- **Image processing runs in the uploader's browser.** `src/client/upload.ts`
  decodes the photo (applying EXIF orientation and dropping all metadata),
  scales the master to at most 3200 px, and encodes five AVIF widths
  (libaom, quality 65 with film-grain synthesis) plus two JPEG fallbacks
  (mozjpeg, quality 85) in parallel Web Workers. The Worker validates the set
  against the size ladder in `src/shared/ladder.ts` and stores it, rejecting
  JPEGs that still carry EXIF data. Because the browser decodes the photo,
  JPEG and PNG work everywhere but HEIC and TIFF only in Safari.
- **Login** verifies the Argon2id hash in WASM. That needs more CPU than the
  Workers Free plan allows, so the account must be on Workers Paid. Login
  attempts are rate limited to 5 per minute per IP.

Each photo also stores its dimensions and average colour, so pages reserve
the right space and paint a matching placeholder before the image arrives.

## Development

```sh
npm install
cp .dev.vars.example .dev.vars        # then set SECRET_KEY
npx wrangler d1 migrations apply photolog --local
npm run hash-password                 # prints an Argon2id hash
npx wrangler d1 execute photolog --local \
  --command "INSERT INTO users (username, password_hash) VALUES ('me', '<hash>')"
npm run dev                           # http://localhost:8787
```

`npm run typecheck` and `npm test` run the checks CI runs.

## Deployment

Pushes to `main` deploy through GitHub Actions (`.github/workflows/deploy.yml`)
with the repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The
workflow applies pending D1 migrations (`migrations/`) before deploying, so a
migration must keep working with the code that is still live.

One-time setup for a new environment: create the D1 database and R2 bucket,
put the database id into `wrangler.jsonc`, apply the migrations, and set the
session key with `npx wrangler secret put SECRET_KEY`.

## Maintenance

Change the password:

```sh
npm run hash-password
npx wrangler d1 execute photolog --remote \
  --command "UPDATE users SET password_hash = '<hash>' WHERE username = 'till'"
```

Delete a photo (row first, so it disappears from the site immediately):

```sh
npx wrangler d1 execute photolog --remote --command "DELETE FROM images WHERE storage_id = '<id>'"
npx wrangler r2 object delete photolog/<id>/original.jpg   # repeat for each file
```

## Migration from the Python version

`scripts/export-legacy.mjs` converts a copy of the old app's SQLite database
and `uploads/` folder into D1 rows and R2 objects. Photos keep their original
permalink dates, and each photo's derivative widths are read from the files on
disk.

```sh
rsync -a <vps>:/srv/docker/applications/photolog/{data,uploads} migration/
node scripts/export-legacy.mjs migration   # writes migration/import.sql and objects.tsv
# import.sql starts with DELETE FROM images; DELETE FROM users;
npx wrangler d1 execute photolog --remote --file migration/import.sql
# then upload every "<key>\t<file>\t<type>" line of objects.tsv to R2
```
