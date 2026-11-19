# Soundboard — project context

A personal **soundboard**: multiple **boards**, each with **pages** of tap-to-play
**sound pads**. Branch **`cloudflare`** is the Cloudflare port (Worker + D1 + private
R2, invite-only accounts); the legacy Next.js/SQLite app on the home server lives on
`dev`/`main` until the prod cutover. Read `README.md` for API, auth and cutover detail.

- **Stack:** React 19 + Tailwind 4 SPA (Vite) served by Workers Static Assets; Worker in
  plain TS (`worker/`); D1; R2; Cloudflare Email Sending (`send_email` binding).
- **Repo:** `BrewerIndustries/soundboard` (private). Worktree for this branch:
  `~/Desktop/Jarvis Server Applications/soundboard-cf` (other sessions use the main
  `soundboard` folder — don't touch it from here).

## Environments

| Env  | Wrangler     | Worker           | URL                                 | D1 / R2                                   |
| ---- | ------------ | ---------------- | ----------------------------------- | ----------------------------------------- |
| DEV  | `--env dev`  | `soundboard-dev` | https://soundboard-dev.dabrewer.dev | `soundboard-dev` / `soundboard-audio-dev` |
| PROD | (top level)  | `soundboard`     | https://soundboard.dabrewer.dev     | `soundboard-prod` / `soundboard-audio-prod` — live 2026-11-03 |

Prod is the Cloudflare Worker (custom domain; the old A record to the home server is
gone). Prod secret values: `.prod.secrets` (gitignored). Deploy prod only with the user's OK:
`env -u CLOUDFLARE_API_TOKEN npm run deploy:prod`.

## Commands  ⚠️ wrangler needs the OAuth login

The shell's `CLOUDFLARE_API_TOKEN` is DNS-scoped only → always `env -u CLOUDFLARE_API_TOKEN`.

```bash
npm run check                                                     # tsc (UI + worker) + eslint + vite build
env -u CLOUDFLARE_API_TOKEN npx wrangler d1 migrations apply soundboard-dev --env dev --remote
env -u CLOUDFLARE_API_TOKEN npm run deploy:dev
env -u CLOUDFLARE_API_TOKEN npx wrangler tail soundboard-dev
npm run migrate:from-server -- --to dev --from prod               # refresh dev from prod server data
```

Local: `.dev.vars` (`SESSION_SECRET`, `JARVIS_TOKEN`), `npm run dev` → wrangler dev with
local D1/R2 and simulated email (writes .txt/.html under `.wrangler/tmp/email`).
Dev secret values + the bootstrap-admin invite link: `.dev.secrets` (gitignored).

## Deploying (the container image builds on the Jarvis box, not the Mac)

The YouTube extractor adds a Cloudflare Container, and wrangler builds/pushes
`container/Dockerfile` during `deploy`. **Do that on the Jarvis box**
(`dan@100.102.159.57`, x86_64 — the `linux/amd64` platform Containers need), not on the
Mac. Don't install Docker/Colima locally.

```bash
git push origin cloudflare
ssh dan@100.102.159.57
cd ~/build/soundboard-cf && git pull            # scratch checkout — NOT /opt (legacy app)
npm install --legacy-peer-deps                  # npm ci refuses: lockfile is out of sync
sudo apt install -y docker-buildx               # the box ships only the legacy builder
# token: Workers Scripts, Containers, D1, R2 + DNS edit; keep it in a 600 file
set -a; . ~/.config/jarvis/cloudflare.env; set +a
npm run deploy:dev                              # builds + pushes the image, deploys DEV
```

The `env -u CLOUDFLARE_API_TOKEN` prefix in the commands above is for the **Mac's**
OAuth login; on the server the API token *is* the auth, so run `npm run deploy:dev`
directly. First deploy takes a few minutes (image build + container provisioning) and
`/api/youtube*` may error until instances are up. Prod still needs the user's OK.

## Architecture map

- `worker/index.ts` — router: `/api/health`; auth pages (`/login`, `/forgot`, `/reset`,
  `/invite` → `public/auth.html`); `/api/auth/*` → `accounts.ts`; other `/api/*` need
  auth; everything else (SPA) needs auth or 302 → `/login?next=`. `run_worker_first`.
- `worker/auth.ts` — PBKDF2 hashing, HMAC token ids, cookie helpers, `authenticate()`
  (bearer JARVIS_TOKEN or session; rolling 90-day expiry), D1 rate limiter.
- `worker/accounts.ts` — `/api/auth/*`: login/logout/me/forgot/reset/accept-invite/link/
  password + admin users CRUD; bootstrap admin; last-admin guard; same-origin check.
- `worker/email.ts` — `env.EMAIL.send({from:{email,name},to,subject,html,text})`; fails
  soft (console.log the link; admins get `link` back).
- `worker/db.ts` — D1 port of the old SQLite layer (same tree JSON); deletes return R2 keys.
- `worker/storage.ts` — R2 put/delete, `serveAudio` with single-range 206/416 support,
  MIME-by-extension, safe-key guard.
- `migrations/` — `0001_init.sql` (boards/pages/sounds), `0002_auth.sql` (users/sessions/
  auth_tokens/rate_hits).
- `src/main.tsx` — boots via `GET /api/auth/me` (401 → login), env banner label.
- `src/components/SoundBoard.tsx` — whole board UI (unchanged apart from auth: no token
  bar; 401 → login; 👤 opens `AccountPanel`).
- `src/components/AccountPanel.tsx` — change password, sign out, admin user management,
  "Copy link" fallback when email isn't available.
- `src/lib/clipPlayer.ts`, `src/lib/types.ts` (shared with the Worker) — unchanged.
- `scripts/migrate-from-server.mjs`, `scripts/verify-audio.mjs` — data migration + check.
- `deploy/` — legacy home-server systemd/nginx scripts; delete after cutover.

## Interface music-kiosk depends on (keep exactly)

`GET /api/boards` (same nested JSON as the old app, incl. `tokenRequired`) and
`GET /api/audio/<key>` with Range, via service binding + `Authorization: Bearer <JARVIS_TOKEN>`.
The auth tables/API shape is shared with music-kiosk too — change both together.

## Gotchas

- Email sending isn't enabled yet (needs Workers Paid; **don't run
  `wrangler email sending enable`** — the user/coordinator does it). Sends currently throw
  `E_RECIPIENT_NOT_ALLOWED`; that's expected.
- `wrangler tail` samples under bursts — don't rely on it to catch every logged link.
- zsh doesn't word-split `$VAR` in shell one-liners; use `${=VAR}`.
- Login rate limit counts **failed** attempts only (per IP + per email, 10/15 min);
  heavy testing from one IP can lock that IP out for 15 min (`DELETE FROM rate_hits`).
