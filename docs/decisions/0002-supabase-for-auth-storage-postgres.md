# 0002 — Supabase for Postgres, Auth and Storage (not for app logic)

**Status:** Accepted

## Context
After choosing Postgres (0001) we still needed real authentication (the scaffold used a dev-only header stub) and object storage for large test files and replay snapshots (the MinIO image we planned to use is no longer publicly pullable). Neither is where this project should spend effort: the hard parts are sandboxed execution, queueing and live collaboration.

## Decision
Use Supabase as the *platform* for three commodity concerns:
- **Postgres** hosting (and a local stack via the Supabase CLI).
- **Auth** — users sign in with Supabase; the API verifies the access token locally against Supabase's published JWKS (ES256), with issuer and audience checks. No per-request call to Supabase.
- **Storage** — a private `coderoom` bucket, accessed only server-side.

Everything else stays in our own services: Express API, BullMQ worker, Docker sandbox, WebSocket gateway.

## Alternatives considered
- **Self-hosted Postgres + hand-rolled auth** — more to secure (password hashing, reset flows, token rotation) for no extra project value.
- **Supabase for everything** (browser queries tables via PostgREST, Edge Functions, Realtime) — would push authorization into RLS policies spread across tables and put sensitive data one policy-bug away from the browser. See 0005 and 0006.
- **Auth0/Clerk + separate Postgres + S3** — three vendors instead of one, with no capability we need that Supabase lacks.

## Consequences
- Roles are per room (`room_participants.role`), not global Supabase roles — the same user can interview in one room and be a candidate in another.
- Local dev runs the Supabase stack in Docker; unused services (Studio, Realtime, Edge Functions, analytics, mail) are disabled in `supabase/config.toml` to keep it lean.
- Vendor exposure is limited: the app talks to Postgres through Drizzle (0003) and to Auth through standard JWT verification, so leaving Supabase means changing a connection string and a JWKS URL.
