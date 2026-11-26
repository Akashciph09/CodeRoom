#!/usr/bin/env bash
# Build and (re)start everything. Safe to run repeatedly: migrations are applied once each, data
# lives in Docker volumes, and only changed services are recreated.
#   git pull && deploy/scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "deploy/.env is missing — run deploy/scripts/gen-secrets.sh first." >&2; exit 1; }

# The worker starts sandboxes from these images on the host's Docker daemon.
docker build -q -t coderoom-runner-python ../sandbox/images/python
docker build -q -t coderoom-runner-javascript ../sandbox/images/javascript

docker compose build
docker compose up -d --remove-orphans --wait
docker compose ps
docker image prune -f >/dev/null
echo "Deployed. Health: $(grep '^API_URL=' .env | cut -d= -f2-)/health"
