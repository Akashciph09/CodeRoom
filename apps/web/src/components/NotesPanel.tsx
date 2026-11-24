import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { MAX_NOTE_CHARS, noteLength, type InterviewerSubmissionView, type NoteView } from "@coderoom/shared";
import { api } from "../lib/api";
import { offsetLabel, removeNote, submissionLabel, upsertNote, wasEdited } from "../lib/notes";

type QuestionRef = { id: string; position: number; title: string };

const GENERAL = "general";

/**
 * The interviewer's private notes (ADR 0016), in the room's bottom panel. Rendered only for the
 * interviewer, and the data never touches the shared Yjs document or room events — it comes from
 * interviewer-only API routes, so a candidate's client has nothing to reveal.
 *
 * A new note is about the question being viewed (or "General") and can link one of that question's
 * runs/submissions. Notes stay editable after the session ends (evaluation often happens then).
 */
export function NotesPanel({
  roomId,
  startedAt,
  questions,
  activeQuestionId,
  submissions,
}: {
  roomId: string;
  /** The room's creation time: note times are shown relative to it ("+12:40"). */
  startedAt: string;
  questions: QuestionRef[];
  activeQuestionId: string;
  /** The room's runs/submissions (interviewer views), newest first. */
  submissions: InterviewerSubmissionView[];
}) {
  const [notes, setNotes] = useState<NoteView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [about, setAbout] = useState<string>(activeQuestionId);
  const [linked, setLinked] = useState("");
  const [busy, setBusy] = useState(false);
  const [formMessage, setFormMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [itemMessage, setItemMessage] = useState<{ id: string; kind: "error" | "info"; text: string } | null>(null);
  /*
   * The fields stay editable while a save is in flight (PR #15 review), so a response must only
   * clear what was actually sent: compare with the latest values, never the ones captured at send.
   */
  const latest = useRef({ draft, about, linked, activeQuestionId, editing });
  latest.current = { draft, about, linked, activeQuestionId, editing };

  // Loaded once; every change after that applies the server's response, so nothing to re-fetch.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    api.notes(roomId).then(
      (list) => current && setNotes(list),
      (err: unknown) => current && setLoadError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      current = false;
    };
  }, [roomId, attempt]);

  // A new note follows the question being viewed — unless one is being written.
  useEffect(() => {
    if (draft.trim() === "") {
      setAbout(activeQuestionId);
      setLinked("");
    }
    // Only when the viewed question changes; not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeQuestionId]);

  const questionSubmissions = submissions.filter((s) => s.roomQuestionId === about);
  const tooLong = noteLength(draft.trim()) > MAX_NOTE_CHARS;

  async function add(e?: FormEvent) {
    e?.preventDefault();
    if (busy || !notes || !draft.trim() || tooLong) return;
    const sent = { draft, about, linked };
    setBusy(true);
    setFormMessage(null);
    try {
      const note = await api.addNote(roomId, {
        body: sent.draft,
        roomQuestionId: sent.about === GENERAL ? null : sent.about,
        submissionId: sent.linked || null,
      });
      setNotes((list) => upsertNote(list ?? [], note));
      const now = latest.current;
      if (now.draft === sent.draft && now.about === sent.about && now.linked === sent.linked) {
        // Nothing changed while saving: start the next note fresh, about the question being viewed
        // now (the saved note keeps the question it was written about).
        setDraft("");
        setLinked("");
        setAbout(now.activeQuestionId);
      } else {
        setFormMessage({ kind: "info", text: "Saved the earlier text. What you changed while it was saving is still here — it isn't saved yet." });
      }
    } catch (err) {
      setFormMessage({ kind: "error", text: `Couldn't save the note: ${err instanceof Error ? err.message : String(err)}. Your text is kept.` });
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(note: NoteView) {
    if (!editing || busy) return;
    if (!editing.text.trim() || noteLength(editing.text.trim()) > MAX_NOTE_CHARS) return;
    const sentText = editing.text;
    setBusy(true);
    setItemMessage(null);
    try {
      // The links stay as they were; only the text changes here.
      const saved = await api.editNote(roomId, note.id, {
        body: sentText,
        roomQuestionId: note.roomQuestionId,
        submissionId: note.submissionId,
      });
      setNotes((list) => upsertNote(list ?? [], saved));
      const now = latest.current.editing;
      if (now?.id === note.id && now.text === sentText) {
        setEditing(null);
      } else if (now?.id === note.id) {
        // Changed while saving: keep the editor open with the newer text.
        setItemMessage({ id: note.id, kind: "info", text: "Saved the earlier text. Save again to keep your latest changes." });
      }
    } catch (err) {
      setItemMessage({ id: note.id, kind: "error", text: `Couldn't save: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBusy(false);
    }
  }

  async function remove(note: NoteView) {
    if (busy || !window.confirm("Delete this note? This can't be undone.")) return;
    setBusy(true);
    setItemMessage(null);
    try {
      await api.deleteNote(roomId, note.id);
      setNotes((list) => removeNote(list ?? [], note.id));
    } catch (err) {
      setItemMessage({ id: note.id, kind: "error", text: `Couldn't delete: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBusy(false);
    }
  }

  // Cmd/Ctrl+Enter saves, like most note fields.
  const submitOnModEnter = (save: () => void) => (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    }
  };

  const questionLabel = (id: string | null) => {
    const q = id ? questions.find((x) => x.id === id) : undefined;
    return q ? { short: `Q${q.position}`, title: q.title } : { short: "General", title: "Not about one question" };
  };

  return (
    <div className="notes-panel">
      <p className="muted small notes-private">
        <span aria-hidden="true">🔒 </span>Private — only you can see these. They're not part of the shared editor.
      </p>

      <form className="note-form" onSubmit={add} aria-label="Add a note">
        <textarea
          aria-label="New note"
          className="note-input"
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={submitOnModEnter(() => void add())}
          placeholder="What did you notice? Hints given, questions asked, how they reasoned…"
          disabled={!notes}
        />
        <div className="note-form-row">
          <select
            aria-label="Note is about"
            className="bare-select"
            value={about}
            onChange={(e) => {
              setAbout(e.target.value);
              setLinked("");
            }}
          >
            <option value={GENERAL}>General</option>
            {questions.map((q) => (
              <option key={q.id} value={q.id}>
                Q{q.position} · {q.title}
              </option>
            ))}
          </select>
          <select
            aria-label="Link a submission"
            className="bare-select"
            value={linked}
            onChange={(e) => setLinked(e.target.value)}
            disabled={about === GENERAL || questionSubmissions.length === 0}
          >
            <option value="">{about !== GENERAL && questionSubmissions.length === 0 ? "No runs yet" : "No linked run"}</option>
            {questionSubmissions.map((s) => (
              <option key={s.submissionId} value={s.submissionId}>
                {submissionLabel(s, startedAt)}
              </option>
            ))}
          </select>
          <span className="spacer" />
          {tooLong && <span className="error small">At most {MAX_NOTE_CHARS} characters.</span>}
          <button type="submit" className="primary" disabled={busy || !notes || !draft.trim() || tooLong}>
            Add note
          </button>
        </div>
        {formMessage && (
          <p className={`${formMessage.kind === "error" ? "error" : "muted"} small`} role={formMessage.kind === "error" ? "alert" : "status"}>
            {formMessage.text}
          </p>
        )}
      </form>

      {loadError ? (
        <p className="error small" role="alert">
          Couldn't load notes: {loadError}{" "}
          <button
            className="link small"
            onClick={() => {
              setLoadError(null);
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        </p>
      ) : !notes ? (
        <p className="muted small">Loading notes…</p>
      ) : notes.length === 0 ? (
        <p className="muted small">No notes yet.</p>
      ) : (
        <ol className="note-list" aria-label="Notes">
          {/* Newest first while interviewing. */}
          {[...notes].reverse().map((n) => {
            const q = questionLabel(n.roomQuestionId);
            const sub = n.submissionId ? submissions.find((s) => s.submissionId === n.submissionId) : undefined;
            const isEditing = editing?.id === n.id;
            return (
              <li key={n.id} className="note" aria-label={`Note ${offsetLabel(n.createdAt, startedAt)}`}>
                <div className="note-meta">
                  <time dateTime={n.createdAt} title={new Date(n.createdAt).toLocaleString()} className="mono">
                    {offsetLabel(n.createdAt, startedAt)}
                  </time>
                  <span className="badge" title={q.title}>
                    {q.short}
                  </span>
                  {n.submissionId && (
                    <span className="small note-link">↳ {sub ? submissionLabel(sub, startedAt) : "a run"}</span>
                  )}
                  {wasEdited(n) && (
                    <span className="muted small" title={`Edited ${new Date(n.updatedAt).toLocaleString()}`}>
                      edited
                    </span>
                  )}
                  {!n.mine && <span className="muted small">by {n.authorName}</span>}
                  <span className="spacer" />
                  {n.mine && !isEditing && (
                    <>
                      <button className="link small" onClick={() => setEditing({ id: n.id, text: n.body })} disabled={busy}>
                        Edit
                      </button>
                      <button className="link small danger-link" onClick={() => void remove(n)} disabled={busy}>
                        Delete
                      </button>
                    </>
                  )}
                </div>
                {isEditing ? (
                  <div className="note-edit">
                    <textarea
                      aria-label="Edit note"
                      className="note-input"
                      rows={3}
                      value={editing.text}
                      onChange={(e) => setEditing({ id: n.id, text: e.target.value })}
                      onKeyDown={submitOnModEnter(() => void saveEdit(n))}
                      autoFocus
                    />
                    <div className="note-form-row">
                      <button
                        className="primary"
                        onClick={() => void saveEdit(n)}
                        disabled={busy || !editing.text.trim() || noteLength(editing.text.trim()) > MAX_NOTE_CHARS}
                      >
                        Save
                      </button>
                      <button
                        className="ghost"
                        onClick={() => {
                          setEditing(null);
                          setItemMessage(null);
                        }}
                        disabled={busy}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="note-body">{n.body}</p>
                )}
                {itemMessage?.id === n.id && (
                  <p className={`${itemMessage.kind === "error" ? "error" : "muted"} small`} role={itemMessage.kind === "error" ? "alert" : "status"}>
                    {itemMessage.text}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
