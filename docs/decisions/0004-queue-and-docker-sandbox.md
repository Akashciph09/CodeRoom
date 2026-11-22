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
- Retries are safe: the worker deletes prior results inside the same transaction that writes new ones.
- Measured locally: infinite loop → `time_limit_exceeded`, memory bomb → `memory_limit_exceeded`, outbound HTTP → fails, no containers left behind (`pnpm smoke`).
