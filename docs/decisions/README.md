# Architecture Decision Records

Short records of *why* the stack looks the way it does. Each one: context, decision, alternatives rejected, consequences.
Rule for this repo: a technology goes in only if it has a "why" and a "why not the alternative".

| # | Decision | Status |
|---|---|---|
| [0001](0001-postgres-over-mongodb.md) | Postgres (relational) over MongoDB | Accepted |
| [0002](0002-supabase-for-auth-storage-postgres.md) | Supabase for Postgres hosting, Auth and Storage — not for app logic | Accepted |
| [0003](0003-drizzle-orm.md) | Drizzle ORM, migrations generated into `supabase/migrations` | Accepted |
| [0004](0004-queue-and-docker-sandbox.md) | Execution via BullMQ queue + per-run Docker sandbox, never in the API | Accepted |
| [0005](0005-yjs-over-own-websocket.md) | Yjs over our own WebSocket gateway, not Supabase Realtime | Accepted |
| [0006](0006-rls-deny-all-server-side-access.md) | RLS enabled, no policies: all data access goes through the API | Accepted |
| [0007](0007-immutable-question-versions.md) | Rooms pin immutable, published question versions (DB-enforced) | Accepted |
| [0008](0008-room-layout-own-splitter.md) | Room layout: question \| code over tests, own splitter, kept per browser | Accepted |
| [0009](0009-multi-question-rooms.md) | Rooms hold an ordered list of questions, revealed by the interviewer | Accepted |
