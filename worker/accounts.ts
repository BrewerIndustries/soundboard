/**
 * /api/auth/* — invite-only accounts: login/logout/me, forgot + reset password,
 * accept invite, change password, and admin user management.
 * Shape is shared with music-kiosk — keep the two in step.
 */
import type { Env } from "./env";
import {
  clearCookie, createSession, hashPassword, INVITE_TTL_MS, MIN_PASSWORD,
  isRateLimited, publicUser, randomToken, recordHits, RESET_TTL_MS, tokenId, verifyPassword,
  type Auth, type User,
} from "./auth";
import { sendLinkEmail } from "./email";

type Json = Record<string, unknown>;

const json = (data: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });
const err = (error: string, status: number) => json({ error }, status);

async function body(req: Request): Promise<Json> {
  try {
    const v = await req.json();
    return v && typeof v === "object" ? (v as Json) : {};
  } catch {
    return {};
  }
}
const s = (v: unknown) => (typeof v === "string" ? v : "");
const normEmail = (v: unknown) => s(v).trim().toLowerCase();
const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;
const ROLES = ["admin", "member"] as const;
const FORGOT_MSG = "If that email has an account, a reset link is on its way.";

/** First run: create the bootstrap admin (no password → use "Forgot password"). */
async function ensureBootstrap(env: Env): Promise<void> {
  const email = normEmail(env.BOOTSTRAP_ADMIN_EMAIL);
  if (!email) return;
  await env.DB.prepare(
    `INSERT INTO users (id,email,name,role,created_at)
     SELECT ?, ?, 'Admin', 'admin', ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
  ).bind(crypto.randomUUID(), email, Date.now()).run();
}

const userById = (env: Env, id: string) => env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first<User>();
const userByEmail = (env: Env, email: string) =>
  env.DB.prepare(`SELECT * FROM users WHERE email = ?`).bind(email).first<User>();

/** Issue a single-use link token (invalidates older unused ones of the same purpose). */
async function issueLink(env: Env, req: Request, user: User, purpose: "invite" | "reset"): Promise<string> {
  const token = randomToken();
  const ttl = purpose === "invite" ? INVITE_TTL_MS : RESET_TTL_MS;
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM auth_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL`).bind(user.id, purpose),
    env.DB.prepare(`INSERT INTO auth_tokens (id,user_id,purpose,expires_at) VALUES (?,?,?,?)`)
      .bind(await tokenId(env, token), user.id, purpose, Date.now() + ttl),
  ]);
  return `${new URL(req.url).origin}/${purpose}?token=${encodeURIComponent(token)}`;
}

async function sendInvite(env: Env, req: Request, user: User) {
  const link = await issueLink(env, req, user, "invite");
  const emailed = await sendLinkEmail(env, {
    to: user.email,
    subject: "You're invited to Soundboard",
    intro: `Hi ${user.name || "there"} — you've been invited to the Soundboard. Pick a password to get started.`,
    cta: "Set your password",
    link,
    note: "This link works once and expires in 7 days.",
  });
  // Email not configured / failed → hand the link to the admin instead.
  return emailed ? { emailed } : { emailed, link };
}

/** Look up a live, unused link token. */
async function liveLink(env: Env, token: string) {
  if (!token || token.length > 128) return null;
  const id = await tokenId(env, token);
  const row = await env.DB.prepare(
    `SELECT t.id AS token_id, t.purpose, u.* FROM auth_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.id = ? AND t.used_at IS NULL AND t.expires_at > ? AND u.disabled = 0`,
  ).bind(id, Date.now()).first<User & { token_id: string; purpose: "invite" | "reset" }>();
  return row;
}

