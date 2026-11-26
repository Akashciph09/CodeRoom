#!/usr/bin/env bash
# Pull (or build) and (re)start everything. Safe to run repeatedly: migrations are applied once each,
# data lives in Docker volumes, and only changed services are recreated.
#   git pull && deploy/scripts/deploy.sh                  # prebuilt images from GHCR (small VMs)
#   BUILD_LOCALLY=1 deploy/scripts/deploy.sh              # build the images on this machine instead
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "deploy/.env is missing — run deploy/scripts/gen-secrets.sh first." >&2; exit 1; }

# The worker starts sandboxes from these images on the host's Docker daemon. They're a few lines
# each (a base image + a non-root user), so building them here is cheap even on a small VM.
docker build -q -t coderoom-runner-python ../sandbox/images/python
docker build -q -t coderoom-runner-javascript ../sandbox/images/javascript

if [ "${BUILD_LOCALLY:-0}" = 1 ]; then
  docker compose build
else
  # Our images come from .github/workflows/images.yml (CODEROOM_TAG in .env pins a version).
  docker compose pull --quiet
fi
docker compose up -d --remove-orphans --no-build --wait
docker compose ps
docker image prune -f >/dev/null
echo "Deployed. Health: $(grep '^API_URL=' .env | cut -d= -f2-)/health"
