# Deploying CodeRoom (free, on one VM)

Everything — Postgres, Auth, Redis, API, worker, web — runs on one small VM behind Caddy with
automatic HTTPS. It fits in **1 GB of RAM** (plus swap), so a free student VM is enough. The reasoning,
alternatives and trade-offs are in [ADR 0022](../docs/decisions/0022-self-hosted-single-vm.md).

```
             https://app.<ip>.sslip.io                 https://api.<ip>.sslip.io
                       │                                          │
             ┌─────────▼──────────────── Caddy (web) ─────────────▼──────────┐
             │ /           → built web app        everything → api:4000       │
             │ /config.js  → URLs from deploy/.env (REST + WebSockets)         │
             │ /auth/v1/*  → auth:9999 (GoTrue)                                │
             └────────────────────────────────────────────────────────────────┘
   auth ──► db (supabase/postgres)  ◄── api ──► redis ◄── worker ──► host Docker ──► sandbox containers
                       ▲
             migrate (one-shot: supabase db push + seed)
```

**The VM never compiles anything.** GitHub Actions ([`images.yml`](../.github/workflows/images.yml))
builds our four images for every commit on `main` and publishes them to GitHub's container registry
as `ghcr.io/akashciph09/coderoom-{api,worker,migrate,web}:sha-<commit>`. `deploy.sh` pulls the four
images of the commit the server has checked out — so images, compose file and migrations always come
from the same commit — and restarts nothing unless all four pulled. The images hold no
settings: URLs and secrets come from `deploy/.env` on the server, so one image fits every deployment.

Measured on the local rehearsal with these settings: about 315 MB idle and 500 MB peak for the whole
stack during the smoke and browser suites, plus up to 256 MB per running sandbox (one at a time).

## 1. Get a VM

Any Ubuntu 24.04 VM with ≥1 GB RAM, a public IPv4 address and ports 22, 80 and 443 open works.
Two free routes:

### Azure for Students (no credit card)

Azure for Students gives full-time students $100 of credit for 12 months, without a card, plus 750
free hours a month of a few small VM sizes. When the credit runs out, resources stop: there is no bill.

