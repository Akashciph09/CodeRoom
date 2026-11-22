# 0003 — Drizzle ORM, migrations in `supabase/migrations`

**Status:** Accepted

## Context
Both the API and the worker need typed access to the same tables. The Mongo scaffold had two hand-synced model definitions.

## Decision
- One schema in `packages/db/src/schema.ts` (Drizzle), shared by API and worker.
- `drizzle-kit generate` writes SQL migrations into `supabase/migrations` with Supabase's timestamp prefix, so `supabase start` / `supabase db reset` apply them and then `supabase/seed.sql`.
- Enums are derived from the zod enums in `packages/shared`, so DB values and API validation can't drift.

## Alternatives considered
- **Prisma** — heavier runtime/engine, its own schema language, and less natural for SQL-first features we use (RLS flags, CHECK constraints, Supabase `auth.users` references).
- **supabase-js query builder** — ties every query to Supabase's REST API and its RLS model; no compile-time schema.
- **Raw SQL** — no types shared between API and worker.

## Consequences
- Migrations are plain, reviewable SQL checked into the repo.
- Changing the schema = edit `schema.ts` → `pnpm db:generate` → `pnpm db:reset`.
