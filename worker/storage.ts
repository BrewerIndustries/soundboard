/**
 * Audio bytes live in a private R2 bucket (one per env). The DB stores only the
 * object `key` ("<uuid>.<ext>"); bytes are served via GET /api/audio/<key>.
 */
import type { Env } from "./env";

const EXT_BY_MIME: Record<string, string> = {
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav",
  "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/x-m4a": "m4a",
  "audio/aac": "aac", "audio/flac": "flac",
};
const MIME_BY_EXT: Record<string, string> = {
  mp3: "audio/mpeg", wav: "audio/wav", webm: "audio/webm", ogg: "audio/ogg",
  m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac",
};

export const extForMime = (mime: string) => EXT_BY_MIME[mime] ?? "bin";

/** Best-guess content type from a storage key's extension (same rule as the old server). */
export function contentTypeForKey(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** A storage key is always "<uuid>.<ext>"; reject anything else. */
export const isSafeKey = (key: string) => /^[a-f0-9-]{36}\.[a-z0-9]{1,5}$/i.test(key);

export async function putAudio(env: Env, body: ArrayBuffer, mime: string): Promise<string> {
  const key = `${crypto.randomUUID()}.${extForMime(mime)}`;
  await env.AUDIO.put(key, body, { httpMetadata: { contentType: contentTypeForKey(key) } });
  return key;
}

export async function deleteAudio(env: Env, keys: string[]): Promise<void> {
  const safe = keys.filter(isSafeKey);
  if (safe.length) await env.AUDIO.delete(safe);
}

const AUDIO_HEADERS = { "accept-ranges": "bytes", "cache-control": "private, max-age=31536000, immutable" };

/** `Content-Disposition: attachment` filename from the pad label, ASCII + RFC 5987. */
function attachmentName(label: string, key: string): string {
  const ext = key.split(".").pop() ?? "mp3";
  const printable = [...label].filter((ch) => ch.charCodeAt(0) >= 32).join("");
  const base =
    printable
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "sound";
  const ascii = base.replace(/[^\x20-\x7e]/g, "").trim() || "sound";
  return `attachment; filename="${ascii}.${ext}"; filename*=UTF-8''${encodeURIComponent(`${base}.${ext}`).replace(/'/g, "%27")}`;
}

/** GET /api/audio/<key> — R2 bytes with single-range (206) support for Safari/iOS. */
export async function serveAudio(env: Env, req: Request, key: string): Promise<Response> {
  if (!isSafeKey(key)) return Response.json({ error: "not found" }, { status: 404 });
  const type = contentTypeForKey(key);
  const head = await env.AUDIO.head(key);
  if (!head) return Response.json({ error: "not found" }, { status: 404 });
  const total = head.size;

  // ?download=1 → attachment named after the pad, for the pad's ⬇ button.
  let extra: Record<string, string> = {};
  if (new URL(req.url).searchParams.has("download")) {
    const row = await env.DB.prepare(`SELECT label, filename FROM sounds WHERE key = ?`)
      .bind(key)
      .first<{ label: string; filename: string }>();
    const label = row?.label || row?.filename?.replace(/\.[^.]+$/, "") || "sound";
    extra = { "content-disposition": attachmentName(label, key) };
  }

  const range = req.headers.get("range");
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m && (m[1] || m[2])) {
    let start: number, end: number;
    if (!m[1]) {
      // suffix range: last N bytes
      const n = parseInt(m[2], 10);
      start = Math.max(0, total - n);
      end = total - 1;
    } else {
      start = parseInt(m[1], 10);
      end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
    }
    if (start > end || start >= total) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${total}` } });
    }
    const obj = await env.AUDIO.get(key, { range: { offset: start, length: end - start + 1 } });
    if (!obj) return Response.json({ error: "not found" }, { status: 404 });
    return new Response(obj.body, {
      status: 206,
      headers: {
        ...AUDIO_HEADERS,
        ...extra,
        "content-type": type,
        "content-length": String(end - start + 1),
        "content-range": `bytes ${start}-${end}/${total}`,
        etag: head.httpEtag,
      },
    });
  }

  const obj = await env.AUDIO.get(key);
  if (!obj) return Response.json({ error: "not found" }, { status: 404 });
  return new Response(obj.body, {
    status: 200,
    headers: { ...AUDIO_HEADERS, ...extra, "content-type": type, "content-length": String(total), etag: head.httpEtag },
  });
}
