# 0022 — Deploy on one free VM, self-hosting Postgres and Auth

**Status:** Accepted — implemented (`deploy/`)

## Context
CodeRoom had no deployment. Constraints for one:
- **$0**, and it must **stay up for months untouched**: a portfolio link that's dead when a reviewer opens it is worse than none.
- **The worker needs a real Docker daemon.** It starts a fresh, locked-down container per test (ADR 0004). Free app platforms (Render, Vercel, Netlify, Fly's paid-only machines) don't provide one. Only a VM does.
- **Hosted Supabase's free plan pauses a project after about a week without activity.** A paused project breaks sign-in and every API call until someone restores it by hand.
- **Oracle Cloud's Always Free tier** has an ARM VM of up to 4 cores and 24 GB RAM, enough for everything. Oracle may reclaim *idle* free VMs, but not on an account upgraded to Pay As You Go, where Always Free resources still cost nothing.

## Decision
Everything runs on **one Oracle Always Free ARM VM** (Pay As You Go account, so not reclaimed), as one Docker Compose project in `deploy/`:
- **Postgres and Auth, self-hosted:** the same Supabase images the local CLI runs (`supabase/postgres` 17 and `gotrue`), pinned to the versions used in development.
  - **No PostgREST, Storage, Realtime or Studio.** We never used them from the browser (ADR 0005, 0006), so they aren't deployed. Caddy returns 404 for their paths, which leaves less exposed than relying on RLS alone.
  - **Tokens stay ES256 and are verified via JWKS (ADR 0002).** GoTrue signs with a P-256 key generated per server (`GOTRUE_JWT_KEYS`). The API fetches the public keys from the auth container over the internal network (new optional `SUPABASE_JWKS_URL`), while the issuer stays the public URL.
  - **Migrations:** the Supabase CLI's `db push` runs in a one-shot `migrate` container before the API and worker start. It's the same tool and migration history as development, plus the seed question.
- **Caddy serves the built web app and fronts everything:**
  - two hostnames, the app (static files, plus Auth under `/auth/v1`) and the API (REST + WebSockets);
  - Let's Encrypt certificates, obtained and renewed automatically;
  - free hostnames from `sslip.io`, so there's no domain to renew.
- **The worker uses the host's Docker daemon:**
  - it reaches the daemon through the mounted socket;
  - code files live in a directory mounted at the same path inside and outside the container, because the sandbox mounts them by host path.
  - The sandbox flags are unchanged (ADR 0004).
- **Operations:**
  - every service has a healthcheck and `restart: unless-stopped`;
  - Docker's log driver rotates logs;
  - `deploy.sh` waits until every service is healthy, and is safe to rerun;
  - `backup.sh` (nightly cron) dumps `public`, `auth` and the migration history and keeps 14 dumps;
  - `restore.sh` restores a dump into an empty database.
- **Rehearsal:** `compose.rehearsal.yml` runs the same stack on a laptop over plain HTTP. It was verified before this was merged:
  - all smoke suites (including realtime) and the full Playwright suite pass against it;
  - backup → wipe → restore reproduced identical row counts, and the smoke tests passed again afterwards.

## Alternatives considered
- **Hosted Supabase free tier + a VM for the rest:** less to run, but the project pauses after a week idle. A keep-alive ping probably prevents that, but it isn't a documented guarantee, and the free tier's limits are outside our control.
- **Supabase Pro ($25/month) or a paid VPS (~$5/month):** more reliable (no capacity lottery, managed backups with Pro). Rejected only because of the $0 constraint; a paid VPS is the documented fallback and needs no changes to `deploy/`.
- **Full self-hosted Supabase stack (Kong, Studio, Storage, Realtime…):** about ten containers for features we deliberately don't use, and more attack surface.
- **Kubernetes (k3s), Nomad, Coolify:** orchestration for a single machine adds moving parts and no availability.
- **Render / Fly / Railway for the API:** no Docker daemon for the worker; Render's free tier also sleeps after 15 minutes idle, which drops WebSocket sessions.
- **Upstash (managed Redis):** BullMQ polls constantly, so it would burn through the free command quota. Redis on the VM costs nothing extra.

## Consequences
- **One machine is the single point of failure.** If the VM is lost, the database goes with it, except for dumps copied off it. The guide covers Oracle's free boot-volume backups and copying dumps to Object Storage (also free).
- **The VM runs untrusted code, so it must be dedicated.** The worker's access to the Docker socket is root-equivalent on the VM; the sandbox containers themselves stay locked down. Nothing else should run there, and only ports 22 (restricted), 80 and 443 are open.
- **No email.** There's no mail server, so accounts are confirmed automatically at sign-up (`GOTRUE_MAILER_AUTOCONFIRM`), and password reset by email doesn't work. After creating the accounts you need, `AUTH_DISABLE_SIGNUP=true` closes sign-ups.
- **Upgrades are ours:** Postgres and GoTrue image versions are pinned and bumped deliberately, and OS security patches come from `unattended-upgrades`.
- **Oracle can change its free terms** or run out of ARM capacity in a region; moving to any VPS is `gen-secrets` (or the old `.env`) + `restore.sh` + `deploy.sh`.
- **The test suites now run against any deployment.** The smoke scripts already took URLs. Playwright takes `E2E_WEB_URL` and `E2E_API_URL`, and the check that the candidate never receives private data now identifies API responses by that URL instead of a hard-coded port 4000.
