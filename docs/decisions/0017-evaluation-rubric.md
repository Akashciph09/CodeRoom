# 0017 — Structured evaluation rubric, locked on submit

**Status:** Accepted — implemented (`evaluations`, `evaluation_scores`, `evaluation_evidence`, lock triggers, review page Evaluation card)

## Context
The review page has evidence: runs and submissions, the automated test score (ADR 0011) and the interviewer's notes (ADR 0016). It has no record of the interviewer's *judgement*. Free-text notes don't compare across candidates or interviewers, and a single "hire/no hire" hides the reasons. Interviewers need a fixed rubric that is anchored to what they observed, drafted while the interview is fresh, and final once submitted.

## Decision
- **Four dimensions, scored 1–4, with "Not observed".** Problem solving, Correctness and testing, Code quality, Communication. Each score has a specific description (`RUBRIC` in `packages/shared`), shown next to every choice. A 4-point scale has no middle option to default to. "Not observed" is explicit: an interview that never touched code quality is not a 1. Each dimension has an optional explanation and links to evidence.
- **Overall recommendation** on a 4-step scale (Strong no hire … Strong hire), and an optional summary.
- **Evidence is linked, not copied.** A dimension can cite this room's notes and this candidate's runs. Composite foreign keys make it impossible to cite another room's note, or a run by someone else.
- **Draft any time; submit only after the interview ends.** `PUT /rooms/:id/evaluations/:candidateId` saves the whole draft, during the interview or after it. It uses optimistic concurrency on `revision`, so a stale tab gets `409 evaluation_changed`. `POST …/submit` requires the room to be closed (`409 room_open`) and the evaluation to be complete: every dimension scored or "Not observed", at least one real score, and a recommendation (`400` with `problems`). It records `submitted_at` and `submitted_by`.
- **Locked on the server, twice.** The API refuses changes to a submitted evaluation (`409 evaluation_submitted`). Database triggers refuse them as well:
  - any change to a submitted evaluation, its scores or its evidence;
  - inserting an evaluation that is already submitted;
  - a submit while the room is open, or when incomplete;
  - editing or deleting a note cited by a submitted evaluation (`409 note_cited` from the API).
  Deletes that cascade from removing a room or an account still work: they run inside the foreign key's trigger (`pg_trigger_depth() > 1`), so only direct changes are refused.
- **Separate from the test score.** The evaluation never reads or writes the test score, and the test score never reads the evaluation. They are separate fields in the review and separate cards in the UI. Nothing computes, suggests or pre-fills a rating: AI is assistive only, and no code path auto-scores a candidate.
- **Interviewer-only.** All routes require the room's interviewer role. The evaluation is read only through `GET /rooms/:id/review` (interviewer-only) and is never in any candidate view, room event or the Yjs document.

## Alternatives considered
- **A 1–5 scale** — the middle 3 becomes the default non-answer.
- **Free text only** — can't be compared, and doesn't make the interviewer cover every dimension.
- **Deriving any dimension from the test score** — mixes automated evidence with human judgement, and would let tests decide part of the evaluation. Rejected on principle.
- **Locking in the API only** — a bug or a manual edit could change a "final" evaluation. Triggers make the lock real, as with immutable question versions (ADR 0007).
- **Copying note text into the evaluation** — duplicates data. Instead, cited notes are frozen while a submitted evaluation cites them.

## Consequences
- **Tests:**
  - `pnpm smoke` (`rooms-smoke.ts`, evaluation section): drafting while live, stale revision, `room_open`, `403` for candidates and outsiders, wrong candidate, cross-room evidence, invalid scores, incomplete submit, submit, the lock, cited notes, the test score unchanged, and every trigger (lock, incomplete, open room, account-deletion cascade).
  - Unit tests for `evaluationProblems` and the input schema.
  - `pnpm e2e` (`evaluation.e2e.ts`).
- One evaluator per room today (ADR 0012). The table is keyed by evaluator, so several interviewers per room would each have their own evaluation.
- A future AI summary can cite the evaluation and its evidence; it must never write ratings.
