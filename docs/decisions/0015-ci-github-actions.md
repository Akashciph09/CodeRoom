# 0015 — CI on GitHub Actions: fast checks, then the real stack

**Status:** Accepted — implemented (`.github/workflows/ci.yml`, `scripts/ci/integration.sh`)

## Context
Until now every test — unit, smoke, realtime, browser — ran only on the author's machine, and each PR said "no CI". Twice a fix was pushed to a branch after its PR had already merged, which only manual checking caught. Reviewers had no independent signal that the tests pass.

## Decision
- **GitHub Actions**, triggered on every pull request, on pushes to `main`, and manually. A newer push cancels the older run.
- **Two jobs:**
  1. **checks** — `pnpm install --frozen-lockfile`, typecheck, unit tests (Vitest), production build. Fast; fails early.
  2. **integration** (after checks) — the real stack inside the runner: local Supabase (`supabase start`, from the repo's dev dependency), Redis (the repo's compose file), the sandbox images, two API instances, the worker and the web app; then `pnpm smoke` (3 suites), the realtime smoke across both API instances, and the Playwright browser tests with bundled Chromium.
- **One script for CI and laptops.** The integration job runs `scripts/ci/integration.sh`; the same command reproduces a CI failure locally. In CI it generates `.env` from `.env.example` plus the local publishable key from `supabase status` (local-only defaults; no secrets in the repo or in Actions). On failure the API/worker/web logs and the Playwright report are uploaded as an artifact.
- **Supply chain:** each action is pinned to a full commit SHA (with its version in a comment), and the workflow token is read-only (`permissions: contents: read`).
- **Branch protection** (requiring both jobs on the PR's final commit before merge) is a repository setting, enabled separately by the owner once CI is green.

## Alternatives considered
- **Unit tests only in CI** — fast, but most of this project's guarantees (sandbox, hidden tests, realtime, races, privacy) are proven by the smoke and browser suites.
- **Service containers for Postgres/Redis** — Supabase Auth, Storage and the migrations need the Supabase stack; running the same CLI as developers avoids a second, divergent setup.
- **Tag-pinned actions (`@v7`)** — tags can be moved; SHAs can't.
- **A hosted test Supabase project** — shared state across runs and real credentials in CI; the local stack is isolated and free.

## Consequences
- Every PR gets a status check; together with branch protection, a PR can't merge on a commit that wasn't tested.
- The integration job takes several minutes (pulling Supabase images dominates).
- Playwright retries once in CI (`retries: CI ? 1 : 0`); a retry that passes is reported as flaky.
