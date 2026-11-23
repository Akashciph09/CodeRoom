import { useState } from "react";
import type { RoomQuestionView, Verdict } from "@coderoom/shared";
import { isInterviewerView } from "../lib/api";
import type { SubmissionEntry } from "../lib/submissions";

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
 * Submission history, newest first. In a multi-question room each card is tagged with its question,
 * and the list can be narrowed to the question being viewed. Pending entries (not yet answered by the
 * server) don't know their question yet and are always shown.
 */
export function ResultsPanel({
  entries,
  questions,
  activeQuestionId,
}: {
  entries: SubmissionEntry[];
  /** Only for multi-question rooms. */
  questions?: RoomQuestionView[];
  activeQuestionId?: string;
}) {
  const [onlyActive, setOnlyActive] = useState(false);
  const positionOf = new Map(questions?.map((q) => [q.id, q.position]));
  const shown =
    questions && onlyActive ? entries.filter((e) => e.pending || e.view.roomQuestionId === activeQuestionId) : entries;
  return (
    <section className="panel results-panel">
      <div className="section-head">
        <h2>Results</h2>
        {questions && (
          <label className="inline small">
            <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} />
            This question only
          </label>
        )}
      </div>
      {shown.length === 0 && <p className="muted">No runs yet.</p>}
      {shown.map((e) => (
        <SubmissionCard
          key={e.submissionId}
          entry={e}
          position={e.pending ? undefined : positionOf.get(e.view.roomQuestionId)}
        />
      ))}
    </section>
  );
}

/** Public tests are numbered to match the "Example n" list; hidden tests get no number. */
function numbered<T extends { testId: string; hidden?: boolean }>(results: T[]) {
  let n = 0;
  return results.map((r) => ({ r, label: r.hidden ? null : ++n }));
}

function SubmissionCard({ entry, position }: { entry: SubmissionEntry; position?: number }) {
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
        {position !== undefined && <span className="badge question-badge">Q{position}</span>}
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
