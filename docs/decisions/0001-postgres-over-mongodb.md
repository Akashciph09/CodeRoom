# 0001 — Postgres over MongoDB

**Status:** Accepted (replaces the initial MongoDB scaffold)

## Context
The domain is relational: a room has participants with roles; a submission belongs to a room, a question and a user; test results belong to a submission and a test case; rubric scores will belong to a submission and a criterion. Most reads join these (e.g. "is this user a candidate in this submission's room?").

With MongoDB, those joins and the integrity rules lived in application code, and the API and worker each carried their own copy of the model.

## Decision
Use PostgreSQL as the single system of record.

## Alternatives considered
- **MongoDB** — flexible documents, but no foreign keys, weaker multi-document transactions, and manual joins for a join-heavy domain. Nothing in the data is genuinely schemaless.
- **MongoDB + embedded documents** (e.g. results inside submissions) — works for one access pattern, but rubric scoring and history/replay need to query across submissions.

## Consequences
- Foreign keys, enums and `CHECK` constraints enforce invariants in the database. Example: `test_results.hidden_output_not_stored` makes it impossible to persist output for a hidden test, even from a buggy worker.
- The result write is one transaction (results + final submission status), so clients never see a half-finished submission.
- Requires migrations (see 0003).
