import { randomBytes } from "node:crypto";
import { Router } from "express";
import { and, desc, eq, inArray, isNull, or, questions, questionVersions, roomParticipants, roomQuestions, rooms, sql, submissions } from "@coderoom/db";
import {
  CreateRoomRequest,
  EvaluationDraftInput,
  JoinRoomRequest,
  NoteRequest,
  RenameRoomRequest,
  SubmitEvaluationRequest,
  roomEventsChannel,
  type RoomBusEvent,
  type CreateRoomResponse,
  type JoinRoomResponse,
  type RoomSummary,
  type RoomView,
  type QuestionSubmissionHistory,
} from "@coderoom/shared";
import { redis } from "../queue.js";
import { latestPublished } from "../services/questions.js";
import { revealQuestion, roomQuestionsFor } from "../services/roomQuestions.js";
import { roomCandidates, roomReview } from "../services/review.js";
import { createNote, deleteNote, listNotes, updateNote } from "../services/notes.js";
import { saveEvaluationDraft, submitEvaluation } from "../services/evaluations.js";
import { customResultsFor, resultsFor, viewFor } from "../services/submissionViews.js";
import { requireRoomRole } from "../auth.js";
import { db } from "../db.js";
import { asyncHandler, BadRequest, NotFound, RoomFull } from "../errors.js";
import { UuidParam } from "./params.js";

export const roomsRouter: Router = Router();

/**
 * Creator becomes the room's interviewer. Each question is pinned to its latest READY version: later
 * edits create new versions and never change what this interview runs against (ADR 0007). The list is
 * ordered and fixed; question 1 is revealed now, the rest when the interviewer reveals them (ADR 0009).
 * Allowed questions: the caller's own, or shared library questions (no owner).
 * TODO: restrict room creation to an org/interviewer allowlist.
 */
roomsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { questionIds, questionPoints, name } = CreateRoomRequest.parse(req.body);
    const userId = req.user!.userId;

    const allowed = await db
      .select({ id: questions.id })
      .from(questions)
      .where(and(inArray(questions.id, questionIds), or(eq(questions.createdBy, userId), isNull(questions.createdBy))));
    const allowedIds = new Set(allowed.map((q) => q.id));
    if (questionIds.some((id) => !allowedIds.has(id))) throw new NotFound("Question not found");

    const versions = await Promise.all(questionIds.map((id) => latestPublished(id)));
    if (versions.some((v) => !v)) {
      throw new BadRequest("A question isn't ready yet — mark it ready before using it in an interview");
    }

    const inviteCode = randomBytes(12).toString("base64url");
    const room = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(rooms)
        .values({ createdBy: userId, inviteCode, name: name ?? null })
        .returning({ id: rooms.id });
      const roomId = created!.id;
      const now = new Date();
      await tx.insert(roomQuestions).values(
        versions.map((v, i) => ({
          roomId,
          position: i + 1,
          questionVersionId: v!.id,
          points: questionPoints?.[i] ?? 1, // equal weights unless the interviewer set them
          revealedAt: i === 0 ? now : null,
        })),
      );
      await tx.insert(roomParticipants).values({ roomId, userId, role: "interviewer" });
      return created!;
    });

    const response: CreateRoomResponse = { roomId: room.id, inviteCode };
    res.status(201).json(response);
  }),
);

/**
 * Joining with an invite code grants the candidate role — to one person per room (ADR 0012). The
 * candidate can rejoin (idempotent); anyone else gets 409 `room_full` and never becomes a participant.
 * The limit is a unique index, so two people joining at the same instant can't both get in.
 * The interviewer opening their own link is just sent to their room (role stays interviewer, the
 * candidate seat stays free).
 */