/** Remaining enabled admins other than `exceptId`. */
async function otherAdmins(env: Env, exceptId: string): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?`)
    .bind(exceptId).first<{ n: number }>();
  return r?.n ?? 0;
}

const clientIp = (req: Request) => req.headers.get("cf-connecting-ip") ?? "unknown";

// --- public endpoints -----------------------------------------------------------

async function login(req: Request, env: Env): Promise<Response> {
  await ensureBootstrap(env);
  const data = await body(req);
  const email = normEmail(data.email);
  const password = s(data.password);
  // Only failed attempts count, so devices sharing one IP don't lock each other out.
  const keys = [`login:ip:${clientIp(req)}`, `login:email:${email}`];
  if (await isRateLimited(env, keys)) return err("Too many attempts — try again in 15 minutes.", 429);
  const user = email ? await userByEmail(env, email) : null;
  const ok = await verifyPassword(password, user?.password_hash ?? "", user?.salt ?? "");
  if (!user || !ok || user.disabled) {
    await recordHits(env, keys);
    return err("Wrong email or password.", 401);
  }
  return json({ user: publicUser(user) }, 200, { "set-cookie": await createSession(env, user.id) });
}

async function forgot(req: Request, env: Env): Promise<Response> {
  await ensureBootstrap(env);
  const email = normEmail((await body(req)).email);
  const keys = [`forgot:ip:${clientIp(req)}`, `forgot:email:${email}`];
  if (await isRateLimited(env, keys)) return err("Too many attempts — try again in 15 minutes.", 429);
  await recordHits(env, keys);
  const user = validEmail(email) ? await userByEmail(env, email) : null;
  if (user && !user.disabled) {
    const link = await issueLink(env, req, user, "reset");
    await sendLinkEmail(env, {
      to: user.email,
      subject: "Reset your Soundboard password",
      intro: "Someone (hopefully you) asked to reset your Soundboard password.",
      cta: "Choose a new password",
      link,
      note: "This link works once and expires in 1 hour. If you didn't ask for it, ignore this email.",
    });
  }
  return json({ ok: true, message: FORGOT_MSG });
}

/** Redeem an invite or reset link: set the password, revoke all sessions, log in. */
async function redeem(req: Request, env: Env, purpose: "invite" | "reset"): Promise<Response> {
  const data = await body(req);
  const password = s(data.password);
  if (password.length < MIN_PASSWORD) return err(`Password must be at least ${MIN_PASSWORD} characters.`, 400);
  const row = await liveLink(env, s(data.token));
  if (!row || row.purpose !== purpose) return err("This link is invalid or has expired.", 400);
  const { hash, salt } = await hashPassword(password);
  const now = Date.now();
  const res = await env.DB.batch([
    env.DB.prepare(`UPDATE auth_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL`).bind(now, row.token_id),
    env.DB.prepare(`UPDATE users SET password_hash = ?, salt = ? WHERE id = ?`).bind(hash, salt, row.id),
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(row.id),
    env.DB.prepare(`DELETE FROM auth_tokens WHERE user_id = ? AND used_at IS NULL`).bind(row.id),
  ]);
  if (!res[0].meta.changes) return err("This link is invalid or has expired.", 400);
  const user = (await userById(env, row.id))!;
  return json({ user: publicUser(user) }, 200, { "set-cookie": await createSession(env, user.id) });
}

/** GET /api/auth/link?token= — who a link is for (so the page can greet them). */
async function linkInfo(url: URL, env: Env): Promise<Response> {
  const row = await liveLink(env, url.searchParams.get("token") ?? "");
  if (!row) return err("This link is invalid or has expired.", 400);
  return json({ purpose: row.purpose, email: row.email, name: row.name });
}

// --- signed-in endpoints ----------------------------------------------------------

async function changePassword(req: Request, env: Env, auth: Extract<Auth, { kind: "session" }>): Promise<Response> {
  const data = await body(req);
  const next = s(data.password);
  if (next.length < MIN_PASSWORD) return err(`Password must be at least ${MIN_PASSWORD} characters.`, 400);
  if (!(await verifyPassword(s(data.current), auth.user.password_hash, auth.user.salt))) {
    return err("Current password is wrong.", 400);
  }
  const { hash, salt } = await hashPassword(next);
  await env.DB.batch([
    env.DB.prepare(`UPDATE users SET password_hash = ?, salt = ? WHERE id = ?`).bind(hash, salt, auth.user.id),
    // Sign out every other device; keep this one.
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ? AND id != ?`).bind(auth.user.id, auth.sessionId),
  ]);
  return json({ ok: true });
}

