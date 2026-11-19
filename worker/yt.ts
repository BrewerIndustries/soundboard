/**
 * YouTube → pad import.
 *
 * Workers can't run yt-dlp, so the extraction lives in a Cloudflare Container
 * (container/Dockerfile + container/service.mjs). `YtContainer` is the Durable
 * Object that starts that container, waits for its HTTP server, and forwards
 * requests to it. The Worker routes below keep the container private: only an
 * authenticated caller can reach it, and only with a YouTube URL.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { createSound } from "./db";
import { deleteAudio, putAudio } from "./storage";

const PORT = 8080;
const INACTIVITY_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_BYTES = 25 * 1024 * 1024;
/** Two warm extractors so two people can pull at once without queueing. */
const POOL = 2;

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "cache-control": "no-store" } });

export class YtContainer extends DurableObject<Env> {
  private starting: Promise<void> | undefined;
  private monitoring: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running) {
      // Restore the timeout and exit monitoring after a DO restart.
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
      this.observeExit();
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.ctx.container) return json({ error: "containers are not enabled on this deployment" }, 503);

    this.starting ??= this.startAndWaitForPort().finally(() => {
      this.starting = undefined;
    });
    await this.starting;

    const url = new URL(request.url);
    url.protocol = "http:";
    url.host = "container";
    const forwarded = new Request(url, request);
    forwarded.headers.delete("host");
    return this.ctx.container.getTcpPort(PORT).fetch(forwarded);
  }

  private async startAndWaitForPort(): Promise<void> {
    const container = this.ctx.container!;
    if (!container.running) {
      container.start({
        image: container.images.yt,
        instance: "basic",
        enableInternet: true,
        env: {
          // Optional escape hatches, both set as Worker secrets.
          ...(this.env.YTDLP_PROXY ? { YTDLP_PROXY: this.env.YTDLP_PROXY } : {}),
          ...(this.env.YTDLP_COOKIES ? { YTDLP_COOKIES: this.env.YTDLP_COOKIES } : {}),
        },
      });
    }
    this.observeExit();
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);

    // `running` means startup was requested, not that the server is listening.
    const port = container.getTcpPort(PORT);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await port.fetch("http://container/health", { signal: AbortSignal.timeout(1000) });
        await response.body?.cancel();
        if (response.ok) return;
      } catch {
        // Port not listening yet — retry the probe only.
      }
      await scheduler.wait(200);
    }
    throw new Error("container did not become ready on port 8080");
  }

  private observeExit(): void {
    if (this.monitoring) return;
    this.monitoring = this.ctx
      .container!.monitor()
      .then(() => console.log("yt container exited"))
      .catch((error: unknown) => console.error("yt container failed:", error))
      .finally(() => {
        this.monitoring = undefined;
      });
    this.ctx.waitUntil(this.monitoring);
  }
}

async function callContainer(env: Env, path: string, payload: unknown): Promise<Response> {
  const name = `pool-${Math.floor(Math.random() * POOL)}`;
  return env.YT.getByName(name).fetch(`https://yt.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

const numOrUndefined = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** POST /api/youtube/info — look up a video's title + duration for the dialog. */
export async function youtubeInfo(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const url = typeof body?.url === "string" ? body.url : "";
  if (!url) return json({ error: "missing youtube url" }, 400);

  let res: Response;
  try {
    res = await callContainer(env, "/info", { url });
  } catch (e) {
    console.error("yt info failed", e);
    return json({ error: "the extractor did not start — try again in a minute" }, 503);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) return json({ error: data.error ?? data.message ?? "could not read that video" }, res.status);
  return json(data);
}

/** POST /api/youtube — pull a clip and create the pad in one step. */
export async function youtubeImport(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ error: "invalid JSON body" }, 400);

  const url = typeof body.url === "string" ? body.url.trim() : "";
  const pageId = typeof body.pageId === "string" ? body.pageId.trim() : "";
  if (!url || !pageId) return json({ error: "need a youtube url and a pageId" }, 400);

  let res: Response;
  try {
    res = await callContainer(env, "/clip", {
      url,
      start: numOrUndefined(body.start),
      end: numOrUndefined(body.end),
    });
  } catch (e) {
    console.error("yt clip failed", e);
    return json({ error: "the extractor did not start — try again in a minute" }, 503);
  }

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const status = res.status >= 400 && res.status < 500 ? res.status : 502;
    return json({ error: data.error ?? data.message ?? "could not pull that clip" }, status);
  }

  const bytes = await res.arrayBuffer();
  if (!bytes.byteLength) return json({ error: "the extractor returned an empty clip" }, 502);
  if (bytes.byteLength > MAX_BYTES) return json({ error: "clip too large (max 25 MB)" }, 413);

  let title = "";
  try {
    title = decodeURIComponent(res.headers.get("x-video-title") ?? "");
  } catch {
    /* keep the fallback */
  }
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : title || "YouTube clip";

  const key = await putAudio(env, bytes, "audio/mpeg");
  const sound = await createSound(env.DB, {
    pageId,
    label,
    accent: body.accent,
    key,
    filename: `${title || "youtube-clip"}.mp3`,
    mime: "audio/mpeg",
    size: bytes.byteLength,
  });
  if (!sound) {
    await deleteAudio(env, [key]); // page vanished — don't orphan bytes
    return json({ error: "page not found" }, 404);
  }
  return json({ sound }, 201);
}
