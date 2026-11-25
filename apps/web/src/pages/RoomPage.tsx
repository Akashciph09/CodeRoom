import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { MAX_CUSTOM_CASES, type Language, type RoomView, type ServerEvent, type SubmissionMode } from "@coderoom/shared";
import { CollaborativeEditor } from "../components/CollaborativeEditor";
import { InterviewTimer } from "../components/InterviewTimer";
import { RoomNameControl } from "../components/RoomNameControl";
import { Presence, RemoteCursorStyles } from "../components/Presence";
import { QuestionNav } from "../components/QuestionNav";
import { QuestionPanel } from "../components/QuestionPanel";
import { RoomColumns, useRoomLayout } from "../components/RoomLayout";
import { RoomTests } from "../components/RoomTests";
import { SubmissionResults } from "../components/ResultsPanel";
import { TestPanel } from "../components/TestPanel";
import { NotesPanel } from "../components/NotesPanel";
import { TopBar } from "../components/TopBar";
import { api, ApiError, isInterviewerView, isRetryable, submitWithRetry } from "../lib/api";
import { attemptsFor, mergeHistory, progress, upsertEntry, type SubmissionEntry } from "../lib/submissions";
import { displayName, useSession } from "../lib/auth";
import {
  colorFor,
  connectRoomDoc,
  connectRoomEvents,
  getLanguage,
  type ConnectionStatus,
  type RoomDoc,
} from "../lib/realtime";
import {
  initialLanguage,
  latestRevealed,
  mergeRoom,
  metaKey,
  nextToReveal,
  revealedQuestions,
  addCaseRefusal,
  casesToRun,
  parseSharedCases,
  starterFor,
  type SharedCase,
} from "../lib/roomQuestions";

export function RoomPage() {
  const { roomId = "" } = useParams();
  return <InterviewRoom key={roomId} roomId={roomId} />;
}

