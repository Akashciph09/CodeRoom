# 0007 — Rooms pin immutable, published question versions

**Status:** Accepted

## Context
Interviewers write their own questions: statement, constraints, starter code, public and hidden tests. Questions get edited — an expected output is fixed, a test is added. If a room pointed at "the question", an edit after an interview would silently change what that interview ran against: old submissions' results would refer to test cases that no longer exist or now expect something else, and a re-run would grade against different tests than the candidate saw.

## Decision
- **Content lives in versions.** `questions` holds identity and owner only. `question_versions` holds title, statement, constraints, starter code; `test_cases` belong to a version.
- **One editable draft, many immutable published versions.** Each question has at most one `draft` (partial unique index). "Mark ready" validates the draft and turns it into the next numbered version (`v1`, `v2`, …). Editing a ready question saves into a new draft; published versions are never modified.
- **Rooms pin a version.** `rooms.question_version_id` is set at creation to the latest ready version and never changes. Submissions copy it; the worker grades against that version's tests. A new room picks up the newest version; existing rooms don't.
- **Immutability is enforced by the database**, not only the API: triggers reject `UPDATE`/`DELETE` of a published version and any insert/update/delete of its test cases. A buggy code path or a manual SQL edit can't rewrite history either.
- **Ownership:** only a question's owner can read the editor view, edit, preview, publish or open rooms with it; others get `404` (not `403`, so ids can't be probed). Questions with no owner are a shared library: anyone can interview with them, nobody can edit them.
- **Preview is the candidate view.** The editor's preview and the room both render the server's `candidateView()` (public tests only, filtered in SQL), so the preview can't drift from what candidates see.
- **Drafts use optimistic concurrency.** Each draft has a `revision` (+1 per save). Save, publish and discard must send the revision the client is working from; the check runs under the per-question row lock, so a stale writer (another tab, another window) gets `409 draft_changed` and nothing is written. Publishing also requires the reviewed revision, so an author can't publish draft content they haven't seen.
- **The editor never drops typing.** A save remembers the exact content it sent; when the response arrives the form is only replaced if it still holds that content, otherwise later keystrokes are kept and stay marked unsaved. Operations that replace the content (publish, discard, delete) make the form read-only while they run.

## Alternatives considered
- **Edit in place + copy tests into the room** — duplicates data per room and still loses the link between a result and "the question it came from".
- **Soft-versioning with `valid_from/valid_to` timestamps** — rooms would resolve "the version at my creation time"; harder to reason about and to enforce than an explicit foreign key.
- **API-only immutability** — one forgotten code path or ad-hoc fix breaks the guarantee silently.
- **Last-write-wins on drafts** — the row lock serializes saves but each save replaces the whole draft, so the slower of two tabs silently erases the other's work. Field-level merging was rejected as overkill for single-author drafts; a clear conflict + "Reload latest" is predictable.

## Migration
Existing data was migrated without loss in three steps: add the new table/columns and backfill (each existing question became its own `v1`, and test cases, rooms and submissions were pointed at it), then make the new references `NOT NULL` and drop the old columns, then add the triggers. Rehearsed on a copy of the local database before applying.

## Consequences
- Verified by `pnpm smoke` (questions section): an interview on v1 keeps showing and grading v1 after v2 is published (sum code stays "Accepted" in the old room, "Wrong answer" in a new v2 room), existing results are unchanged, and the DB rejects edits to published versions. And by `pnpm e2e` (author → interview → publish v2 → the running interview still shows v1).
- Ready questions can't be deleted (rooms may pin them); never-ready ones can. Drafts can be discarded back to the last ready version.
- Storage grows with every publish (full copy of content and tests per version) — negligible for text, and it's what makes results reproducible.
