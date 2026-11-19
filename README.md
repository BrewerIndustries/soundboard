# Soundboard

A personal **soundboard** — multiple **boards**, each holding **pages** of
tap-to-play **sound pads**. Tap a pad to fire its clip; overlap them freely.
Boards, pages, and pads are created, renamed, recoloured, and deleted inline.

**Runs on Cloudflare** (branch `cloudflare`): one Worker serves the static React UI
and the JSON API on the same origin, with **D1** for boards/pages/sounds and a
**private R2** bucket for the audio bytes. Moved off the home server so the
5 Dec 2026 wedding doesn't depend on it. Access is **invite-only accounts**
(email + password), plus a bearer token for scripts and the music-kiosk.

- **Stack:** React 19 + Tailwind 4 SPA built with Vite → Workers Static Assets;
  Worker in plain TypeScript (no framework); D1 (SQLite); R2; Cloudflare Email Sending.
- **Repo:** `BrewerIndustries/soundboard` (private). Worktree for this branch:
  `~/Desktop/Jarvis Server Applications/soundboard-cf`.

## Environments

| Env  | Worker           | URL                                   | D1                | R2                      | Status |
| ---- | ---------------- | ------------------------------------- | ----------------- | ----------------------- | ------ |
| DEV  | `soundboard-dev` | https://soundboard-dev.dabrewer.dev   | `soundboard-dev`  | `soundboard-audio-dev`  | live, mirrors prod data |
| PROD | `soundboard`     | https://soundboard.dabrewer.dev       | `soundboard-prod` | `soundboard-audio-prod` | **live** since 2026-11-03 (see *Prod cutover*) |

Prod moved off the home server on 2026-11-03. The old Next.js app (`/opt/soundboard`,
:4720, `deploy/` folder) is no longer reachable at soundboard.dabrewer.dev; its
systemd unit + nginx block are still to be stopped (cutover step 8).

## The model — boards → pages → sounds

- A **board** is a themed collection (e.g. "Hannah") with an emoji + accent colour.
- A board holds ordered **pages**; a **page** holds **sound pads** (label, accent
  colour, uploaded audio clip).

## Playback controls

Tap a pad to play it from the top (tapping a live pad restarts it). Each pad has a
control row: **▶/⏸** play/pause, **■** stop, **fade in**, **fade out**. The **🔊**
button opens Volume + Fade durations (per device, `localStorage`). **■ Stop all**
appears while anything plays. Playback is Web Audio (`src/lib/clipPlayer.ts`), so
volume + fades work on iOS too. The same player lives in music-kiosk.

## Importing a pad from YouTube

**＋ Add sound → From YouTube**: paste a video link, optionally set **Start** / **End**
(`0:12`, `1:02:03`), and the server pulls the audio, trims it, converts it to mp3 and
creates the pad. The **Check** button fills in the title and length first; the label
is pre-filled from the title and can be edited. Caps: 10 minutes and 20 MB per clip.

Workers cannot run yt-dlp, so extraction happens in a **Cloudflare Container**
(`container/`): Python + `yt-dlp[default]` + `ffmpeg`, plus the
[bgutil PO-token provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)
for YouTube's attestation checks. The container is private — it is reached only
through the `YtContainer` Durable Object (`worker/yt.ts`), which starts it on
demand, waits for its `/health`, forwards requests and lets it go idle after 3
minutes. The Worker stores the returned mp3 in R2 like any uploaded clip.

- Instance type: `basic` (1 GiB, ¼ vCPU) — plenty for audio; raise to `standard-1`
  in `worker/yt.ts` if ffmpeg ever runs out of memory.
- Two containers (`pool-0`, `pool-1`) so two imports can run at once; a third gets
  a "busy" error rather than queueing.
- If YouTube starts refusing Cloudflare's egress IPs ("Sign in to confirm you're not
  a bot"), set either secret and redeploy:
  - `YTDLP_PROXY` — an HTTP/SOCKS proxy URL for yt-dlp.
  - `YTDLP_COOKIES` — the text of a `cookies.txt` from a throwaway YouTube account.
- YouTube's terms forbid downloading without permission; this is for clips you have
  the right to use.

## Accounts & auth

Everything except `GET /api/health` and the sign-in pages needs one of:

1. **A user session** — invite-only accounts. `sb_session` cookie (HttpOnly, Secure,
   SameSite=Lax, Path=/) holding a random token; D1 stores only
   `HMAC-SHA256(token, SESSION_SECRET)`. **90-day rolling** expiry (extended at most
   once a day), so a kiosk iPad stays signed in.
2. **`Authorization: Bearer <JARVIS_TOKEN>`** (or `x-jarvis-token`) — scripts and the
   music-kiosk service binding. Full access: reads, writes and user admin.

- Passwords: PBKDF2-SHA256, 100 000 iterations, 16-byte salt, min 10 characters.
- Roles: `admin` (manages users) and `member`. The last enabled admin can't be
  demoted, disabled or deleted.
