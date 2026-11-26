# Deploying CodeRoom (free, on one VM)

Everything — Postgres, Auth, Redis, API, worker, web — runs on one Oracle Cloud **Always Free** ARM VM
behind Caddy with automatic HTTPS. The reasoning, alternatives and trade-offs are in
[ADR 0022](../docs/decisions/0022-self-hosted-single-vm.md).

```
             https://app.<ip>.sslip.io                 https://api.<ip>.sslip.io
                       │                                          │
             ┌─────────▼──────────────── Caddy (web) ─────────────▼──────────┐
             │ /           → built web app        everything → api:4000       │
             │ /auth/v1/*  → auth:9999 (GoTrue)   (REST + WebSockets)         │
             └────────────────────────────────────────────────────────────────┘
   auth ──► db (supabase/postgres)  ◄── api ──► redis ◄── worker ──► host Docker ──► sandbox containers
                       ▲
             migrate (one-shot: supabase db push + seed)
```

Expected cost within Oracle’s Always Free allowances is $0. Setup takes about an hour, mostly in the Oracle console.

## 1. Oracle Cloud account

1. Sign up at cloud.oracle.com. A card is needed for identity checks; the Always Free resources cost nothing.
   Pick your **home region** carefully: Always Free compute only runs there, and popular regions
   sometimes have no free ARM capacity.
