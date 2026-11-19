/**
 * YouTube → audio clip service (runs inside the Cloudflare Container).
 *
 * Two jobs, both driven by yt-dlp + ffmpeg:
 *   POST /info  { url }                     → video title / duration / uploader
 *   POST /clip  { url, start?, end? }        → audio/mpeg bytes, trimmed to [start,end]
 *
 * It is only reachable through the Worker's Durable Object, never from the public
 * internet, so it does its own URL allow-listing and size/time caps and nothing else.
 */
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 8080);
const YTDLP = process.env.YTDLP_PATH ?? "yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";

/** Longest clip we will ever hand back (the pads are 1–30s in practice). */
const MAX_CLIP_SECONDS = 600;
const MAX_BYTES = 20 * 1024 * 1024;
const YTDLP_TIMEOUT_MS = 90_000;
const FFMPEG_TIMEOUT_MS = 90_000;
const INFO_TIMEOUT_MS = 45_000;
const MAX_CONCURRENT = 2;

const ALLOWED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

const EXTRA_ARGS = (process.env.YTDLP_EXTRA_ARGS ?? "").split(/\s+/).filter(Boolean);
const COOKIES_FILE = "/tmp/yt-cookies.txt";
let cookiesReady = false;

if (process.env.YTDLP_COOKIES) {
  // Escape hatch for YouTube bot checks: a cookies.txt for a throwaway account.
  await writeFile(COOKIES_FILE, process.env.YTDLP_COOKIES, "utf8").catch((e) =>
    console.error("could not write cookies file", e),
  );
  cookiesReady = true;
}

/** Only plain YouTube watch/shorts/live URLs — nothing else may reach yt-dlp. */
function videoUrl(raw) {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) return null;
  return u.toString();
}

function baseArgs() {
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--no-color",
    "--socket-timeout",
    "20",
    "--retries",
    "3",
    // yt-dlp needs a JS runtime to solve YouTube's challenge scripts.
    "--js-runtimes",
    "node",
  ];
  if (process.env.YTDLP_PROXY) args.push("--proxy", process.env.YTDLP_PROXY);
  if (cookiesReady) args.push("--cookies", COOKIES_FILE);
  return args.concat(EXTRA_ARGS);
}

