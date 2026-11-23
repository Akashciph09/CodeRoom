# 0013 — The interviewer's room list shows each candidate, their email and test score

**Status:** Accepted — implemented (`GET /rooms`, `services/review.ts` `candidateSummaries`, `HomePage`)

## Context
An interviewer's room list showed only the first question's title, role, status and date. With many interviews of the same question, finding "Casey's interview" meant opening rooms one by one, and seeing how someone did meant opening each review.

## Decision
- **Interviewer rows carry their candidates:** name, email and the test score (ADR 0011), plus `hasSubmit` so "0 because nothing was submitted" isn't shown as a failing score. Rooms nobody joined list none ("No candidate joined"). The list is an array because rooms from before ADR 0012 can have more than one candidate.
- **The same scoring code as the review page.** `candidateSummaries` batches the list's rooms and calls the same `scoreCandidate`, with the same pass-count query, so the list and the review can't disagree. Smoke tests compare the two.
- **Privacy: interviewer rows only.** The API adds `candidates` only to rows where the caller is the interviewer. On a candidate's own list nothing changes: no names, emails or scores of anyone. Emails are personal data and appear on no candidate-facing view or in logs.
- **Search** filters the list client-side by question title, candidate name or email (the list is the 50 most recent rooms).

## Alternatives considered
- **Store the score on the room** — it would need updating on every submission and could drift from the review; computing it on read keeps one source of truth.
- **A separate "candidates" page** — another place to look; the list is where interviewers already are.
- **Server-side search** — unnecessary for 50 rows; worth adding with pagination if lists grow.

## Consequences
- Verified by `pnpm smoke` (`rooms-smoke.ts`: list score equals review score per room, empty room, not-yet-submitted candidate, and a candidate's list with no candidate details) and `pnpm e2e` (`room-list.e2e.ts`).
- Only the 50 most recent rooms are listed and searched.
