# 0009 — Rooms hold an ordered list of questions, revealed by the interviewer

**Status:** Accepted — implemented (`room_questions`, `routes/rooms.ts`, `RoomPage`)

## Context
An interview often has more than one problem: a warm-up, then a harder one. A room used to pin exactly one question version (`rooms.question_version_id`), so a second problem meant a second room and a second invite link. A multi-question room has to keep everything [ADR 0007](0007-immutable-question-versions.md) guarantees (every interview grades against the exact versions it started with) and must not tell the candidate what's coming before the interviewer chooses to.

## Decision
- **`room_questions(id, room_id, position, question_version_id, revealed_at)`**, one row per question, 1–5 per room, positions `1..n`. The list and each pinned version are fixed when the room is created; the only later change is `revealed_at`.
- **The interviewer reveals; the candidate navigates among revealed questions.** Q1 is revealed when the room is created. Questions are revealed strictly in order: the reveal is one conditional `UPDATE … WHERE revealed_at IS NULL AND <previous position is revealed>`, so a double-click can't skip a question and repeating a reveal is a no-op. The candidate's view switches to the newly revealed question; they can go back to earlier ones.
- **Unrevealed questions don't exist for the candidate.** `GET /rooms/:id` filters them out on the server. A submission to an unrevealed question gets the same `404` as a nonexistent one. Their content never appears in candidate responses, events or the shared Yjs doc: starter code is seeded only once a question is revealed. The candidate isn't told how many questions remain.
- **Submissions name their question.** `POST /submissions` takes `roomQuestionId`, and the API copies that question's pinned version onto the row. A **composite foreign key** `(room_question_id, room_id, question_version_id) → room_questions` makes it impossible, even via a buggy path or manual SQL, to record a submission against another room's question or a different version than the one pinned. The worker is unchanged: it already grades by `submissions.question_version_id`.
- **One code buffer and language per question, keyed by position.** Q1 keeps the original Yjs names (`"code"`, meta `language` / `initialized`); question *n* > 1 uses `code:n`, `language:n`, `initialized:n`. Positions never change within a room, so they're stable keys, and existing rooms' stored documents keep working without a Yjs data migration.
- **Realtime — durable, like closure ([ADR 0005](0005-yjs-over-own-websocket.md)).** The reveal's DB update is the commit point. A `room:question_revealed` bus event (carrying the room's new revealed count, no content) is the fast path; the room-status reconciler on every gateway also re-reads each open room's revealed count every `ROOM_STATUS_RECONCILE_MS`, so a lost publish reaches connected clients within one interval without a reconnect. Gateways forward a reveal only when the count goes up, so the two paths never notify twice. Clients re-fetch the room on the event, on every events reconnect, and on `room:closed`, merging forward-only. The last one matters because gateways stop reconciling reveals once a room has ended: a reveal whose publish was lost just before the close is picked up by that final re-fetch.
- **Reveal and close are serialized.** `revealQuestion` locks the room row (`SELECT … FOR UPDATE`) and checks the status in the same transaction as the reveal; ending the session is an `UPDATE` of that row and takes the same lock. A reveal that races the end of the session either commits first or waits and is refused — never a question revealed in an ended room. Submissions use the same row: the open-room check and the insert share one transaction holding `FOR SHARE` (submissions don't block each other, closing waits for them and they wait for closing), so none is accepted into an ended room.

## Alternatives considered
- **Candidate sees every question from the start** — simpler, but interviewers lose control of pacing and the candidate sees the whole interview up front.
- **Both screens follow the interviewer** — the candidate can't go back to fix an earlier answer while talking about it.
- **Buffers keyed by `room_questions.id`** — cleaner names, but existing rooms' stored `"code"` text would need rewriting inside persisted Yjs state; a position key gives the same stability without touching it.
- **One shared buffer for all questions** — switching questions would destroy the previous answer.
- **Questions added during the interview** — deferred; a fixed list keeps reveal ordering and the composite key simple. Adding later is possible (pin at add time).

## Migration
Same pattern as ADR 0007, rehearsed on a copy of the local database:
1. Add `room_questions` and a nullable `submissions.room_question_id`, then backfill: every existing room becomes a one-question room (position 1, revealed at room creation) and its submissions point at that row.
2. Make `room_question_id` `NOT NULL`, add the composite foreign key, and drop `rooms.question_version_id`.

## Consequences
- Verified by `pnpm smoke` (`rooms-smoke.ts`: including a deterministic close/reveal race — the reveal is fired while the room row is held by a closing transaction), `pnpm smoke:realtime` (a reveal stored with no publish reaches a candidate connected to another instance; a normal reveal is announced exactly once) and `pnpm e2e` (`multi-question.e2e.ts`).
- Room summaries show the first question's title.
- At most 5 questions per room; the limit is in the shared request schema.
