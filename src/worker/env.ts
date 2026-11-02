export interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  ASSETS: Fetcher;
  LOGIN_LIMITER: RateLimit;
  /** "production" (HTTPS, __Host- cookie, HSTS) or "development" (wrangler dev). */
  ENVIRONMENT: "production" | "development";
  /** HMAC key for session tokens. Set with `wrangler secret put SECRET_KEY`. */
  SECRET_KEY: string;
}

export interface User {
  id: number;
  username: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { user: User | null };
};
