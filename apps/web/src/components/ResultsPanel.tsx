import { Fragment, useEffect, useState } from "react";
import type { HiddenCaseReplayResult, InterviewerSubmissionView, Verdict } from "@coderoom/shared";
import { api, isInterviewerView, type SubmissionView } from "../lib/api";
import { attemptMetadata, type SubmissionEntry } from "../lib/submissions";
import { VERDICT_LABEL } from "../lib/verdicts";

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return <span className={`verdict ${verdict === "accepted" ? "ok" : "bad"}`}>{VERDICT_LABEL[verdict]}</span>;
}

function AttemptStatus({ entry }: { entry: SubmissionEntry }) {
  if (entry.pending || entry.view.status === "queued") return <span className="verdict pending">Queued…</span>;
  if (entry.view.status === "running") return <span className="verdict pending">Running…</span>;
  return <VerdictBadge verdict={entry.view.overall ?? "internal_error"} />;
}

export function ResultsPanel({ run }: { run?: SubmissionEntry }) {
  return (
    <section className="panel results-panel" aria-label="Latest Run">
      <h2>Latest Run</h2>
      {run ? (
        <div className="submission">
          <div className="submission-head">
            <AttemptStatus entry={run} />
            <AttemptMetadata entry={run} />
          </div>
          {!run.pending && <PublicResults view={run.view} />}
        </div>
      ) : <p className="muted">Run your code to see test results.</p>}
    </section>
  );
}

function PublicResults({ view: v }: { view: SubmissionView }) {
  const publicResults = isInterviewerView(v) ? v.results.filter((r) => !r.hidden) : v.publicResults;
  return (
    <>
      <table className="tests" aria-label="Public test results">
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

    </>
  );
}

function AttemptMetadata({ entry }: { entry: SubmissionEntry }) {
  const { language, createdAt, roomTestRevision } = attemptMetadata(entry);
  return (
    <>
      {language && <span className="badge">{language === "python" ? "Python" : "JavaScript"}</span>}
      {createdAt && <time className="muted" dateTime={createdAt}>{new Date(createdAt).toLocaleString()}</time>}
      {roomTestRevision !== undefined && <span className="muted">Revision {roomTestRevision}</span>}
    </>
  );
}

export function SubmissionResults({ submissions, selected, onSelect }: {
  submissions: SubmissionEntry[];
  selected?: SubmissionEntry;
  onSelect: (id?: string) => void;
}) {
  return (
    <section className="panel submission-results" aria-label="Submission results">
      {selected ? (
        <>
          <button className="link submission-back" type="button" onClick={() => onSelect()}>Back to submissions</button>
          <h2>Submission details</h2>
          <article className="submission" aria-label="Selected submission">
            <div className="submission-head" role="status">
              <AttemptStatus entry={selected} />
              <AttemptMetadata entry={selected} />
            </div>
            {!selected.pending && <SubmissionDetails view={selected.view} />}
          </article>
        </>
      ) : (
        <>
          <h2>Submission history</h2>
          {submissions.length === 0 ? <p className="muted">No submissions for this question yet.</p> : (
            <ol reversed className="submission-history" aria-label="Submission history">
              {submissions.map((entry, index) => (
                <li key={entry.submissionId}>
                  <button type="button" onClick={() => onSelect(entry.submissionId)}>
                    <span className="submission-number muted"><span className="sr-only">Submission </span>{submissions.length - index}</span>
                    <AttemptStatus entry={entry} />
                    <AttemptMetadata entry={entry} />
                  </button>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

function SubmissionDetails({ view }: { view: SubmissionView }) {
  return (
    <>
      <PublicResults view={view} />
      {isInterviewerView(view) ? (
        <>
          <HiddenResults key={view.submissionId} view={view} />
          <details>
            <summary>Submitted code</summary>
            <pre className="code-snapshot">{view.code}</pre>
          </details>
        </>
      ) : view.hiddenTotal !== undefined && view.hiddenPassed !== undefined && (
        <p className="muted small">{view.hiddenPassed}/{view.hiddenTotal} hidden tests passed</p>
      )}
    </>
  );
}

function HiddenResults({ view }: { view: InterviewerSubmissionView }) {
  const [expandedIds, setExpandedIds] = useState(() => new Set<string>());
  const hidden = view.results.filter((result) => result.hidden);
  if (!hidden.length) return null;

  function toggleCase(testId: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (!next.delete(testId)) next.add(testId);
      return next;
    });
  }

  return (
    <table className="tests" aria-label="Hidden test results">
      <tbody>
        {hidden.map((result, index) => {
          const expanded = expandedIds.has(result.testId);
          return (
            <Fragment key={result.testId}>
              <tr>
                <td>Hidden case {index + 1}</td>
                <td><VerdictBadge verdict={result.verdict} /></td>
                <td className="muted">{result.timeMs} ms</td>
                <td>{result.verdict !== "accepted" && (
                  <button type="button" className="link" aria-expanded={expanded}
                    aria-label={`${expanded ? "Hide" : "Inspect"} hidden case ${index + 1}`}
                    onClick={() => toggleCase(result.testId)}>
                    {expanded ? "Hide details" : "Inspect"}
                  </button>
                )}</td>
              </tr>
              {expanded && (
                <tr><td colSpan={4}><HiddenCaseDetails submissionId={view.submissionId} testId={result.testId} /></td></tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function HiddenCaseDetails({ submissionId, testId }: { submissionId: string; testId: string }) {
  const [details, setDetails] = useState<{ input: string; expectedOutput: string }>();
  const [error, setError] = useState(false);
  const [replay, setReplay] = useState<HiddenCaseReplayResult>();
  const [replaying, setReplaying] = useState(false);
  const [replayError, setReplayError] = useState<string>();

  async function runReplay() {
    setReplaying(true);
    setReplay(undefined);
    setReplayError(undefined);
    try {
      setReplay(await api.replayHiddenCase(submissionId, testId));
    } catch (error) {
      setReplayError(error instanceof Error ? error.message : "Couldn’t replay this case.");
    } finally {
      setReplaying(false);
    }
  }
  useEffect(() => {
    let active = true;
    api.failedHiddenCase(submissionId, testId).then((test) => {
      if (active) setDetails(test);
    }, () => {
      if (active) setError(true);
    });
    return () => { active = false; };
  }, [submissionId, testId]);

  if (error) return <p role="alert" className="error small">Couldn’t load this case. Close it and try again.</p>;
  if (!details) return <p role="status" className="muted small">Loading case…</p>;
  return (
    <>
      <div className="hidden-case-details">
        <div><span className="case-label">Input</span><pre className="case-box" aria-label="Hidden case input">{details.input}</pre></div>
        <div><span className="case-label">Expected output</span><pre className="case-box" aria-label="Hidden case expected output">{details.expectedOutput}</pre></div>
      </div>
      <button type="button" className="link" onClick={runReplay} disabled={replaying}>{replaying ? "Replaying…" : "Replay case"}</button>
      {replayError && <p role="alert" className="error small">{replayError}</p>}
      {replay && (
        <div className="hidden-case-details" aria-label="Sandbox replay">
          <div><span className="case-label">Candidate output from replay</span><pre className="case-box" aria-label="Candidate output from replay">{replay.stdout || "No output"}</pre></div>
          {replay.stderr && <div><span className="case-label">Replay error output</span><pre className="case-box">{replay.stderr}</pre></div>}
          <div><span className="case-label">Replay verdict </span><VerdictBadge verdict={replay.verdict} /></div>
        </div>
      )}
    </>
  );
}
