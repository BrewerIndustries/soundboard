/**
 * Soundboard Worker: serves the static SPA (Workers Static Assets, dist/) and the
 * JSON API on the same origin, so the UI's relative /api/... fetches just work.
 *
 * Every request runs through this Worker first (assets.run_worker_first). Public:
 * /api/health, the /api/auth/* login/forgot/reset/invite endpoints, and the auth
 * pages (/login, /forgot, /reset, /invite). Everything else needs a user session
 * cookie or the JARVIS_TOKEN bearer (see auth.ts / accounts.ts).
 */
import type { Env } from "./env";
import { authenticate } from "./auth";
import { authRoutes, sameOrigin } from "./accounts";
import * as db from "./db";
import { deleteAudio, putAudio, serveAudio } from "./storage";
import { youtubeImport, youtubeInfo } from "./yt";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB per clip
const AUTH_PAGES = new Set(["/login", "/forgot", "/reset", "/invite"]);

const json = (data: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });
const err = (error: string, status: number) => json({ error }, status);

async function body(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = await req.json();
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function api(req: Request, env: Env, path: string, method: string): Promise<Response> {
  const parts = path.split("/").filter(Boolean); // ["api", resource, id?]
  const [, resource, id] = parts;

  if (resource === "boards" && !id) {
    if (method === "GET") return json({ boards: await db.listBoards(env.DB), tokenRequired: true });
    if (method === "POST") {
      const payload = await body(req);
      if (!payload) return err("invalid JSON body", 400);
      const board = await db.createBoard(env.DB, payload);
      return board ? json({ board }, 201) : err("a board needs a non-empty name", 400);
    }
  }

  if (resource === "pages" && !id && method === "POST") {
    const payload = await body(req);
    if (!payload) return err("invalid JSON body", 400);
    const page = await db.createPage(env.DB, payload);
    return page ? json({ page }, 201) : err("need a valid boardId and a non-empty name", 400);
  }

  if (resource === "sounds" && !id && method === "POST") return upload(req, env);

  // YouTube → pad import (container-backed). `/api/youtube/info` looks a video up,
  // `/api/youtube` pulls the clip and creates the pad. See worker/yt.ts.
  if (resource === "youtube" && id === "info" && method === "POST") return youtubeInfo(req, env);
  if (resource === "youtube" && !id && method === "POST") return youtubeImport(req, env);

  if (id && (resource === "boards" || resource === "pages" || resource === "sounds")) {
    if (method === "PATCH") {
      const patch = await body(req);
      if (!patch) return err("invalid JSON body", 400);
      const ok =
        resource === "boards" ? await db.updateBoard(env.DB, id, patch)
        : resource === "pages" ? await db.updatePage(env.DB, id, patch)
        : await db.updateSound(env.DB, id, patch);
      return ok ? json({ ok: true }) : err("not found", 404);
    }
    if (method === "DELETE") {
      if (resource === "sounds") {
        const key = await db.deleteSound(env.DB, id);
        if (key === null) return err("not found", 404);
        await deleteAudio(env, [key]);
        return json({ ok: true });
      }
      const keys = resource === "boards" ? await db.deleteBoard(env.DB, id) : await db.deletePage(env.DB, id);
      if (keys === null) return err("not found", 404);
      await deleteAudio(env, keys);
      return json({ ok: true, removedSounds: keys.length });
    }
  }

  if (resource === "audio" && id && (method === "GET" || method === "HEAD")) {
    return serveAudio(env, req, decodeURIComponent(id));
  }

  return err("not found", 404);
}

async function upload(req: Request, env: Env): Promise<Response> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES + 1024 * 1024) return err("clip too large (max 25 MB)", 413);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return err("expected multipart/form-data", 400);
  }
  const file = form.get("file");
  const pageId = String(form.get("pageId") ?? "").trim();
  const label = String(form.get("label") ?? "").trim();
  const accent = form.get("accent");

  if (!file || typeof file === "string") return err("missing file", 400);
  if (!pageId) return err("missing pageId", 400);
  const mime = file.type || "application/octet-stream";
  if (!mime.startsWith("audio/")) return err("file must be an audio clip", 415);
  if (file.size > MAX_BYTES) return err("clip too large (max 25 MB)", 413);

  const key = await putAudio(env, await file.arrayBuffer(), mime);
  const sound = await db.createSound(env.DB, {
    pageId, label: label || file.name.replace(/\.[^.]+$/, ""), accent,
    key, filename: file.name, mime, size: file.size,
  });
  if (!sound) {
    await deleteAudio(env, [key]); // page vanished — don't orphan bytes
    return err("page not found", 404);
  }
  return json({ sound }, 201);
}

/** Append a refreshed session cookie (rolling expiry) to a response. */
function withCookie(res: Response, cookie?: string): Response {
  if (!cookie) return res;
  const out = new Response(res.body, res);
  out.headers.append("set-cookie", cookie);
  return out;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();

    if (path === "/api/health") return json({ ok: true });
    if (AUTH_PAGES.has(path) || path === "/auth" || path === "/auth.html") {
      // One static page renders all four flows (html_handling maps /auth → auth.html).
      return env.ASSETS.fetch(new Request(new URL("/auth", url), { method: "GET" }));
    }

    const auth = await authenticate(req, env);
    const cookie = auth?.kind === "session" ? auth.setCookie : undefined;

    if (path.startsWith("/api/auth/")) {
      try {
        return withCookie(await authRoutes(req, env, url, auth), cookie);
      } catch (e) {
        console.error("auth error", path, e);
        return err("internal error", 500);
      }
    }

    if (path.startsWith("/api/")) {
      if (!auth) return err("unauthorized", 401);
      if (auth.kind === "session" && method !== "GET" && method !== "HEAD" && !sameOrigin(req)) {
        return err("cross-origin request refused", 403);
      }
      try {
        return withCookie(await api(req, env, path, method), cookie);
      } catch (e) {
        console.error("api error", path, e);
        return err("internal error", 500);
      }
    }

    if (!auth) {
      if (method !== "GET" && method !== "HEAD") return err("unauthorized", 401);
      const next = path + url.search;
      return Response.redirect(new URL(`/login?next=${encodeURIComponent(next)}`, url).toString(), 302);
    }
    return withCookie(await env.ASSETS.fetch(req), cookie);
  },
} satisfies ExportedHandler<Env>;

// Durable Object that owns the YouTube extractor container (see worker/yt.ts).
// Wrangler resolves the class from the Worker entry's exports.
export { YtContainer } from "./yt";
