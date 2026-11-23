import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ReviewCandidate, ReviewQuestion, ReviewSubmission, RoomReview, Verdict } from "@coderoom/shared";
import { TopBar } from "../components/TopBar";
import { api, ApiError } from "../lib/api";
import { lineDiff } from "../lib/lineDiff";
import { formatElapsed } from "../lib/timer";

const VERDICT_LABEL: Record<Verdict, string> = {
  accepted: "Accepted",
  wrong_answer: "Wrong answer",
  time_limit_exceeded: "Time limit exceeded",
  memory_limit_exceeded: "Memory limit exceeded",
  runtime_error: "Runtime error",
  compile_error: "Compile error",
  internal_error: "Internal error",
};

/**
 * Post-interview review (ADR 0011), interviewer only. The test score is evidence for the evaluation —
 * correctness on Submit only — never the evaluation itself.
 */
export function ReviewPage() {
  const { roomId = "" } = useParams();
  const [review, setReview] = useState<RoomReview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.review(roomId).then(setReview, (err: unknown) =>
      setError(err instanceof ApiError && err.status === 403 ? "Only the interviewer can review this interview." : String(err)),
    );
  }, [roomId]);

  if (error) {
    return (
      <>
        <TopBar />
        <main className="center">
          <div className="card">
            <p className="error">{error}</p>
            <Link to="/">Back home</Link>
          </div>
        </main>
      </>
    );
  }
  if (!review) return <div className="center muted">Loading review…</div>;

  const start = Date.parse(review.createdAt);
  const end = review.closedAt ? Date.parse(review.closedAt) : Date.parse(review.serverTime);

  return (
    <>
      <TopBar />
      <main className="review-page">
        <div className="page-head">
          <div>
            <Link to={`/rooms/${review.roomId}`} className="small">
              ← Back to the room
            </Link>
            <h1>Interview review</h1>
            <p className="muted">
              {new Date(review.createdAt).toLocaleString()} · {review.closedAt ? "lasted" : "in progress,"} {formatElapsed(end - start)}
              {!review.closedAt && " so far"}
            </p>
          </div>
          <span className={`badge ${review.status}`}>{review.status === "open" ? "in progress" : "ended"}</span>
        </div>

        <section className="card" aria-label="Questions">
          <h2>Questions</h2>
          <table className="review-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Question</th>
                <th>Points</th>
                <th>Revealed</th>
                <th>Time spent</th>
              </tr>
            </thead>
            <tbody>
              {review.questions.map((q) => (
                <tr key={q.id}>
                  <td>Q{q.position}</td>
                  <td>
                    {q.title} <span className="muted small">v{q.version}</span>
                  </td>
                  <td>{q.points}</td>
                  <td>{q.revealedAt ? `+${formatElapsed(Date.parse(q.revealedAt) - start)}` : <span className="muted">not revealed</span>}</td>
                  <td>{q.timeSpentMs !== undefined ? formatElapsed(q.timeSpentMs) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {review.candidates.length === 0 && <p className="muted">No candidate joined this interview.</p>}
        {review.candidates.map((c) => (
          <CandidateReview key={c.userId} candidate={c} questions={review.questions} start={start} />
        ))}
      </main>
    </>
  );
}

function CandidateReview({ candidate, questions, start }: { candidate: ReviewCandidate; questions: ReviewQuestion[]; start: number }) {
  return (
    <section className="card candidate-review" aria-label={`Candidate ${candidate.name}`}>
      <div className="score-head">
        <h2>{candidate.name}</h2>
        <div className="score" aria-label="Test score">
          <span className="score-value">{candidate.score}</span>
          <span className="muted"> / 100</span>
        </div>
      </div>
      <p className="muted small">
        Test score: share of each revealed question's tests passed on its best Submit (hidden tests included), weighted as
        shown. It measures correctness only — not approach, code quality or communication — and is evidence for your
        evaluation, not a decision.
      </p>

      <table className="review-table" aria-label="Score breakdown">
        <thead>
          <tr>
            <th>#</th>
            <th>Best Submit</th>
            <th>Points</th>
          </tr>
        </thead>
        <tbody>
          {candidate.questions.map((s) => {
            const q = questions.find((x) => x.id === s.roomQuestionId);
            return (
              <tr key={s.roomQuestionId}>
                <td>Q{q?.position}</td>
                <td>
                  {!s.counted ? (
                    <span className="muted">not revealed — not counted</span>
                  ) : s.best ? (
                    `${s.best.passed}/${s.best.total} tests`
                  ) : (
                    <span className="muted">no Submit</span>
                  )}
                </td>
                <td>{s.counted ? s.earned : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h3>Timeline</h3>
      {questions
        .filter((q) => q.revealedAt)
        .map((q) => (
          <QuestionTimeline
            key={q.id}
            question={q}
            submissions={candidate.submissions.filter((s) => s.roomQuestionId === q.id)}
            start={start}
            bestId={candidate.questions.find((s) => s.roomQuestionId === q.id)?.best?.submissionId}
          />
        ))}
    </section>
  );
}

function QuestionTimeline({
  question,
  submissions,
  start,
  bestId,
}: {
  question: ReviewQuestion;
  submissions: ReviewSubmission[];
  start: number;
  bestId?: string;
}) {
  return (
    <div className="timeline" aria-label={`Q${question.position} timeline`}>
      <div className="timeline-head">
        <strong>Q{question.position}</strong> {question.title}
        <span className="muted small"> · revealed +{formatElapsed(Date.parse(question.revealedAt!) - start)}</span>
      </div>
      {submissions.length === 0 ? (
        <p className="muted small">No runs or submissions.</p>
      ) : (
        <ol className="timeline-list">
          {submissions.map((s, i) => {
            const previousSubmit = submissions.slice(0, i).reverse().find((p) => p.mode === "submit");
            return (
              <TimelineEntry
                key={s.submissionId}
                submission={s}
                start={start}
                isBest={s.submissionId === bestId}
                previousSubmit={s.mode === "submit" ? previousSubmit : undefined}
              />
            );
          })}
        </ol>
      )}
    </div>
  );
}

function TimelineEntry({
  submission: s,
  start,
  isBest,
  previousSubmit,
}: {
  submission: ReviewSubmission;
  start: number;
  isBest: boolean;
  previousSubmit?: ReviewSubmission;
}) {
  const [open, setOpen] = useState<"code" | "diff" | null>(null);
  const done = s.status === "completed" || s.status === "failed";
  const verdict = done ? (s.overall ?? "internal_error") : null;
  return (
    <li className="timeline-entry">
      <div className="timeline-row">
        <span className="mono muted">+{formatElapsed(Date.parse(s.createdAt) - start)}</span>
        <span className="badge">{s.mode === "submit" ? "Submit" : "Run"}</span>
        <span className={`verdict ${verdict === "accepted" ? "ok" : verdict ? "bad" : "pending"}`}>
          {verdict ? VERDICT_LABEL[verdict] : "Running…"}
        </span>
        <span className="small">
          {s.passed}/{s.total} tests
          {s.hiddenTotal > 0 && ` (hidden ${s.hiddenPassed}/${s.hiddenTotal})`}
          {s.customCases > 0 && ` · ${s.customCases} custom`}
        </span>
        {isBest && <span className="badge ready">counted</span>}
        <span className="spacer" />
        <button className="link small" onClick={() => setOpen(open === "code" ? null : "code")}>
          {open === "code" ? "Hide code" : "Code"}
        </button>
        {previousSubmit && (
          <button className="link small" onClick={() => setOpen(open === "diff" ? null : "diff")}>
            {open === "diff" ? "Hide diff" : "Diff vs previous Submit"}
          </button>
        )}
      </div>
      {open === "code" && <pre className="code-snapshot">{s.code}</pre>}
      {open === "diff" && previousSubmit && (
        <pre className="code-snapshot diff" aria-label="Diff vs previous Submit">
          {lineDiff(previousSubmit.code, s.code).map((l, i) => (
            <span key={i} className={`diff-${l.kind}`}>
              {l.kind === "added" ? "+ " : l.kind === "removed" ? "- " : "  "}
              {l.text}
              {"\n"}
            </span>
          ))}
        </pre>
      )}
    </li>
  );
}