- Invite links last **7 days**, reset links **1 hour**; single use. Redeeming one
  sets the password, signs out every other session, and signs you in.
- Changing your password (👤 → Change password) signs out your other devices.
- Rate limits (D1 sliding window, 10 per 15 min): **failed** logins per IP and per
  email; forgot-password requests per IP and per email.
- Cookie-authed writes must come from the same origin (403 otherwise).
- **Bootstrap:** when `users` is empty, the first login/forgot request creates
  `BOOTSTRAP_ADMIN_EMAIL` (var) as a passwordless admin; it sets a password via
  "Forgot password" — or via an invite link minted with the bearer token
  (`POST /api/auth/users/<id>/resend`), which works before email is set up.

UI: `/login`, `/forgot`, `/reset?token=…`, `/invite?token=…` (one static page,
`public/auth.html`); in the app, **👤** opens Account (change password, sign out,
and for admins the user list: invite, resend, role, disable/enable, delete).

### Email (fails soft)

Invite + reset emails go out through the `send_email` binding **`EMAIL`**
(Cloudflare Email Sending) from `"Soundboard" <noreply@dabrewer.dev>`, html + text.
Until the sending domain is onboarded (needs Workers Paid +
`wrangler email sending enable` — **not done yet**), sends throw
(`E_RECIPIENT_NOT_ALLOWED`), so:

- the link is `console.log`ged (`wrangler tail soundboard-dev`; tail samples under load);
- invite/resend responses include `link` (and `emailed: false`), and the admin UI
  shows a **Copy link** box;
- forgot-password never returns the link (only logs it).

## API

All JSON. "session|token" = a user session cookie or the bearer token.

| Method + path                        | Auth          | Purpose |
| ------------------------------------ | ------------- | ------- |
| `GET /api/health`                    | public        | `{ ok: true }` |
| `POST /api/auth/login`               | public        | `{ email, password }` → cookie + `{ user }` |
| `POST /api/auth/logout`              | public        | Deletes the session, clears the cookie. |
| `GET /api/auth/me`                   | session/token | `{ user, token, env }` (`user` null for the bearer). |
| `POST /api/auth/forgot`              | public        | `{ email }` → always 200, same message; emails `/reset?token=…`. |
| `POST /api/auth/reset`               | public        | `{ token, password }` → sets password, revokes all sessions, signs in. |
| `POST /api/auth/accept-invite`       | public        | `{ token, password }` → same, for `/invite?token=…` links. |
| `GET /api/auth/link?token=`          | public        | `{ purpose, email, name }` for a live link (page greeting). |
| `POST /api/auth/password`            | session       | `{ current, password }` → change; signs out other sessions. |
| `GET /api/auth/users`                | admin/token   | `{ users }` (`pending` = no password yet). |
| `POST /api/auth/users`               | admin/token   | Invite `{ email, name, role }` → `{ user, emailed, link? }`. |
| `POST /api/auth/users/:id/resend`    | admin/token   | Re-issue the invite (only while pending) → `{ emailed, link? }`. |
| `PATCH /api/auth/users/:id`          | admin/token   | `{ role?, disabled?, name? }`. Disabling kills their sessions. |
| `DELETE /api/auth/users/:id`         | admin/token   | Delete user + sessions + links. |
| `GET /api/boards`                    | session/token | Full tree (boards → pages → sounds) — **same JSON as before**. |
| `POST /api/boards`                   | session/token | Create a board `{ name, icon?, accent? }`. |
| `PATCH /api/boards/:id`              | session/token | Rename / recolour / reorder. |
| `DELETE /api/boards/:id`             | session/token | Delete board (+ pages, sounds, R2 objects). |
| `POST /api/pages`                    | session/token | Add a page `{ boardId, name }`. |
| `PATCH /api/pages/:id`               | session/token | Rename / reorder. |
| `DELETE /api/pages/:id`              | session/token | Delete page (+ sounds, R2 objects). |
| `POST /api/sounds`                   | session/token | Upload a pad — multipart `file, pageId, label?, accent?`; `audio/*`, ≤ 25 MB. |
| `PATCH /api/sounds/:id`              | session/token | Relabel / recolour / reorder. |
| `DELETE /api/sounds/:id`             | session/token | Delete pad + R2 object. |
| `POST /api/youtube/info`             | session/token | `{ url }` → `{ title, uploader, duration, thumbnail }` (title check in the dialog). |
| `POST /api/youtube`                  | session/token | `{ url, pageId, start?, end?, label?, accent? }` → pulls via the container and creates the pad: `{ sound }`. |
| `GET /api/audio/:key`                | session/token | Clip bytes from R2; **Range → 206**, `Content-Type` from the key's extension. |

**music-kiosk contract:** `GET /api/boards` and `GET /api/audio/<key>` (with Range),
called through a service binding to this Worker with `Authorization: Bearer <JARVIS_TOKEN>`.

## Data model (D1, `migrations/`)