roomsRouter.post(
  "/join",
  asyncHandler(async (req, res) => {
    const { inviteCode } = JoinRoomRequest.parse(req.body);
    const userId = req.user!.userId;

    const [room] = await db
      .select({ id: rooms.id, status: rooms.status })
      .from(rooms)
      .where(eq(rooms.inviteCode, inviteCode))
      .limit(1);
    if (!room || room.status !== "open") throw new NotFound("Room not found or closed");

    const [existing] = await db
      .select({ role: roomParticipants.role })
      .from(roomParticipants)
      .where(and(eq(roomParticipants.roomId, room.id), eq(roomParticipants.userId, userId)))
      .limit(1);
    if (existing?.role === "interviewer") {
      const response: JoinRoomResponse = { roomId: room.id, role: "interviewer" };
      res.json(response);
      return;
    }
    if (!existing) {
      // Conflicts on the primary key (same user, concurrent retry) or on the one-candidate index
      // (someone else took the seat) both insert nothing; only the second case is a refusal.
      const inserted = await db
        .insert(roomParticipants)
        .values({ roomId: room.id, userId, role: "candidate" })
        .onConflictDoNothing()
        .returning({ userId: roomParticipants.userId });
      if (inserted.length === 0) {
        const [now] = await db
          .select({ role: roomParticipants.role })
          .from(roomParticipants)
          .where(and(eq(roomParticipants.roomId, room.id), eq(roomParticipants.userId, userId)))
          .limit(1);
        if (now?.role !== "candidate") throw new RoomFull();
      }
    }

    const response: JoinRoomResponse = { roomId: room.id, role: "candidate" };
    res.json(response);
  }),
);

roomsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const roomId = UuidParam.parse(req.params.id);
    const role = await requireRoomRole(roomId, req.user!.userId);

    const [row] = await db
      .select({ status: rooms.status, inviteCode: rooms.inviteCode, name: rooms.name, createdAt: rooms.createdAt, closedAt: rooms.closedAt })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1);
    if (!row) throw new NotFound();

    const view: RoomView = {
      roomId,
      status: row.status,
      role,
      // The invite code and the room's name are the interviewer's (ADR 0014: names may hold internal notes).
      ...(role === "interviewer" ? { inviteCode: row.inviteCode, ...(row.name ? { name: row.name } : {}) } : {}),
      // Pinned versions, candidate view (public tests only). Candidates get revealed questions only.
      questions: await roomQuestionsFor(roomId, role),
      createdAt: row.createdAt.toISOString(),
      ...(row.closedAt ? { closedAt: row.closedAt.toISOString() } : {}),
      serverTime: new Date().toISOString(),
    };
    res.json(view);
  }),
);

/** Rename or clear the room's name (ADR 0014). Interviewer only; allowed after the session ended too. */
roomsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const roomId = UuidParam.parse(req.params.id);
    await requireRoomRole(roomId, req.user!.userId, "interviewer");
    const { name } = RenameRoomRequest.parse(req.body);
    await db.update(rooms).set({ name }).where(eq(rooms.id, roomId));
    res.json({ roomId, name });
  }),
);

/**
 * Post-interview review (ADR 0011): per candidate, the test score with its breakdown, time per
 * question and every run/submission with its code. Interviewer only (403 for candidates and outsiders).
 */
roomsRouter.get(
  "/:id/review",
  asyncHandler(async (req, res) => {
    const roomId = UuidParam.parse(req.params.id);
    await requireRoomRole(roomId, req.user!.userId, "interviewer");
    res.json(await roomReview(roomId, req.user!.userId));
  }),
);

/*
 * Private interviewer notes (ADR 0016). Every route is interviewer-only (403 for candidates and
 * outsiders); only a note's author can edit or delete it. Allowed after the session ended too.
 * Notes never go through Yjs or room events — those reach the candidate.
 */
roomsRouter.get(
  "/:id/notes",
  asyncHandler(async (req, res) => {
    const roomId = UuidParam.parse(req.params.id);
    await requireRoomRole(roomId, req.user!.userId, "interviewer");
    res.json(await listNotes(roomId, req.user!.userId));
  }),
);

roomsRouter.post(
  "/:id/notes",
  asyncHandler(async (req, res) => {
    const roomId = UuidParam.parse(req.params.id);
    await requireRoomRole(roomId, req.user!.userId, "interviewer");
    const { body, ...links } = NoteRequest.parse(req.body);
    res.status(201).json(await createNote(roomId, req.user!.userId, body, links));
  }),
);

roomsRouter.patch(
  "/:id/notes/:noteId",
  asyncHandler(async (req, res) => {
    const roomId = UuidParam.parse(req.params.id);
    await requireRoomRole(roomId, req.user!.userId, "interviewer");
    const noteId = UuidParam.parse(req.params.noteId);
    const { body, ...links } = NoteRequest.parse(req.body);
    res.json(await updateNote(roomId, req.user!.userId, noteId, body, links));
  }),
);

