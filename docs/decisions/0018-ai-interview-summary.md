# 0018 — Claude drafts an evidence-linked interview summary

## Decision

The interviewer can request a summary on the review page. The API builds the prompt from the
interviewer's review and sends it to the Claude Messages API through one server-side service.
We chose Claude Haiku as the default for short synthesis tasks, with a server-side model override.
We use Node's built-in fetch for this single endpoint. An SDK or a multi-provider framework would
add dependencies for features this flow does not use.

The prompt includes revealed question titles, structured run results, interviewer notes, and saved
rubric dimensions. It excludes raw candidate code, candidate names and emails, test inputs and outputs, and
the overall recommendation. Free text is untrusted evidence. The model receives no tools and cannot
write to CodeRoom. It is asked for observations and follow-up questions, with no scores, rankings,
or hiring recommendations.

The service requests [structured JSON](https://platform.claude.com/docs/en/build-with-claude/structured-outputs),
validates model output, and drops bullets with missing or unknown citations. Citation
labels and anchors come from server-loaded evidence. A valid citation identifies a source the
interviewer can verify. The feature stores no AI output, and interviewers can edit or discard the
draft in the review page.

Model calls happen on demand, with a per-interviewer rate limit, an input budget, and a timeout.
Tests inject a fake model. Production keys are server-only and optional, so the rest of the app
works without an AI provider configured.

## Alternatives considered

- Sending raw code would add prompt-injection exposure and provider data sharing without being
  necessary for summarizing test results and interviewer observations.
- Persisting or automatically generating summaries would retain unreviewed AI output and incur calls
  before an interviewer requests them.
