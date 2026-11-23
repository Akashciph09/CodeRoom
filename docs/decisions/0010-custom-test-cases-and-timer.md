# 0010 — Shared custom test cases (run-only) and an interview timer

**Status:** Accepted — implemented

## Context
Before submitting, a candidate wants to try edge cases beyond the given examples, and an interviewer often wants to propose one ("what about an empty array?"). Both should see the same cases. These cases must never weaken grading: submissions are graded on the question's pinned tests ([ADR 0007](0007-immutable-question-versions.md)), and hidden tests stay hidden. Separately, the interviewer wants to see how long the interview has been running.

## Decision
- **Custom cases are shared through the room's Yjs doc** — one `Y.Array` per question (`cases:<position>`), each case `{ id, input, expectedOutput?, addedBy }`. Either participant can add or remove one; both see it instantly; it's persisted with the doc and becomes read-only when the room ends (the gateway already drops updates to ended rooms — ADR 0005). No new API or event was needed for sharing.
- **The 10-case limit holds even with concurrent edits.** Adding re-checks the shared list's size at the moment of adding (not when the form opened) and refuses with an explanation at the limit. Two participants adding at the same instant can still push the list past 10 — each client checked its own count, and preventing that would need a server round trip for every edit. That case is handled deterministically: Run sends the **first 10 in the shared list's order**, which Yjs makes identical on every client, and the extras are marked "not run" with a prompt to remove some. Run never breaks.
- **Read-only means read-only immediately.** When editing stops (the session ends), an open add-case form closes, and the add itself re-checks that editing is still allowed, so nothing is written locally that the gateway would then drop.
- **Run-only.** `POST /submissions` accepts `customCases` only with `mode: "run"`; Submit stays the official grading on the question's own tests. The API validates them like any input (≤ 10 cases, ≤ 10 KB input/expected each) and stores them with the submission (`submissions.custom_cases`), so a run is reproducible and the case list can't change under the worker.
- **Separate results, never mixed with test results.** The worker runs custom cases after the question's tests, in the same sandbox, and writes `custom_case_results` in the same transaction as `test_results` (delete-then-insert, so retries stay idempotent). With an expected output a case is judged like a test; without one it only shows what the code printed (runtime errors and timeouts still count). A run's `overall` verdict is still computed from the question's tests only, so custom cases never change a verdict.
- **Visible to both roles.** Custom cases were written by participants, so their inputs and outputs are not secret: both the candidate and interviewer views include them. Hidden-test rules are untouched.
- **Timer:** the interviewer's top bar shows time since the room was created; it stops at `rooms.closed_at` (set when the session ends). The room view carries `createdAt`, `closedAt` and the server's `now`, and the client corrects for its own clock offset, so a wrong local clock doesn't skew it. Candidates don't see it.

## Alternatives considered
- **Store custom cases in Postgres behind their own API + events** — more code for the same result; the Yjs doc already gives sharing, persistence, cross-instance fan-out and read-only enforcement.
- **Let custom cases affect the verdict / allow them on Submit** — a candidate could "pass" with their own tests; grading must come only from the pinned question version.
- **Add custom cases to `test_results`** — that table references `test_cases` and carries the hidden-output constraint; mixing participant-written cases into it would blur exactly the line the schema protects.
- **Show the timer to the candidate** — adds pressure without helping the interviewer; easy to enable later.

## Consequences
- Verified by `pnpm smoke` (`custom-cases` section) and `pnpm e2e` (`custom-cases.e2e.ts`).
- Custom cases run inside the same sandbox limits as tests, so they add run time; the 10-case cap bounds it.
