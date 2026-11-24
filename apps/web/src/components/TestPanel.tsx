import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  MAX_CUSTOM_CASE_BYTES,
  MAX_CUSTOM_CASES,
  utf8Length,
  type CandidateQuestionView,
  type RoomQuestionView,
} from "@coderoom/shared";
import type { SharedCase } from "../lib/roomQuestions";
import { questionOf, type SubmissionEntry } from "../lib/submissions";
import { ResultsPanel } from "./ResultsPanel";

type Tab = "cases" | "result" | "notes";

/** What the Case tabs list: the question's public examples, then the shared custom cases. */
type CaseItem =
  | { kind: "example"; key: string; input: string; expectedOutput: string }
  | { kind: "custom"; key: string; custom: SharedCase };

/**
 * Below the editor:
 *  - "Testcase": the question's public examples, then custom cases either participant added (shared
 *    through the room doc, ADR 0010), one case at a time, plus "+" to add one. Hidden tests are never
 *    listed — only their count.
 *  - "Test Result": the runs for this question.
 *  - "Notes": the interviewer's private notes — only when `notes` is given (never for the candidate).
 *    Kept mounted while another tab shows, so a half-written note survives switching tabs.
 * Switches to Test Result when a run for this question starts — except from Notes, so the candidate
 * pressing Run never pulls the interviewer out of a note they're writing.
 */
export function TestPanel({
  question,
  roomQuestion,
  entries,
  ended = false,
  customCases,
  canEditCases,
  onAddCase,
  onRemoveCase,
  notes,
}: {
  question: CandidateQuestionView;
  /** The room question being viewed — only in multi-question rooms (scopes the results). */
  roomQuestion?: RoomQuestionView;
  entries: SubmissionEntry[];
  /** The interview has ended: opening it is for reviewing results, so start on Test Result. */
  ended?: boolean;
  customCases: SharedCase[];
  /** Adding/removing is off once the room ended, and for questions the candidate can't see yet. */
  canEditCases: boolean;
  /** Adds the case unless that's no longer allowed (checked at that moment): its id, or why it was refused. */
  onAddCase: (c: { input: string; expectedOutput?: string }) => { id: string } | { refused: string };
  onRemoveCase: (id: string) => void;
  /** The interviewer's notes panel. Omitted for candidates: no tab, nothing rendered. */
  notes?: ReactNode;
}) {
  const [tab, setTab] = useState<Tab>(ended ? "result" : "cases");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const items: CaseItem[] = [
    ...question.publicTests.map((t) => ({ kind: "example" as const, key: `ex:${t.id}`, input: t.input, expectedOutput: t.expectedOutput })),
    ...customCases.map((c) => ({ kind: "custom" as const, key: `custom:${c.id}`, custom: c })),
  ];
  // The selected case, or the first one if it was removed (by either participant) or never chosen.
  const current = items.find((i) => i.key === selectedKey) ?? items[0];
  const exampleCount = question.publicTests.length;

  // Back to the first case and out of the add form when the question changes.
  useEffect(() => {
    setSelectedKey(null);
    setAdding(false);
  }, [question.versionId]);
  // Editing just stopped (e.g. the session ended): close an open form, it can't add anything any more.
  useEffect(() => {
    if (!canEditCases) setAdding(false);
  }, [canEditCases]);
  const showForm = adding && canEditCases;
  const overflow = Math.max(0, customCases.length - MAX_CUSTOM_CASES);

  /*
   * A run starting for this question (ours, or the candidate's for the interviewer) → show its result.
   * "Starting" = a new newest entry that is still pending (our submit or the queued event). One effect
   * tracks the question and its newest run together, and handles a question change first, so:
   *  - switching to a question that already has runs keeps the current tab;
   *  - loading history (on open, reload or reconnect) doesn't count as a run starting.
   */
  const newest = entries.find((e) => !roomQuestion || questionOf(e) === roomQuestion.id);
  const questionKey = roomQuestion?.id ?? "";
  const seen = useRef({ questionKey, newestId: newest?.submissionId });
  useEffect(() => {
    const prev = seen.current;
    seen.current = { questionKey, newestId: newest?.submissionId };
    if (prev.questionKey !== questionKey) return; // switched questions: not a new run
    if (newest && newest.submissionId !== prev.newestId && newest.pending) setTab((t) => (t === "notes" ? t : "result"));
  }, [questionKey, newest]);

  const full = customCases.length >= MAX_CUSTOM_CASES;

  return (
    <section className="pane tests-pane" aria-label="Tests">
      <div className="pane-head" role="tablist" aria-label="Test panel">
        <button
          role="tab"
          aria-selected={tab === "cases"}
          className={`pane-tab ${tab === "cases" ? "active" : ""}`}
          onClick={() => setTab("cases")}
        >
          <span className="pane-icon ok" aria-hidden="true">☑</span> Testcase
        </button>
        <span className="pane-sep" aria-hidden="true" />
        <button
          role="tab"
          aria-selected={tab === "result"}
          className={`pane-tab ${tab === "result" ? "active" : ""}`}
          onClick={() => setTab("result")}
        >
          <span className="pane-icon ok" aria-hidden="true">&gt;_</span> Test Result
        </button>
        {notes && (
          <>
            <span className="pane-sep" aria-hidden="true" />
            <button
              role="tab"
              aria-selected={tab === "notes"}
              className={`pane-tab ${tab === "notes" ? "active" : ""}`}
              onClick={() => setTab("notes")}
            >
              <span className="pane-icon" aria-hidden="true">✎</span> Notes
            </button>
          </>
        )}
      </div>

      {tab === "cases" ? (
        <div className="pane-body cases">
          <div className="case-tabs" role="group" aria-label="Cases">
            {items.map((item, i) => {
              const selected = !showForm && current?.key === item.key;
              const customIndex = i - exampleCount;
              const label = item.kind === "example" ? `Case ${i + 1}` : `Custom ${customIndex + 1}`;
              const notRun = item.kind === "custom" && customIndex >= MAX_CUSTOM_CASES;
              return (
                <button
                  key={item.key}
                  className={`case-tab ${item.kind === "custom" ? "custom" : ""} ${notRun ? "not-run" : ""} ${selected ? "active" : ""}`}
                  title={notRun ? "Over the limit — not run until cases are removed" : undefined}
                  aria-pressed={selected}
                  onClick={() => {
                    setSelectedKey(item.key);
                    setAdding(false);
                  }}
                >
                  {item.kind === "custom" && (
                    <span className="case-icon" aria-hidden="true">
                      ✎{" "}
                    </span>
                  )}
                  {label}
                </button>
              );
            })}
            {canEditCases && (
              <button
                className={`case-tab case-add ${showForm ? "active" : ""}`}
                aria-label="Add a custom test case"
                title={full ? `At most ${MAX_CUSTOM_CASES} custom cases` : "Add a test case for both of you to run"}
                disabled={full}
                onClick={() => setAdding(true)}
              >
                +
              </button>
            )}
          </div>

          {overflow > 0 && (
            <p className="warning small" role="status">
              Only the first {MAX_CUSTOM_CASES} custom cases run (cases were added at the same time). Remove {overflow} to
              include the rest.
            </p>
          )}
          {showForm ? (
            <AddCaseForm
              onCancel={() => setAdding(false)}
              onAdd={(c) => {
                const result = onAddCase(c);
                if ("refused" in result) return result.refused; // shown in the form; nothing was written
                setAdding(false);
                setSelectedKey(`custom:${result.id}`);
                return null;
              }}
            />
          ) : current ? (
            <div className="case-io">
              {current.kind === "custom" && (
                <div className="case-meta">
                  <span className="muted small">
                    Added by {current.custom.addedBy.name} ({current.custom.addedBy.role}) · runs with Run, not used for grading
                  </span>
                  {canEditCases && (
                    <button className="link small" onClick={() => onRemoveCase(current.custom.id)}>
                      Remove
                    </button>
                  )}
                </div>
              )}
              <div className="case-label">Input =</div>
              <pre className="case-box" aria-label="Case input">
                {current.kind === "example" ? current.input : current.custom.input}
              </pre>
              <div className="case-label">Expected output =</div>
              <pre className="case-box" aria-label="Case expected output">
                {current.kind === "example"
                  ? current.expectedOutput
                  : (current.custom.expectedOutput ?? "— not set: Run just shows the output —")}
              </pre>
            </div>
          ) : (
            <p className="muted">This question has no example cases.</p>
          )}
          {question.hiddenTestCount > 0 && (
            <p className="muted small">
              Submit also runs {question.hiddenTestCount} hidden test{question.hiddenTestCount === 1 ? "" : "s"}.
            </p>
          )}
        </div>
      ) : tab === "result" ? (
        <div className="pane-body">
          <ResultsPanel entries={entries} question={roomQuestion} />
        </div>
      ) : null}
      {notes && (
        <div className="pane-body" hidden={tab !== "notes"}>
          {notes}
        </div>
      )}
    </section>
  );
}

