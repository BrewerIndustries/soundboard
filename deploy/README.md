# Deploying Soundboard to the jarvis server

Two environments live on the jarvis server (`dan@100.102.159.57`, Tailscale-only),
each a **git checkout** authenticated with a read-only deploy key
(`~/.ssh/soundboard-deploy`, via the `github-soundboard` host alias in `~/.ssh/config`):

| Env  | Branch | Path                  | Port | Service          | URL                                 |
| ---- | ------ | --------------------- | ---- | ---------------- | ----------------------------------- |
| MAIN | `main` | `/opt/soundboard`     | 4720 | `soundboard`     | https://soundboard.dabrewer.dev     |
| DEV  | `dev`  | `/opt/soundboard-dev` | 4730 | `soundboard-dev` | https://soundboard.dev.dabrewer.dev |

Each has its own `.env` (separate `JARVIS_TOKEN`), an isolated SQLite DB at
`data/soundboard.db`, **and its own audio directory at `data/sounds/`** — dev and
prod never share files. `.env`, `data/`, `node_modules/`, and `.next/` are gitignored
and live only on the server.

**Audio storage is the server's own disk** — no cloud bucket. Bytes are written to
`data/sounds/<uuid>.<ext>` and served (with HTTP Range support) via `/api/audio/<key>`.
The whole box is reachable only over Tailscale, so the media is private by default.

**Environment banner:** DEV's `.env` must include `JARVIS_ENV=dev` so the UI shows its
amber "DEV ENVIRONMENT — NOT PRODUCTION" strip and `[DEV]` tab title. **MAIN must leave
`JARVIS_ENV` unset.** The prod unit also sets `PORT=4720`, which hard-suppresses the
banner regardless of `.env`. Read at request time (`force-dynamic`), so editing `.env`
+ `systemctl restart <service>` is enough — no rebuild needed for the banner.

## Workflow

Work on `dev`, deploy to DEV, and **promote to MAIN only via a PR the user approves**
(never fast-forward or `git push origin dev:main`):

```bash
git push origin dev
ssh dan@100.102.159.57 /opt/soundboard-dev/deploy/update-dev.sh   # → DEV (:4730)

# once a dev→main PR is approved + merged:
ssh dan@100.102.159.57 /opt/soundboard/deploy/update.sh           # → MAIN (:4720)
```

Each `update*.sh` does `git pull --ff-only && npm install && npm run build && systemctl restart <service>`.
(`npm install`, not `npm ci` — the lockfile is generated on macOS and `ci` can trip on
the `@emnapi/*` native-module drift on Linux.)

## First-time setup (per environment)

```bash
# 1. deploy key (once): generate on the server, add the PUBLIC key to the repo as a
#    read-only deploy key, and add an SSH host alias `github-soundboard`.
ssh-keygen -t ed25519 -f ~/.ssh/soundboard-deploy -N "" -C "soundboard deploy (jarvis-server)"
#    ~/.ssh/config:
#      Host github-soundboard
#        HostName github.com
#        User git
#        IdentityFile ~/.ssh/soundboard-deploy
#        IdentitiesOnly yes

# 2. clone (main → /opt/soundboard, dev → /opt/soundboard-dev)
sudo mkdir -p /opt/soundboard-dev && sudo chown dan:dan /opt/soundboard-dev
git clone -b dev github-soundboard:BrewerIndustries/soundboard.git /opt/soundboard-dev

# 3. configure + build  (better-sqlite3 compiles native — build ON the server, as dan)
cd /opt/soundboard-dev
cp .env.example .env            # set JARVIS_TOKEN=$(openssl rand -hex 24); dev also adds JARVIS_ENV=dev
npm install
npm run build

# 4. service
sudo cp deploy/soundboard-dev.service /etc/systemd/system/      # (non-dev variant for prod)
sudo systemctl daemon-reload
sudo systemctl enable --now soundboard-dev
sudo systemctl status soundboard-dev
```

## Reverse proxy (nginx)

Add a `server{}` block per env to `/etc/nginx/sites-available/dabrewer.dev`, then
`sudo nginx -t && sudo systemctl reload nginx`:

```nginx
server {
    server_name soundboard.dev.dabrewer.dev;        # prod: soundboard.dabrewer.dev
    ssl_certificate     /etc/letsencrypt/live/dev.dabrewer.dev/fullchain.pem;   # prod: dabrewer.dev
    ssl_certificate_key /etc/letsencrypt/live/dev.dabrewer.dev/privkey.pem;
    location / {
        proxy_pass http://localhost:4730;           # prod: 4720
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 30m;                    # audio uploads (25 MB cap in-app)
    }
}
```

DNS: the dev subdomain is covered by the `*.dev.dabrewer.dev` wildcard. The prod
subdomain `soundboard.dabrewer.dev` needs a Cloudflare A record → `100.102.159.57`
(DNS-only). Wildcard Let's Encrypt certs already cover TLS for both.

The SQLite DB + audio bytes live under `/opt/soundboard/data/` — included in server backups.
