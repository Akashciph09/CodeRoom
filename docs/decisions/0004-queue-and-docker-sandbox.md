# 0004 — BullMQ queue + per-run Docker sandbox

**Status:** Accepted

## Context
Strangers submit arbitrary code. Running it in the API process would let one infinite loop or fork bomb take down every interview, and would expose the server's network, filesystem and secrets.

## Decision
- The API validates, stores and enqueues; it **never executes** code. The job payload is only the submission id.
- Stateless workers (BullMQ consumers on Redis) run each test in a fresh container with: no network, memory = swap limit, CPU quota, PID limit, read-only root FS, small `noexec` tmpfs, all capabilities dropped, `no-new-privileges`, non-root user, file-size and open-file ulimits, and a wall-clock timeout that `docker kill`s the container.
- These flags live in one function (`apps/worker/src/sandbox/dockerArgs.ts`) with a unit test per control.

## Alternatives considered
- **Execute in the API / child process** — no isolation.
- **Judge0 or a hosted execution API** — fast to adopt, but the isolation and scaling story is the point of this project.
- **gVisor / Firecracker** — stronger isolation; a reasonable next step (`--runtime=runsc`) once the Docker baseline is measured.
- **Postgres-backed queue** (pg-boss) — would work, but Redis is already needed for pub/sub fan-out, and BullMQ gives retries, back-pressure and concurrency control out of the box.

## Consequences
- Throughput scales horizontally by adding worker processes.
- Retries are safe: the worker deletes prior results inside the same transaction that writes new ones, and skips submissions that are already `completed`/`failed`.
- **Delivery is guaranteed by a transactional outbox, not by the enqueue call.** The `submissions` row is written first and is the source of truth. If enqueueing fails (Redis blip, API crash between insert and enqueue), the API still answers `202`, and a sweeper in every worker re-enqueues `queued` rows older than 30 s (partial index `submissions_queued_idx`). Because `jobId = submissionId`, re-enqueueing is idempotent. A submission can be delayed, never lost.
- **Abuse controls in front of the queue:** a per-user fixed-window rate limit (10 submit attempts/min, counted in Redis so it holds across API instances; `429` + `Retry-After`) and an `Idempotency-Key` header so a retried request returns the original submission instead of creating a second one.
- **Idempotency lives in Postgres, on the submission row.** `submissions.idempotency_key` with a unique `(user_id, idempotency_key)` index is written in the same `INSERT` as the submission, so the key and the submission exist together or not at all. A retry finds the original row (`202`, `Idempotent-Replayed: true`); concurrent duplicates collide on the index (`ON CONFLICT DO NOTHING`) and replay the winner; reusing a key for a different body is `422`. (An earlier version kept the mapping in Redis, written after the insert — a crash between the two could create duplicates.) The browser keeps one key per logical action — same code/mode/language — until it gets a definitive answer, and retries network errors/5xx with that same key.
- Measured locally: infinite loop → `time_limit_exceeded`, memory bomb → `memory_limit_exceeded`, outbound HTTP → fails, no containers left behind (`pnpm smoke`).
