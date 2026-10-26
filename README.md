# Soundboard

A personal **soundboard** — multiple **boards**, each holding **pages** of
tap-to-play **sound pads**. Tap a pad to fire its clip; overlap them freely.
Boards, pages, and pads are created, renamed, recoloured, and deleted inline.
Audio bytes live on the **jarvis server's own disk** (Tailscale-only, no cloud
bucket); everything else persists in per-environment SQLite.

Part of the Jarvis constellation: it lives on the jarvis server with the usual
dev/prod split and shows up as a tile in the Launcher + Dashboard.

- **Stack:** Next.js 16 + React 19 + Tailwind 4, SQLite via `better-sqlite3`.
  Uploaded audio is stored on local disk and served (with Range support) via an
  API route — nothing leaves the box.
- **Repo:** `BrewerIndustries/soundboard` (private). Local working copy:
  `~/Desktop/Jarvis Server Applications/soundboard`.

## The model — boards → pages → sounds

- A **board** is a themed collection (e.g. "Hannah") with an emoji + accent colour.
- A board holds ordered **pages**, so one board can span more pads than fit on a
  single screen.
- A **page** holds **sound pads**. Each pad has a label, an accent colour, and an
  uploaded audio clip. Tap it to play.

The seed board on a fresh database is **Hannah** with a **Sounds** page — the
original idea's starting point. Add the first pad by uploading a clip (e.g.
"jam quieter").

## Playback controls

Tap a pad to play it from the top (tapping a live pad restarts it). Each pad has a
control row: **▶/⏸** play/pause, **■** stop, **fade in** (start silent and rise,
resume a paused pad with a fade, or pull back a fade-out) and **fade out** (then
stop). The **🔊** button opens Volume + Fade in/out durations, saved per device in
`localStorage`. **■ Stop all** appears while anything plays.

Pads play through Web Audio (`src/lib/clipPlayer.ts`): a per-pad gain node for
fades into a master gain for the volume, which also works on iOS (it ignores
`<audio>.volume`). The same player lives in music-kiosk.

## Environments (both on the jarvis server, `dan@100.102.159.57`, over Tailscale)

| Env  | Branch | Path                  | Port | Service          | URL                                 |
| ---- | ------ | --------------------- | ---- | ---------------- | ----------------------------------- |
| DEV  | `dev`  | `/opt/soundboard-dev` | 4730 | `soundboard-dev` | https://soundboard.dev.dabrewer.dev |
| MAIN | `main` | `/opt/soundboard`     | 4720 | `soundboard`     | https://soundboard.dabrewer.dev     |

Each env is a git checkout with its **own `.env` (separate `JARVIS_TOKEN`), an
isolated SQLite DB, and its own `data/sounds/` audio directory**. DEV's `.env`
sets `JARVIS_ENV=dev` → amber non-prod banner; MAIN leaves it unset (and is
hard-guarded by its `:4720` port). See [deploy/README.md](deploy/README.md).

## Workflow  ⚠️

- **Work on `dev`.** Push to `dev` and deploy DEV freely.
- **Never promote to `main` without the user's explicit approval — via a PR, never a
  fast-forward / `git push origin dev:main`.** `main` is production and holds real data.

```bash
git push origin dev
ssh dan@100.102.159.57 /opt/soundboard-dev/deploy/update-dev.sh    # → DEV (:4730)
# after an approved dev→main PR merges:
ssh dan@100.102.159.57 /opt/soundboard/deploy/update.sh            # → MAIN (:4720)
```

## Local development

```bash
npm install
npm run dev            # http://localhost:3000  (.env.local with JARVIS_TOKEN=test)
npm run build          # production build (run before deploying)
```

A fresh/empty database is **seeded** with the "Hannah" board so the app looks alive on
first run; it's editable and deletable like anything else.

## Auth

Reads and playback are **open** (it's your own board on a private Tailscale network).
Mutations — creating/renaming/deleting boards, pages, and sounds, plus audio uploads —
require the shared `JARVIS_TOKEN`, sent as `Authorization: Bearer <token>` or
`x-jarvis-token: <token>`. The UI has a 🔒 token bar that stores it in `localStorage`.
If `JARVIS_TOKEN` is unset, writes are open too (fine for a trusted box).

## Data model

- **boards** — `id`, `name`, `icon` (emoji), `accent` (palette key), `position`, timestamps.
- **pages** — `id`, `board_id` (FK, cascade), `name`, `position`, `createdAt`.
- **sounds** — `id`, `page_id` (FK, cascade), `label`, `accent`, `key` (on-disk
  filename), `filename`, `mime`, `size`, `position`, `createdAt`.

Deleting a board or page cascades to its sounds and unlinks the audio bytes from disk.

## API

| Method + path            | Auth  | Purpose                                            |
| ------------------------ | ----- | -------------------------------------------------- |
| `GET /api/boards`        | open  | Full tree (boards → pages → sounds).               |
| `POST /api/boards`       | token | Create a board `{ name, icon?, accent? }`.         |
| `PATCH /api/boards/:id`  | token | Rename / recolour / reorder.                       |
| `DELETE /api/boards/:id` | token | Delete board (cascades pages + sounds + files).    |
| `POST /api/pages`        | token | Add a page `{ boardId, name }`.                    |
| `PATCH /api/pages/:id`   | token | Rename / reorder.                                  |
| `DELETE /api/pages/:id`  | token | Delete page (cascades sounds + files).             |
| `POST /api/sounds`       | token | Upload a pad — multipart `file, pageId, label?, accent?`. |
| `PATCH /api/sounds/:id`  | token | Relabel / recolour / reorder.                      |
| `DELETE /api/sounds/:id` | token | Delete pad + unlink bytes.                         |
| `GET /api/audio/:key`    | open  | Stream a clip's bytes (supports Range / 206).      |

Uploads must be `audio/*` and ≤ 25 MB.

## Constellation wiring

- **`.jarvis.json`** — registry declaration read by the Launcher + Dashboard sync
  (`id: soundboard`, `category: standalone`, per-env `status` + `deploy.port`).
- **Launcher** (`BrewerIndustries/jarvis-launcher`): an `AppDef` in `DEFAULT_APPS`,
  category `standalone`, `prodPort: 4720`.
- **Dashboard** (`BrewerIndustries/jarvis-dashboard`): `soundboard` added to `REPOS` +
  `DEFAULTS` in `scripts/sync-registry.mjs`.
- nginx proxies the two subdomains to `:4720` / `:4730`; prod DNS is a Cloudflare A
  record, dev is the `*.dev.dabrewer.dev` wildcard.
