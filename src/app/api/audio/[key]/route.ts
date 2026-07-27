import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { contentTypeForKey, statAudio } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ key: string }> };

// GET /api/audio/<key> — stream a sound's bytes from the server's disk. Reads are
// open (Tailscale-only box). Supports Range requests so browser <audio> seeking /
// Safari playback works. The key is validated (uuid.ext) to block path traversal.
export async function GET(req: NextRequest, ctx: Ctx) {
  const { key } = await ctx.params;
  const file = statAudio(decodeURIComponent(key));
  if (!file) return NextResponse.json({ error: "not found" }, { status: 404 });

  const type = contentTypeForKey(key);
  const buf = await readFile(file.path);
  const total = buf.length;

  const range = req.headers.get("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : total - 1;
      if (start > end || start >= total) {
        return new Response(null, {
          status: 416,
          headers: { "content-range": `bytes */${total}` },
        });
      }
      const slice = buf.subarray(start, end + 1);
      return new Response(slice, {
        status: 206,
        headers: {
          "content-type": type,
          "content-length": String(slice.length),
          "content-range": `bytes ${start}-${end}/${total}`,
          "accept-ranges": "bytes",
          "cache-control": "private, max-age=31536000, immutable",
        },
      });
    }
  }

  return new Response(buf, {
    status: 200,
    headers: {
      "content-type": type,
      "content-length": String(total),
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
