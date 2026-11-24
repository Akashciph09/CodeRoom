# 0014 — Optional room names, visible to the interviewer only

**Status:** Accepted — implemented (`rooms.name`, `POST /rooms`, `PATCH /rooms/:id`, room list, room top bar, review)

## Context
Rooms were identified only by their first question, so an interviewer running many interviews of the same question couldn't tell "Backend interview" from "SRE interview" in their list.

## Decision
- **An optional name per room** (`rooms.name`, e.g. "Backend interview"): set when the room is created, renamed or cleared later by the interviewer (`PATCH /rooms/:id { name }`), also after the session ended.
- **1–80 characters after trimming**; an empty name means "no name" (stored as `NULL`). The database enforces it too (`CHECK` on the trimmed length), so no code path can store a blank or oversized name.
- **Interviewer only.** It's the interviewer's label for organizing their interviews and may hold internal notes ("SRE — referral from Priya"), so it is never sent to candidates: `GET /rooms/:id` includes it only for the interviewer, and `GET /rooms` only on interviewer rows. Candidates keep seeing question titles. Renaming is interviewer-only (`403` otherwise).
- **Where it shows:** the room list's Interview column (name, with the first question underneath; search matches it), the room's top bar (with a rename control), and the review page header. Rooms without a name show the first question as before.

## Alternatives considered
- **Show the name to candidates** — friendlier, but leaks whatever the interviewer typed; question titles already tell the candidate what they're doing. Easy to add later as a separate "public title" if wanted.
- **Required name** — slows down starting an interview; most single-question rooms are identified well enough by the question.
- **Free-form tags instead of a name** — more flexible, more UI; a single name covers the request.

## Consequences
- Verified by `pnpm smoke` (`rooms-smoke.ts`: create with a name, trimming, blank → none, too long → 400, rename/clear by the interviewer, candidate can't rename (403), candidate's room view and list never contain the name) and `pnpm e2e` (`room-names.e2e.ts`).