/** Run a command to completion (or timeout) and collect its output. */
function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      if (stdout.length < 4_000_000) stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < 40_000) stderr += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${e.message}`, killed });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, killed });
    });
  });
}

const tail = (s, n = 1200) => (s.length > n ? s.slice(-n) : s).trim();

function json(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    ...headers,
  });
  res.end(data);
}

async function readJson(req, limit = 8 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function videoInfo(url) {
  const r = await run(YTDLP, [...baseArgs(), "-J", "--skip-download", url], INFO_TIMEOUT_MS);
  if (r.code !== 0) return { error: ytError(r) };
  let data;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    return { error: { message: "yt-dlp returned unreadable metadata", detail: tail(r.stdout) } };
  }
  const entry = Array.isArray(data.entries) ? data.entries[0] : data;
  if (!entry) return { error: { message: "no video found at that URL" } };
  return {
    info: {
      id: entry.id,
      title: entry.title ?? "",
      uploader: entry.uploader ?? entry.channel ?? "",
      duration: Number(entry.duration) || 0,
      thumbnail: entry.thumbnail ?? "",
      webpage_url: entry.webpage_url ?? url,
    },
  };
}

/** Turn a yt-dlp failure into something a person can act on. */
function ytError(r) {
  const s = `${r.stderr}\n${r.stdout}`.toLowerCase();
  if (r.killed) return { message: "YouTube took too long to respond — try a shorter video." };
  if (s.includes("sign in to confirm") || s.includes("not a bot"))
    return { message: "YouTube wants a sign-in for this server's IP. Add a cookies file (YTDLP_COOKIES) to the Worker secrets." };
  if (s.includes("video unavailable") || s.includes("private video") || s.includes("removed"))
    return { message: "That video is unavailable (private, removed, or region-locked)." };
  if (s.includes("unsupported url") || s.includes("is not a valid url"))
    return { message: "That does not look like a YouTube video link." };
  if (s.includes("requested format is not available"))
    return { message: "No audio-only format is available for that video." };
  return { message: "Could not pull audio from that video.", detail: tail(r.stderr) };
}

async function makeClip(url, start, end) {
  const dir = await mkdtemp(join(tmpdir(), "ytcl-"));
  try {
    const dl = await run(
      YTDLP,
      [...baseArgs(), "--write-info-json", "-f", "bestaudio/best", "-o", join(dir, "src.%(ext)s"), url],
      YTDLP_TIMEOUT_MS,
    );
    if (dl.code !== 0) return { error: ytError(dl) };

    let meta = {};
    try {
      meta = JSON.parse(await readFile(join(dir, "src.info.json"), "utf8"));
    } catch {
      /* metadata is a nicety; the clip still works without it */
    }

    const files = (await readdir(dir)).filter(
      (f) => f.startsWith("src.") && !f.endsWith(".info.json") && !f.endsWith(".part"),
    );
    if (!files.length) return { error: { message: "yt-dlp downloaded nothing", detail: tail(dl.stderr) } };
    const src = join(dir, files[0]);

    const from = Math.max(0, Number(start) || 0);
    const to = Number(end) > 0 ? Number(end) : 0;
    if (to && to <= from) return { error: { message: "The end time is before the start time." } };
    if (from > 3600 * 6) return { error: { message: "That start time is past the end of the video." } };

    // Trim to the requested range, clamp to the clip cap, and stop at the end of
    // the video so the reported length matches the file.
    const total = Number(meta.duration) || 0;
    const wanted = to ? to - from : total > 0 ? total - from : MAX_CLIP_SECONDS;
    if (wanted <= 0) return { error: { message: "That start time is past the end of the video." } };
    const length = Math.min(wanted, MAX_CLIP_SECONDS);

    const out = join(dir, "clip.mp3");
    const args = ["-nostdin", "-hide_banner", "-loglevel", "error"];
    if (from > 0) args.push("-ss", String(from));
    args.push("-i", src, "-t", String(length), "-vn");
    args.push("-acodec", "libmp3lame", "-b:a", "192k", "-ar", "44100", "-ac", "2", out);

    const ff = await run(FFMPEG, args, FFMPEG_TIMEOUT_MS);
    if (ff.code !== 0) return { error: { message: "Could not convert the audio to mp3.", detail: tail(ff.stderr) } };

    const info = await stat(out);
    if (info.size === 0) return { error: { message: "The clip came out empty — check the start/end times." } };
    if (info.size > MAX_BYTES) return { error: { message: "That clip is too big (max 20 MB) — try a shorter range." } };
    return {
      path: out,
      size: info.size,
      from,
      length,
      dir,
      title: typeof meta.title === "string" ? meta.title : "",
      duration: Number(meta.duration) || 0,
    };
  } catch (e) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

let active = 0;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://container");

  if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });

  if (req.method !== "POST" || (url.pathname !== "/info" && url.pathname !== "/clip")) {
    return json(res, 404, { error: "not found" });
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    return json(res, 400, { error: "invalid JSON body" });
  }

  const target = videoUrl(body.url);
  if (!target) return json(res, 400, { error: "only YouTube video links are supported" });

  if (url.pathname === "/info") {
    const { info, error } = await videoInfo(target);
    if (error) return json(res, 422, error);
    return json(res, 200, info);
  }

  if (active >= MAX_CONCURRENT)
    return json(res, 429, { error: "busy — another clip is downloading, try again in a moment" });
  active++;
  let released = false;
  let streaming = false;
  const release = () => {
    if (released) return;
    released = true;
    active = Math.max(0, active - 1);
  };
  try {
    const clip = await makeClip(target, body.start, body.end);
    if (clip.error) return json(res, 422, clip.error);

    res.writeHead(200, {
      "content-type": "audio/mpeg",
      "content-length": clip.size,
      "x-video-title": encodeURIComponent(clip.title),
      "x-video-duration": String(clip.duration),
      "x-clip-start": String(clip.from),
      "x-clip-length": String(Math.round(clip.length)),
      "cache-control": "no-store",
    });
    const stream = createReadStream(clip.path);
    streaming = true;
    stream.pipe(res);
    const cleanup = () => {
      release();
      rm(clip.dir, { recursive: true, force: true }).catch(() => {});
    };
    res.on("close", cleanup);
    stream.on("error", (e) => {
      console.error("stream error", e);
      res.destroy();
      cleanup();
    });
  } catch (e) {
    console.error("clip failed", e);
    if (!res.headersSent) json(res, 500, { error: "clip generation failed" });
  } finally {
    // Early-exit paths release here; once streaming, the response's close handler does.
    if (!streaming) release();
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`yt-clip service listening on :${PORT}`));
