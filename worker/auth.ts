/**
 * Auth primitives for the public-internet deploy (Web Crypto only, no deps).
 *
 * Two ways in:
 *   - `Authorization: Bearer <JARVIS_TOKEN>` (or `x-jarvis-token`) — scripts and the
 *     music-kiosk service binding. Full access, reads + writes (+ user admin).
 *   - an invite-only user account → `sb_session` cookie holding a random token;
 *     D1 stores only HMAC(token, SESSION_SECRET). 90-day rolling expiry.
 *
 * Shape is shared with music-kiosk — keep the two in step.
 */
import type { Env } from "./env";

export const COOKIE_NAME = "sb_session";
export const DAY_MS = 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 90 * DAY_MS;
export const INVITE_TTL_MS = 7 * DAY_MS;
export const RESET_TTL_MS = 60 * 60 * 1000;
export const MIN_PASSWORD = 10;
const PBKDF2_ITERATIONS = 100_000; // Workers' maximum

const enc = new TextEncoder();

export const hex = (buf: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));

export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(s: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", enc.encode(s));
}

/** Constant-time string equality (hash first so lengths always match). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

/** hex HMAC-SHA256(value, SESSION_SECRET) — the stored id for session + link tokens. */
export async function tokenId(env: Env, token: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(token)));
}

// --- passwords ---------------------------------------------------------------

async function pbkdf2(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, key, 256),
  );
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { hash: hex(await pbkdf2(password, salt)), salt: hex(salt) };
}

export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  if (!hash || !salt) {
    await pbkdf2(password, new Uint8Array(16)); // keep timing similar for passwordless users
    return false;
  }
  const got = await pbkdf2(password, unhex(salt));
  const want = unhex(hash);
  return got.length === want.length && crypto.subtle.timingSafeEqual(got, want);
}

// --- cookies -----------------------------------------------------------------

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export const sessionCookie = (token: string, maxAgeS = SESSION_TTL_MS / 1000) =>
  `${COOKIE_NAME}=${token}; Path=/; Max-Age=${Math.floor(maxAgeS)}; HttpOnly; Secure; SameSite=Lax`;
export const clearCookie = () => `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

// --- sessions ----------------------------------------------------------------

export interface User {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
  disabled: number;
  created_at: number;
  password_hash: string;
  salt: string;
}
export type PublicUser = Omit<User, "password_hash" | "salt" | "disabled"> & {
  disabled: boolean;
  pending: boolean; // no password set yet (invite outstanding / bootstrap admin)
};

export const publicUser = (u: User): PublicUser => ({
  id: u.id, email: u.email, name: u.name, role: u.role, created_at: u.created_at,
  disabled: Boolean(u.disabled), pending: !u.password_hash,
});

/** Create a session row and return the Set-Cookie header value. */
export async function createSession(env: Env, userId: string): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO sessions (id,user_id,created_at,expires_at) VALUES (?,?,?,?)`)
    .bind(await tokenId(env, token), userId, now, now + SESSION_TTL_MS)
    .run();
  return sessionCookie(token);
}

export type Auth =
  | { kind: "token" }
  | { kind: "session"; user: User; sessionId: string; setCookie?: string };

/** Who is calling? A JARVIS_TOKEN match wins; else a live session for an enabled user. */
export async function authenticate(req: Request, env: Env): Promise<Auth | null> {
  const bearer = req.headers.get("authorization");
  const provided = bearer?.toLowerCase().startsWith("bearer ")
    ? bearer.slice(7).trim()
    : req.headers.get("x-jarvis-token");
  if (provided && env.JARVIS_TOKEN && (await safeEqual(provided, env.JARVIS_TOKEN))) return { kind: "token" };

  const raw = readCookie(req, COOKIE_NAME);
  if (!raw || !env.SESSION_SECRET || raw.length > 128) return null;
  const sid = await tokenId(env, raw);
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT s.expires_at AS s_exp, u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ? AND u.disabled = 0`,
  ).bind(sid, now).first<User & { s_exp: number }>();
  if (!row) return null;
  const { s_exp, ...user } = row;

  // Rolling expiry: extend once more than a day has passed since the last extension.
  let setCookie: string | undefined;
  if (now - (s_exp - SESSION_TTL_MS) > DAY_MS) {
    await env.DB.prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`).bind(now + SESSION_TTL_MS, sid).run();
    setCookie = sessionCookie(raw);
  }
  return { kind: "session", user, sessionId: sid, setCookie };
}

// --- rate limiting (D1 sliding window) --------------------------------------------

const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT = 10;

/** True if any key already has RATE_LIMIT hits inside the sliding window. */
export async function isRateLimited(env: Env, keys: string[]): Promise<boolean> {
  const since = Date.now() - RATE_WINDOW_MS;
  const counts = await env.DB.batch(
    keys.map((k) => env.DB.prepare(`SELECT COUNT(*) AS n FROM rate_hits WHERE key = ? AND at > ?`).bind(k, since)),
  );
  return counts.some((r) => ((r.results[0] as { n: number }).n ?? 0) >= RATE_LIMIT);
}

/** Record one hit per key (and prune hits that fell out of the window). */
export async function recordHits(env: Env, keys: string[]): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM rate_hits WHERE at <= ?`).bind(now - RATE_WINDOW_MS),
    ...keys.map((k) => env.DB.prepare(`INSERT INTO rate_hits (key, at) VALUES (?, ?)`).bind(k, now)),
  ]);
}
