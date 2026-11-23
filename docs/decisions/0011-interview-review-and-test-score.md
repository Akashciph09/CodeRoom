# 0011 — Interview review page and a test score out of 100 (evidence, not a decision)

**Status:** Accepted — implemented (`apps/api/src/services/scoring.ts`, `routes/review.ts`, `apps/web/src/pages/ReviewPage.tsx`)

## Context
After a room ends, the interviewer needs to evaluate how the candidate did. The evidence is already stored — pinned question versions, every run and submission with per-test results (including hidden tests), the code of each submission, reveal and end times — but it was scattered across the room view. Interviewers also want a simple objective number: "how many test cases did they pass?". The project's rules forbid automated hiring decisions and auto-scoring as a decision; any number must be an input to the human evaluation, clearly labelled.

## Decision
- **A review page per room** (`/rooms/:id/review`, `GET /rooms/:id/review`), **interviewer only** (candidates and outsiders get `403`, like every interviewer-only view). For each candidate in the room: the test score and its breakdown, each question's reveal window, and a timeline of every run/submission with its code and a diff against the previous submission of the same question.
- **Test score out of 100, computed by one pure, unit-tested function** (`scoring.ts`):
  - **Per question, then combined** — a question's credit is the fraction of its tests passed, so a question with many tests can't outweigh one with few.
  - **Submit only, hidden tests included** — Run only uses visible examples and custom cases, which a candidate could hard-code.
  - **Best Submit per question** — breaking a solved question later doesn't remove the credit (every attempt is still on the timeline).
  - **Only revealed questions count** — a question the interviewer never reached isn't held against the candidate; the score is normalized over revealed questions' points.
  - **Weights:** each room question has `points` (1–100), equal by default, optionally set when the room is created (e.g. warm-up 20, main 50, hard 30). Existing rooms are backfilled as equal weights.
  - **Per candidate** — rooms created before [ADR 0012](0012-one-candidate-per-room.md) can have more than one; new rooms have exactly one.
- **Labelled as evidence.** The page says what the score measures ("tests passed on Submit, hidden tests included") and what it doesn't (approach, code quality, communication). The human rubric (next step) remains the evaluation; nothing is auto-decided.
- **Reveal window per question** (per room): from a question's reveal to the next reveal, or to the session's end (or now, while live). It's labelled as pacing, not candidate effort: participants can revisit earlier questions, and Q1 is revealed at room creation, possibly long before anyone joined. Measuring real per-question effort would need activity timestamps (e.g. from recorded edit history), which aren't stored yet.
- **The page stays current.** It re-fetches on room events while the room is live (and on every reconnect, since events can be lost), polls while any submission is still being graded — which also covers a Submit finishing after the session ended — and re-fetches on focus. Only the newest response is applied. A failed refresh is transient: the last loaded review stays on screen with a "Couldn't refresh — retrying" warning, polling continues until a refresh succeeds, and success clears the warning. Only "access denied" (`403`) or a failed first load shows the error screen (the latter with *Try again*). Review opens in the same tab: sign-in is per tab, so a new tab would be signed out.

## Alternatives considered
- **Pool all test cases** — simple, but test counts differ per question, so weights would be accidental.
- **Last submission instead of best** — punishes a late regression on a question that was solved.
- **Count unrevealed questions as zero** — penalizes the candidate for the interviewer's pacing.
- **Use Run results too** — Run lacks hidden tests; scoring it would reward hard-coding the examples.
- **Store the score** — it's derived from immutable data (pinned versions, finished submissions), so computing it on read keeps one source of truth; if the rules change, old interviews are re-scored consistently.

## Consequences
- Verified by unit tests (`scoring.test.ts`, diff), `pnpm smoke` (`review` section: access control, best-not-last, hidden tests counted, unrevealed excluded, weights, per candidate) and `pnpm e2e` (`review.e2e.ts`).
- Replay isn't possible for past interviews: only the final merged code and submission snapshots are stored, not every edit. Recording edit history is a separate, later change.
