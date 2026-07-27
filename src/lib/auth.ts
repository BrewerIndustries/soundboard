import { NextRequest } from "next/server";

/**
 * Writes (create/edit/delete boards, pages, sounds; audio uploads) require a
 * shared secret. Accepts either:
 *   Authorization: Bearer <token>
 *   x-jarvis-token: <token>
 * If JARVIS_TOKEN is unset, writes are open (fine for a trusted Tailscale-only
 * box, but the UI warns you about it). Reads + playback are always open.
 */
export function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.JARVIS_TOKEN;
  if (!expected) return true;

  const bearer = req.headers.get("authorization");
  const fromBearer = bearer?.toLowerCase().startsWith("bearer ")
    ? bearer.slice(7).trim()
    : null;
  const provided = fromBearer ?? req.headers.get("x-jarvis-token");
  return provided === expected;
}

export const tokenIsConfigured = () => Boolean(process.env.JARVIS_TOKEN);
