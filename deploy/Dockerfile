# Production images for the self-hosted deployment (ADR 0022). Build context: the repo root.
#   api      — Express + WebSocket gateway
#   worker   — BullMQ consumer; runs sandboxes through the host's Docker daemon
#   migrate  — one-shot: applies supabase/migrations (+ seed) with the Supabase CLI
#   web      — Caddy serving the built client and reverse-proxying the API and Auth

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app

# ---- build everything once ------------------------------------------------------------------------
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
# No URLs baked in: the web app reads them at runtime from /config.js, which Caddy serves from
# deploy/.env. So these images are the same for every deployment and can be prebuilt in CI.
RUN pnpm -r build
# The migrate image needs only the Supabase CLI binary, not the workspace's dev dependencies.
# (Resolved the way the CLI's own launcher does: the per-platform package @supabase/cli-<os>-<arch>.)
RUN bin=$(node -e 'const { createRequire } = require("node:module"); const path = require("node:path"); \
      const req = createRequire(require.resolve("supabase/package.json")); \
      const arch = { x64: "x64", arm64: "arm64" }[process.arch]; \
      console.log(path.join(path.dirname(req.resolve(`@supabase/cli-linux-${arch}/package.json`)), "bin", "supabase"))') \
    && cp "$bin" /usr/local/bin/supabase && supabase --version

# ---- runtime: production dependencies + compiled output, for one app ------------------------------
FROM base AS runtime-deps
ARG APP
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/${APP}/package.json apps/${APP}/
RUN pnpm install --frozen-lockfile --prod --filter "@coderoom/${APP}..."
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/apps/${APP}/dist apps/${APP}/dist

FROM runtime-deps AS api
ENV NODE_ENV=production
WORKDIR /app/apps/api
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]

FROM runtime-deps AS worker
ENV NODE_ENV=production
# Only the Docker CLI: containers run on the host daemon through the mounted socket.
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app/apps/worker
# Root inside this container: talking to the Docker socket is root-equivalent anyway (see ADR 0022).
CMD ["node", "dist/index.js"]

# ---- migrations -----------------------------------------------------------------------------------
FROM debian:bookworm-slim AS migrate
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/supabase /usr/local/bin/supabase
WORKDIR /app
COPY supabase supabase
# --include-seed adds the shared "Sum two numbers" question; the CLI records seed files and skips them later.
CMD ["sh", "-c", "exec supabase db push --db-url \"$MIGRATE_DATABASE_URL\" --include-seed --yes"]

# ---- web + reverse proxy --------------------------------------------------------------------------
FROM caddy:2.10-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
# A broken Caddyfile fails the build here, not on the server.
RUN APP_ADDRESS=http://app.test API_ADDRESS=http://api.test caddy validate --config /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv/web
