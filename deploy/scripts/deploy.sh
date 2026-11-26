#!/usr/bin/env bash
# Pull (or build) and (re)start everything. Safe to run repeatedly: migrations are applied once each,
# data lives in Docker volumes, and only changed services are recreated.
#   git pull && deploy/scripts/deploy.sh            # this commit's images, prebuilt in CI (small VMs)
#   BUILD_LOCALLY=1 deploy/scripts/deploy.sh        # build them on this machine instead (≥4 GB RAM)
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "deploy/.env is missing — run deploy/scripts/gen-secrets.sh first." >&2; exit 1; }

# One release = the four images built from the commit checked out here, so the images always match
# this compose file and these migrations (.github/workflows/images.yml publishes sha-<commit> for every
# commit on main). CODEROOM_TAG in deploy/.env overrides it — for emergencies only.
if [ "${BUILD_LOCALLY:-0}" = 1 ]; then
  # Built from this working tree, uncommitted changes included: a local tag, never a CI release tag.
  grep -q '^CODEROOM_TAG=' .env || export CODEROOM_TAG="local-$(git rev-parse --short=12 HEAD)"
elif ! grep -q '^CODEROOM_TAG=' .env; then
  if [ -n "$(git status --porcelain --untracked-files=no -- . ../apps ../packages ../supabase)" ]; then
    echo "Uncommitted changes in the checkout: prebuilt images wouldn't match them." >&2
    echo "Discard them (git checkout -- .) or use BUILD_LOCALLY=1." >&2
    exit 1
  fi
  export CODEROOM_TAG="sha-$(git rev-parse HEAD)"
fi
echo "Release: ${CODEROOM_TAG:-$(grep '^CODEROOM_TAG=' .env | cut -d= -f2-)}"

# The worker starts sandboxes from these images on the host's Docker daemon. They're a few lines
# each (a base image + a non-root user), so building them here is cheap even on a small VM.
docker build -q -t coderoom-runner-python ../sandbox/images/python
docker build -q -t coderoom-runner-javascript ../sandbox/images/javascript

if [ "${BUILD_LOCALLY:-0}" = 1 ]; then
  docker compose build
else
  # All four must pull before anything restarts: a partial release never starts.
  if ! docker compose pull --quiet migrate api worker web; then
    echo >&2
    echo "Couldn't pull this commit's images. Either the Images workflow for this commit hasn't finished" >&2
    echo "(GitHub → Actions → Images; wait, or 'git pull' to a commit that has them), or the packages" >&2
    echo "are private (see deploy/README.md, step 4). Nothing was restarted." >&2
    exit 1
  fi
  docker compose pull --quiet db auth redis
fi
docker compose up -d --remove-orphans --no-build --wait
docker compose ps
docker image prune -f >/dev/null
echo "Deployed. Health: $(grep '^API_URL=' .env | cut -d= -f2-)/health"
