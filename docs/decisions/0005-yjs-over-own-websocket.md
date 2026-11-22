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
- **Saves are durable-by-retry:** writes for a room are serialized (an older snapshot can't overwrite a newer one), `dirty` is restored if a write fails, failed saves retry with exponential backoff, and the final save on unload retries 5 times before giving up (logged).
- **Ending a session is enforced on live sockets, not just at connect time.** `POST /rooms/:id/close` flips the room to `closed` and publishes `room:closed` on the room bus; every gateway marks that room's document read-only and drops sync step-2/update messages from clients, while still answering sync step 1 (so the final code stays viewable). New connections to ended rooms are accepted read-only. The window between the close and each instance receiving the bus event is the only gap.
- **Events are fire-and-forget**, so clients re-fetch submission history over REST every time the events socket (re)connects; results published during a disconnect are never lost to the UI.
