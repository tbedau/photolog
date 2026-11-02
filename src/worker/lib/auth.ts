// Session handling for the single admin account.
//
// Passwords are Argon2id hashes (migrated as-is from the Python app, which
// used pwdlib's defaults: m=64 MiB, t=3, p=4). Verification runs in WASM (see
// argon2.ts); it takes far more than the Free plan's 10 ms CPU per request,
// so this Worker needs the Workers Paid plan.
//
// The session is a short-lived HS256 JWT in an HttpOnly, SameSite=Strict
// cookie. In production the __Host- prefix forces Secure, Path=/ and no Domain.

import { argon2idVerify } from "./argon2";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import type { AppEnv, Env, User } from "../env";

export const SESSION_MINUTES = 30;

// Verified against when the username doesn't exist, so a failed login takes
// the same time either way and can't be used to enumerate accounts.
const DUMMY_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$kzjT+oHEUUSXLtKXgkI77g$f5VbPDMYQgITHQj0G5WHC7AptyM+4jpZL9WpyKqi+78";

export function cookieName(env: Env): string {
  return env.ENVIRONMENT === "production" ? "__Host-access_token" : "access_token";
}

export async function authenticate(
  env: Env,
  username: string,
  password: string,
): Promise<User | null> {
  const row = await env.DB.prepare(
    "SELECT id, username, password_hash FROM users WHERE username = ?",
  )
    .bind(username)
    .first<User & { password_hash: string }>();

  const valid = await argon2idVerify(password, row?.password_hash ?? DUMMY_HASH);

  return row && valid ? { id: row.id, username: row.username } : null;
}

export async function startSession(c: Context<AppEnv>, user: User): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const token = await sign(
    { sub: user.username, iat: now, exp: now + SESSION_MINUTES * 60 },
    c.env.SECRET_KEY,
    "HS256",
  );
  setCookie(c, cookieName(c.env), token, {
    httpOnly: true,
    secure: c.env.ENVIRONMENT === "production",
    sameSite: "Strict",
    path: "/",
    maxAge: SESSION_MINUTES * 60,
  });
}

export function endSession(c: Context<AppEnv>): void {
  deleteCookie(c, cookieName(c.env), {
    path: "/",
    secure: c.env.ENVIRONMENT === "production",
  });
}

export function hasSessionCookie(c: Context<AppEnv>): boolean {
  return getCookie(c, cookieName(c.env)) !== undefined;
}

/** The signed-in user, or null for a missing, expired or forged session. */
export async function currentUser(c: Context<AppEnv>): Promise<User | null> {
  const token = getCookie(c, cookieName(c.env));
  if (!token) return null;
  try {
    const payload = await verify(token, c.env.SECRET_KEY, "HS256");
    if (typeof payload.sub !== "string" || typeof payload.iat !== "number") return null;
    return await c.env.DB.prepare("SELECT id, username FROM users WHERE username = ?")
      .bind(payload.sub)
      .first<User>();
  } catch {
    return null;
  }
}
