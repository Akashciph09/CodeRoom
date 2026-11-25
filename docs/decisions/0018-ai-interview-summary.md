# 0018 — AI drafts an evidence-linked interview summary

## Decision

The interviewer can request a summary on the review page. The API builds the prompt from the
interviewer's review and sends it to the Claude Messages API through one server-side service.
We chose Claude Haiku as the default for short synthesis tasks, with a server-side model override.
For portfolio demos, CodeRoom can also use GroqCloud's free tier with GPT-OSS 20B. This model
supports [strict structured output](https://console.groq.com/docs/structured-outputs) and keeps
the response contract shared with Claude. Select a provider explicitly through server configuration.
Use synthetic interview data for free-tier demos.

We use Node's built-in fetch for these two HTTP endpoints. An SDK or a multi-provider framework would
add dependencies for features this flow does not use.

The prompt includes revealed question titles, structured run results, interviewer notes, and saved
rubric dimensions. It excludes raw candidate code, candidate names and emails, test inputs and outputs, and
the overall recommendation. Free text is untrusted evidence. The model receives no tools and cannot
write to CodeRoom. It is asked for observations and follow-up questions, with no scores, rankings,
or hiring recommendations.

The service requests [structured JSON](https://platform.claude.com/docs/en/build-with-claude/structured-outputs),
validates model output, and drops bullets with missing or unknown citations. Citation
labels and anchors come from server-loaded evidence. A valid citation identifies a source the
interviewer can verify. The generated draft is saved privately per room and interviewer. The author can save edits or discard
the draft in the review page. Edits change only the text, so citations remain server-authored.
Revision checks prevent a stale request from overwriting edits or restoring a discarded draft.

Model calls happen on demand, with a per-interviewer rate limit, an input budget, and a timeout.
Tests inject a fake model. Production keys are server-only and optional, so the rest of the app
works without an AI provider configured.

## Alternatives considered

- Sending raw code would add prompt-injection exposure and provider data sharing without being
  necessary for summarizing test results and interviewer observations.
- Browser-only drafts disappear when the page closes. Server-side drafts survive navigation and reloads.
  Generation still requires a request from the interviewer.
