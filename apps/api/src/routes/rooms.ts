import { randomBytes } from "node:crypto";
import { Router } from "express";
import {
  and,
  asc,
  desc,
  eq,
  questions,
  roomParticipants,
  rooms,
  submissions,
  testCases,
} from "@coderoom/db";
import {
  CreateRoomRequest,
  JoinRoomRequest,
  type CreateRoomResponse,
  type JoinRoomResponse,
  type RoomSummary,
  type RoomView,
} from "@coderoom/shared";
import { resultsFor, viewFor } from "../services/submissionViews.js";
import { requireRoomRole } from "../auth.js";
import { db } from "../db.js";
import { asyncHandler, BadRequest, Conflict, NotFound } from "../errors.js";
import { UuidParam } from "./params.js";

export const roomsRouter: Router = Router();

/** Creator becomes the room's interviewer. TODO: restrict room creation to an org/interviewer allowlist. */
roomsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { questionId } = CreateRoomRequest.parse(req.body);
    const userId = req.user!.userId;

    const [question] = await db
      .select({ status: questions.status })
      .from(questions)
      .where(eq(questions.id, questionId))
      .limit(1);
    if (!question) throw new NotFound("Question not found");
    if (question.status !== "approved") throw new BadRequest("Question is not approved yet");

    const inviteCode = randomBytes(12).toString("base64url");
    const room = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(rooms)
        .values({ questionId, createdBy: userId, inviteCode })
        .returning({ id: rooms.id });
      await tx.insert(roomParticipants).values({ roomId: created!.id, userId, role: "interviewer" });
      return created!;
    });

    const response: CreateRoomResponse = { roomId: room.id, inviteCode };
    res.status(201).json(response);
  }),
);

/** Joining with an invite code grants the candidate role. */
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
    if (existing?.role === "interviewer") throw new Conflict("Interviewer cannot join as candidate");
    if (!existing) {
      await db
        .insert(roomParticipants)
        .values({ roomId: room.id, userId, role: "candidate" })
        .onConflictDoNothing();
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
      .select({
        status: rooms.status,
        inviteCode: rooms.inviteCode,
        questionId: questions.id,
        title: questions.title,
        prompt: questions.prompt,
      })
      .from(rooms)
      .innerJoin(questions, eq(questions.id, rooms.questionId))
      .where(eq(rooms.id, roomId))
      .limit(1);
    if (!row) throw new NotFound();

    // Hidden tests are filtered in SQL so they never enter this process's response path.
    const publicTests = await db
      .select({ id: testCases.id, input: testCases.input, expectedOutput: testCases.expectedOutput })
      .from(testCases)
      .where(and(eq(testCases.questionId, row.questionId), eq(testCases.isHidden, false)))
      .orderBy(asc(testCases.position));

    const view: RoomView = {
      roomId,
      status: row.status,
      role,
      ...(role === "interviewer" ? { inviteCode: row.inviteCode } : {}),
      question: { id: row.questionId, title: row.title, prompt: row.prompt, publicTests },
    };
    res.json(view);
  }),
);

/** Submission history for the room, newest first, each in the caller's role view. Candidates see only their own. */
roomsRouter.get(
  "/:id/submissions",
  asyncHandler(async (req, res) => {
    const roomId = UuidParam.parse(req.params.id);
    const userId = req.user!.userId;
    const role = await requireRoomRole(roomId, userId);

    const rows = await db
      .select()
      .from(submissions)
      .where(
        role === "interviewer"
          ? eq(submissions.roomId, roomId)
          : and(eq(submissions.roomId, roomId), eq(submissions.userId, userId)),
      )
      .orderBy(desc(submissions.createdAt))
      .limit(50);

    const results = await resultsFor(rows.map((r) => r.id));

    res.json(
      rows.map((submission) =>
        viewFor(role, { submission, results: results.filter((r) => r.submissionId === submission.id) }),
      ),
    );
  }),
);

/** Rooms the caller participates in, newest first. */
roomsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const rows = await db
      .select({
        roomId: rooms.id,
        role: roomParticipants.role,
        status: rooms.status,
        questionTitle: questions.title,
        createdAt: rooms.createdAt,
      })
      .from(roomParticipants)
      .innerJoin(rooms, eq(rooms.id, roomParticipants.roomId))
      .innerJoin(questions, eq(questions.id, rooms.questionId))
      .where(eq(roomParticipants.userId, req.user!.userId))
      .orderBy(desc(rooms.createdAt))
      .limit(50);
    const list: RoomSummary[] = rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
    res.json(list);
  }),
);
