# 0005 — Yjs over our own WebSocket gateway (not Supabase Realtime)

**Status:** Accepted — not built yet (build step 4)

## Context
Interviewer and candidate edit the same buffer. Concurrent typing must merge without overwriting, with a <250 ms target. We also need room events (presence, "submission finished").

## Decision
- Use **Yjs** (a CRDT) bound to Monaco for the shared buffer.
- Run our own WebSocket gateway attached to the API's HTTP server. It authenticates the Supabase token and checks room membership on connect.
- Fan out across gateway instances with **Redis pub/sub** (already in the stack for the queue).

## Alternatives considered
- **Supabase Realtime (broadcast)** — designed for small JSON messages; Yjs exchanges binary updates and an awareness protocol, and we'd lose control over auth-on-connect, persistence hooks and latency. Disabled in `supabase/config.toml` because nothing uses it.
- **Operational Transform (ShareDB)** — needs a central transform server and is harder to reason about than a CRDT for two-party editing.
- **Last-write-wins over plain WebSocket** — loses keystrokes under concurrent edits.

## Consequences
- One more server component we own, but it's also where replay snapshots get persisted (to Supabase Storage).
- Horizontal scaling of the gateway depends on Redis pub/sub, not sticky sessions alone.