roomsRouter.delete(
  "/:id/notes/:noteId",
  asyncHandler(async (req, res) => {
    const roomId = UuidParam.parse(req.params.id);
    await requireRoomRole(roomId, req.user!.userId, "interviewer");
    const noteId = UuidParam.parse(req.params.noteId);
    await deleteNote(roomId, req.user!.userId, noteId);
    res.status(204).end();
  }),
);

/*
 * The interviewer's structured evaluation of the room's candidate (ADR 0017). Interviewer-only.
 * Drafts can be saved during the interview and after; submitting (which locks it) only after the
 * interview ended. Read through the review (`GET /rooms/:id/review`).
 */
roomsRouter.put(
  "/:id/evaluations/:candidateId",
  asyncHandler(async (req, res) => {
    const roomId = UuidParam.parse(req.params.id);
    await requireRoomRole(roomId, req.user!.userId, "interviewer");
    const candidateId = UuidParam.parse(req.params.candidateId);
    const input = EvaluationDraftInput.parse(req.body);
    res.json(await saveEvaluationDraft(roomId, candidateId, req.user!.userId, input));
  }),
);

roomsRouter.post(
  "/:id/evaluations/:candidateId/submit",
  asyncHandler(async (req, res) => {
    const roomId = UuidParam.parse(req.params.id);
    await requireRoomRole(roomId, req.user!.userId, "interviewer");
    const candidateId = UuidParam.parse(req.params.candidateId);
    const { revision } = SubmitEvaluationRequest.parse(req.body);
    res.json(await submitEvaluation(roomId, candidateId, req.user!.userId, revision));
  }),
);

/**
 * Interviewer reveals the next question to the candidate (in order; idempotent; never after the room
 * ended). The DB update is the commit point. The bus event is the fast path (best effort): every
 * gateway also re-reads revealed questions from the DB (`roomStatusReconciler`), so a lost publish
 * delays the candidate's update by at most one interval, even while their sockets stay connected.
 */
roomsRouter.post(
  "/:id/questions/:roomQuestionId/reveal",
  asyncHandler(async (req, res) => {
    const roomId = UuidParam.parse(req.params.id);
    await requireRoomRole(roomId, req.user!.userId, "interviewer");
    const roomQuestionId = UuidParam.parse(req.params.roomQuestionId);
    const { changed, revealedCount } = await revealQuestion(roomId, roomQuestionId);
    if (changed) {
      const event: RoomBusEvent = { type: "room:question_revealed", roomId, revealedCount };
      redis
        .publish(roomEventsChannel(roomId), JSON.stringify(event))
        .catch((err) => console.error(`reveal publish failed for ${roomId}; reconciler will deliver:`, err));
    }
    res.json({ roomQuestionId, revealed: true });
  }),
);

/** Submission history for the room, newest first, each in the caller's role view. Candidates see only their own. */
roomsRouter.get(
  "/:id/submissions",
  asyncHandler(async (req, res) => {
    const roomId = UuidParam.parse(req.params.id);
    const userId = req.user!.userId;
    const role = await requireRoomRole(roomId, userId);

    const rows = await db.select().from(submissions)
      .where(and(eq(submissions.roomId, roomId), role === "candidate" ? eq(submissions.userId, userId) : undefined))
      .orderBy(desc(submissions.createdAt), desc(submissions.id))
      .limit(50);
    res.json(await submissionHistoryViews(role, rows));
  }),
);

async function submissionHistoryViews(role: Awaited<ReturnType<typeof requireRoomRole>>, rows: (typeof submissions.$inferSelect)[]) {
  const ids = rows.map((r) => r.id);
  const [results, custom] = await Promise.all([resultsFor(ids), customResultsFor(ids)]);
  return rows.map((submission) => viewFor(role, {
    submission,
    results: results.filter((r) => r.submissionId === submission.id),
    custom: custom.filter((r) => r.submissionId === submission.id),
  }));
}

