# 0012 — One interviewer and one candidate per room, enforced by the database

**Status:** Accepted — implemented (migration `one_candidate_per_room`, `POST /rooms/join`)

## Context
Joining with the invite link granted the candidate role to anyone who had the link, so a forwarded or leaked link let extra people into an interview: they could see the questions, type in the shared editor and submit. An interview is one interviewer and one candidate.

## Decision
- **One interviewer, one candidate per room.** The interviewer is the room's creator (unchanged). The first person to join with the invite link becomes the candidate; anyone else gets `409` with the structured code `conflict: "room_full"` (clients match the code, not the message) and never becomes a participant, so every room route, WebSocket and the review keep refusing them (403). The candidate can rejoin with the link (another device, a reload) — joining is idempotent for them. The interviewer opening their own invite link is simply sent to their room (`200`, role `interviewer`); nothing is inserted and the candidate seat stays free.
- **Enforced by the database, not a check-then-insert.** Partial unique indexes allow at most one (non-legacy) `candidate` row and one `interviewer` row per room. Two people opening the link at the same instant race on the index: exactly one insert succeeds (`ON CONFLICT DO NOTHING`), the other is refused.
- **Existing rooms keep their data.** Four rooms already had two candidates before this rule (with 28 submissions between them). Instead of deleting participants — which would orphan their submissions from the review — the migration marks every candidate except the earliest to join as `legacy_extra`. They keep access to those old rooms and stay in the review; the unique index ignores legacy rows; no new legacy rows can be created.

## Alternatives considered
- **Check the candidate count in the API, then insert** — racy: two simultaneous joins both see zero candidates.
- **Delete extra candidates in existing rooms** — loses who submitted what in old interviews.
- **Expire the invite code after the first join** — the candidate couldn't rejoin from another device; the participant row already identifies them.
- **Per-candidate invite links / email allowlist** — more secure against link sharing before the candidate joins, but needs email delivery or identity matching; a later option.

## Consequences
- Verified by `pnpm smoke` (`rooms-smoke.ts`: a second person gets 409 `room_full` and no access, the candidate can rejoin, the interviewer's own link returns them to the room without taking the seat, 10 rounds of two people joining at once always yield exactly one candidate) and `pnpm e2e` (a third person opening the invite link is turned away; the interviewer opening their own link before anyone joined lands in their room and the seat stays free).
- A leaked link still lets someone *become* the candidate if they join first. The interviewer sees who joined (presence avatars) and can end the room.
