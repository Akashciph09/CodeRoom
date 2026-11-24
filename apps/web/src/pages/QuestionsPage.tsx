import { useEffect, useState } from "react";
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
          <button className="primary" onClick={createQuestion} disabled={busy}>
            Create question
          </button>
        </div>
        {error && <p className="error">{error}</p>}

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