function InterviewRoom({ roomId }: { roomId: string }) {
  const { session } = useSession();
  const [room, setRoom] = useState<RoomView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roomDoc, setRoomDoc] = useState<RoomDoc | null>(null);
  const [synced, setSynced] = useState(false);
  const [docStatus, setDocStatus] = useState<ConnectionStatus>("connecting");
  const [eventStatus, setEventStatus] = useState<ConnectionStatus>("connecting");
  /** The question this participant is looking at (local — each side navigates on their own). */
  const [activePosition, setActivePosition] = useState(1);
  const [submissionNavigation, setSubmissionNavigation] = useState<{ questionId: string; selectedId?: string }>();
  const [runNavigation, setRunNavigation] = useState(0);
  const [sending, setSending] = useState<Extract<SubmissionEntry, { pending: true }>>();
  const [language, setLanguage] = useState<Language>("python");
  const [entries, setEntries] = useState<SubmissionEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  /** Shared custom cases of the question being viewed (ADR 0010). */
  const [customCases, setCustomCases] = useState<SharedCase[]>([]);
  const layout = useRoomLayout();
  const active = room?.questions.find((q) => q.position === activePosition) ?? room?.questions[0];
  const activeQuestionId = useRef(active?.id);
  activeQuestionId.current = active?.id;

  // Room metadata. Re-fetched on every events (re)connect and on `room:question_revealed` — see below.
  useEffect(() => {
    setRoom(null);
    setError(null);
    api.room(roomId).then(
      (r) => {
        setRoom(r);
        setActivePosition(latestRevealed(r)?.position ?? 1);
      },
      (err: unknown) => {
        setError(err instanceof ApiError && err.status === 403 ? "You're not a participant in this room." : String(err));
      },
    );
  }, [roomId]);

  /** Room events are fire-and-forget, so the room is re-fetched (and merged forward-only) when they may have been missed. */
  const refreshRoom = useCallback(() => {
    api
      .room(roomId)
      .then((next) => setRoom((prev) => mergeRoom(prev, next)))
      .catch(() => {});
  }, [roomId]);

  /**
   * Re-fetch history (on every events (re)connect). Merged, not replaced: a result event that arrived
   * while this request was in flight is further along than the snapshot and must not be rolled back.
   */
  const refreshHistory = useCallback(() => {
    const questionId = activeQuestionId.current;
    if (!questionId) return;
    api
      .roomSubmissions(roomId, questionId)
      .then((list) => setEntries((prev) => mergeHistory(prev, list)))
      .catch(() => {});
  }, [roomId]);
  useEffect(() => { refreshHistory(); }, [active?.id, refreshHistory]);

  // Shared editor (Yjs) — one doc per room, one Y.Text per question inside it.
  useEffect(() => {
    if (!room || !session) return;
    const user = { name: displayName(session), color: colorFor(session.user.id), role: room.role };
    const rd = connectRoomDoc(roomId, session.access_token, user);
    setRoomDoc(rd);
    setSynced(false);

    const onStatus = ({ status }: { status: ConnectionStatus }) => setDocStatus(status);
    rd.provider.on("status", onStatus);
    const onSync = (isSynced: boolean) => setSynced(isSynced);
    rd.provider.on("sync", onSync);

    return () => {
      rd.provider.off("status", onStatus);
      rd.provider.off("sync", onSync);
      rd.destroy();
      setRoomDoc(null);
      setSynced(false);
    };
    // Reconnect only when the room or user changes, not on token refresh (handled inside connectRoomDoc).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.roomId, session?.user.id]);

  /**
   * The interviewer seeds each question's starter code once, when it's revealed (a per-question flag in
   * the doc prevents re-seeding). Unrevealed questions are never seeded, so nothing about them reaches
   * the shared doc — and the candidate — early.
   */
  useEffect(() => {
    if (!roomDoc || !synced || !room || room.role !== "interviewer" || room.status !== "open") return;
    for (const rq of revealedQuestions(room)) {
      if (roomDoc.meta.get(metaKey("initialized", rq.position))) continue;
      const lang = initialLanguage(rq.question);
      const text = roomDoc.textFor(rq.position);
      roomDoc.doc.transact(() => {
        roomDoc.meta.set(metaKey("initialized", rq.position), true);
        roomDoc.meta.set(metaKey("language", rq.position), lang);
        if (text.length === 0) text.insert(0, starterFor(rq.question, lang));
      });
    }
  }, [roomDoc, synced, room]);

  // The selected language of the question being viewed (synced through the doc).
  useEffect(() => {
    if (!roomDoc) return;
    const sync = () => setLanguage(getLanguage(roomDoc.meta, activePosition));
    sync();
    roomDoc.meta.observe(sync);
    return () => roomDoc.meta.unobserve(sync);
  }, [roomDoc, activePosition]);

  // The viewed question's shared custom cases (both participants add/remove them; synced through the doc).
  useEffect(() => {
    if (!roomDoc) return;
    const cases = roomDoc.casesFor(activePosition);
    const sync = () => setCustomCases(parseSharedCases(cases.toArray()));
    sync();
    cases.observe(sync);
    return () => cases.unobserve(sync);
  }, [roomDoc, activePosition]);

  // Live room events
  useEffect(() => {
    if (!room) return;
    const onEvent = (event: ServerEvent) => {
      if (event.type === "room:closed") {
        setRoom((r) => (r ? { ...r, status: "closed" } : r));
        // Also re-fetch: a reveal whose notification was lost may have landed just before the close, and
        // gateways stop reconciling reveals for ended rooms — this is the last chance to pick it up.
        refreshRoom();
      } else if (event.type === "room:question_revealed" || event.type === "room:tests_added") {
        refreshRoom();
      } else if (event.type === "submission:queued") {
        const { type: _type, roomId: _roomId, ...attempt } = event;
        setEntries((prev) =>
          upsertEntry(prev, { ...attempt, pending: true }),
        );
        if (!attempt.mode || !attempt.createdAt) refreshHistory();
      } else if (event.type === "submission:result") {
        const view = event.result;
        setEntries((prev) => upsertEntry(prev, { submissionId: view.submissionId, pending: false, view }));
      }
    };
    const onOpen = () => {
      refreshHistory();
      refreshRoom();
      // Notes can link recent attempts from other questions without first visiting each question.
      if (room.role === "interviewer") void api.roomSubmissions(room.roomId)
        .then((list) => setEntries((prev) => mergeHistory(prev, list)))
        .catch(() => {});
    };
    return connectRoomEvents(room.roomId, { onEvent, onStatus: setEventStatus, onOpen });
    // Only (re)subscribe when the room itself changes, not when its status or questions change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.roomId, refreshHistory, refreshRoom]);

  /**
   * When a new question is revealed, the candidate is taken to it. Their earlier answers stay in their
   * own buffers, and they can switch back. (The interviewer navigates on their own.)
   */
  const revealedCount = room ? revealedQuestions(room).length : 0;
  const seenRevealed = useRef<number | null>(null);
  useEffect(() => {
    if (!room) return;
    const previous = seenRevealed.current;
    seenRevealed.current = revealedCount;
    if (previous !== null && revealedCount > previous && room.role === "candidate") {
      setActivePosition(latestRevealed(room)?.position ?? 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealedCount]);

  const activeText = useMemo(
    () => (roomDoc && active ? roomDoc.textFor(active.position) : null),
    [roomDoc, active?.position],
  );

  const changeLanguage = useCallback(
    (next: Language) => {
      if (!roomDoc || !active) return;
      const text = roomDoc.textFor(active.position);
      const previous = getLanguage(roomDoc.meta, active.position);
      roomDoc.doc.transact(() => {
        roomDoc.meta.set(metaKey("language", active.position), next);
        // Swap the starter only if the code is still the untouched starter.
        if (text.toString() === starterFor(active.question, previous)) {
          text.delete(0, text.length);
          text.insert(0, starterFor(active.question, next));
        }
      });
    },
    [roomDoc, active],
  );

  /**
   * The idempotency key belongs to one logical action (this exact question/code/mode/language), not one
   * click. It's kept until the server gives a definitive answer, so clicking again after a lost response
   * re-sends the same key and gets the original submission back instead of a second run.
   */
  const pendingAttempt = useRef<{ fingerprint: string; key: string } | null>(null);

  const submit = useCallback(
    async (mode: SubmissionMode) => {
      if (!roomDoc || !active) return;
      // Run also tries the shared custom cases; Submit is graded on the question's tests only (ADR 0010).
      const cases =
        mode === "run" ? casesToRun(parseSharedCases(roomDoc.casesFor(active.position).toArray()), MAX_CUSTOM_CASES) : [];
      const body = {
        roomId,
        roomQuestionId: active.id,
        language,
        mode,
        code: roomDoc.textFor(active.position).toString(),
        ...(cases.length > 0
          ? {
              customCases: cases.map((c) => ({
                input: c.input,
                ...(c.expectedOutput !== undefined ? { expectedOutput: c.expectedOutput } : {}),
              })),
            }
          : {}),
      };
      const fingerprint = JSON.stringify(body);
      if (pendingAttempt.current?.fingerprint !== fingerprint) {
        pendingAttempt.current = { fingerprint, key: crypto.randomUUID() };
      }
      const attempt = { submissionId: pendingAttempt.current.key, pending: true as const, roomQuestionId: active.id, mode, language };
      setSending(attempt);
      if (mode === "run") {
        setRunNavigation((n) => n + 1);
      } else {
        setSubmissionNavigation({ questionId: active.id, selectedId: attempt.submissionId });
      }
      setSubmitting(true);
      setNotice(null);
      try {
        const { submissionId, status, createdAt, roomTestRevision } = await submitWithRetry(body, attempt.submissionId);
        pendingAttempt.current = null;
        setEntries((prev) => upsertEntry(prev, {
          ...attempt, submissionId, ...(createdAt && { createdAt }), ...(roomTestRevision !== undefined && { roomTestRevision }),
        }));
        setSubmissionNavigation((current) => current?.selectedId === attempt.submissionId ? { ...current, selectedId: submissionId } : current);
        if (status !== "queued" || !createdAt) refreshHistory();
      } catch (err) {
        if (!isRetryable(err)) pendingAttempt.current = null; // 4xx is final: the next click is a new action
        setSubmissionNavigation((current) => current?.selectedId === attempt.submissionId ? { questionId: current.questionId } : current);
        setNotice(err instanceof Error ? err.message : String(err));
      } finally {
        setSending(undefined);
        setSubmitting(false);
      }
    },
    [roomDoc, roomId, language, active, refreshHistory],
  );

  async function reveal() {
    if (!room || !active) return;
    setRevealing(true);
    setNotice(null);
    try {
      await api.revealQuestion(room.roomId, active.id);
      refreshRoom();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setRevealing(false);
    }
  }

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

  const submissions = active ? attemptsFor(entries, active.id, "submit") : [];
  const showSubmissionResults = !!active && submissionNavigation?.questionId === active.id;
  const selectedId = showSubmissionResults ? submissionNavigation?.selectedId : undefined;
  const selected = selectedId === sending?.submissionId ? sending : submissions.find((entry) => entry.submissionId === selectedId);
  const latestRun = active ? attemptsFor(entries, active.id, "run")[0] : undefined;
  const run = sending?.mode === "run" && sending.roomQuestionId === active?.id ? sending : latestRun;
  const pendingRunId = latestRun && progress(latestRun) < 3 ? latestRun.submissionId : undefined;
  const pendingSubmitId = selected && selected !== sending && progress(selected) < 3 ? selected.submissionId : undefined;

  useEffect(() => {
    const ids = [pendingRunId, pendingSubmitId].filter((id): id is string => id !== undefined);
    if (!ids.length || eventStatus !== "connected") return;
    // Events deliver the final result. Poll unresolved attempts to show running status and recover
    // a missed completion without allowing a stale response to replace a newer result.
    let stopped = false;
    const timer = window.setInterval(() => {
      for (const id of ids) void api.submission(id).then((view) => {
        if (!stopped) setEntries((prev) => upsertEntry(prev, { submissionId: id, pending: false, view }));
      }).catch(() => {});
    }, 1500);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [pendingRunId, pendingSubmitId, eventStatus]);

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
  if (!room || !active) return <div className="center muted">Loading room…</div>;

  const isCandidate = room.role === "candidate";
  const live = docStatus === "connected" && eventStatus === "connected";
  const closed = room.status !== "open";
  const canReveal = !closed && !isCandidate && nextToReveal(room)?.id === active.id;
  const multi = room.questions.length > 1;
  const selectSubmission = (id?: string) => setSubmissionNavigation({ questionId: active.id, selectedId: id });

  return (
    <div className="room-page">
      {roomDoc && <RemoteCursorStyles awareness={roomDoc.provider.awareness} />}
      <TopBar>
        {room.role === "interviewer" && (
          <RoomNameControl roomId={room.roomId} name={room.name} onRenamed={(name) => setRoom((r) => (r ? { ...r, name: name ?? undefined } : r))} />
        )}
        <span className={`badge ${room.role}`}>{room.role}</span>
        {/* Both roles see the same elapsed time (server timestamps), stopping when the session ends. */}
        <InterviewTimer createdAt={room.createdAt} closedAt={room.closedAt} serverTime={room.serverTime} ended={closed} />
        <span className={`status-dot ${live ? "on" : "off"}`} title={`editor: ${docStatus}, events: ${eventStatus}`} />
        <span className="muted small">{live ? "live" : "reconnecting…"}</span>
        {roomDoc && <Presence awareness={roomDoc.provider.awareness} />}
        {room.inviteCode && !closed && (
          <button className="ghost" onClick={copyInvite}>
            {copied ? "Copied!" : "Copy invite link"}
          </button>
        )}
        {!layout.narrow && (
          <button className="ghost" onClick={layout.reset} disabled={layout.isDefault} title="Restore the default panel sizes">
            Reset layout
          </button>
        )}
        {room.role === "interviewer" && (
          // Same tab: sign-in is per tab (lib/auth.tsx), so a new tab would open signed out.
          <Link to={`/rooms/${room.roomId}/review`} className="button-link">
            Review
          </Link>
        )}
        {room.role === "interviewer" && !closed && (
          <button className="danger" onClick={endSession}>
            End session
          </button>
        )}
      </TopBar>
      {closed && <div className="banner">This interview has ended. The code is read-only.</div>}
      {notice && <div className="banner error" role="alert">{notice}</div>}

      <RoomColumns
        layout={layout}
        runNavigation={runNavigation}
        resultsKey={run ? `${run.submissionId}:${progress(run)}` : ""}
        question={
          <section className="pane question-pane">
            {multi && <QuestionNav questions={room.questions} activePosition={active.position} onSelect={setActivePosition} />}
            {!active.revealed && (
              <div className="reveal-bar" role="status">
                <span>The candidate can't see this question yet.</span>
                {canReveal ? (
                  <button className="primary" onClick={reveal} disabled={revealing}>
                    Reveal to candidate
                  </button>
                ) : (
                  !closed && <span className="muted small">Reveal Q{nextToReveal(room)?.position} first.</span>
                )}
              </div>
            )}
            <QuestionPanel question={active.question} />
          </section>
        }
        code={
          <section className="pane code-pane" aria-label="Code">
            <div className="pane-head">
              <div className="editor-tabs" role="tablist" aria-label="Editor views" onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const index = event.key === "Home" ? 0 : event.key === "End" ? 1 : Number(!showSubmissionResults);
                const tab = event.currentTarget.querySelectorAll("button")[index];
                tab?.click();
                tab?.focus();
              }}>
                <button id="editor-code-tab" type="button" role="tab" aria-selected={!showSubmissionResults} aria-controls="editor-code"
                  tabIndex={showSubmissionResults ? -1 : 0} className={`pane-tab ${!showSubmissionResults ? "active" : ""}`}
                  onClick={() => setSubmissionNavigation(undefined)}>
                  <span className="pane-icon ok" aria-hidden="true">&lt;/&gt;</span> Code
                </button>
                <button id="editor-submissions-tab" type="button" role="tab" aria-selected={showSubmissionResults} aria-controls="room-submission-results"
                  tabIndex={showSubmissionResults ? 0 : -1} className={`pane-tab ${showSubmissionResults ? "active" : ""}`}
                  onClick={() => { if (!showSubmissionResults) selectSubmission(); }}>
                  Submissions
                </button>
              </div>
              {multi && (
                <span className="badge question-badge" title={active.question.title}>
                  Q{active.position}
                </span>
              )}
              <div className="spacer" />
              {isCandidate && (
                <>
                  <button onClick={() => submit("run")} disabled={submitting || !roomDoc || closed}>
                    Run
                  </button>
                  <button className="primary" onClick={() => submit("submit")} disabled={submitting || !roomDoc || closed}>
                    Submit
                  </button>
                </>
              )}
            </div>
            {isCandidate && !closed && (active.testRevision ?? 0) > 0 && !submissions.some((entry) =>
              !entry.pending && entry.view.status === "completed" && entry.view.roomTestRevision === active.testRevision
            ) && (
              <div className="pane-toolbar small" role="status">The interviewer added additional tests. Please resubmit.</div>
            )}
            <div id="editor-code" className="code-content" role="tabpanel" aria-labelledby="editor-code-tab" hidden={showSubmissionResults}>
              <div className="pane-toolbar">
                <select
                  className="bare-select"
                  aria-label="Language"
                  value={language}
                  onChange={(e) => changeLanguage(e.target.value as Language)}
                  disabled={!roomDoc || !active.revealed || closed}
                >
                  <option value="python">Python</option>
                  <option value="javascript">JavaScript</option>
                </select>
              </div>
              {roomDoc && activeText ? (
                <CollaborativeEditor
                  text={activeText}
                  awareness={roomDoc.provider.awareness}
                  language={language}
                  // Unrevealed questions are read-only for the interviewer too: nothing is typed into a buffer
                  // the candidate can't see yet.
                  readOnly={closed || !active.revealed}
                  onCursor={(line, column) => setCursor({ line, column })}
                />
              ) : (
                <div className="editor center muted">Connecting…</div>
              )}
              <div className="pane-foot">
                <span>{closed ? "Read-only" : docStatus === "connected" ? "Synced" : "Reconnecting…"}</span>
                <span>
                  Ln {cursor.line}, Col {cursor.column}
                </span>
              </div>
            </div>
            <div id="room-submission-results" className="pane-body" role="tabpanel" aria-labelledby="editor-submissions-tab" hidden={!showSubmissionResults}>
              {showSubmissionResults && <SubmissionResults submissions={submissions} selected={selected} onSelect={selectSubmission} />}
            </div>
          </section>
        }
        tests={
          <TestPanel
            question={active.question}
            run={run}
            runNavigation={runNavigation}
            ended={closed}
            customCases={customCases}
            // Never for unrevealed questions: anything in the shared doc is readable by the candidate's client.
            canEditCases={!!roomDoc && !closed && active.revealed}
            onAddCase={(c) => {
              // Re-check now, not when the form opened: the other participant may have added cases or
              // ended the session since.
              const cases = roomDoc?.casesFor(active.position);
              const refused = addCaseRefusal({
                count: cases?.length ?? 0,
                max: MAX_CUSTOM_CASES,
                editable: !!cases && room.status === "open" && active.revealed,
              });
              if (refused || !cases) return { refused: refused ?? "Not connected yet." };
              const id = crypto.randomUUID();
              const addedBy = { name: session ? displayName(session) : "Someone", role: room.role };
              cases.push([{ id, ...c, addedBy }]);
              return { id };
            }}
            onRemoveCase={(id) => {
              if (room.status !== "open") return;
              const cases = roomDoc?.casesFor(active.position);
              if (!cases) return;
              const index = cases.toArray().findIndex((c) => (c as { id?: unknown })?.id === id);
              if (index >= 0) cases.delete(index, 1);
            }}
            roomTests={room.role === "interviewer" && !closed && active.revealed ? (
              <RoomTests key={active.id} roomId={room.roomId} questionId={active.id} tests={active.addedTests ?? []} onAdded={refreshRoom} />
            ) : undefined}
            notes={
              room.role === "interviewer" ? (
                <NotesPanel
                  roomId={room.roomId}
                  startedAt={room.createdAt}
                  questions={room.questions.map((q) => ({ id: q.id, position: q.position, title: q.question.title }))}
                  activeQuestionId={active.id}
                  submissions={entries.flatMap((e) => (!e.pending && isInterviewerView(e.view) ? [e.view] : []))}
                />
              ) : undefined
            }
          />
        }
      />
    </div>
  );
}
