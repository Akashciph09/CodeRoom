# 0016 — Private interviewer notes, stored outside the shared document

**Status:** Accepted — implemented (`interview_notes`, `/rooms/:id/notes`, room Notes tab, review page)

## Context
The review page shows evidence (submissions, tests, timeline, test score) but nothing the interviewer observed: hints given, questions asked, how the candidate reasoned. Interviewers need to write that down during the session, privately, and see it when evaluating. These notes are also the evidence a rubric (next) and a future AI summary will cite.

## Decision
- **A table, not the shared Yjs document.** `interview_notes(id, room_id, author_id, room_question_id?, submission_id?, body, created_at, updated_at)`. The candidate's browser receives the room's Yjs document in full — hiding a notes panel would not protect anything in it — so notes never touch Yjs, awareness or room events.
- **Interviewer-only, enforced by the API.** Every route (`GET/POST /rooms/:id/notes`, `PATCH/DELETE /rooms/:id/notes/:noteId`) requires the interviewer role; candidates and outsiders get `403`. Only a note's author can edit or delete it. Notes can be written and edited after the session ends (evaluation often happens then).
- **Optional links, checked by the database.** A note may refer to one of the room's questions and/or one of its submissions. Composite foreign keys `(room_question_id, room_id)` and `(submission_id, room_id)` make it impossible to link another room's question or submission, whatever the API does. When a submission is linked, the note's question is that submission's question (the API derives it, and refuses a mismatch).
- **Text:** 1–5000 characters after trimming (`CHECK`). Times are shown relative to the start of the interview ("+12:40"), with the full timestamp on hover.
- **Where it shows:** a Notes tab beside Testcase / Test Result, rendered only for the interviewer (a new note defaults to the question being viewed and can link one of its submissions); and a Notes section on the review page, each linked to its timeline entry.

## Alternatives considered
- **Notes in the Yjs document, hidden for candidates** — the candidate's client still has the data. Rejected.
- **A separate Yjs document per interviewer** — realtime isn't needed for one person's notes; REST is simpler and easy to authorize.
- **Free-form timestamps typed by the interviewer** — the server's creation time is reliable evidence; the review shows it relative to the interview start.

## Consequences
- Verified by `pnpm smoke` (`rooms-smoke.ts` notes section: CRUD, `403` for candidate/outsider, author-only edits, limits, cross-room links refused by the API and by the database, submission-derived question, notes on the review) and `pnpm e2e` (`interview-notes.e2e.ts`).
- One author per room today (ADR 0012); the author column already supports more interviewers later.
