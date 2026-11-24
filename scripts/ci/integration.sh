#!/usr/bin/env bash
#
# Integration suites against a real local stack — the same steps in CI and on a laptop (ADR 0015):
#   local Supabase + Redis + sandbox images → build → 2 API instances, worker, web app →
#   pnpm smoke (3 suites) → realtime smoke across both instances → Playwright browser tests.
#
# Usage:  bash scripts/ci/integration.sh
#   Needs Docker, Node 22 (20 works), pnpm, `pnpm install` done, and ports 4000/4001/5173 free.
#   PLAYWRIGHT_CHANNEL=chrome uses installed Chrome; empty uses Playwright's bundled Chromium (CI).
#   In CI (CI=true) `.env` is generated from `.env.example`; locally an existing `.env` is kept.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
LOGS="${CI_LOG_DIR:-$ROOT/.ci-logs}"
mkdir -p "$LOGS"

group() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::group::$*"; else echo "==> $*"; fi; }
endgroup() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::endgroup::"; fi; }

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT

port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for port in 4000 4001 5173; do
  if ! port_free "$port"; then
    echo "Port $port is in use — stop the dev servers first (this script starts its own)." >&2
    exit 1
  fi
done

wait_for() { # url, name
  for _ in $(seq 1 90); do
    if curl -sf -o /dev/null "$1"; then echo "$2 is up"; return 0; fi
    sleep 1
  done
  echo "$2 did not come up at $1 — see $LOGS" >&2
  return 1
}

group "Stack: Supabase, Redis, sandbox images"
if ! pnpm exec supabase status >/dev/null 2>&1; then pnpm exec supabase start; fi
pnpm infra:up
pnpm sandbox:build
endgroup

group "Environment"
if [ "${CI:-}" = "true" ] || [ ! -f .env ]; then
  cp .env.example .env
  key="$(pnpm exec supabase status -o env | sed -n 's/^PUBLISHABLE_KEY="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p')"
  if [ -z "$key" ]; then echo "Couldn't read the local publishable key from supabase status" >&2; exit 1; fi
  sed -i.bak "s|^VITE_SUPABASE_PUBLISHABLE_KEY=.*|VITE_SUPABASE_PUBLISHABLE_KEY=$key|" .env && rm -f .env.bak
  echo ".env written from .env.example (local Supabase defaults)"
else
  echo "Using the existing .env"
fi
endgroup

group "Build"
pnpm build
endgroup

group "Start: API ×2, worker, web"
(cd apps/api && PORT=4000 node dist/index.js >"$LOGS/api-4000.log" 2>&1) & PIDS+=($!)
(cd apps/api && PORT=4001 node dist/index.js >"$LOGS/api-4001.log" 2>&1) & PIDS+=($!)
(cd apps/worker && node dist/index.js >"$LOGS/worker.log" 2>&1) & PIDS+=($!)
(cd apps/web && exec ./node_modules/.bin/vite --port 5173 --strictPort >"$LOGS/web.log" 2>&1) & PIDS+=($!)
wait_for http://localhost:4000/health "API :4000"
wait_for http://localhost:4001/health "API :4001"
wait_for http://localhost:5173/ "Web :5173"
endgroup

group "Smoke (REST, questions, rooms)"
pnpm smoke
endgroup

group "Realtime smoke across two API instances"
SMOKE_API_URL_2=http://localhost:4001 pnpm smoke:realtime
endgroup

group "Browser tests (Playwright)"
pnpm e2e
endgroup

echo "All integration suites passed."
