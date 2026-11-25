import { useState } from "react";
import type { RoomQuestionView, Verdict } from "@coderoom/shared";
import { isInterviewerView, type SubmissionView } from "../lib/api";
import { questionOf, type SubmissionEntry } from "../lib/submissions";
import { VERDICT_LABEL } from "../lib/verdicts";

function VerdictBadge({ verdict }: { verdict?: Verdict }) {
  if (!verdict) return <span className="verdict pending">Running…</span>;
  return <span className={`verdict ${verdict === "accepted" ? "ok" : "bad"}`}>{VERDICT_LABEL[verdict]}</span>;
}

/**
 * Submission history, newest first. In a multi-question room it shows only the runs of the question
 * being viewed (`question`), so its test rows match that question's examples; switching questions
 * switches the list. Single-question rooms show everything.
 */
export function ResultsPanel({
  entries,
  question,
}: {
  entries: SubmissionEntry[];
  /** The question being viewed — only in multi-question rooms. */
  question?: RoomQuestionView;
}) {
  // A placeholder that never learned its question (shouldn't happen) stays visible rather than vanish.
  const shown = question
    ? entries.filter((e) => {
        const q = questionOf(e);
        return q === undefined || q === question.id;
      })
    : entries;
  return (
    <section className="panel results-panel">
      <h2>Public results{question && <span className="muted"> · Q{question.position}</span>}</h2>
      {shown.length === 0 && <p className="muted">{question ? `No runs for Q${question.position} yet.` : "No runs yet."}</p>}
      {shown.map((e) => (
        <SubmissionCard key={e.submissionId} entry={e} />
      ))}
    </section>
  );
}

function SubmissionCard({ entry }: { entry: SubmissionEntry }) {
  if (entry.pending) {
    return (
      <div className="submission">
        <div className="submission-head">
          <VerdictBadge />
          <span className="muted">queued</span>
        </div>
      </div>
    );
  }

  const v = entry.view;
  const done = v.status === "completed" || v.status === "failed";
  const publicResults = isInterviewerView(v) ? v.results.filter((r) => !r.hidden) : v.publicResults;
  const publicVerdict = publicResults.find((r) => r.verdict !== "accepted")?.verdict ?? "accepted";
  return (
    <div className="submission">
      <div className="submission-head">
        {done && publicResults.length === 0 ? <span className="muted">No public results</span> :
          <VerdictBadge verdict={done ? publicVerdict : undefined} />}
        <span className="badge">{v.mode}</span>
      </div>

      <table className="tests">
        <tbody>
          {publicResults.map((r, index) => (
            <tr key={r.testId}>
              <td>Example {index + 1}</td>
              <td>
                <VerdictBadge verdict={r.verdict} />
              </td>
              <td className="muted">{r.timeMs} ms</td>
              <td className="output">{r.stderr?.trim() ? <pre>{r.stderr.trim().slice(-400)}</pre> : r.stdout ? <pre>{r.stdout.trim().slice(0, 200)}</pre> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {v.customResults.length > 0 && (
        <>
          <div className="custom-head muted small">
            Custom cases · not graded
            {(() => {
              const checked = v.customResults.filter((c) => c.expectedOutput !== undefined);
              return checked.length > 0
                ? ` · ${checked.filter((c) => c.verdict === "accepted").length}/${checked.length} matched`
                : "";
            })()}
          </div>
          <table className="tests custom-results">
            <tbody>
              {v.customResults.map((c) => (
                <tr key={c.position}>
                  <td>Custom {c.position + 1}</td>
                  <td>
                    {c.expectedOutput === undefined && c.verdict === "accepted" ? (
                      <span className="verdict">Ran</span>
                    ) : (
                      <VerdictBadge verdict={c.verdict} />
                    )}
                  </td>
                  <td className="muted">{c.timeMs} ms</td>
                  <td className="output">
                    <pre aria-label={`Custom ${c.position + 1} output`}>
                      {c.stderr?.trim() ? c.stderr.trim().slice(-400) : (c.stdout ?? "").trim().slice(0, 400)}
                    </pre>
                    {c.expectedOutput !== undefined && c.verdict === "wrong_answer" && (
                      <pre className="muted">expected: {c.expectedOutput.trim().slice(0, 200)}</pre>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {isInterviewerView(v) && v.mode === "run" && <SubmittedCode code={v.code} />}
    </div>
  );
}

function SubmittedCode({ code }: { code: string }) {
  const [showCode, setShowCode] = useState(false);
  return (
    <>
      <button className="link" onClick={() => setShowCode((s) => !s)}>
        {showCode ? "Hide" : "Show"} submitted code
      </button>
      {showCode && <pre className="code-snapshot">{code}</pre>}
    </>
  );
}

export function SubmissionResults({ submissions }: { submissions: SubmissionView[] }) {
  return (
    <section className="panel submission-results" aria-label="Submission results">
      <h2>Submission results</h2>
      {submissions.length === 0 && <p className="muted">No submissions for this question yet.</p>}
      {submissions.map((view) => (
        <div className="submission" key={view.submissionId}>
          <div className="submission-head">
            <VerdictBadge verdict={view.status === "failed" ? "internal_error" : view.overall} />
            {isInterviewerView(view) && <time className="muted" dateTime={view.createdAt}>{new Date(view.createdAt).toLocaleTimeString()}</time>}
          </div>
          {isInterviewerView(view) ? (
            <>
              <table className="tests" aria-label="Hidden test results">
                <tbody>
                  {view.results.filter((result) => result.hidden).map((result, index) => (
                    <tr key={result.testId}>
                      <td>Hidden case {index + 1}</td>
                      <td><VerdictBadge verdict={result.verdict} /></td>
                      <td className="muted">{result.timeMs} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <SubmittedCode code={view.code} />
            </>
          ) : view.hiddenTotal !== undefined && view.hiddenPassed !== undefined && (
            <>
              <p className="muted small">{view.hiddenPassed}/{view.hiddenTotal} hidden tests passed</p>
              {view.hiddenPassed > 0 && (
                <ul className="passed-hidden-tests" aria-label="Passed hidden tests">
                  {Array.from({ length: view.hiddenPassed }, (_, index) => (
                    <li key={index} className="badge"><span className="verdict ok">✓</span> Passed case {index + 1}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      ))}
    </section>
  );
}
