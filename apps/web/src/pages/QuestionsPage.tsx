import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { MyQuestionSummary } from "@coderoom/shared";
import { TopBar } from "../components/TopBar";
import { api } from "../lib/api";

export function QuestionStatus({ q }: { q: Pick<MyQuestionSummary, "status" | "latestVersion" | "hasUnpublishedChanges"> }) {
  if (q.status === "draft") return <span className="badge draft">Draft</span>;
  return (
    <>
      <span className="badge ready">Ready · v{q.latestVersion}</span>
      {q.hasUnpublishedChanges && <span className="badge pending-changes">Unpublished changes</span>}
    </>
  );
}

/** "My questions": everything the user authored, with draft/ready status. */
export function QuestionsPage() {
  const navigate = useNavigate();
  const [questions, setQuestions] = useState<MyQuestionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [brief, setBrief] = useState("");
  const [generating, setGenerating] = useState(false);

  async function generateQuestion(event: FormEvent) {
    event.preventDefault();
    if (generating || brief.trim().length < 5) return;
    setGenerating(true);
    setError(null);
    try {
      const question = await api.generateQuestion(brief.trim());
      navigate(`/questions/${question.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  useEffect(() => {
    api.myQuestions().then(setQuestions, (err: Error) => setError(err.message));
  }, []);

  async function createQuestion() {
    setBusy(true);
    try {
      const q = await api.createQuestion();
      navigate(`/questions/${q.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar />
      <main className="home">
        <div className="page-head">
          <h1>My questions</h1>
          <div className="actions">
            <button onClick={() => setShowGenerator((show) => !show)} aria-expanded={showGenerator} disabled={busy || generating}>
              Draft with AI
            </button>
            <button className="primary" onClick={createQuestion} disabled={busy || generating}>
              Create question
            </button>
          </div>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {showGenerator && (
          <form className="card" onSubmit={generateQuestion}>
            <label>
              Interview brief
              <textarea
                aria-label="Interview brief"
                rows={4}
                value={brief}
                minLength={5}
                maxLength={3000}
                onChange={(event) => setBrief(event.target.value)}
                placeholder="Backend intern, arrays and hash maps, 30 minutes"
                required
                disabled={generating}
              />
            </label>
            <p className="muted small">The brief is sent to the configured AI provider. Use role requirements and topics.</p>
            <button className="primary" disabled={generating || brief.trim().length < 5}>Generate draft</button>
            {generating && <p className="muted small" role="status">Drafting the question and checking its tests…</p>}
          </form>
        )}

        <section className="card">
          {questions === null ? (
            <p className="muted">Loading…</p>
          ) : questions.length === 0 ? (
            <p className="muted">No questions yet. Create one to use it in your interviews.</p>
          ) : (
            <ul className="question-list" role="list" aria-label="My questions">
              {questions.map((q) => (
                <li key={q.id}>
                  <h2><Link to={`/questions/${q.id}`}>{q.title}</Link></h2>
                  <div className="question-list-meta">
                    <QuestionStatus q={q} />
                    <time className="muted" dateTime={q.updatedAt}>{new Date(q.updatedAt).toLocaleString()}</time>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
