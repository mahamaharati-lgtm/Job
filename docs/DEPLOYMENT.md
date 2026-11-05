# Deployment

The app is a single Node.js process. It serves the dashboard and API, and runs the scheduler (a one-minute tick that decides from database timestamps what is due). It needs:

- an **always-on** machine (the scheduler must keep running; this chat session does not run it);
- a **persistent disk** mounted at `/app/data` (SQLite database + encrypted files);
- about **1 GB RAM** (headless Chromium for applications);
- HTTPS (all managed platforms below provide it).

Before any deployment, generate secrets:

```bash
openssl rand -base64 32      # DATA_ENCRYPTION_KEY — store a backup copy in your password manager
openssl rand -hex 24         # CRON_SECRET (optional)
```

## Option A — Fly.io (simple, Mumbai region)

```bash
fly launch --no-deploy --copy-config        # uses fly.toml in this repo
fly volumes create job_data --size 1 --region bom
fly secrets set ADMIN_PASSWORD='choose-a-long-password' \
  DATA_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  PUBLIC_URL=https://<your-app>.fly.dev
# optional:
fly secrets set ADZUNA_APP_ID=... ADZUNA_APP_KEY=... ANTHROPIC_API_KEY=... TELEGRAM_BOT_TOKEN=...
fly deploy
```

`auto_stop_machines = "off"` keeps the scheduler alive.

## Option B — Render

1. New → **Blueprint** → select this repository (uses `render.yaml`).
2. Fill in the `sync: false` variables (ADMIN_PASSWORD, PUBLIC_URL, optional keys). `DATA_ENCRYPTION_KEY` and `CRON_SECRET` are generated automatically. Copy the encryption key somewhere safe.
3. A persistent disk requires a paid instance. On the free tier data is lost on restart, so don't use it.

## Option C — Any VPS (cheapest)

```bash
git clone https://github.com/mahamaharati-lgtm/Job.git && cd Job
cp .env.example .env && nano .env            # ADMIN_PASSWORD, DATA_ENCRYPTION_KEY, PUBLIC_URL, ...
docker compose up -d --build
```

Put Caddy in front for automatic HTTPS (`/etc/caddy/Caddyfile`):

```
jobs.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

## Option D — Railway

Create a service from the repo (Dockerfile is detected), add a volume mounted at `/app/data`, and set the same variables.

## After deploying

1. Open the URL, sign in, upload your resume, verify the profile, fill the Answer bank.
2. Settings → Notifications: enable a channel and click **Send test**.
3. Settings → Notifications & schedule: confirm the timezone (`Asia/Kolkata`), search interval and digest time.
4. Run a few **dry runs** on Greenhouse/Lever jobs before you switch to automatic mode.

## Optional: external wake-up

If your host sleeps when idle, set the repository secrets `APP_URL` and `CRON_SECRET`. The workflow `.github/workflows/scheduler-tick.yml` then calls `POST /api/internal/tick` every 3 hours. On always-on hosts it is not needed.

## Backups

Back up the whole `data/` directory **and** your `DATA_ENCRYPTION_KEY`, kept separately. Without the key the backup cannot be read.

## Splitting web and worker (optional)

`npm run start:web` and `npm run start:worker` (or `APP_MODE=web|worker`) run them as separate processes. Both need access to the same `data/` directory, so this only makes sense on a single machine.
