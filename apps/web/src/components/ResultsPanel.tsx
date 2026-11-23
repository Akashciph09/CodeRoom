import { useState } from "react";
import type { RoomQuestionView, Verdict } from "@coderoom/shared";
import { isInterviewerView } from "../lib/api";
import { questionOf, type SubmissionEntry } from "../lib/submissions";

const VERDICT_LABEL: Record<Verdict, string> = {
  accepted: "Accepted",
  wrong_answer: "Wrong answer",
  time_limit_exceeded: "Time limit exceeded",
  memory_limit_exceeded: "Memory limit exceeded",
  runtime_error: "Runtime error",
  compile_error: "Compile error",
  internal_error: "Internal error",
};

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
      <h2>Results{question && <span className="muted"> · Q{question.position}</span>}</h2>
      {shown.length === 0 && <p className="muted">{question ? `No runs for Q${question.position} yet.` : "No runs yet."}</p>}
      {shown.map((e) => (
        <SubmissionCard key={e.submissionId} entry={e} />
      ))}
    </section>
  );
}

/** Public tests are numbered to match the "Example n" list; hidden tests get no number. */
function numbered<T extends { testId: string; hidden?: boolean }>(results: T[]) {
  let n = 0;
  return results.map((r) => ({ r, label: r.hidden ? null : ++n }));
}

function SubmissionCard({ entry }: { entry: SubmissionEntry }) {
  const [showCode, setShowCode] = useState(false);
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
  return (
    <div className="submission">
      <div className="submission-head">
        <VerdictBadge verdict={done ? (v.overall ?? "internal_error") : undefined} />
        <span className="badge">{v.mode}</span>
        {isInterviewerView(v) && (
          <>
            <span className="badge">{v.language}</span>
            <span className="muted">{new Date(v.createdAt).toLocaleTimeString()}</span>
          </>
        )}
        {!isInterviewerView(v) && v.hiddenTotal !== undefined && (
          <span className="muted">
            hidden tests {v.hiddenPassed}/{v.hiddenTotal}
          </span>
        )}
      </div>

      <table className="tests">
        <tbody>
          {numbered(isInterviewerView(v) ? v.results : v.publicResults).map(({ r, label }) => (
            <tr key={r.testId}>
              <td>{label === null ? <span className="badge hidden">hidden</span> : `Example ${label}`}</td>
              <td>
                <VerdictBadge verdict={r.verdict} />
              </td>
              <td className="muted">{r.timeMs} ms</td>
              <td className="output">{r.stderr?.trim() ? <pre>{r.stderr.trim().slice(-400)}</pre> : r.stdout ? <pre>{r.stdout.trim().slice(0, 200)}</pre> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {isInterviewerView(v) && (
        <>
          <button className="link" onClick={() => setShowCode((s) => !s)}>
            {showCode ? "Hide" : "Show"} submitted code
          </button>
          {showCode && <pre className="code-snapshot">{v.code}</pre>}
        </>
      )}
    </div>
  );
}
