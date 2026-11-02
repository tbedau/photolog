import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";

// All scripts are external files under /static/build, so script-src needs no
// nonce or 'unsafe-inline'. `style-src-attr 'unsafe-inline'` keeps the
// per-image `style="--dom:#…"` placeholder colour working.
const BASE_CSP = {
  "default-src": "'self'",
  "script-src": "'self'",
  "style-src": "'self'",
  "style-src-attr": "'unsafe-inline'",
  "img-src": "'self' data:",
  "font-src": "'self'",
  "connect-src": "'self'",
  "worker-src": "'none'",
  "frame-ancestors": "'none'",
  "form-action": "'self'",
  "base-uri": "'none'",
  "object-src": "'none'",
};

// The upload page starts encoder Web Workers. The WebAssembly itself is
// compiled inside those workers, which get their own (empty) policy from the
// static asset response, so the page needs no 'wasm-unsafe-eval'.
const UPLOAD_CSP = {
  ...BASE_CSP,
  "worker-src": "'self'",
};

const serialize = (policy: Record<string, string>) =>
  Object.entries(policy)
    .map(([k, v]) => `${k} ${v}`)
    .join("; ");

const BASE_CSP_HEADER = serialize(BASE_CSP);
const UPLOAD_CSP_HEADER = serialize(UPLOAD_CSP);

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  h.set(
    "Permissions-Policy",
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  );
  h.set("Content-Security-Policy", c.req.path === "/upload" ? UPLOAD_CSP_HEADER : BASE_CSP_HEADER);
  if (c.env.ENVIRONMENT === "production") {
    h.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  }
};

/**
 * Rejects state-changing requests sent from another origin. SameSite=Strict
 * already keeps the session cookie off them; this is a second layer.
 */
export const sameOriginPosts: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === "POST") {
    const origin = c.req.header("Origin");
    if (origin && origin !== new URL(c.req.url).origin) {
      return c.json({ error: "Cross-origin request rejected" }, 403);
    }
  }
  await next();
};
