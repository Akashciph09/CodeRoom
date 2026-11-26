#!/usr/bin/env bash
# Nightly database backup (cron: see deploy/README.md). Keeps the newest $KEEP dumps in deploy/backups.
# Dumps the schemas CodeRoom needs to come back: app data (public), accounts (auth) and the
# migration history (supabase_migrations). Restore with restore.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
KEEP=${KEEP:-14}
mkdir -p backups
chmod 700 backups

out="backups/coderoom-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T db pg_dump -U supabase_admin -d postgres -Fc \
  --schema=public --schema=auth --schema=supabase_migrations > "$out.partial"
mv "$out.partial" "$out"
chmod 600 "$out"

# Retention: newest $KEEP only.
ls -1t backups/coderoom-*.dump | tail -n +"$((KEEP + 1))" | xargs -r rm --
echo "$(date -u +%FT%TZ) backup ok: $out ($(du -h "$out" | cut -f1))"
