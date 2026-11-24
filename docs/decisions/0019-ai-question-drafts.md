# 0019 — Draft and validate questions with AI

An authenticated author supplies a short role or topic brief. The existing AI service requests one
standalone programming question and a Python reference solution. Claude and Groq use the same
structured output contract. No room, candidate, or interview data is loaded for this flow.

The API validates the model response and queues the reference solution and generated tests on the
existing execution queue as a distinct job type. Only the worker executes the reference solution.
Each test gets its own container with the same restrictions as candidate runs. The job returns
verdicts only and expires quickly. We reuse the queue and worker concurrency controls to avoid
introducing a second execution system. The request waits for a bounded period and saves the draft
atomically after validation. A worker or provider failure can be retried without an empty draft.

Per-test reference verdicts are visible to the author. They are retained for unchanged test inputs
and outputs and cleared for edited tests. The reference solution is never saved with the question.
Agreement with the reference is a consistency check. The model can generate a solution and tests
that share the same error, so the interviewer still reviews the statement and cases and explicitly
marks the draft ready. No generated question is published automatically.

We generate one question per request to bound worker load. Generating batches or running reference
code in the API would increase resource usage or weaken the execution boundary, respectively.
