# 0013 — The interviewer's room list shows each candidate's name and email

**Status:** Accepted — implemented (`GET /rooms`, `services/review.ts` `roomCandidates`, `HomePage` `RoomsTable`)

## Context
An interviewer's room list showed only the first question's title, role, status and date. With many interviews of the same question, finding "Casey's interview" meant opening rooms one by one.

A first version also showed each candidate's test score and grading state in the list. It was removed before release: scoring belongs on the review page (ADR 0011), where it's shown with its breakdown and caveats; a bare number in a list invites comparing candidates on correctness alone, and keeping list labels in sync with grading states added complexity for little value.

## Decision
- **Interviewer rows carry their candidates — name and email only**, in join order. Rooms nobody joined list none. It's an array because rooms from before ADR 0012 can have more than one candidate; the list shows the first plus "+N", and search matches every one of them.
- **Privacy: interviewer rows only.** The API adds `candidates` only to rows where the caller is the interviewer. On a candidate's own list there are no names or emails of anyone (their own row says "You"). Emails are personal data and appear on no candidate-facing view or in logs.
- **No scoring in the list.** `GET /rooms` does no score aggregation; the review page's scoring (`scoreCandidate`, pass counts) is unchanged.
- **Layout:** a semantic table with fixed columns — Interview | Candidate | Your role | Status | Created | Action (`table-layout: fixed`, ellipsis with the full text on hover and in the DOM), so long names and emails can't push other columns or overflow the card. The Interview column shows the room's first question (rooms have no names yet). Closed rooms read "Ended". Dates are compact ("23 Nov, 18:20", with the year when it isn't the current one) with the full timestamp in `title` and as screen-reader text. Review appears only on interviewer rows. Below 680 px each row becomes a compact card (names and emails wrap instead of truncating); explicit ARIA roles keep the table semantics when rows are restyled.
- **Search** filters client-side by question title or any candidate's name or email (the list is the 50 most recent rooms).

## Alternatives considered
- **Scores in the list** — removed; see Context.
- **CSS Grid of divs** — equally aligned, but a table gives column headers and row/cell semantics for free.
- **Horizontal scrolling on phones** — hides the action column; cards keep everything visible.
- **Server-side search** — unnecessary for 50 rows; worth adding with pagination if lists grow.

## Consequences
- Verified by unit tests (`lib/roomList.test.ts`: date format, labels, "+N" cell, search over collapsed candidates), `pnpm smoke` (`rooms-smoke.ts`: name/email only, empty room, legacy room with two candidates in join order, a candidate's list with no candidate details) and `pnpm e2e` (`room-list.e2e.ts`: column headers, alignment and no overflow with a very long name and email, Ended, the full timestamp, search, phone cards without horizontal overflow, the candidate's own list).
- Only the 50 most recent rooms are listed and searched.
