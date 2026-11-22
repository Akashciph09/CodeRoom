# 0005 — Yjs over our own WebSocket gateway (not Supabase Realtime)

**Status:** Accepted — implemented (`apps/api/src/realtime/`)

## Context
Interviewer and candidate edit the same buffer. Concurrent typing must merge without overwriting, with a <250 ms target. We also need room events ("submission queued", "result ready") where each participant receives a role-specific view.

## Decision
- **Yjs** (a CRDT) for the shared buffer, speaking the standard y-websocket protocol so the stock `y-websocket` / `y-monaco` clients work unchanged.
- **Our own WebSocket gateway** on the API's HTTP server, with two endpoints: `/yjs/:roomId` (binary Yjs sync + awareness) and `/rooms/:roomId/events` (JSON server events).
- **Auth before upgrade:** the Supabase access token travels in `Sec-WebSocket-Protocol` (`["coderoom.v1", token]`), not the URL, so it doesn't land in proxy or access logs. The gateway verifies the JWT, checks room membership and room status, and only then completes the upgrade; failures get a plain HTTP 400/401/403/404/410. Sockets are closed with code 4401 when the token expires.
- **Horizontal scaling via Redis pub/sub:** each room has a channel; instances publish document and awareness updates tagged with their instance id and ignore their own. When an instance loads a room it publishes its state vector, and peers reply with only the missing updates.
- **Persistence:** merged Yjs state is upserted into `room_documents` (Postgres `bytea`) 2 s after the last change and when the last local client leaves. Updates are idempotent, so any instance writing the merged state is safe.
- **Room events:** the API and worker publish id-only events (`room:<id>:events`); each gateway loads the submission once and sends each subscriber the view its role allows (`viewFor(role, …)`, the same function the REST API uses).

## Alternatives considered
- **Supabase Realtime (broadcast)** — designed for small JSON messages; Yjs exchanges binary updates plus an awareness protocol, and we'd give up auth-on-upgrade, server-side persistence hooks and per-role result views. Disabled in `supabase/config.toml`.
- **`y-websocket`'s bundled server** — single-process, no auth hook, no cross-instance fan-out.
- **Operational Transform (ShareDB)** — needs a central transform server; harder to reason about than a CRDT for two-party editing.
- **Last-write-wins over plain WebSocket** — loses keystrokes under concurrent edits.
- **Token in the query string** — simplest, but tokens end up in logs.

## Consequences
- Verified by `pnpm smoke:realtime` with interviewer and candidate on two different API instances: auth rejections, sync, convergence of concurrent edits, awareness, live per-role results, and persistence after everyone leaves.
- Persisting the full merged state (not an update log) means no edit-by-edit replay yet; the replay feature will add periodic snapshots to Supabase Storage.
- The `room_documents` row can be written by several instances; since every instance holds the merged state, last-write-wins on the row is safe.
- **Every save is lock-and-merge, never a blind overwrite.** Several instances can save the same room, and any of them may have missed a bus update. Each save runs in a transaction that takes a per-room **advisory lock** (`pg_advisory_xact_lock(hashtextextended(room_id, 0))`), reads the stored snapshot, applies it to the live doc (healing anything this instance missed and sending it to its clients), then writes the doc. An advisory lock is used instead of `SELECT … FOR UPDATE` because a row lock has nothing to lock on a room's very first save. Verified against Postgres: two instances that can't see each other making concurrent first saves keep both edits 20/20 times with the lock, 0/20 without it.
- **Saves are retried, and unsaved state is retained — with stated limits.** Writes are also serialized per instance (`entry.saving`); `dirty` is restored if a write fails; failed saves retry with exponential backoff. On unload the manager first awaits any in-flight save (which may have cleared `dirty` and then failed), then retries. If it still can't write, the state is **retained in memory** and retried in the background (same lock-and-merge) for as long as the process lives, and **spilled to Redis** (`yjs:unsaved:<roomId>`, 7-day TTL, best effort). The next load of the room merges retained/spilled state back (Yjs merges are idempotent) and deletes the spill once saved.
  - *Not guaranteed:* if the process exits while Postgres is still failing, the edits survive only if the Redis spill was written, Redis kept it, and the room is loaded again within 7 days. On a hard crash, edits made inside the 2 s debounce window are recovered only from connected clients — y-websocket clients keep their local doc and push missing updates back on reconnect.
- **Ending a session is enforced on live sockets, durably.** The DB update in `POST /rooms/:id/close` is the commit point. Publishing `room:closed` on the room bus is the fast path (best effort). Every gateway also runs a **status reconciler** (default every 5 s) that re-reads the stored status of rooms it serves and enforces it, so a failed publish or a missed event delays enforcement by at most one interval instead of leaving sockets writable. Enforcement = the room's doc drops sync step-2/update messages (still answers step 1, so the final code stays viewable) and events sockets get `room:closed` once.
- **Events are fire-and-forget**, so clients re-fetch submission history over REST every time the events socket (re)connects. History is **merged** into what the client has, never replacing a submission with an earlier state (pending < queued < running < completed/failed), so a slow history response can't roll back a result event that arrived meanwhile.
