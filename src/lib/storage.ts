import { createReadStream, existsSync, mkdirSync, statSync } from "fs";
import { unlink, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { randomUUID } from "crypto";

/**
 * Audio bytes live on the jarvis server's own disk (Tailscale-only), NOT in any
 * cloud bucket. Each environment points at its own directory via
 * SOUNDBOARD_MEDIA_DIR, so dev + prod never share files. The DB only stores the
 * object `key` (the on-disk filename); bytes are served through /api/audio/<key>.
 */
const MEDIA_DIR =
  process.env.SOUNDBOARD_MEDIA_DIR ?? join(process.cwd(), "data", "sounds");

function ensureDir(): string {
  mkdirSync(MEDIA_DIR, { recursive: true });
  return MEDIA_DIR;
}

// Map a handful of common audio MIME types to file extensions for tidy keys.
const EXT_BY_MIME: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/flac": "flac",
};

export function extForMime(mime: string): string {
  return EXT_BY_MIME[mime] ?? "bin";
}

const MIME_BY_EXT: Record<string, string> = {
  mp3: "audio/mpeg", wav: "audio/wav", webm: "audio/webm", ogg: "audio/ogg",
  m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac",
};

/** Best-guess content type from a storage key's extension. */
export function contentTypeForKey(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** A storage key is always "<uuid>.<ext>" — reject anything else to block traversal. */
export function isSafeKey(key: string): boolean {
  return /^[a-f0-9-]{36}\.[a-z0-9]{1,5}$/i.test(key);
}

/** Persist audio bytes; returns the generated storage key. */
export async function putAudio(bytes: Buffer, mime: string): Promise<string> {
  const dir = ensureDir();
  const key = `${randomUUID()}.${extForMime(mime)}`;
  await writeFile(join(dir, key), bytes);
  return key;
}

export interface StoredFile {
  path: string;
  size: number;
}

/** Resolve a key to its on-disk file, or null if missing / unsafe. */
export function statAudio(key: string): StoredFile | null {
  if (!isSafeKey(key)) return null;
  const path = resolve(join(ensureDir(), key));
  if (!path.startsWith(resolve(MEDIA_DIR))) return null; // defence in depth
  if (!existsSync(path)) return null;
  return { path, size: statSync(path).size };
}

export function audioStream(path: string, start?: number, end?: number) {
  return createReadStream(path, start != null && end != null ? { start, end } : {});
}

/** Best-effort delete; a missing file is not an error. */
export async function deleteAudio(key: string): Promise<void> {
  if (!isSafeKey(key)) return;
  try {
    await unlink(join(MEDIA_DIR, key));
  } catch {
    /* already gone */
  }
}
