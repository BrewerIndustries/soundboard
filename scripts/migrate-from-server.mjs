#!/usr/bin/env node
/**
 * Copy the home server's Soundboard data (SQLite rows + audio files) into a
 * Cloudflare env's D1 + R2. Repeatable: the target's D1 rows are REPLACED with the
 * source's; audio objects are (re)uploaded under the same keys. Read-only on the server.
 *
 *   node scripts/migrate-from-server.mjs --to dev  --from prod    # dev mirrors real prod sounds
 *   node scripts/migrate-from-server.mjs --to prod --from prod    # cutover
 *
 * Flags:
 *   --to dev|prod        target Cloudflare env (required)
 *   --from prod|dev      source server checkout: /opt/soundboard or /opt/soundboard-dev (default prod)
 *   --host user@host     SSH target (default dan@100.102.159.57)
 *   --skip-audio         only replace D1 rows
 *   --dry-run            fetch + verify locally, write nothing to Cloudflare
 *
 * Needs: ssh access to the server, and wrangler logged in via OAuth. The shell's
 * CLOUDFLARE_API_TOKEN (DNS-scoped) is stripped for wrangler calls automatically.
 *
 * Orphans: R2 objects in the target that are no longer referenced are NOT deleted.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const to = opt("to");
const from = opt("from", "prod");
const host = opt("host", "dan@100.102.159.57");
const dryRun = flag("dry-run");
const skipAudio = flag("skip-audio");

if (!["dev", "prod"].includes(to) || !["dev", "prod"].includes(from)) {
  console.error("usage: migrate-from-server.mjs --to dev|prod [--from prod|dev] [--host u@h] [--skip-audio] [--dry-run]");
  process.exit(2);
}

const SRC_DIR = from === "prod" ? "/opt/soundboard" : "/opt/soundboard-dev";
const D1_NAME = to === "prod" ? "soundboard-prod" : "soundboard-dev";
const BUCKET = to === "prod" ? "soundboard-audio-prod" : "soundboard-audio-dev";
const ENV_ARGS = to === "prod" ? [] : ["--env", "dev"];

const root = resolve(import.meta.dirname, "..");
const cache = join(root, ".migrate-cache", from);
const audioDir = join(cache, "sounds");
mkdirSync(audioDir, { recursive: true });

const wranglerEnv = { ...process.env };
delete wranglerEnv.CLOUDFLARE_API_TOKEN;
const wrangler = (...a) =>
  execFileSync("npx", ["wrangler", ...a], { cwd: root, env: wranglerEnv, stdio: ["ignore", "pipe", "pipe"] }).toString();

// --- 1. dump rows from the server's SQLite (opened read-only; WAL-safe) --------
console.log(`→ reading ${host}:${SRC_DIR}`);
const remote = `
const fs = require("fs"), path = require("path");
const env = {};
try { for (const l of fs.readFileSync(".env", "utf8").split("\\n")) { const m = /^\\s*([A-Z_]+)\\s*=\\s*(.*)\\s*$/.exec(l); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {}
const dbPath = env.SOUNDBOARD_DB_PATH || path.join(process.cwd(), "data", "soundboard.db");
const mediaDir = env.SOUNDBOARD_MEDIA_DIR || path.join(process.cwd(), "data", "sounds");
const db = new (require("better-sqlite3"))(dbPath, { readonly: true, fileMustExist: true });
const q = (t) => db.prepare("SELECT * FROM " + t + " ORDER BY position, createdAt").all();
process.stdout.write(JSON.stringify({ mediaDir, boards: q("boards"), pages: q("pages"), sounds: q("sounds") }));
`;
const dump = JSON.parse(
  execFileSync("ssh", [host, `cd ${SRC_DIR} && node -`], { input: remote, maxBuffer: 64 * 1024 * 1024 }).toString(),
);
const { boards, pages, sounds, mediaDir } = dump;
writeFileSync(join(cache, "dump.json"), JSON.stringify(dump, null, 2));
console.log(`  boards=${boards.length} pages=${pages.length} sounds=${sounds.length} (media: ${mediaDir})`);

// --- 2. copy the audio files down (scp, read-only on the server) ---------------
const SAFE = /^[a-f0-9-]{36}\.[a-z0-9]{1,5}$/i;
for (const s of sounds) if (!SAFE.test(s.key)) throw new Error(`unsafe key in source: ${s.key}`);
if (!skipAudio && sounds.length) {
  console.log(`→ copying ${sounds.length} audio file(s)`);
  execFileSync("scp", ["-q", ...sounds.map((s) => `${host}:${mediaDir}/${s.key}`), audioDir + "/"], { stdio: "inherit" });
}

// --- 3. verify sizes locally ----------------------------------------------------
let bytes = 0;
const MIME_BY_EXT = { mp3: "audio/mpeg", wav: "audio/wav", webm: "audio/webm", ogg: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac" };
const manifest = [];
for (const s of sounds) {
  const p = join(audioDir, s.key);
  if (!existsSync(p)) {
    if (skipAudio) continue;
    throw new Error(`missing audio for sound ${s.id} (${s.key})`);
  }
  const size = statSync(p).size;
  if (size !== s.size) console.warn(`  ! size mismatch ${s.key}: db=${s.size} file=${size}`);
  bytes += size;
  const sha256 = createHash("sha256").update(readFileSync(p)).digest("hex");
  manifest.push({ key: s.key, size, sha256, type: MIME_BY_EXT[s.key.split(".").pop().toLowerCase()] ?? "application/octet-stream" });
}
writeFileSync(join(cache, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`  ${manifest.length} file(s), ${bytes} bytes — manifest: ${join(cache, "manifest.json")}`);

// --- 4. build the replacement SQL ----------------------------------------------
const lit = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const insert = (table, cols, rows) =>
  rows.map((r) => `INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map((c) => lit(r[c])).join(",")});`);
const sql = [
  "DELETE FROM sounds;",
  "DELETE FROM pages;",
  "DELETE FROM boards;",
  ...insert("boards", ["id", "name", "icon", "accent", "position", "createdAt", "updatedAt"], boards),
  ...insert("pages", ["id", "board_id", "name", "position", "createdAt"], pages),
  ...insert("sounds", ["id", "page_id", "label", "accent", "key", "filename", "mime", "size", "position", "createdAt"], sounds),
].join("\n");
const sqlFile = join(cache, `import-to-${to}.sql`);
writeFileSync(sqlFile, sql + "\n");
console.log(`  SQL: ${sqlFile}`);

if (dryRun) {
  console.log("dry run — nothing written to Cloudflare");
  process.exit(0);
}

// --- 5. upload audio first (so the new rows never point at missing bytes) ------
if (!skipAudio) {
  for (const m of manifest) {
    process.stdout.write(`→ r2 put ${BUCKET}/${m.key} (${m.size} B) … `);
    wrangler("r2", "object", "put", `${BUCKET}/${m.key}`, "--file", join(audioDir, m.key), "--content-type", m.type, "--remote");
    console.log("ok");
  }
}

// --- 6. replace D1 rows ----------------------------------------------------------
console.log(`→ d1 execute ${D1_NAME} (replace all rows)`);
wrangler("d1", "execute", D1_NAME, ...ENV_ARGS, "--remote", "--file", sqlFile, "-y");
const counts = JSON.parse(
  wrangler("d1", "execute", D1_NAME, ...ENV_ARGS, "--remote", "--json", "--command",
    "SELECT (SELECT COUNT(*) FROM boards) b, (SELECT COUNT(*) FROM pages) p, (SELECT COUNT(*) FROM sounds) s, (SELECT COALESCE(SUM(size),0) FROM sounds) bytes"),
)[0].results[0];
console.log(`✓ ${D1_NAME}: boards=${counts.b} pages=${counts.p} sounds=${counts.s} bytes=${counts.bytes}`);
console.log(`  verify bytes via the API with scripts/verify-audio.mjs (sha256 list in ${join(cache, "manifest.json")})`);
