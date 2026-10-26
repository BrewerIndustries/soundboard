# Soundboard — project context

A personal **soundboard**: multiple **boards**, each with **pages** of tap-to-play
**sound pads**. Architecture cloned from its sibling `idea-log` in the Jarvis
constellation (same Next.js + SQLite + systemd/nginx shape), with local-disk audio
storage instead of R2.

- **Stack:** Next.js 16 + React 19 + Tailwind 4, SQLite via `better-sqlite3`. App Router.
- **Repo:** `BrewerIndustries/soundboard` (private). Working copy:
  `~/Desktop/Jarvis Server Applications/soundboard`.

## Environments (both on the jarvis server, `dan@100.102.159.57`, over Tailscale)

| Env  | Branch | Path                  | Port | Service          | URL                                 |
| ---- | ------ | --------------------- | ---- | ---------------- | ----------------------------------- |
| DEV  | `dev`  | `/opt/soundboard-dev` | 4730 | `soundboard-dev` | https://soundboard.dev.dabrewer.dev |
| MAIN | `main` | `/opt/soundboard`     | 4720 | `soundboard`     | https://soundboard.dabrewer.dev     |

Each env is a git checkout (read-only deploy key `~/.ssh/soundboard-deploy`, host alias
`github-soundboard`) with its **own `.env` (separate `JARVIS_TOKEN`), an isolated SQLite
DB, and its own `data/sounds/` audio dir**. `.env`, `data/`, `node_modules/`, `.next/`
are gitignored — server-only.

DEV's `.env` sets **`JARVIS_ENV=dev`** → amber non-prod banner + `[DEV]` title. MAIN
leaves it unset; the prod unit's `PORT=4720` also hard-suppresses the banner. Read at
request time (`page.tsx` is `force-dynamic`), so `.env` edit + restart suffices.

## Workflow  ⚠️ READ THIS

- **Work on `dev`.** Push to `dev` and deploy DEV freely.
- **Never promote to `main` without the user's explicit permission — and only via an
  approved PR** (`gh pr create --base main --head dev`). Do NOT fast-forward or
  `git push origin dev:main`. `main` is production.

```bash
git push origin dev
ssh dan@100.102.159.57 /opt/soundboard-dev/deploy/update-dev.sh    # → DEV (:4730)
# after the user approves + merges a dev→main PR:
ssh dan@100.102.159.57 /opt/soundboard/deploy/update.sh           # → MAIN (:4720)
```

## Domain model — boards → pages → sounds (see `src/lib/types.ts`)

- **boards** table: `id`, `name`, `icon` (emoji), `accent` (palette key), `position`, timestamps.
- **pages** table: `id`, `board_id` (FK ON DELETE CASCADE), `name`, `position`, `createdAt`.
- **sounds** table: `id`, `page_id` (FK ON DELETE CASCADE), `label`, `accent`, `key`
  (on-disk filename), `filename`, `mime`, `size`, `position`, `createdAt`.
- `foreign_keys = ON`; deletes collect the orphaned storage keys **before** the cascade
  so the route can `unlink` the audio bytes. `GET /api/boards` returns the full nested tree.
- `ACCENT` palette + `PAD_PALETTE` (auto-colour rotation) ported from idea-log.
- A fresh DB is **seeded** with the "Hannah" board + a "Sounds" page (`src/lib/seed.ts`);
  no audio bytes are seeded.

## Audio storage (`src/lib/storage.ts`)

- Bytes live on **local disk**, NOT R2. `SOUNDBOARD_MEDIA_DIR` (default `./data/sounds`);
  each env points at its own dir so dev + prod never share files.
- Keys are `<uuid>.<ext>`; `isSafeKey` + a `resolve()` prefix check block path traversal.
- Served by `GET /api/audio/<key>` with **HTTP Range support** (206) so browser `<audio>`
  seeking / Safari playback works. Uploads capped at 25 MB, `audio/*` only.

## Architecture map

- `src/lib/db.ts` — SQLite open/cache/WAL + FK cascade; boards/pages/sounds CRUD;
  `listBoards()` assembles the tree; delete fns return orphaned keys; `seed()` on empty DB.
- `src/lib/types.ts` — `ACCENT` palette, `PAD_PALETTE`, `Board`/`Page`/`Sound` types, `formatBytes`.
- `src/lib/storage.ts` — local-disk put/stat/delete + MIME/ext maps + safe-key guard.
- `src/lib/auth.ts` — `isAuthorized` (Bearer or `x-jarvis-token`; open if no token set).
- `src/app/api/boards/route.ts` — `GET` (tree) / `POST`; `boards/[id]` — `PATCH`/`DELETE`.
- `src/app/api/pages/route.ts` — `POST`; `pages/[id]` — `PATCH`/`DELETE`.
- `src/app/api/sounds/route.ts` — `POST` (multipart upload); `sounds/[id]` — `PATCH`/`DELETE`.
- `src/app/api/audio/[key]/route.ts` — `GET` byte-serving with Range.
- `src/app/page.tsx` — resolves `JARVIS_ENV`; **hard prod guard keys off `PORT === "4720"`**.
- `src/components/SoundBoard.tsx` — the whole client UI: board rail, page tabs, pad grid
  (each pad + play/pause/stop/fade-in/fade-out row), create modals, Edit mode
  (rename/delete via prompt/confirm), token bar, 🔊 volume + fade-duration bar
  (localStorage), env banner.
- `src/lib/clipPlayer.ts` — pad playback via Web Audio (per-pad gain for fades → master
  gain for volume); a `useSyncExternalStore` store of pad status. Mirrors music-kiosk's.
- `src/app/globals.css` — base theme + DEV banner + pad press animation.
- `.jarvis.json` — registry declaration read by the Launcher + Dashboard registry sync.
- `deploy/` — systemd units, `update*.sh`, `README.md`.

## Constellation wiring

- **Launcher** (`BrewerIndustries/jarvis-launcher`): `AppDef` in `DEFAULT_APPS`
  (`src/lib/apps.ts`), category `standalone`, `prodPort: 4720`. URL auto-derives to
  `soundboard.dabrewer.dev` / `soundboard.dev.dabrewer.dev`.
- **Dashboard** (`BrewerIndustries/jarvis-dashboard`): `soundboard` in `REPOS` +
  `DEFAULTS` in `scripts/sync-registry.mjs`; the registry sync reads this repo's `.jarvis.json`.
- nginx proxies the two subdomains to `:4720` / `:4730`; prod DNS is a Cloudflare A record,
  dev is the `*.dev.dabrewer.dev` wildcard.

## Local development

```bash
npm install
npm run dev      # http://localhost:3000  (.env.local: JARVIS_TOKEN=test, JARVIS_ENV=dev)
npm run build    # run before deploying — catches native-module / TS issues
```

## Gotchas

- **Build as `dan`, never `sudo`** on the server — a root-owned `.next/` breaks later builds.
- **Use `npm install`, not `npm ci`** on the server — the lockfile is macOS-generated and
  `ci` can trip on the `@emnapi/*` native-module drift on Linux.
- **`client_max_body_size 30m`** in the nginx block — else large clip uploads 413 at the proxy.
