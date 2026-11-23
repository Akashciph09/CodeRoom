import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { MAX_ROOM_QUESTIONS, type QuestionSummary, type RoomSummary } from "@coderoom/shared";
import { TopBar } from "../components/TopBar";
import { api } from "../lib/api";
import { submitLabel } from "../lib/roomList";

export function HomePage() {
  const navigate = useNavigate();
  const [questions, setQuestions] = useState<QuestionSummary[]>([]);
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  /** The interview's questions, in order. */
  const [selected, setSelected] = useState<string[]>([]);
  /** Optional weights for the test score (ADR 0011); off = equal weights. */
  const [weighted, setWeighted] = useState(false);
  const [points, setPoints] = useState<Record<string, number>>({});
  const [toAdd, setToAdd] = useState("");
  const [invite, setInvite] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.questions().then((qs) => {
      setQuestions(qs);
      setSelected((current) => (current.length > 0 || !qs[0] ? current : [qs[0].id]));
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
      const { roomId } = await api.createRoom(selected, weighted ? selected.map((id) => pointsOf(id)) : undefined);
      navigate(`/rooms/${roomId}`);
    } catch (err) {
      fail(err);
      setBusy(false);
    }
  }

  const byId = new Map(questions.map((q) => [q.id, q]));
  const available = questions.filter((q) => !selected.includes(q.id));
  const addId = available.some((q) => q.id === toAdd) ? toAdd : (available[0]?.id ?? "");
  const label = (q: QuestionSummary) => `${q.title} · v${q.version}${q.owned ? " (yours)" : " (library)"}`;

  /** Equal split of 100 by default (e.g. 33/33/34), until the interviewer edits a value. */
  const equalShare = (id: string) => {
    const i = selected.indexOf(id);
    const base = Math.floor(100 / Math.max(selected.length, 1));
    return i === selected.length - 1 ? 100 - base * (selected.length - 1) : base;
  };
  const pointsOf = (id: string) => points[id] ?? equalShare(id);
  const pointsTotal = selected.reduce((sum, id) => sum + pointsOf(id), 0);

  function move(index: number, by: -1 | 1) {
    setSelected((list) => {
      const next = list.slice();
      [next[index], next[index + by]] = [next[index + by]!, next[index]!];
      return next;
    });
  }

  // Search by question, or (on rooms you interview) by candidate name or email.
  const needle = search.trim().toLowerCase();
  const shownRooms = (rooms ?? []).filter(
    (r) =>
      !needle ||
      r.questionTitle.toLowerCase().includes(needle) ||
      (r.candidates ?? []).some((c) => c.name.toLowerCase().includes(needle) || c.email.toLowerCase().includes(needle)),
  );

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
            <p className="muted">
              You'll be the interviewer. Share the invite link with the candidate. Use a library question or{" "}
              <Link to="/questions">one of your own</Link>.
            </p>
            <div className="picked" aria-label="Interview questions">
              <span className="label">
                Questions, in order — the candidate sees Q1 first; you reveal the rest during the interview
              </span>
              <ol className="picked-list">
                {selected.map((id, i) => {
                  const q = byId.get(id);
                  return (
                    <li key={id}>
                      <span className="badge question-badge">Q{i + 1}</span>
                      <span className="picked-title">{q ? label(q) : id}</span>
                      {weighted && (
                        <input
                          type="number"
                          className="points-input"
                          aria-label={`Q${i + 1} points`}
                          min={1}
                          max={100}
                          value={pointsOf(id)}
                          onChange={(e) =>
                            setPoints((p) => ({ ...p, [id]: Math.min(100, Math.max(1, Math.round(Number(e.target.value) || 1))) }))
                          }
                        />
                      )}
                      <button type="button" className="ghost small-btn" aria-label={`Move Q${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                        ↑
                      </button>
                      <button
                        type="button"
                        className="ghost small-btn"
                        aria-label={`Move Q${i + 1} down`}
                        disabled={i === selected.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="ghost small-btn"
                        aria-label={`Remove Q${i + 1}`}
                        disabled={selected.length === 1}
                        onClick={() => setSelected((list) => list.filter((x) => x !== id))}
                      >
                        ✕
                      </button>
                    </li>
                  );
                })}
              </ol>
              {selected.length < MAX_ROOM_QUESTIONS && available.length > 0 && (
                <div className="picked-add">
                  <select aria-label="Question to add" value={addId} onChange={(e) => setToAdd(e.target.value)}>
                    {available.map((q) => (
                      <option key={q.id} value={q.id}>
                        {label(q)}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={() => addId && setSelected((list) => [...list, addId])}>
                    Add question
                  </button>
                </div>
              )}
              <label className="inline small">
                <input type="checkbox" checked={weighted} onChange={(e) => setWeighted(e.target.checked)} />
                Set points per question for the test score
                {weighted
                  ? ` (total ${pointsTotal}; scores are scaled to 100)`
                  : " (otherwise every question counts equally)"}
              </label>
            </div>
            <button className="primary" disabled={busy || selected.length === 0}>
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
          <div className="section-head">
            <h2>Your rooms</h2>
            {rooms && rooms.length > 0 && (
              <input
                type="search"
                className="room-search"
                aria-label="Search rooms"
                placeholder="Search by candidate, email or question"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            )}
          </div>
          {rooms === null ? (
            <p className="muted">Loading…</p>
          ) : rooms.length === 0 ? (
            <p className="muted">No rooms yet.</p>
          ) : shownRooms.length === 0 ? (
            <p className="muted">No rooms match “{search.trim()}”.</p>
          ) : (
            <ul className="room-list" aria-label="Your rooms">
              {shownRooms.map((r) => (
                <li key={r.roomId}>
                  <div className="room-main">
                    <Link to={`/rooms/${r.roomId}`}>{r.questionTitle}</Link>
                    {r.candidates && (
                      <div className="room-candidates small">
                        {r.candidates.length === 0 ? (
                          <span className="muted">No candidate joined</span>
                        ) : (
                          r.candidates.map((c) => (
                            <span key={c.email} className="room-candidate">
                              {c.name} <span className="muted">· {c.email}</span>
                            </span>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                  <span className={`badge ${r.role}`}>{r.role}</span>
                  <span className={`badge ${r.status}`}>{r.status}</span>
                  <span className="muted small">{new Date(r.createdAt).toLocaleString()}</span>
                  {r.candidates && r.candidates.length > 0 && (
                    <span className="room-score small" aria-label="Test score">
                      {r.candidates.map(submitLabel).join(" · ")}
                    </span>
                  )}
                  {r.role === "interviewer" && (
                    <Link to={`/rooms/${r.roomId}/review`} className="small">
                      Review
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
