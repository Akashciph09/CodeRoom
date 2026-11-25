# 0021 — Interviewers add tests scoped to the live room

Interviewers may add public or hidden tests to a revealed question in an open room. Candidate
custom tests still use the shared document and run only when the candidate clicks Run. Interviewer
additions are server-only records attached to the room question. Public additions appear in the
question view and are graded on Run and Submit. Hidden additions are graded only on Submit,
with output suppressed and only aggregate hidden counts available to candidates.

The room question's monotonic test revision advances when the interviewer adds a case.
Room locking serializes additions with submission creation and closure. Each submission copies
the revision before enqueueing. The worker uses that snapshot on every attempt, preserving results
for queued, retried and completed submissions. Results for additions use a separate table so the
published question bank and its existing result foreign keys stay intact. Review counts both tables.

The interviewer can enter a case manually or request three AI suggestions with reasons. The
provider receives the problem and public examples. Existing hidden cases, candidate data and
the optional trusted Python reference stay inside CodeRoom. The worker checks the exact reviewed
input and expected output when a reference is supplied. Without a reference, an explicit confirmation
is required. Suggestions themselves never modify the test suite.

The room event carries only a revision. The reconciler and reconnect fetch recover missed events.
The candidate is asked to resubmit when a question's tests are newer than their completed Submit.
Using Yjs for additions would disclose hidden input, and changing the pinned bank version would
affect other interviews or invalidate their historical results.
