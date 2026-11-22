# CodeRoom

**A live technical-interview platform where candidate code runs in isolated sandboxes and AI assists the interviewer — without ever deciding who gets hired.**

Interviewer and candidate share a room. The candidate writes code; every run goes through a queue to a disposable, locked-down Docker container and comes back with per-test verdicts. Hidden test cases never leave the server. An AI copilot (in progress) helps the interviewer prepare questions, ask follow-ups and summarize evidence against a rubric.

> **Status:** a working interview product end to end — sign in, create a room, share an invite link, edit code together in real time, run/submit against sandboxed tests and see role-aware results live. Tested across multiple API instances. AI copilot, rubric and replay are next — see [Roadmap](#roadmap).

---

## Highlights

- **Untrusted code never touches the API server.** The API validates, stores and enqueues; separate workers execute.
- **Per-run Docker sandbox** with no network, memory/CPU/PID limits, read-only filesystem, dropped capabilities, non-root user and a hard timeout. An infinite loop is killed; a memory bomb is stopped; outbound HTTP fails.
- **Hidden tests stay hidden** — enforced three ways: a candidate-only serializer, a database `CHECK` constraint that refuses to store hidden-test output, and Row Level Security that blocks direct table access via Supabase's public API.
- **Per-room roles.** The same user can interview in one room and be a candidate in another; every request is checked against room membership.
- **Horizontally scalable execution.** Stateless BullMQ workers; add processes to add throughput. Retries are idempotent.
- **Collaborative editing that scales out.** Yjs (CRDT) over our own WebSocket gateway; interviewer and candidate can be connected to *different* API instances and stay in sync via Redis pub/sub. Concurrent edits converge; the document survives everyone leaving.
- **Live, role-aware results.** When the worker finishes, every connected participant gets the submission pushed over WebSocket — candidates the redacted view, interviewers the full one.
- **A real interview UI.** Invite links, a shared Monaco editor with named live cursors and presence, a synced language picker, Run/Submit for the candidate, and a results panel where the interviewer also sees hidden tests and the exact submitted code.
- **Every stack choice is documented** in [Architecture Decision Records](docs/decisions/README.md).

## Architecture

```mermaid
flowchart LR
    subgraph Browser
        W["React + Monaco"]
    end
    subgraph Supabase
        AUTH["Auth<br/>ES256 JWT"]
        PG[("Postgres<br/>RLS on all tables")]
        ST[("Storage<br/>private bucket")]
    end
    API["Express API"]
    Q[["Redis / BullMQ"]]
    WK1["Worker"]
    WK2["Worker xN"]
    SB[("Sandbox container<br/>no network, limits, read-only")]
    PS[["Redis pub/sub"]]
    GW["WebSocket gateway xN<br/>Yjs sync + room events"]

    W -->|"sign in"| AUTH
    W -->|"REST + Bearer token"| API
    W <-->|"WebSocket, token as subprotocol"| GW
    API -->|"verify JWT via JWKS"| AUTH
    API -->|"Drizzle"| PG
    API -->|"enqueue submissionId"| Q
    API -->|"submission queued event"| PS
    Q --> WK1
    Q --> WK2
    WK1 -->|"docker run"| SB
    WK1 -->|"results in one transaction"| PG
    WK1 -->|"submission done event"| PS
    PS <-->|"doc updates, awareness, room events"| GW
    GW -->|"persist editor state"| PG
```

### Submission flow

1. Candidate calls `POST /submissions` with a Supabase access token.
2. API verifies the token (JWKS, issuer, audience), checks the user is a **candidate in that room**, checks the room is open and the code size, then inserts the submission. The question comes from the room, not the client.
3. API enqueues a job containing **only the submission id** and returns `202 Accepted`.
4. A worker loads the submission and its test cases, then runs each test in a fresh container with stdin input and a wall-clock timeout.
5. Verdicts (`accepted`, `wrong_answer`, `time_limit_exceeded`, `memory_limit_exceeded`, `runtime_error`, …) and the overall result are written in **one transaction**, then announced on Redis pub/sub.
6. Every gateway instance with participants in that room loads the result once and pushes it over WebSocket: a **candidate view** (public results + hidden pass count) or an **interviewer view** (everything), based on each participant's role. `GET /submissions/:id` returns the same role-based views.

### Realtime flow

1. The client opens `ws://<api>/yjs/<roomId>` with the access token as a WebSocket **subprotocol** (`["coderoom.v1", token]`) — tokens never appear in URLs or access logs.
2. Before the upgrade completes, the gateway verifies the JWT, checks the user is a participant and the room is open. Rejections are plain HTTP `401/403/404/410`; no socket is created.
3. The gateway loads the room's Yjs document from Postgres (or memory) and speaks the standard y-websocket protocol, so stock `y-websocket` / `y-monaco` clients work.
4. Local edits are broadcast to this instance's clients **and** published to Redis (`yjs:<roomId>`), tagged with the instance id; other instances apply them and forward to their clients. A newly loaded instance asks peers for anything it's missing.
5. State is persisted 2 s after the last edit and when the last client leaves. Sockets close with `4401` when the token expires, so the client reconnects with a fresh one.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React, TypeScript, Vite, React Router | Small SPA; the editor route is lazy-loaded (initial bundle ~80 KB gzipped) |
| Editor | Monaco (bundled, no CDN) + `y-monaco` | VS Code's editor; one Monaco instance shared with the Yjs binding; live remote cursors |
| Browser auth | `@supabase/auth-js` only | The browser only signs in — it never queries tables, so the full Supabase client isn't needed ([ADR 0006](docs/decisions/0006-rls-deny-all-server-side-access.md)) |
| API | Node.js, Express, TypeScript | Thin validate → persist → enqueue layer |
| Database | Postgres (Supabase) + Drizzle ORM | Relational domain, FKs and constraints enforce invariants — [ADR 0001](docs/decisions/0001-postgres-over-mongodb.md), [0003](docs/decisions/0003-drizzle-orm.md) |
| Auth / Storage | Supabase Auth, Supabase Storage | Commodity concerns, managed — [ADR 0002](docs/decisions/0002-supabase-for-auth-storage-postgres.md) |
| Queue | Redis + BullMQ | Retries, back-pressure, concurrency; Redis also does pub/sub — [ADR 0004](docs/decisions/0004-queue-and-docker-sandbox.md) |
| Execution | Docker (per-run containers) | Isolation with measurable limits — [ADR 0004](docs/decisions/0004-queue-and-docker-sandbox.md) |
| Realtime | Yjs + `ws` gateway, Redis pub/sub fan-out | CRDT merging, auth before upgrade, scales across instances — [ADR 0005](docs/decisions/0005-yjs-over-own-websocket.md) |
| Validation | zod (shared package) | One schema for API, worker and DB enums |
| Testing | Vitest + end-to-end smoke scripts | Unit-tests every sandbox control; smoke tests hit the real stack, including two API instances |

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
| Unauthorized WebSocket access | Auth + room membership checked before the upgrade; token sent as subprotocol (not in URL); socket closed at token expiry |
| Oversized / malformed realtime messages | 1 MB max frame; invalid Yjs messages close the socket; dead connections dropped by heartbeat |
| Submission flooding | Per-user rate limit in Redis (10/min across all API instances), `429` + `Retry-After` |
| Editing after the interview ended | Server drops document writes on already-open sockets; enforced on every instance via the room bus |

## Reliability

| Failure | What happens |
|---|---|
| Redis/queue unavailable right after the submission row is written | API still answers `202`; the worker's **outbox sweeper** re-enqueues `queued` rows older than 30 s. Delayed, never lost. |
| Client retries a submit after a lost response | The browser reuses the same `Idempotency-Key` for the same action; the key is stored on the submission row (unique per user, same `INSERT`), so the retry returns the original. Concurrent duplicates collide on the index; a reused key with a different body is `422` |
| Duplicate job for the same submission | `jobId = submissionId` dedupes in BullMQ; the worker skips already-finished submissions |
| Worker crashes mid-job | BullMQ stalled-job detection re-runs it; results are written in one transaction, previous partial results deleted |
| Postgres write of the editor document fails | Change stays `dirty`; saves retry with backoff. Unload waits for any in-flight save first. If the final retries fail, edits are **retained in memory** with background retries for as long as the process lives, plus a **best-effort** Redis copy (7-day TTL) that the next load of the room merges back. Edits can still be lost if the process exits while Postgres is down *and* the Redis copy is missing (spill failed, Redis lost it, or 7 days passed) |
| Two instances save the same room (one missed an update, or both make the very first save) | Every save runs under a per-room Postgres advisory lock and merges with the stored snapshot instead of overwriting it, so a save can't remove content another instance saved |
| Last user leaves while a save is in flight | Unload awaits that save; if it fails, the doc is saved again before it's destroyed |
| `room:closed` publish fails, or a gateway misses it | Each gateway reconciles room status from Postgres every 5 s and enforces it on open sockets |
| Browser loses its events socket while a result is published | On every reconnect the client re-fetches history and **merges** it — a submission never moves backwards, so a slow response can't undo a newer result |
| A gateway instance holds unsaved edits when another loads the room | The new instance asks peers for missing updates (state-vector sync over Redis) |

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

Open http://localhost:5173, create an account and start a room, then use **Copy invite link**. Each browser tab keeps its own session, so you can paste the link into a second tab and sign up as the candidate to try both sides at once.

Verify end to end (with `pnpm dev` running, in another terminal):

```bash
pnpm smoke
pnpm smoke:realtime
pnpm e2e
```

To prove cross-instance sync, start a second API on another port and point the candidate at it:

```bash
PORT=4001 pnpm --filter @coderoom/api dev
SMOKE_API_URL_2=http://localhost:4001 pnpm smoke:realtime
```

### Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Build shared libs, then run web, API and worker in watch mode |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm typecheck` / `pnpm build` | Type-check / build all packages |
| `pnpm smoke` | End-to-end checks against the running stack |
| `pnpm smoke:realtime` | Realtime checks: upgrade auth, sync latency, convergence, live results, persistence |
| `pnpm e2e` | Playwright browser tests of the interviewer/candidate flow (local stack only) |
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
| `GET` | `/questions` | any user | Approved questions (id, title) |
| `GET` | `/rooms` | any user | Rooms the caller participates in |
| `POST` | `/rooms` | any user | Create a room for an approved question; caller becomes interviewer. Returns invite code |
| `POST` | `/rooms/join` | any user | Join with invite code as candidate |
| `GET` | `/rooms/:id` | participant | Question, public tests, caller's role (invite code for the interviewer) |
| `GET` | `/rooms/:id/submissions` | participant | History, newest first, in the caller's role view (candidates see only their own) |
| `POST` | `/rooms/:id/close` | interviewer | End the session: room becomes read-only everywhere, including already-open sockets |
| `POST` | `/submissions` | candidate | `{ roomId, language, mode: "run" \| "submit", code }` → `202 { submissionId }`. Optional `Idempotency-Key` header; 10/min per user (`429` + `Retry-After`) |
| `GET` | `/submissions/:id` | participant | Candidate view or interviewer view, by role |

### WebSocket

Both require the subprotocols `["coderoom.v1", <access token>]` and room membership.

| Path | Protocol | Description |
|---|---|---|
| `/yjs/:roomId` | y-websocket (binary) | Shared editor. Use `doc.getText("code")`. Awareness carries cursors/names |
| `/rooms/:roomId/events` | JSON, server → client | `ready`, `submission:queued`, `submission:result` (role-specific view), `room:closed`. Fire-and-forget: clients re-fetch history over REST on every (re)connect |

Ended rooms still accept WebSocket connections (to view the final code), but the server drops every document write.

## Testing

- **Unit tests** — every sandbox `docker run` flag, verdict mapping, the candidate/interviewer serializers (hidden test ids never appear in the candidate view), the document manager against a fake database (failed saves are retried, saves never overlap, unload waits for an in-flight save, edits are retained and recovered — even by a new process — when the DB is down, read-only rooms drop writes), and the browser's history merge (a result is never rolled back by an older snapshot).
- **Smoke test** (`pnpm smoke`) — signs up real Supabase users and checks 25 behaviours against the running stack. Latest local run:

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
| Same `Idempotency-Key` sent twice | one submission, second response marked `Idempotent-Replayed` |
| Two concurrent requests with one key | both get the same submission; exactly one row in Postgres |
| Same key, different code | `422` |
| 11 submit attempts in a minute | 11th → `429` with `Retry-After` |
| Queued row with no job (simulated enqueue failure) | recovered by the outbox sweeper and graded `accepted` |

- **Realtime smoke test** (`pnpm smoke:realtime`) — 23 checks, run with interviewer on one API instance and candidate on another:

| Case | Result |
|---|---|
| No subprotocol / no token / bad token / outsider / bad path | `400` / `401` / `401` / `403` / `404` before upgrade |
| Edit propagation across instances (30 edits) | p50 0.6 ms, p95 1.1 ms on localhost (target < 250 ms) |
| 50 concurrent inserts at the same position | both clients converge to identical text |
| Awareness (cursor/name) | reaches the client on the other instance |
| Candidate submits | both get `submission:queued`; candidate gets redacted result, interviewer gets full result |
| Interviewer ends the session | both get `room:closed`; edits on already-open sockets are dropped; new submissions `400`; candidate can't end it (`403`) |
| Room closed in the DB with **no** event published | gateways enforce it via reconciliation (~4 s); open sockets on the other instance stop writing |
| Two instances blind to each other make concurrent first saves (×10, real Postgres) | both edits kept 10/10 (0/20 with the advisory lock removed) |
| Everyone disconnects, new client joins | document restored from Postgres |

> Latency is measured on one machine, so it reflects gateway + Redis overhead, not network distance.

- **Browser tests** (`pnpm e2e`, Playwright) — two real users in two browser contexts run a whole interview in Chrome (~11 s):

| Step | Checked |
|---|---|
| Interviewer signs up, creates a room | starter code seeded, interviewer has no Run/Submit |
| Copy invite link → candidate opens it | redirected to sign-in, lands back in the room after signing up |
| Presence | each side sees both named avatars |
| Candidate types | text appears in the interviewer's editor |
| Candidate submits | candidate: "Accepted, hidden tests 2/2", no hidden rows; interviewer: 2 hidden rows + submitted code |
| Language picker | change syncs to the other side |
| `while (true) {}` | "Time limit exceeded" on both sides |
| Outsider opens the room URL | "You're not a participant in this room", no editor |
| Interviewer ends the session | banner on both sides, Run/Submit disabled, typing changes nothing on either side |
| Reload after the end | final code and history still shown |
| Signed-out visit to a room | redirected to sign-in with the room kept in `next` |

The tests refuse to run unless Supabase and the API are on `localhost` (they create throwaway accounts), and they fail fast if the API isn't healthy. They use the installed Google Chrome; set `PLAYWRIGHT_CHANNEL=""` and run `pnpm --filter @coderoom/web exec playwright install chromium` to use Playwright's bundled browser instead (e.g. CI). Each assertion was checked to fail when the behaviour it guards is broken — for example, disabling the editor's read-only mode makes the end-of-session step fail.

## Project structure

```
apps/
  api/          Express API, auth, routes, serializers, realtime gateway, smoke tests
  worker/       BullMQ consumer + Docker sandbox runner
  web/          React client: sign-in, rooms, Yjs-bound Monaco editor, presence, live results
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
- [x] WebSocket gateway: Yjs collaborative editing, cross-instance fan-out, persistence, live role-aware results
- [x] Browser UI: sign in, invite links, collaborative Monaco with live cursors, run/submit, role-aware live results
- [x] Browser end-to-end tests (Playwright) for the two-role flow
- [ ] Run unit, smoke and browser tests in CI against a containerized stack
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