roomsRouter.get(
  "/:id/questions/:questionId/submissions",
  asyncHandler(async (req, res) => {
    const roomId = UuidParam.parse(req.params.id);
    const questionId = UuidParam.parse(req.params.questionId);
    const before = UuidParam.optional().parse(req.query.before);
    const userId = req.user!.userId;
    const role = await requireRoomRole(roomId, userId);
    const scope = and(eq(submissions.roomId, roomId), eq(submissions.roomQuestionId, questionId),
      role === "candidate" ? eq(submissions.userId, userId) : undefined);
    // Rank in storage, so loading a page or inserting a newer Submit never renumbers older attempts.
    const ranked = db.$with("ranked_submissions").as(db.select({
      id: submissions.id,
      attemptNumber: sql<number>`(row_number() over (order by ${submissions.createdAt}, ${submissions.id}))::int`.as("attempt_number"),
    }).from(submissions).where(and(scope, eq(submissions.mode, "submit"))));
    const cursor = before ? db.select({ number: ranked.attemptNumber }).from(ranked).where(eq(ranked.id, before)) : undefined;
    const [page, runs] = await Promise.all([
      db.with(ranked).select({ submission: submissions, attemptNumber: ranked.attemptNumber })
        .from(ranked).innerJoin(submissions, eq(submissions.id, ranked.id))
        .where(cursor ? sql`${ranked.attemptNumber} < (${cursor})` : undefined)
        .orderBy(desc(ranked.attemptNumber)).limit(50),
      before ? [] : db.select().from(submissions).where(and(scope, eq(submissions.mode, "run")))
        .orderBy(desc(submissions.createdAt), desc(submissions.id)).limit(1),
    ]);
    const views = await submissionHistoryViews(role, [...page.map(({ submission }) => submission), ...runs]);
    const response: QuestionSubmissionHistory = {
      submissions: page.map(({ attemptNumber }, index) => ({ attemptNumber, view: views[index]! })),
      ...(runs.length ? { latestRun: views[page.length]! } : {}),
    };
    res.json(response);
  }),
);

/**
 * End the session (interviewer only). Idempotent.
 * The DB update is the commit point. The bus event is only the fast path (best effort): every gateway
 * also reconciles room status from the DB, so already-open sockets become read-only even if it's lost.
 */
roomsRouter.post(
  "/:id/close",
  asyncHandler(async (req, res) => {
    const roomId = UuidParam.parse(req.params.id);
    await requireRoomRole(roomId, req.user!.userId, "interviewer");
    // Row-locking UPDATE: serialized with revealQuestion's `FOR UPDATE` and the submission insert's
    // `FOR SHARE` on the same row, so no question is revealed and no submission accepted after this commits.
    // Idempotent: closing again keeps the original end time (the interview timer stops there).
    await db
      .update(rooms)
      .set({ status: "closed", closedAt: sql`COALESCE(${rooms.closedAt}, now())` })
      .where(eq(rooms.id, roomId));
    const event: RoomBusEvent = { type: "room:closed", roomId };
    redis
      .publish(roomEventsChannel(roomId), JSON.stringify(event))
      .catch((err) => console.error(`room:closed publish failed for ${roomId}; reconciler will enforce:`, err));
    res.json({ roomId, status: "closed" });
  }),
);

/** Rooms the caller participates in, newest first (50). Interviewer rows include their candidates. */
roomsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const rows = await db
      .select({
        roomId: rooms.id,
        name: rooms.name,
        role: roomParticipants.role,
        status: rooms.status,
        questionTitle: questionVersions.title,
        createdAt: rooms.createdAt,
      })
      .from(roomParticipants)
      .innerJoin(rooms, eq(rooms.id, roomParticipants.roomId))
      // Titled by the first question (always revealed, so safe to show candidates too).
      .innerJoin(roomQuestions, and(eq(roomQuestions.roomId, rooms.id), eq(roomQuestions.position, 1)))
      .innerJoin(questionVersions, eq(questionVersions.id, roomQuestions.questionVersionId))
      .where(eq(roomParticipants.userId, req.user!.userId))
      .orderBy(desc(rooms.createdAt))
      .limit(50);
    // Candidate names and emails only for rooms the caller interviews (ADR 0013): a candidate's own list
    // never carries another person's details. (Scores are on the review page, not here.)
    const candidates = await roomCandidates(rows.filter((r) => r.role === "interviewer").map((r) => r.roomId));
    const list: RoomSummary[] = rows.map(({ name, ...r }) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      // Interviewer rows only: candidates (ADR 0013) and the room's name (ADR 0014).
      ...(r.role === "interviewer" ? { candidates: candidates.get(r.roomId) ?? [], ...(name ? { name } : {}) } : {}),
    }));
    res.json(list);
  }),
);
