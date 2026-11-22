# CodeRoom

**A live technical-interview platform where candidate code runs in isolated sandboxes and AI assists the interviewer — without ever deciding who gets hired.**

Interviewer and candidate share a room. The candidate writes code; every run goes through a queue to a disposable, locked-down Docker container and comes back with per-test verdicts. Hidden test cases never leave the server. An AI copilot (in progress) helps the interviewer prepare questions, ask follow-ups and summarize evidence against a rubric.

> **Status:** backend core is working and tested end-to-end (auth, rooms, submission pipeline, sandbox). Live collaborative editor, interviewer UI and AI features are next — see [Roadmap](#roadmap).

---

## Highlights

- **Untrusted code never touches the API server.** The API validates, stores and enqueues; separate workers execute.
- **Per-run Docker sandbox** with no network, memory/CPU/PID limits, read-only filesystem, dropped capabilities, non-root user and a hard timeout. An infinite loop is killed; a memory bomb is stopped; outbound HTTP fails.
- **Hidden tests stay hidden** — enforced three ways: a candidate-only serializer, a database `CHECK` constraint that refuses to store hidden-test output, and Row Level Security that blocks direct table access via Supabase's public API.
- **Per-room roles.** The same user can interview in one room and be a candidate in another; every request is checked against room membership.
- **Horizontally scalable execution.** Stateless BullMQ workers; add processes to add throughput. Retries are idempotent.
- **Every stack choice is documented** in [Architecture Decision Records](docs/decisions/README.md).

## Architecture

```mermaid
flowchart LR
    subgraph Browser
        W[React + Monaco]
    end
    subgraph Supabase
        AUTH[Auth<br/>ES256 JWT]
        PG[(Postgres<br/>RLS on all tables)]
        ST[(Storage<br/>private bucket)]
    end
    W -- sign in --> AUTH
    W -- REST + Bearer token --> API[Express API]
    API -- verify JWT via JWKS --> AUTH
    API -- Drizzle --> PG
    API -- enqueue submissionId --> Q[[Redis / BullMQ]]
    Q --> WK1[Worker]
    Q --> WK2[Worker ×N]
    WK1 -- docker run --network none ... --> SB[(Sandbox container)]
    WK1 -- results in one transaction --> PG
    WK1 -- submission:id:done --> PS[[Redis pub/sub]]
    PS -. planned .-> GW[WebSocket gateway<br/>Yjs sync]
    GW -. planned .-> W
```

### Submission flow

1. Candidate calls `POST /submissions` with a Supabase access token.
2. API verifies the token (JWKS, issuer, audience), checks the user is a **candidate in that room**, checks the room is open and the code size, then inserts the submission. The question comes from the room, not the client.
3. API enqueues a job containing **only the submission id** and returns `202 Accepted`.
4. A worker loads the submission and its test cases, then runs each test in a fresh container with stdin input and a wall-clock timeout.
5. Verdicts (`accepted`, `wrong_answer`, `time_limit_exceeded`, `memory_limit_exceeded`, `runtime_error`, …) and the overall result are written in **one transaction**, then announced on Redis pub/sub.
6. `GET /submissions/:id` returns a **candidate view** (public results + hidden pass count) or an **interviewer view** (everything), based on the caller's role in the room.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React, TypeScript, Vite, Monaco | Industry-standard editor (VS Code's) |
| API | Node.js, Express, TypeScript | Thin validate → persist → enqueue layer |
| Database | Postgres (Supabase) + Drizzle ORM | Relational domain, FKs and constraints enforce invariants — [ADR 0001](docs/decisions/0001-postgres-over-mongodb.md), [0003](docs/decisions/0003-drizzle-orm.md) |
| Auth / Storage | Supabase Auth, Supabase Storage | Commodity concerns, managed — [ADR 0002](docs/decisions/0002-supabase-for-auth-storage-postgres.md) |
| Queue | Redis + BullMQ | Retries, back-pressure, concurrency; Redis also does pub/sub — [ADR 0004](docs/decisions/0004-queue-and-docker-sandbox.md) |
| Execution | Docker (per-run containers) | Isolation with measurable limits — [ADR 0004](docs/decisions/0004-queue-and-docker-sandbox.md) |
| Realtime (planned) | Yjs over own WebSocket gateway | CRDT merging, latency control — [ADR 0005](docs/decisions/0005-yjs-over-own-websocket.md) |
| Validation | zod (shared package) | One schema for API, worker and DB enums |
| Testing | Vitest + end-to-end smoke script | Unit-tests every sandbox control; smoke test hits the real stack |

**Deliberately not used:** MongoDB, a separate S3/MinIO, Supabase Realtime, browser-side table queries ([ADR 0006](docs/decisions/0006-rls-deny-all-server-side-access.md)).

## Security model

