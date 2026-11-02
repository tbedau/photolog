import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "./env";
import { authenticate, currentUser, endSession, hasSessionCookie, startSession } from "./lib/auth";
import { dayFromPath } from "./lib/dates";
import { allImages, imageByStorageId, imageForDay, latestImages } from "./lib/images";
import { sameOriginPosts, securityHeaders } from "./lib/security";
import { dailyCapError, storeUpload, UploadError } from "./lib/upload";
import { ArchivePage, DetailPage, FeedPage, LoginPage, UploadPage } from "./views/pages";

const FRONTPAGE_PHOTO_COUNT = 30;

// Public pages are cached per data centre for a few minutes. A new upload
// purges the copies in the uploader's data centre; elsewhere they expire.
const PAGE_CACHE_SECONDS = 300;
const PUBLIC_PAGES = ["/", "/archive"];

const app = new Hono<AppEnv>();

app.use(securityHeaders);
app.use(sameOriginPosts);

/**
 * Serves a public HTML page from the edge cache when possible. Signed-in
 * visitors bypass the cache so they always see their latest upload.
 */
async function cachedPage(
  c: Context<AppEnv>,
  render: () => Promise<Response>,
): Promise<Response> {
  const cache = caches.default;
  const key = new Request(new URL(c.req.path, c.req.url).toString());
  const signedIn = hasSessionCookie(c);
  if (!signedIn) {
    const hit = await cache.match(key);
    if (hit) {
      const res = new Response(hit.body, hit);
      res.headers.set("Cache-Control", "no-cache");
      return res;
    }
  }
  const res = await render();
  if (res.status === 200) {
    // Browsers revalidate every time; the edge copy lives a few minutes.
    res.headers.set("Cache-Control", "no-cache");
    if (!signedIn) {
      const copy = new Response(res.clone().body, res);
      copy.headers.set("Cache-Control", `public, max-age=${PAGE_CACHE_SECONDS}`);
      c.executionCtx.waitUntil(cache.put(key, copy));
    }
  }
  return res;
}

app.get("/", (c) =>
  cachedPage(c, async () => c.html(<FeedPage images={await latestImages(c.env, FRONTPAGE_PHOTO_COUNT)} />)),
);

app.get("/archive", (c) =>
  cachedPage(c, async () => c.html(<ArchivePage images={await allImages(c.env)} />)),
);

app.get("/:year{[0-9]{4}}/:month{[0-9]{1,2}}/:day{[0-9]{1,2}}", async (c) => {
  const day = dayFromPath(c.req.param("year"), c.req.param("month"), c.req.param("day"));
  if (!day) return c.notFound();
  return cachedPage(c, async () => {
    const { image, prev, next } = await imageForDay(c.env, day);
    if (!image) return c.notFound();
    return c.html(<DetailPage image={image} prev={prev} next={next} />);
  });
});

// ---------- Images ----------

const STORAGE_ID = /^[0-9a-f]{32}$/;
const DERIVATIVE = /^(?:(\d{2,4})\.(avif|jpg)|original\.jpg)$/;

app.get("/i/:id/:file", async (c) => {
  const { id, file } = c.req.param();
  if (!STORAGE_ID.test(id) || !DERIVATIVE.test(file)) return c.notFound();

  // The Cache API also answers If-None-Match with a 304.
  const cache = caches.default;
  const hit = await cache.match(c.req.raw);
  // Re-wrap: cached responses have immutable headers, and middleware adds some.
  if (hit) return new Response(hit.body, hit);

  const object = await c.env.PHOTOS.get(`${id}/${file}`);
  if (!object) return c.notFound();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Content-Disposition", "inline");
  const res = new Response(object.body, { headers });
  c.executionCtx.waitUntil(cache.put(c.req.raw, res.clone()));
  return res;
});

// Pre-2024 flat URLs (`/images/{uuid}_{user}.jpg`) → the largest JPEG.
app.get("/images/:filename", async (c) => {
  const storageId = c.req.param("filename").split("_")[0].replace(/\.jpg$/, "");
  if (!STORAGE_ID.test(storageId)) return c.notFound();
  const image = await imageByStorageId(c.env, storageId);
  if (!image) return c.notFound();
  const widths: number[] = JSON.parse(image.jpeg_widths);
  return c.redirect(`/i/${storageId}/${widths.at(-1)}.jpg`, 301);
});

// ---------- Auth ----------

app.get("/login", async (c) => {
  if (await currentUser(c)) return c.redirect("/upload", 302);
  return c.html(<LoginPage />);
});

app.post("/token", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const { success } = await c.env.LOGIN_LIMITER.limit({ key: ip });
  if (!success) {
    c.header("Retry-After", "60");
    return c.json({ error: "Too many attempts. Try again in a minute." }, 429);
  }

  const form = await c.req.formData();
  const username = String(form.get("username") ?? "");
  const password = String(form.get("password") ?? "");
  const user = await authenticate(c.env, username, password);
  if (!user) {
    console.warn("login_failed", { username, ip });
    return c.json({ error: "Incorrect username or password" }, 401);
  }
  await startSession(c, user);
  return c.json({ success: true, redirect: "/upload" });
});

// POST only: a GET logout could be triggered by prefetchers and crawlers.
app.post("/logout", (c) => {
  endSession(c);
  return c.redirect("/", 303);
});

// ---------- Upload ----------

app.get("/upload", async (c) => {
  if (!(await currentUser(c))) return c.redirect("/login", 302);
  c.header("Cache-Control", "no-store");
  return c.html(<UploadPage />);
});

app.get("/upload/precheck", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: "Your session has expired. Sign in again." }, 401);
  const error = await dailyCapError(c.env, user);
  return error ? c.json({ error }, 429) : c.json({ ok: true });
});

app.post("/upload", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: "Your session has expired. Sign in again." }, 401);
  try {
    await storeUpload(c.env, user, await c.req.formData());
  } catch (err) {
    if (err instanceof UploadError) return c.json({ error: err.message }, err.status);
    throw err;
  }
  const cache = caches.default;
  c.executionCtx.waitUntil(
    Promise.all(PUBLIC_PAGES.map((path) => cache.delete(new URL(path, c.req.url).toString()))),
  );
  return c.json({ success: true, redirect: "/" });
});

// ---------- Fallbacks ----------

// Unknown pages send browsers home; other requests get an honest 404.
app.notFound((c) => {
  if (c.req.header("Accept")?.includes("text/html")) return c.redirect("/", 302);
  return c.json({ detail: "Not Found" }, 404);
});

app.onError((err, c) => {
  console.error("unhandled_error", err);
  return c.json({ error: "Internal Server Error" }, 500);
});

export default app;