- **boards** — `id`, `name`, `icon`, `accent`, `position`, `createdAt`, `updatedAt`.
- **pages** — `id`, `board_id`, `name`, `position`, `createdAt`.
- **sounds** — `id`, `page_id`, `label`, `accent`, `key` (R2 object key `<uuid>.<ext>`),
  `filename`, `mime`, `size`, `position`, `createdAt`.
- **users**, **sessions**, **auth_tokens**, **rate_hits** — accounts (times in epoch ms).

Same board/page/sound schema as the old SQLite app, so the migration is a straight copy.

## Develop, check, deploy

Wrangler must use the OAuth login — the shell's `CLOUDFLARE_API_TOKEN` is DNS-only:

```bash
npm install
npm run check                                   # typecheck (UI + Worker) + lint + vite build
# local: .dev.vars with SESSION_SECRET=… and JARVIS_TOKEN=… (gitignored), then
npx wrangler d1 migrations apply soundboard-dev --env dev --local
npm run dev                                     # vite build + wrangler dev --env dev (local D1/R2/email sim)

# deploy DEV
env -u CLOUDFLARE_API_TOKEN npx wrangler d1 migrations apply soundboard-dev --env dev --remote
env -u CLOUDFLARE_API_TOKEN npm run deploy:dev
env -u CLOUDFLARE_API_TOKEN npx wrangler tail soundboard-dev     # logs (incl. fail-soft email links)
```

The YouTube extractor adds a Container, so **deploys need Docker running** locally
(wrangler builds and pushes `container/Dockerfile` on deploy). Local `wrangler dev`
will also try to pull the image; if Docker is not running, everything except
`/api/youtube*` still works. The first container deploy takes a few minutes to build
the image and provision instances.

### Secrets (per env, `wrangler secret put <NAME> [--env dev]`)

| Name             | Purpose |
| ---------------- | ------- |
| `SESSION_SECRET` | HMAC key for session + link token ids. Rotating it signs everyone out and voids open links. |
| `JARVIS_TOKEN`   | Bearer token for scripts + the music-kiosk service binding. |

Vars (in `wrangler.jsonc`): `JARVIS_ENV` (`dev` → amber banner), `BOOTSTRAP_ADMIN_EMAIL`.
Dev values live in `.dev.secrets` in the worktree (gitignored), not in the repo.

## Migrating data from the home server

`scripts/migrate-from-server.mjs` copies the server's SQLite rows + audio into a
Cloudflare env. Read-only on the server (opens the DB `readonly` via the app's own
`better-sqlite3`, `scp`s the clips). **Replaces** all board/page/sound rows in the
target; uploads audio to R2 first so rows never point at missing bytes. Doesn't touch
users. Doesn't delete orphaned R2 objects.

```bash
npm run migrate:from-server -- --to dev --from prod     # dev mirrors real prod sounds
npm run migrate:from-server -- --to prod --from prod    # cutover
#   --dry-run   fetch + verify + write SQL locally only
#   --skip-audio  rows only
JARVIS_TOKEN=… node scripts/verify-audio.mjs https://soundboard-dev.dabrewer.dev   # sha256 + Range check per clip
```

Cache (dump, clips, manifest with sha256, generated SQL) goes to `.migrate-cache/` (gitignored).

## Prod cutover (done 2026-11-03 except step 6 admin password, step 8 server cleanup)

1. Apply migrations: `env -u CLOUDFLARE_API_TOKEN npm run db:migrate:prod`.
2. Data: freeze edits on the home server, then
   `npm run migrate:from-server -- --to prod --from prod` (+ `verify-audio.mjs` after step 4).
3. DNS: delete the `soundboard.dabrewer.dev` **A record → 100.102.159.57** in the
   Cloudflare dashboard (a Worker custom domain won't take over an existing record).
4. Deploy: `env -u CLOUDFLARE_API_TOKEN npm run deploy:prod` (creates the custom domain
   + its proxied record). Until step 5 every request fails closed (401).
5. Secrets, right after: `openssl rand -hex 32 | env -u CLOUDFLARE_API_TOKEN npx wrangler secret put SESSION_SECRET`,
   same for `JARVIS_TOKEN` (give music-kiosk prod the same value). Then check a bearer
   `GET /api/boards` and `scripts/verify-audio.mjs https://soundboard.dabrewer.dev`.
6. First admin: `POST /api/auth/users/<id>/resend` with the bearer → invite link for
   `myemailisdanmail@gmail.com` (or "Forgot password" once email works).
7. Email: after the Workers Paid upgrade, `wrangler email sending enable` for
   `dabrewer.dev` (onboards `noreply@dabrewer.dev`). Nothing to redeploy.
8. Afterwards: stop/disable the `soundboard` systemd unit + nginx block on the server,
   update `.jarvis.json` (tech/deploy) and the Launcher/Dashboard entries, retire `deploy/`,
   merge `cloudflare` into `dev` → `main` via PR.

## Constellation wiring

- **`.jarvis.json`** — registry declaration read by the Launcher + Dashboard sync (still
  describes the home-server deploy until cutover).
- **music-kiosk** — reads boards + audio via a service binding (see API).