1. **Find a region and size you're allowed to use.** Student subscriptions only allow a few regions, and
   not every free size is offered in each. In the portal, open Cloud Shell (`>_`, Bash, "No storage
   account required"), then:

   ```bash
   az policy assignment list --query "[].parameters.listOfAllowedLocations.value" -o tsv
   ```

   For each allowed region (closest first), check the free sizes; `AVAILABLE` means you can use it:

   ```bash
   az vm list-skus -l <region> --size Standard_B --all --query "[?name=='Standard_B1s'||name=='Standard_B2ats_v2'||name=='Standard_B2pts_v2'].[name, restrictions[0].reasonCode || 'AVAILABLE']" -o tsv
   ```

2. **Create the VM** (Virtual machines → Create):

   | Tab | Setting | Value |
   |---|---|---|
   | Basics | Region | the one you found (e.g. India South Central) |
   | | Image | Ubuntu Server 24.04 LTS — **x64** |
   | | Size | **Standard_B2ats_v2** (2 vCPU, 1 GB) or Standard_B1s — search by name with filters cleared; the default sizes cost $50+/month |
   | | Authentication | SSH public key, generate a new key pair, username `azureuser` |
   | | Inbound ports | SSH (22), HTTP (80), HTTPS (443) |
   | Disks | OS disk | Standard SSD, default size; **Delete with VM** checked |
   | Networking | | defaults (new public IP — Standard SKU, so it's static) |
   | Management | System-assigned managed identity | **off** (this VM runs untrusted code; it needs no Azure identity) |
   | | Auto-shutdown | off |
   | Monitoring | Boot diagnostics | managed storage (a few cents; gives you the Serial console if SSH ever breaks) |

   Download the private key when asked — it's the only way in — then on your Mac:

   ```bash
   mkdir -p ~/.ssh && mv ~/Downloads/<key>.pem ~/.ssh/ && chmod 600 ~/.ssh/<key>.pem
   ```

3. **Cost check:** the compute is free within the 750 hours; the public IP (~$3–4/month) and disk come
   out of the credit. Add a budget alert (Cost Management → Budgets, e.g. $5/month), and the next day
   check the **Free services** page shows your VM's free hours being used.

### Oracle Cloud Always Free (needs a card for verification)

Ampere A1 ARM shape, Ubuntu 24.04, public IPv4. Open TCP 80/443 (and UDP 443) in the subnet's
Security List, and in Ubuntu's iptables (Oracle images ship restrictive rules):

```bash
sudo iptables -I INPUT 1 -p tcp -m multiport --dports 80,443 -j ACCEPT && sudo iptables -I INPUT 1 -p udp --dport 443 -j ACCEPT && sudo netfilter-persistent save
```

The prebuilt images are x64 only; on ARM, deploy with `BUILD_LOCALLY=1` (step 4) — fine on Oracle's
larger ARM shapes, not on 1 GB.

### Your hostnames

With public IP `172.128.33.87`, your free hostnames are `app.172-128-33-87.sslip.io` and
`api.172-128-33-87.sslip.io` — sslip.io resolves them to that IP, nothing to register or renew.

## 2. Log in

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/<key>.pem azureuser@<public-ip>
```

(`IdentitiesOnly` stops your SSH client offering other keys first, which can make the server close the
connection.)

## 3. Prepare the VM (once)

```bash
git clone https://github.com/Akashciph09/CodeRoom.git && cd CodeRoom
```

```bash
sudo bash deploy/scripts/setup-vm.sh
```

It installs Docker (with Compose and Buildx), adds 2 GB of swap (a 1 GB VM needs it), turns on
automatic security updates with a 04:00 reboot when one needs it, and creates the directory for
submitted code. Log out and back in afterwards so your user can run `docker`.

**This VM runs untrusted code.** The worker controls Docker, which is root-equivalent on this
machine (the sandboxes themselves are locked down — ADR 0004). Don't run anything else on it.

## 4. Configure and deploy

```bash
deploy/scripts/gen-secrets.sh https://app.<ip-with-dashes>.sslip.io https://api.<ip-with-dashes>.sslip.io
```

This writes `deploy/.env` (mode 600) with the database password and the ES256 signing key.
**Keep a copy in your password manager** so a restore can reuse those settings. Run it once per server.

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

It pulls this commit's images (the **Images** run for that commit on GitHub must have finished),
applies the migrations, seeds the "Sum two numbers" question and waits for every
service's health check. The worker check verifies access to Docker, both sandbox images, and the
writable run directory. Caddy obtains HTTPS certificates on the first request. Open
`https://app.<ip>.sslip.io`, sign up as the interviewer, and from a private window as the candidate.

**Images are public packages.** GitHub creates new packages as private; the first time
`images.yml` publishes them, open your GitHub profile → Packages → each `coderoom-*` package →
Package settings → Change visibility → **Public** (they contain only open-source code, no settings).
Otherwise `deploy.sh` fails with "denied" — or log the VM in with a token that can read packages:
`echo <token> | docker login ghcr.io -u <github-user> --password-stdin`.

**Rolling back** = deploying an older commit: `git checkout <commit> && deploy/scripts/deploy.sh`
(then `git checkout main` to go forward again). Pick a commit whose **Images** run succeeded (GitHub →
Actions → Images): every commit on `main` gets a run, but a run can fail, and then that commit has
no images — `deploy.sh` stops without restarting anything. Only roll back past a commit that added a migration
after restoring a backup from before it — migrations only move forward.
`BUILD_LOCALLY=1 deploy/scripts/deploy.sh` builds the images on the machine instead — needs ≥4 GB RAM.
Always (re)start through `deploy.sh`: it selects the release; a bare `docker compose up` doesn't.

Once your accounts exist, close sign-ups: add `AUTH_DISABLE_SIGNUP=true` to `deploy/.env` and run
`deploy/scripts/deploy.sh` again. There is no mail server, so sign-ups are confirmed automatically and
password reset by email isn't available.

### Sizing

The defaults suit 1 GB. On a bigger machine raise them in `deploy/.env`:
`WORKER_CONCURRENCY` (default 1 sandbox at a time), `PG_SHARED_BUFFERS` (64MB), `API_HEAP_MB` (192),
`WORKER_HEAP_MB` (128), `REDIS_MAXMEMORY` (96mb), `SANDBOX_MEMORY_MB` (256).

## 5. Backups

Nightly at 03:15 (keeps the latest 14 in `deploy/backups/`):

```bash
(crontab -l 2>/dev/null; echo "15 3 * * * cd $HOME/CodeRoom && deploy/scripts/backup.sh >> $HOME/coderoom-backup.log 2>&1") | crontab -
```

Those dumps live on the same VM, so also keep a copy elsewhere:
- **Off the VM:** copy the dumps to your laptop now and then:
  `scp -i ~/.ssh/<key>.pem '<user>@<ip>:CodeRoom/deploy/backups/*.dump' .`
- **Disk snapshots** (Azure: the disk → Create snapshot; Oracle: boot volume backups) cover losing the
  VM, at a small storage cost.

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

- **The site doesn't load:** check the firewall (Azure: the VM's Networking → inbound rules for 80/443;
  Oracle: step 1), then `docker compose -f deploy/docker-compose.yml logs web`.
- **`deploy.sh` can't pull this commit's images:** the Images run for that commit hasn't finished
  (GitHub → Actions → Images), or — "denied" — the packages are still private (step 4). Nothing is
  restarted in that case; the old release keeps running.
- **`JavaScript heap out of memory` during a deploy:** it's building on the VM — use the prebuilt images
  (don't set `BUILD_LOCALLY` on small machines).
- **Certificate errors:** Caddy needs ports 80 and 443 reachable from the internet. sslip.io is
  shared by many people, so Let's Encrypt rate limits can occasionally bite; a free DuckDNS name or
  your own domain works the same way (put its URLs in `deploy/.env`).
- **Runs stay "queued":** `docker compose -f deploy/docker-compose.yml logs worker`; check the
  sandbox images exist (`docker images | grep coderoom-runner`). Stuck submissions are re-queued
  automatically once the worker is back.
- **Changing the hostnames** (new IP or domain): edit `APP_URL`/`API_URL` in `deploy/.env` and redeploy
  (no rebuild: the web app reads them from `/config.js`). Everyone has to sign in again, since tokens
  name the old issuer.