async function admin(req: Request, env: Env, parts: string[], method: string): Promise<Response> {
  const [, , , id, action] = parts; // ["api","auth","users",id?,action?]

  if (!id && method === "GET") {
    await ensureBootstrap(env); // so a bearer listing on a fresh deploy shows the admin to invite
    const { results } = await env.DB.prepare(`SELECT * FROM users ORDER BY created_at`).all<User>();
    return json({ users: results.map(publicUser) });
  }

  if (!id && method === "POST") {
    const data = await body(req);
    const email = normEmail(data.email);
    const name = s(data.name).trim().slice(0, 100);
    const role = s(data.role) || "member";
    if (!validEmail(email)) return err("Enter a valid email.", 400);
    if (!(ROLES as readonly string[]).includes(role)) return err("Role must be admin or member.", 400);
    if (await userByEmail(env, email)) return err("That email already has an account.", 409);
    const user: User = {
      id: crypto.randomUUID(), email, name, role: role as User["role"], disabled: 0,
      created_at: Date.now(), password_hash: "", salt: "",
    };
    await env.DB.prepare(`INSERT INTO users (id,email,name,role,created_at) VALUES (?,?,?,?,?)`)
      .bind(user.id, user.email, user.name, user.role, user.created_at).run();
    return json({ user: publicUser(user), ...(await sendInvite(env, req, user)) }, 201);
  }

  const user = id ? await userById(env, id) : null;
  if (!user) return err("not found", 404);

  if (action === "resend" && method === "POST") {
    if (user.password_hash) return err("This user already set a password — they can use “Forgot password”.", 409);
    if (user.disabled) return err("Enable the user first.", 409);
    return json({ ok: true, ...(await sendInvite(env, req, user)) });
  }

  if (!action && method === "PATCH") {
    const data = await body(req);
    const role = data.role !== undefined ? s(data.role) : user.role;
    const disabled = data.disabled !== undefined ? (data.disabled ? 1 : 0) : user.disabled;
    const name = data.name !== undefined ? s(data.name).trim().slice(0, 100) : user.name;
    if (!(ROLES as readonly string[]).includes(role)) return err("Role must be admin or member.", 400);
    const losesAdmin = user.role === "admin" && !user.disabled && (role !== "admin" || disabled);
    if (losesAdmin && (await otherAdmins(env, user.id)) === 0) return err("Can't demote or disable the last admin.", 409);
    await env.DB.batch([
      env.DB.prepare(`UPDATE users SET role = ?, disabled = ?, name = ? WHERE id = ?`).bind(role, disabled, name, user.id),
      ...(disabled ? [env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(user.id)] : []),
    ]);
    return json({ user: publicUser({ ...user, role: role as User["role"], disabled, name }) });
  }

  if (!action && method === "DELETE") {
    if (user.role === "admin" && !user.disabled && (await otherAdmins(env, user.id)) === 0) {
      return err("Can't delete the last admin.", 409);
    }
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(user.id),
      env.DB.prepare(`DELETE FROM auth_tokens WHERE user_id = ?`).bind(user.id),
      env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(user.id),
    ]);
    return json({ ok: true });
  }

  return err("not found", 404);
}

/** Cookie-authed writes must come from our own origin (defence-in-depth on top of SameSite=Lax). */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  return !origin || origin === new URL(req.url).origin;
}

/** Route /api/auth/*. `auth` is the already-resolved caller (or null). */
export async function authRoutes(req: Request, env: Env, url: URL, auth: Auth | null): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean); // ["api","auth",...]
  const route = parts[2] ?? "";
  const method = req.method.toUpperCase();

  if (method !== "GET" && !sameOrigin(req)) return err("cross-origin request refused", 403);

  // public
  if (route === "login" && method === "POST") return login(req, env);
  if (route === "forgot" && method === "POST") return forgot(req, env);
  if (route === "reset" && method === "POST") return redeem(req, env, "reset");
  if (route === "accept-invite" && method === "POST") return redeem(req, env, "invite");
  if (route === "link" && method === "GET") return linkInfo(url, env);
  if (route === "logout" && method === "POST") {
    if (auth?.kind === "session") await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(auth.sessionId).run();
    return json({ ok: true }, 200, { "set-cookie": clearCookie() });
  }

  if (!auth) return err("unauthorized", 401);

  if (route === "me" && method === "GET") {
    const env_ = (env.JARVIS_ENV ?? "").trim().toLowerCase();
    const label = !env_ || ["main", "prod", "production"].includes(env_) ? null : env_.toUpperCase();
    return json({ user: auth.kind === "session" ? publicUser(auth.user) : null, token: auth.kind === "token", env: label });
  }
  if (route === "password" && method === "POST") {
    if (auth.kind !== "session") return err("sign in as a user to change a password", 400);
    return changePassword(req, env, auth);
  }
  if (route === "users") {
    // JARVIS_TOKEN counts as admin (recovery / scripted bootstrap).
    if (auth.kind === "session" && auth.user.role !== "admin") return err("admins only", 403);
    return admin(req, env, parts, method);
  }
  return err("not found", 404);
}