/** Input + optional expected output for a new custom case, with the server's size limits checked up front. */
function AddCaseForm({
  onAdd,
  onCancel,
}: {
  /** Returns why the case wasn't added, or null when it was. */
  onAdd: (c: { input: string; expectedOutput?: string }) => string | null;
  onCancel: () => void;
}) {
  const [input, setInput] = useState("");
  const [expected, setExpected] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  const tooBig = utf8Length(input) > MAX_CUSTOM_CASE_BYTES || utf8Length(expected) > MAX_CUSTOM_CASE_BYTES;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (tooBig) return;
    setRefused(onAdd({ input, ...(expected.trim() ? { expectedOutput: expected } : {}) }));
  }

  return (
    <form className="case-io" onSubmit={submit} aria-label="New test case">
      <label className="case-label" htmlFor="custom-case-input">
        Input =
      </label>
      <textarea
        id="custom-case-input"
        aria-label="New case input"
        className="mono case-box"
        rows={3}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="stdin for your code, e.g. 3&#10;-1 -2 -3"
        autoFocus
      />
      <label className="case-label" htmlFor="custom-case-expected">
        Expected output (optional) =
      </label>
      <textarea
        id="custom-case-expected"
        aria-label="New case expected output"
        className="mono case-box"
        rows={2}
        value={expected}
        onChange={(e) => setExpected(e.target.value)}
        placeholder="Leave empty to just see what the code prints"
      />
      {tooBig && <p className="error small">Each field is limited to {MAX_CUSTOM_CASE_BYTES / 1000} KB.</p>}
      {refused && (
        <p className="error small" role="alert">
          {refused}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="primary" disabled={tooBig}>
          Add case
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
        <span className="muted small">Both of you will see it. It runs with Run; Submit is graded on the question's tests.</span>
      </div>
    </form>
  );
}