2. Stay on the **Always Free account** and select resources marked Always Free eligible. Capacity
   depends on your home region, and Oracle may reclaim idle instances. Keep off-VM backups so you can recover.
   [Oracle Always Free limits](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
3. Pay As You Go is optional. Resources outside the free allowances can incur charges after upgrading.
   Oracle budget alerts notify you of spending and do not cap it.
   [Oracle budgets](https://docs.oracle.com/en-us/iaas/Content/Billing/Concepts/budgetsoverview.htm)

## 2. The VM

Compute → Instances → Create:

| Setting | Value |
|---|---|
| Image | Canonical Ubuntu 24.04 |
| Shape | Ampere `VM.Standard.A1.Flex` with **2 OCPUs and 12 GB RAM** (the total Always Free A1 allowance) |
| Networking | Create a VCN with a public subnet; assign a public IPv4 address |
| SSH key | Upload your public key |
| Boot volume | 100 GB (Always Free includes 200 GB of block storage in total) |

"Out of capacity"? Retry later, or try another availability domain in the same region.

Note the **public IP**, e.g. `140.238.10.20`. Your free hostnames are then
`app.140-238-10-20.sslip.io` and `api.140-238-10-20.sslip.io` (sslip.io resolves them to that IP —
nothing to register or renew).

### Open ports 80 and 443

1. **Oracle firewall:** VCN → the subnet's Security List → Add Ingress Rules from `0.0.0.0/0`:
   TCP 80, TCP 443, UDP 443. Restrict the existing SSH rule (TCP 22) to your own IP if you can.
2. **Ubuntu's firewall** (Oracle images ship with restrictive iptables rules) — on the VM:

   ```bash
   sudo iptables -I INPUT 1 -p tcp -m multiport --dports 80,443 -j ACCEPT
   sudo iptables -I INPUT 1 -p udp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```

## 3. Prepare the VM

```bash
ssh ubuntu@<public-ip>
```

```bash
sudo apt-get update && sudo apt-get -y upgrade
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu && newgrp docker
```

Security updates install themselves (`unattended-upgrades` is on by default in Ubuntu). Let them
reboot the VM when a kernel update needs it — every container comes back on its own:

```bash
printf 'Unattended-Upgrade::Automatic-Reboot "true";\nUnattended-Upgrade::Automatic-Reboot-Time "04:00";\n' | sudo tee /etc/apt/apt.conf.d/52coderoom-reboot
```

**This VM runs untrusted code.** The worker controls Docker, which is root-equivalent on this
machine (the sandboxes themselves are locked down — ADR 0004). Don't run anything else on it.

## 4. Configure and deploy

```bash
git clone https://github.com/Akashciph09/CodeRoom.git && cd CodeRoom
```

```bash
deploy/scripts/gen-secrets.sh https://app.140-238-10-20.sslip.io https://api.140-238-10-20.sslip.io
```

This writes `deploy/.env` (mode 600) with the database password and the ES256 signing key.
**Keep a copy in your password manager** so a restore can reuse those settings.

Optional — AI features (summaries, question drafts, test suggestions):

```bash
test -e deploy/api.env || install -m 600 deploy/api.env.example deploy/api.env
chmod 600 deploy/api.env
nano deploy/api.env
```

Deploy:

```bash
deploy/scripts/deploy.sh
```

The first run builds the images (about 10 minutes on the free VM), applies the migrations, seeds the
"Sum two numbers" question and waits for service health checks. The worker check verifies access to Docker,
both sandbox images, and the writable run directory. Caddy obtains HTTPS certificates automatically.
Open `https://app.<ip>.sslip.io`, sign up as the interviewer, and
from a private window as the candidate.

Once your accounts exist, close sign-ups: add `AUTH_DISABLE_SIGNUP=true` to `deploy/.env` and run
`deploy/scripts/deploy.sh` again. There is no mail server, so sign-ups are confirmed automatically and
password reset by email isn't available.

## 5. Backups

Nightly at 03:15 (keeps the latest 14 in `deploy/backups/`):

```bash
(crontab -l 2>/dev/null; echo "15 3 * * * cd $HOME/CodeRoom && deploy/scripts/backup.sh >> $HOME/coderoom-backup.log 2>&1") | crontab -
```

Those dumps live on the same VM, so also keep a copy elsewhere:
- **Boot volume backups:** Block Storage → Boot Volumes → your volume → Backup Policies. Always Free
  includes a few volume backups; a weekly policy covers losing the VM.
- **Off the VM:** copy a dump now and then (`scp ubuntu@<ip>:CodeRoom/deploy/backups/*.dump .`), or
  sync them to Oracle Object Storage (also part of Always Free).

Restore (a new VM, or after `docker compose down -v`), with the original `deploy/.env` in place:

```bash
deploy/scripts/restore.sh deploy/backups/coderoom-<time>.dump && deploy/scripts/deploy.sh
```

## 6. Monitoring

An HTTP monitor on `https://api.<ip>.sslip.io/health` checks whether the API can reach Postgres and
Redis. Check `docker compose -f deploy/docker-compose.yml ps worker` for worker readiness. After
deploying, run a candidate submission to confirm end-to-end grading.

## Day-to-day

| Task | Command (in `~/CodeRoom`) |
|---|---|
| Ship the latest `main` | `git pull && deploy/scripts/deploy.sh` |
| Status | `docker compose -f deploy/docker-compose.yml ps` |
| Logs | `docker compose -f deploy/docker-compose.yml logs -f api worker` |
| Restart one service | `docker compose -f deploy/docker-compose.yml restart api` |
| Database shell | `docker compose -f deploy/docker-compose.yml exec db psql -U postgres` |

New migrations in `supabase/migrations/` are applied by the `migrate` step of every deploy, before the
API and worker start. Image versions of Postgres and GoTrue are pinned in `docker-compose.yml`; bump
them deliberately, after a backup.

## Rehearse locally

The same stack runs on a laptop over plain HTTP (app on `localhost:8080`, API on `localhost:8081`),
in its own Compose project, so it never touches your dev data:

```bash
cd deploy
export COMPOSE_FILE=docker-compose.yml:compose.rehearsal.yml COMPOSE_ENV_FILES=rehearsal.env
export AUTH_JWT_KEYS="$(docker run --rm node:22-alpine node -e 'const c=require("node:crypto");const {privateKey}=c.generateKeyPairSync("ec",{namedCurve:"P-256"});console.log(JSON.stringify([{...privateKey.export({format:"jwk"}),kid:c.randomUUID(),use:"sig",alg:"ES256",key_ops:["sign","verify"]}]))')"
docker build -q -t coderoom-runner-python ../sandbox/images/python && docker build -q -t coderoom-runner-javascript ../sandbox/images/javascript
docker compose up -d --build --wait
```

Run the browser tests against it (from the repo root):

```bash
E2E_WEB_URL=http://localhost:8080 E2E_API_URL=http://localhost:8081 \
  E2E_SUPABASE_URL=http://localhost:8080 pnpm e2e
```

The smoke scripts also take `SMOKE_API_URL=http://localhost:8081` and `SUPABASE_URL=http://localhost:8080`.
Some of their checks use Postgres and Redis directly, so publish those ports with a small extra
Compose file first. Clean up with `docker compose down -v`.

## Troubleshooting

- **The site doesn't load:** check both firewalls (step 2), then `docker compose -f deploy/docker-compose.yml logs web`.
- **Certificate errors:** Caddy needs ports 80 and 443 reachable from the internet. sslip.io is
  shared by many people, so Let's Encrypt rate limits can occasionally bite; a free DuckDNS name or
  your own domain works the same way (put its URLs in `deploy/.env`).
- **Runs stay "queued":** `docker compose -f deploy/docker-compose.yml logs worker`; check the
  sandbox images exist (`docker images | grep coderoom-runner`). Stuck submissions are re-queued
  automatically once the worker is back.
- **Changing the hostnames** (new IP or domain): edit `APP_URL`/`API_URL` in `deploy/.env` and redeploy.
  Everyone has to sign in again, since tokens name the old issuer.
