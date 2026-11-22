import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { QuestionSummary, RoomSummary } from "@coderoom/shared";
import { TopBar } from "../components/TopBar";
import { api } from "../lib/api";

export function HomePage() {
  const navigate = useNavigate();
  const [questions, setQuestions] = useState<QuestionSummary[]>([]);
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [questionId, setQuestionId] = useState("");
  const [invite, setInvite] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.questions().then((qs) => {
      setQuestions(qs);
      setQuestionId((current) => current || qs[0]?.id || "");
    }, fail);
    api.myRooms().then(setRooms, fail);
  }, []);

  function fail(err: unknown) {
    setError(err instanceof Error ? err.message : String(err));
  }

  async function createRoom(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { roomId } = await api.createRoom(questionId);
      navigate(`/rooms/${roomId}`);
    } catch (err) {
      fail(err);
      setBusy(false);
    }
  }

  function joinRoom(e: FormEvent) {
    e.preventDefault();
    // Accept either a bare code or a full invite link.
    const code = invite.trim().split("/").pop();
    if (code) navigate(`/join/${encodeURIComponent(code)}`);
  }

  return (
    <>
      <TopBar />
      <main className="home">
        {error && <p className="error">{error}</p>}
        <div className="home-grid">
          <form className="card" onSubmit={createRoom}>
            <h2>Start an interview</h2>
            <p className="muted">You'll be the interviewer. Share the invite link with the candidate.</p>
            <label>
              Question
              <select value={questionId} onChange={(e) => setQuestionId(e.target.value)} required>
                {questions.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.title}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary" disabled={busy || !questionId}>
              Create room
            </button>
          </form>

          <form className="card" onSubmit={joinRoom}>
            <h2>Join an interview</h2>
            <p className="muted">Paste the invite code or link you received.</p>
            <label>
              Invite code
              <input value={invite} onChange={(e) => setInvite(e.target.value)} required />
            </label>
            <button className="primary">Join</button>
          </form>
        </div>

        <section className="card">
          <h2>Your rooms</h2>
          {rooms === null ? (
            <p className="muted">Loading…</p>
          ) : rooms.length === 0 ? (
            <p className="muted">No rooms yet.</p>
          ) : (
            <ul className="room-list">
              {rooms.map((r) => (
                <li key={r.roomId}>
                  <Link to={`/rooms/${r.roomId}`}>{r.questionTitle}</Link>
                  <span className={`badge ${r.role}`}>{r.role}</span>
                  <span className={`badge ${r.status}`}>{r.status}</span>
                  <span className="muted">{new Date(r.createdAt).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
