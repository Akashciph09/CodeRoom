import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { NoteView, ReviewCandidate, ReviewQuestion, ReviewSubmission, RoomReview } from "@coderoom/shared";
import { TopBar } from "../components/TopBar";
import { api, ApiError } from "../lib/api";
import { lineDiff } from "../lib/lineDiff";
import { connectRoomEvents } from "../lib/realtime";
import { formatElapsed } from "../lib/timer";
import { VERDICT_LABEL } from "../lib/verdicts";
import { offsetLabel, submissionLabel, wasEdited } from "../lib/notes";
import { InterviewSummaryCard } from "../components/InterviewSummaryCard";
import { EvaluationCard } from "../components/EvaluationCard";

/** While any submission is still being graded, re-fetch this often. */
const REVIEW_POLL_MS = 2000;


/**
 * Post-interview review (ADR 0011), interviewer only. The test score is evidence for the evaluation —
 * correctness on Submit only — never the evaluation itself.
 */
export function ReviewPage() {
  const { roomId = "" } = useParams();
  const [review, setReview] = useState<RoomReview | null>(null);
  /** Nothing valid to show: access denied, or the first load failed. */
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null);
  /** A refresh failed after the review loaded: keep showing it, warn, and keep retrying. */
  const [refreshFailed, setRefreshFailed] = useState(false);
  const loaded = useRef(false);

  /*
   * The review must keep up with submissions that are still being graded (PR #8 review):
   *  - live room: re-fetch on room events, and on every events (re)connect since events can be lost;
   *  - anything still queued/running (also after the room ended, when there's no event stream):
   *    poll until every submission has finished;
   *  - re-fetch when the tab regains focus.
   * Responses can arrive out of order, so only the newest request's answer is applied.
   * A failed refresh is transient (PR #8 review): it never replaces a loaded review with an error
   * screen; the next success clears it. Only "access denied" or a failed first load is fatal.
   */
  const latestRequest = useRef(0);
  const load = useCallback(() => {
    const id = ++latestRequest.current;
    api.review(roomId).then(
      (r) => {
        if (id !== latestRequest.current) return;
        loaded.current = true;
        setReview(r);
        setError(null);
        setRefreshFailed(false);
      },
      (err: unknown) => {
        if (id !== latestRequest.current) return;
        if (err instanceof ApiError && err.status === 403) {
          setError({ message: "Only the interviewer can review this interview.", retryable: false });
        } else if (loaded.current) {
          setRefreshFailed(true);
        } else {
          setError({ message: err instanceof Error ? err.message : String(err), retryable: true });
        }
      },
    );
  }, [roomId]);

  useEffect(() => {
    loaded.current = false;
    setReview(null);
    setError(null);
    setRefreshFailed(false);
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  const live = review?.status === "open";
  useEffect(() => {
    if (!live) return;
    return connectRoomEvents(roomId, {
      onEvent: (e) => {
        if (e.type === "submission:queued" || e.type === "submission:result" || e.type === "room:closed" || e.type === "room:question_revealed") load();
      },
      onStatus: () => {},
      onOpen: load,
    });
  }, [roomId, live, load]);

  const pending = review?.candidates.some((c) => c.submissions.some((s) => s.status === "queued" || s.status === "running")) ?? false;
  // Poll while grading is in progress, and keep retrying after a failed refresh until one succeeds.
  useEffect(() => {
    if (!pending && !refreshFailed) return;
    const timer = setInterval(load, REVIEW_POLL_MS);
    return () => clearInterval(timer);
  }, [pending, refreshFailed, load]);

  if (error) {
    return (
      <>
        <TopBar />
        <main className="center">
          <div className="card">
            <p className="error">{error.message}</p>
            {error.retryable && (
              <button
                onClick={() => {
                  setError(null);
                  load();
                }}
              >
                Try again
              </button>
            )}
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
        {refreshFailed && (
          <p className="warning small" role="status">
            Couldn't refresh — showing the last loaded review and retrying…
          </p>
        )}
        <div className="page-head">
          <div>
            <Link to={`/rooms/${review.roomId}`} className="small">
              ← Back to the room
            </Link>
            <h1>Interview review</h1>
            {review.name && <p className="review-room-name">{review.name}</p>}
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
                <th title="From this question's reveal to the next reveal, or to the end">Reveal window</th>
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
                  <td>{q.revealWindowMs !== undefined ? formatElapsed(q.revealWindowMs) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            Reveal window: from a question's reveal to the next reveal, or to the end. It shows how the interview was paced,
            not how long the candidate worked on each question — they can go back to earlier questions, and Q1's window starts
            when the room was created.
          </p>
        </section>

        <InterviewSummaryCard key={review.roomId} roomId={review.roomId} />
        <ReviewNotes review={review} />

        {review.candidates.length === 0 && <p className="muted">No candidate joined this interview.</p>}
        {review.candidates.map((c) => (
          <div key={c.userId} className="candidate-block">
            <CandidateReview candidate={c} questions={review.questions} start={start} />
            {/* The interviewer's judgement (ADR 0017) — its own card, apart from the test score. */}
            <EvaluationCard
              roomId={review.roomId}
              candidateId={c.userId}
              candidateName={c.name}
              evaluation={c.evaluation}
              ended={review.status === "closed"}
              notes={review.notes}
              submissions={c.submissions}
              questions={review.questions}
              startedAt={review.createdAt}
              onReload={load}
            />
          </div>
        ))}
      </main>
    </>
  );
}

/** The interviewer's private notes (ADR 0016), oldest first, each linked to its question and run. */
function ReviewNotes({ review }: { review: RoomReview }) {
  const allSubmissions = review.candidates.flatMap((c) => c.submissions);
  return (
    <section className="card review-notes" aria-label="Notes">
      <h2>Notes</h2>
      {review.notes.length === 0 ? (
        <p className="muted small">No notes. Add them in the room's Notes tab — during the interview or afterwards.</p>
      ) : (
        <ol className="note-list">
          {review.notes.map((n: NoteView) => {
            const q = review.questions.find((x) => x.id === n.roomQuestionId);
            const sub = n.submissionId ? allSubmissions.find((s) => s.submissionId === n.submissionId) : undefined;
            return (
              <li key={n.id} className="note" id={`note-${n.id}`}>
                <div className="note-meta">
                  <time dateTime={n.createdAt} title={new Date(n.createdAt).toLocaleString()} className="mono">
                    {offsetLabel(n.createdAt, review.createdAt)}
                  </time>
                  <span className="badge" title={q?.title ?? "Not about one question"}>
                    {q ? `Q${q.position}` : "General"}
                  </span>
                  {sub && (
                    <a className="note-jump" href={`#submission-${sub.submissionId}`}>
                      ↳ {submissionLabel(sub, review.createdAt)}
                    </a>
                  )}
                  {wasEdited(n) && (
                    <span className="muted small" title={`Edited ${new Date(n.updatedAt).toLocaleString()}`}>
                      edited
                    </span>
                  )}
                  {!n.mine && <span className="muted small">by {n.authorName}</span>}
                </div>
                <p className="note-body">{n.body}</p>
              </li>
            );
          })}
        </ol>
      )}
      <p className="muted small">Private to you — never shown to the candidate.</p>
    </section>
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
    <li className="timeline-entry" id={`submission-${s.submissionId}`}>
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
