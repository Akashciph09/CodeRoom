import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { MAX_ROOM_NAME, MAX_ROOM_QUESTIONS, type QuestionSummary, type RoomSummary } from "@coderoom/shared";
import { TopBar } from "../components/TopBar";
import { api } from "../lib/api";
import { candidateCell, formatRoomDate, roleLabel, roomMatches, roomStatusLabel } from "../lib/roomList";

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
  const [roomName, setRoomName] = useState("");

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
      const { roomId } = await api.createRoom(selected, weighted ? selected.map((id) => pointsOf(id)) : undefined, roomName);
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

  // Search by question, or (on rooms you interview) by any candidate's name or email.
  const shownRooms = (rooms ?? []).filter((r) => roomMatches(r, search));

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
            <label>
              Room name (optional)
              <input
                aria-label="Room name"
                value={roomName}
                maxLength={MAX_ROOM_NAME}
                placeholder="e.g. Backend interview, SRE interview"
                onChange={(e) => setRoomName(e.target.value)}
              />
            </label>
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

        <section className="card rooms-card">
          <div className="section-head rooms-head">
            <h2>Your rooms</h2>
            {rooms && rooms.length > 0 && (
              <input
                type="search"
                className="room-search"
                aria-label="Search rooms"
                placeholder="Search by name, candidate, email or question"
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
            <RoomsTable rooms={shownRooms} />
          )}
        </section>
      </main>
    </>
  );
}

/**
 * "Your rooms" as a table with fixed columns (Interview | Candidate | Your role | Status | Created |
 * Action), so long names and emails can't push other columns out of line. Explicit ARIA roles keep the
 * table semantics when narrow screens restyle rows as cards.
 */
function RoomsTable({ rooms }: { rooms: RoomSummary[] }) {
  const now = new Date();
  return (
    <table className="rooms-table" role="table" aria-label="Your rooms">
      <colgroup>
        <col className="col-interview" />
        <col className="col-candidate" />
        <col className="col-role" />
        <col className="col-status" />
        <col className="col-created" />
        <col className="col-action" />
      </colgroup>
      <thead role="rowgroup">
        <tr role="row">
          <th role="columnheader" scope="col">Interview</th>
          <th role="columnheader" scope="col">Candidate</th>
          <th role="columnheader" scope="col">Your role</th>
          <th role="columnheader" scope="col">Status</th>
          <th role="columnheader" scope="col">Created</th>
          <th role="columnheader" scope="col">Action</th>
        </tr>
      </thead>
      <tbody role="rowgroup">
        {rooms.map((r) => {
          const date = formatRoomDate(r.createdAt, now);
          const cell = r.candidates ? candidateCell(r.candidates) : null;
          return (
            <tr key={r.roomId} role="row" className="room-row">
              <td role="cell" className="cell-interview">
                {/* The room's name if it has one (interviewer rows, ADR 0014), else its first question. */}
                <Link to={`/rooms/${r.roomId}`} className="truncate" title={r.name ?? r.questionTitle}>
                  {r.name ?? r.questionTitle}
                </Link>
                {r.name && (
                  <span className="truncate muted small room-question" title={r.questionTitle}>
                    {r.questionTitle}
                  </span>
                )}
              </td>
              <td role="cell" className="cell-candidate">
                {r.role === "candidate" ? (
                  <span className="muted">You</span>
                ) : cell ? (
                  <div className="candidate-stack">
                    <span className="candidate-name">
                      <span className="truncate" title={cell.first.name}>
                        {cell.first.name}
                      </span>
                      {cell.more > 0 && (
                        <span className="badge candidate-more" title={`Also: ${cell.others}`}>
                          +{cell.more}
                          <span className="sr-only"> more: {cell.others}</span>
                        </span>
                      )}
                    </span>
                    <span className="candidate-email truncate muted small" title={cell.first.email}>
                      {cell.first.email}
                    </span>
                  </div>
                ) : (
                  <span className="muted">
                    <span aria-hidden="true">—</span>
                    <span className="sr-only">No candidate joined</span>
                  </span>
                )}
              </td>
              <td role="cell" className="cell-role">
                <span className={`badge ${r.role}`}>{roleLabel(r.role)}</span>
              </td>
              <td role="cell" className="cell-status">
                <span className={`badge ${r.status}`}>{roomStatusLabel(r.status)}</span>
              </td>
              <td role="cell" className="cell-created">
                <time dateTime={r.createdAt} title={date.full} className="small">
                  <span aria-hidden="true">{date.short}</span>
                  <span className="sr-only">{date.full}</span>
                </time>
              </td>
              <td role="cell" className="cell-action">
                {r.role === "interviewer" && (
                  <Link to={`/rooms/${r.roomId}/review`} className="small">
                    Review
                  </Link>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
