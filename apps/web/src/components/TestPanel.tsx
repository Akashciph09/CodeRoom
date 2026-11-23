import { useEffect, useRef, useState } from "react";
import type { CandidateQuestionView, RoomQuestionView } from "@coderoom/shared";
import { questionOf, type SubmissionEntry } from "../lib/submissions";
import { ResultsPanel } from "./ResultsPanel";

type Tab = "cases" | "result";

/**
 * Below the editor: "Testcase" shows the question's public examples one case at a time; "Test Result"
 * shows the runs for this question. Hidden tests are never listed — only their count, as on the
 * question panel. Switches to Test Result when a new run for this question starts.
 */
export function TestPanel({
  question,
  roomQuestion,
  entries,
}: {
  question: CandidateQuestionView;
  /** The room question being viewed — only in multi-question rooms (scopes the results). */
  roomQuestion?: RoomQuestionView;
  entries: SubmissionEntry[];
}) {
  const [tab, setTab] = useState<Tab>("cases");
  const [caseIndex, setCaseIndex] = useState(0);
  const cases = question.publicTests;
  const current = cases[Math.min(caseIndex, cases.length - 1)];

  // Back to Case 1 when the question changes.
  useEffect(() => setCaseIndex(0), [question.versionId]);

  // A new run for this question (ours, or the candidate's for the interviewer) → show its result.
  const latest = entries.find((e) => !roomQuestion || questionOf(e) === roomQuestion.id)?.submissionId;
  const seenLatest = useRef(latest);
  useEffect(() => {
    if (latest && latest !== seenLatest.current) setTab("result");
    seenLatest.current = latest;
  }, [latest]);
  // Switching questions keeps the tab but must not count the other question's history as "new".
  useEffect(() => {
    seenLatest.current = latest;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomQuestion?.id]);

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
      </div>

      {tab === "cases" ? (
        <div className="pane-body cases">
          {cases.length === 0 ? (
            <p className="muted">This question has no example cases.</p>
          ) : (
            <>
              <div className="case-tabs" role="group" aria-label="Cases">
                {cases.map((c, i) => (
                  <button
                    key={c.id}
                    className={`case-tab ${current?.id === c.id ? "active" : ""}`}
                    aria-pressed={current?.id === c.id}
                    onClick={() => setCaseIndex(i)}
                  >
                    Case {i + 1}
                  </button>
                ))}
              </div>
              {current && (
                <div className="case-io">
                  <div className="case-label">Input =</div>
                  <pre className="case-box" aria-label="Case input">
                    {current.input}
                  </pre>
                  <div className="case-label">Expected output =</div>
                  <pre className="case-box" aria-label="Case expected output">
                    {current.expectedOutput}
                  </pre>
                </div>
              )}
            </>
          )}
          {question.hiddenTestCount > 0 && (
            <p className="muted small">
              Submit also runs {question.hiddenTestCount} hidden test{question.hiddenTestCount === 1 ? "" : "s"}.
            </p>
          )}
        </div>
      ) : (
        <div className="pane-body">
          <ResultsPanel entries={entries} question={roomQuestion} />
        </div>
      )}
    </section>
  );
}
