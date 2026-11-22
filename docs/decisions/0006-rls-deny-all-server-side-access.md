# 0006 — RLS enabled with no policies; all data access goes through the API

**Status:** Accepted

## Context
Supabase exposes every `public` table over its REST API to anyone holding the publishable key (which ships in the browser). Our data includes hidden test cases, interviewer notes and scores that candidates must never see.

## Decision
- Every table is created with Row Level Security **enabled and no policies**, so the `anon` and `authenticated` roles can read and write nothing via Supabase's REST API.
- The browser uses Supabase only to sign in. All data goes through our API, which connects as the database owner and enforces per-room roles in code.
- Visibility is shaped by explicit serializers: `toCandidateView` (no hidden-test detail, ever) and `toInterviewerView`.

## Alternatives considered
- **Fine-grained RLS policies + browser queries** — authorization would be split between SQL policies and API code, and hidden-test safety would depend on every policy being right. Harder to test and to explain.
- **RLS disabled** — any leaked or misused publishable key exposes the whole database.

## Consequences
- Defence in depth: a bug in the API's serializers still can't be bypassed by calling Supabase directly. Verified by `pnpm smoke` ("RLS: test_cases unreadable via Supabase REST").
- If we later want direct browser reads (e.g. for a public question list), we add a narrow policy for that one table.
