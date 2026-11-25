# 0020 — Suggest hidden tests from a question and check them against an author's reference

The question editor can request hidden test suggestions for the author's saved question revision.
The existing Claude or Groq provider receives its title, statement, constraints, and public examples.
Existing hidden cases and the author's Python reference stay inside CodeRoom. The API removes
duplicate inputs against all saved cases before sending proposals to the existing sandbox worker.
The worker uses the supplied reference to compare each suggested expected output.

An author can select passing cases and add them to the editor. The existing Save draft and Mark
ready actions remain the write and publication paths. The suggestion request does not change the
question. Proposals and verdicts are temporary, and the supplied reference is not retained with
the question. A passing check demonstrates agreement with the reference, so authors still review
inputs for coverage and compliance with the constraints.

We reuse the AI transport and worker rather than adding a provider or execution path. Deriving
expected outputs from an unchecked model response alone would miss mismatches. Automatically
saving suggestions would bypass the author's review and interfere with concurrent draft edits.
