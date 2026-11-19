#!/usr/bin/env node
/**
 * Verify migrated audio byte-for-byte through the deployed API.
 *
 *   JARVIS_TOKEN=... node scripts/verify-audio.mjs https://soundboard-dev.dabrewer.dev [.migrate-cache/prod/manifest.json]
 *
 * For each manifest entry: full GET → sha256 + size + content-type must match;
 * then a Range request (bytes=0-1023 or smaller) must return 206 with the right
 * Content-Range and the same leading bytes.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [base, manifestPath = ".migrate-cache/prod/manifest.json"] = process.argv.slice(2);
const token = process.env.JARVIS_TOKEN;
if (!base || !token) {
  console.error("usage: JARVIS_TOKEN=... verify-audio.mjs <base-url> [manifest.json]");
  process.exit(2);
}
const auth = { authorization: `Bearer ${token}` };
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
let failed = 0;
for (const m of manifest) {
  const url = `${base}/api/audio/${m.key}`;
  const full = await fetch(url, { headers: auth });
  const buf = Buffer.from(await full.arrayBuffer());
  const sha = createHash("sha256").update(buf).digest("hex");
  const okFull = full.status === 200 && buf.length === m.size && sha === m.sha256 && full.headers.get("content-type") === m.type;

  const end = Math.min(1023, m.size - 1);
  const part = await fetch(url, { headers: { ...auth, range: `bytes=0-${end}` } });
  const pbuf = Buffer.from(await part.arrayBuffer());
  const okRange =
    part.status === 206 &&
    part.headers.get("content-range") === `bytes 0-${end}/${m.size}` &&
    pbuf.equals(buf.subarray(0, end + 1));

  console.log(`${okFull && okRange ? "OK  " : "FAIL"} ${m.key} ${m.size}B sha256=${sha.slice(0, 12)}… full=${full.status} range=${part.status} ${full.headers.get("content-type")}`);
  if (!okFull || !okRange) failed++;
}
console.log(failed ? `${failed} failure(s)` : `all ${manifest.length} verified`);
process.exit(failed ? 1 : 0);