| Threat | Control |
|---|---|
| Malicious code crashes or hijacks the server | Code never runs in the API; workers execute in disposable containers |
| Infinite loop / CPU exhaustion | `--cpus` quota + wall-clock timeout → `docker kill` |
| Memory bomb | `--memory` with equal `--memory-swap` (no swap) |
| Fork bomb | `--pids-limit 64` |
| Data exfiltration / calling out | `--network none` |
| Tampering with the image or host | `--read-only`, `noexec` tmpfs, `--cap-drop ALL`, `no-new-privileges`, non-root user, read-only code mount |
| Candidate reads hidden tests | Candidate serializer + DB `CHECK` constraint + RLS deny-all on Supabase REST |
| Forged identity / role | JWT verified against Supabase JWKS; roles looked up per room server-side, never trusted from the client |
| Probing other rooms | Non-participants get `403` whether or not the room exists |

## Getting started

### Prerequisites
- Node.js 22+ recommended (20 works for the backend; see note below)
- pnpm 9 (`corepack enable`)
- Docker Desktop (running)

### Setup

```bash
git clone https://github.com/<your-username>/coderoom.git
cd coderoom
pnpm install
cp .env.example .env
```

Start the local services:

```bash
pnpm db:start        # local Supabase: Postgres, Auth, Storage; applies migrations + seed
pnpm infra:up        # Redis
pnpm sandbox:build   # Python + JavaScript runner images
```

Copy the **publishable key** printed by `pnpm db:start` (or `pnpm exec supabase status`) into `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env`.

Run everything:

```bash
pnpm dev             # web :5173, api :4000, worker
```

Verify end to end (with `pnpm dev` running, in another terminal):

```bash
pnpm smoke
```

### Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Build shared libs, then run web, API and worker in watch mode |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm typecheck` / `pnpm build` | Type-check / build all packages |
| `pnpm smoke` | End-to-end checks against the running stack |
| `pnpm db:start` / `db:stop` | Start / stop local Supabase |
| `pnpm db:reset` | Wipe local DB, reapply migrations and seed |
| `pnpm db:generate` | Generate a SQL migration from `packages/db/src/schema.ts` |
| `pnpm infra:up` / `infra:down` | Start / stop Redis |
| `pnpm sandbox:build` | Build language runner images |

> **Node note:** `@supabase/supabase-js` requires Node 22+ when used from Node. The backend doesn't depend on it; the smoke test uses `@supabase/auth-js`.

## API

All endpoints except `/health` require `Authorization: Bearer <supabase access token>`.

| Method | Path | Who | Description |
|---|---|---|---|
| `GET` | `/health` | — | Postgres + Redis status |
| `POST` | `/rooms` | any user | Create a room for an approved question; caller becomes interviewer. Returns invite code |
| `POST` | `/rooms/join` | any user | Join with invite code as candidate |
| `GET` | `/rooms/:id` | participant | Question, public tests, caller's role |
| `POST` | `/submissions` | candidate | `{ roomId, language, mode: "run" \| "submit", code }` → `202 { submissionId }` |
| `GET` | `/submissions/:id` | participant | Candidate view or interviewer view, by role |

## Testing

- **Unit tests** — every sandbox `docker run` flag, verdict mapping, and the candidate/interviewer serializers (hidden test ids never appear in the candidate view).
- **Smoke test** (`pnpm smoke`) — signs up real Supabase users and checks 19 behaviours against the running stack. Latest local run:

| Case | Result |
|---|---|
| Correct solution (submit) | `accepted`, hidden 2/2 — ~0.5 s |
| Wrong answer | `wrong_answer`, hidden 0/2 |
| Exception | `runtime_error` |
| `while True: pass` | `time_limit_exceeded` (container killed) |
| Memory bomb | `memory_limit_exceeded` |
| Outbound HTTP | blocked → `runtime_error` |
| No / bad token | `401` |
| Outsider / interviewer submitting | `403` |
| Supabase REST read of `test_cases` | 0 rows (RLS) |
| Leftover containers | 0 |

## Project structure

```
apps/
  api/          Express API, auth, routes, serializers, smoke test
  worker/       BullMQ consumer + Docker sandbox runner
  web/          React + Monaco client (placeholder)
packages/
  shared/       zod schemas and types shared by every app
  db/           Drizzle schema, DB client, migration config
supabase/       Local stack config, generated migrations, seed data
sandbox/images/ Runner Dockerfiles (python, javascript)
infra/          docker-compose (Redis)
docs/decisions/ Architecture Decision Records
```

## Roadmap

- [x] Monorepo, shared schemas, Postgres schema + migrations
- [x] Supabase Auth with per-room roles and invite codes
- [x] Submission API → queue → Docker sandbox → verdicts
- [x] Candidate / interviewer result views, RLS lockdown, smoke test
- [ ] WebSocket gateway with Yjs collaborative editing (<250 ms target)
- [ ] Interviewer and candidate UI, live results
- [ ] Question bank API (draft → approved workflow)
- [ ] Submission history and editor replay (Supabase Storage)
- [ ] Structured evaluation rubric
- [ ] AI copilot: JD → assessment blueprint, question drafts with human review, follow-up suggestions, failure explanations, rubric-mapped summaries
- [ ] Sandbox attack suite (fork bomb, filesystem writes) and 1,000-submission stress test
- [ ] Stronger isolation option (gVisor `runsc`)

## Principles

- AI assists the interviewer; **no code path auto-rejects, auto-scores or auto-advances a candidate.**
- AI-generated questions are drafts until a human approves them.
- Every technology has a written "why" and "why not the alternative".
