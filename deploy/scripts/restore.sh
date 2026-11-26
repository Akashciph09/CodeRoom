#!/usr/bin/env bash
# Restore a backup.sh dump into an EMPTY database — a new server, or after `docker compose down -v`.
#   deploy/scripts/restore.sh deploy/backups/coderoom-<time>.dump
# Needs the same deploy/.env as the backup came from (password and signing key), or users must sign in again.
set -euo pipefail
dump=$(realpath "${1:?usage: restore.sh <file.dump>}")
[ -f "$dump" ] && [ -r "$dump" ] || { echo "Cannot read backup: $dump" >&2; exit 1; }
cd "$(dirname "$0")/.."

if docker compose ps --status running --services | grep -qx auth; then
  echo "Stop the stack first (docker compose down); restore runs against the database alone." >&2
  exit 1
fi
docker compose up -d --wait db
if [ "$(docker compose exec -T db psql -U supabase_admin -d postgres -tAc "select to_regclass('public.rooms') is not null")" = "t" ]; then
  echo "This database already has CodeRoom tables — restore only into an empty one." >&2
  exit 1
fi

# Auth isn't running, so the dump's auth schema (with its migration history) replaces the image's
# empty one, and GoTrue finds itself up to date when it starts. Owners are kept from the dump.
docker compose exec -T db pg_restore -U supabase_admin -d postgres --clean --if-exists --exit-on-error < "$dump"
echo "Restored $dump. Now run deploy/scripts/deploy.sh."
