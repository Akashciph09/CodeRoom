import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Language, RoomView, ServerEvent, SubmissionMode } from "@coderoom/shared";
import { CollaborativeEditor } from "../components/CollaborativeEditor";
import { Presence, RemoteCursorStyles } from "../components/Presence";
import { QuestionPanel } from "../components/QuestionPanel";
import { ResultsPanel, type SubmissionEntry } from "../components/ResultsPanel";
import { TopBar } from "../components/TopBar";
import { api, ApiError } from "../lib/api";
import { displayName, useSession } from "../lib/auth";
import {
  colorFor,
  connectRoomDoc,
  connectRoomEvents,
  getLanguage,
  type ConnectionStatus,
  type RoomDoc,
} from "../lib/realtime";

const STARTER: Record<Language, string> = {
  python: "import sys\n\n\ndef solve(data: str) -> str:\n    # TODO\n    return \"\"\n\n\nprint(solve(sys.stdin.read()))\n",
  javascript:
    "const input = require('fs').readFileSync(0, 'utf8');\n\nfunction solve(data) {\n  // TODO\n  return '';\n}\n\nconsole.log(solve(input));\n",
};

export function RoomPage() {
  const { roomId = "" } = useParams();
  const { session } = useSession();
  const [room, setRoom] = useState<RoomView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roomDoc, setRoomDoc] = useState<RoomDoc | null>(null);
  const [docStatus, setDocStatus] = useState<ConnectionStatus>("connecting");
  const [eventStatus, setEventStatus] = useState<ConnectionStatus>("connecting");
  const [language, setLanguage] = useState<Language>("python");
  const [entries, setEntries] = useState<SubmissionEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Room metadata (history is loaded whenever the events socket (re)connects — see below)
  useEffect(() => {
    setRoom(null);
    setError(null);
    api.room(roomId).then(setRoom, (err: unknown) => {
      setError(err instanceof ApiError && err.status === 403 ? "You're not a participant in this room." : String(err));
    });
  }, [roomId]);

  /** Server history is authoritative; keep only local placeholders the server doesn't know about yet. */
  const refreshHistory = useCallback(() => {
    api
      .roomSubmissions(roomId)
      .then((list) =>
        setEntries((prev) => {
          const known = new Set(list.map((v) => v.submissionId));
          const localOnly = prev.filter((e) => e.pending && !known.has(e.submissionId));
          return [...localOnly, ...list.map((view) => ({ submissionId: view.submissionId, pending: false as const, view }))];
        }),
      )
      .catch(() => {});
  }, [roomId]);

  // Shared editor (Yjs)
  useEffect(() => {
    if (!room || !session) return;
    const user = { name: displayName(session), color: colorFor(session.user.id), role: room.role };
    const rd = connectRoomDoc(roomId, session.access_token, user);
    setRoomDoc(rd);

    const onStatus = ({ status }: { status: ConnectionStatus }) => setDocStatus(status);
    rd.provider.on("status", onStatus);

    const syncLanguage = () => setLanguage(getLanguage(rd.meta));
    rd.meta.observe(syncLanguage);

    // The interviewer seeds starter code once per room (a flag in the doc prevents re-seeding).
    const onSync = (synced: boolean) => {
      if (!synced) return;
      syncLanguage();
      if (room.role === "interviewer" && !rd.meta.get("initialized")) {
        rd.doc.transact(() => {
          rd.meta.set("initialized", true);
          rd.meta.set("language", "python");
          if (rd.text.length === 0) rd.text.insert(0, STARTER.python);
        });
      }
    };
    rd.provider.on("sync", onSync);

    return () => {
      rd.provider.off("status", onStatus);
      rd.provider.off("sync", onSync);
      rd.meta.unobserve(syncLanguage);
      rd.destroy();
      setRoomDoc(null);
    };
    // Reconnect only when the room or user changes, not on token refresh (handled inside connectRoomDoc).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.roomId, session?.user.id]);

  // Live submission events
  useEffect(() => {
    if (!room) return;
    const onEvent = (event: ServerEvent) => {
      if (event.type === "room:closed") {
        setRoom((r) => (r ? { ...r, status: "closed" } : r));
      } else if (event.type === "submission:queued") {
        setEntries((prev) =>
          prev.some((e) => e.submissionId === event.submissionId)
            ? prev
            : [{ submissionId: event.submissionId, pending: true }, ...prev],
        );
      } else if (event.type === "submission:result") {
        const view = event.result;
        setEntries((prev) => {
          const next = prev.filter((e) => e.submissionId !== view.submissionId);
          return [{ submissionId: view.submissionId, pending: false, view }, ...next];
        });
      }
    };
    return connectRoomEvents(room.roomId, { onEvent, onStatus: setEventStatus, onOpen: refreshHistory });
    // Only (re)subscribe when the room itself changes, not when its status flips to closed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.roomId, refreshHistory]);

  const changeLanguage = useCallback(
    (next: Language) => {
      if (!roomDoc) return;
      const previous = getLanguage(roomDoc.meta);
      roomDoc.doc.transact(() => {
        roomDoc.meta.set("language", next);
        // Swap the starter only if the code is still the untouched starter.
        if (roomDoc.text.toString() === STARTER[previous]) {
          roomDoc.text.delete(0, roomDoc.text.length);
          roomDoc.text.insert(0, STARTER[next]);
        }
      });
    },
    [roomDoc],
  );

  const submit = useCallback(
    async (mode: SubmissionMode) => {
      if (!roomDoc) return;
      setSubmitting(true);
      setNotice(null);
      try {
        const { submissionId } = await api.submit(
          { roomId, language, mode, code: roomDoc.text.toString() },
          crypto.randomUUID(),
        );
        setEntries((prev) =>
          prev.some((e) => e.submissionId === submissionId) ? prev : [{ submissionId, pending: true }, ...prev],
        );
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
    },
    [roomDoc, roomId, language],
  );

  async function endSession() {
    if (!room || !confirm("End this interview? The editor becomes read-only and no more runs are allowed.")) return;
    try {
      await api.closeRoom(room.roomId);
      setRoom({ ...room, status: "closed" });
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }

  function copyInvite() {
    if (!room?.inviteCode) return;
    navigator.clipboard.writeText(`${window.location.origin}/join/${room.inviteCode}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

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
  if (!room) return <div className="center muted">Loading room…</div>;

  const isCandidate = room.role === "candidate";
  const live = docStatus === "connected" && eventStatus === "connected";
  const closed = room.status !== "open";

  return (
    <div className="room-page">
      {roomDoc && <RemoteCursorStyles awareness={roomDoc.provider.awareness} />}
      <TopBar>
        <span className={`badge ${room.role}`}>{room.role}</span>
        <span className={`status-dot ${live ? "on" : "off"}`} title={`editor: ${docStatus}, events: ${eventStatus}`} />
        <span className="muted small">{live ? "live" : "reconnecting…"}</span>
        {roomDoc && <Presence awareness={roomDoc.provider.awareness} />}
        {room.inviteCode && !closed && (
          <button className="ghost" onClick={copyInvite}>
            {copied ? "Copied!" : "Copy invite link"}
          </button>
        )}
        {room.role === "interviewer" && !closed && (
          <button className="danger" onClick={endSession}>
            End session
          </button>
        )}
      </TopBar>
      {closed && <div className="banner">This interview has ended. The code is read-only.</div>}

      <div className="room-layout">
        <QuestionPanel room={room} />

        <section className="editor-pane">
          <div className="editor-toolbar">
            <select value={language} onChange={(e) => changeLanguage(e.target.value as Language)} disabled={!roomDoc}>
              <option value="python">Python</option>
              <option value="javascript">JavaScript</option>
            </select>
            {notice && <span className="error small">{notice}</span>}
            <div className="spacer" />
            {isCandidate ? (
              <>
                <button onClick={() => submit("run")} disabled={submitting || !roomDoc || closed}>
                  Run
                </button>
                <button className="primary" onClick={() => submit("submit")} disabled={submitting || !roomDoc || closed}>
                  Submit
                </button>
              </>
            ) : (
              <span className="muted small">Only the candidate can run code. You see every test, including hidden ones.</span>
            )}
          </div>
          {roomDoc ? (
            <CollaborativeEditor
              text={roomDoc.text}
              awareness={roomDoc.provider.awareness}
              language={language}
              readOnly={closed}
            />
          ) : (
            <div className="editor center muted">Connecting…</div>
          )}
        </section>

        <ResultsPanel entries={entries} />
      </div>
    </div>
  );
}
