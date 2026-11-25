import { Router } from "express";
import { and, eq, isNotNull, roomQuestions, roomTestCases, rooms, sql, testCases } from "@coderoom/db";
import { AddRoomTestRequest, MAX_ROOM_TEST_CASES, roomEventsChannel, type RoomBusEvent } from "@coderoom/shared";
import { requireRoomRole } from "../auth.js";
import { db } from "../db.js";
import { asyncHandler, BadRequest, Conflict, HttpError, NotFound, TooManyRequests } from "../errors.js";
import { redis, validateGeneratedTests } from "../queue.js";
import { configuredRoomTestModel, suggestRoomTests, type RoomTestModel } from "../services/ai.js";
import { roomQuestionsFor } from "../services/roomQuestions.js";
import { enforceSubmitRateLimit } from "../services/submitGuards.js";
import { UuidParam } from "./params.js";

const scope = (roomId: string, questionId: string) => and(
  eq(roomQuestions.roomId, roomId),
  eq(roomQuestions.id, questionId),
  isNotNull(roomQuestions.revealedAt),
);

export function roomTestsRouter(model: RoomTestModel = configuredRoomTestModel): Router {
  const router = Router();
  const path = "/:id/questions/:questionId/tests";

  router.post(`${path}/suggest`, asyncHandler(async (req, res) => {
    const roomId = UuidParam.parse(req.params.id);
    const questionId = UuidParam.parse(req.params.questionId);
    const userId = req.user!.userId;
    await requireRoomRole(roomId, userId, "interviewer");
    const [room] = await db.select({ status: rooms.status }).from(rooms).where(eq(rooms.id, roomId));
    if (room?.status !== "open") throw new BadRequest("Room is closed.");
    // Use exactly the public question view, including any public room additions.
    const selected = (await roomQuestionsFor(roomId, "candidate")).find((q) => q.id === questionId);
    if (!selected) throw new NotFound("Revealed question not found in this room.");
    if ((selected.testRevision ?? 0) >= MAX_ROOM_TEST_CASES) throw new BadRequest("This room question has reached the test limit.");
    const { title, statement, constraints, publicTests } = selected.question;
    const evidence = JSON.stringify({ untrustedQuestion: { title, statement, constraints, publicTests } });
    if (Buffer.byteLength(evidence) > 32_000) throw new BadRequest("This question has too much public data for AI suggestions.");

    const now = Math.floor(Date.now() / 1000);
    const key = `rl:room-tests:${userId}:${Math.floor(now / 60)}`;
    const counts = await redis.multi().incr(key).expire(key, 61).exec();
    const count = counts?.[0]?.[1];
    if (typeof count !== "number") throw new HttpError(503, "Suggestions are temporarily unavailable.");
    if (count > 3) throw new TooManyRequests("Too many test suggestions. Try again shortly.", 60 - now % 60);
    res.setHeader("Cache-Control", "no-store");
    res.json(await suggestRoomTests(evidence, model));
  }));

  router.post(path, asyncHandler(async (req, res) => {
    const roomId = UuidParam.parse(req.params.id);
    const questionId = UuidParam.parse(req.params.questionId);
    const userId = req.user!.userId;
    await requireRoomRole(roomId, userId, "interviewer");
    const { input, expectedOutput, isHidden, referencePython } = AddRoomTestRequest.parse(req.body);
    const [target] = await db.select({ status: rooms.status, revision: roomQuestions.testRevision })
      .from(roomQuestions).innerJoin(rooms, eq(rooms.id, roomQuestions.roomId)).where(scope(roomId, questionId));
    if (!target) throw new NotFound("Revealed question not found in this room.");
    if (target.status !== "open") throw new BadRequest("Room is closed.");
    if (target.revision >= MAX_ROOM_TEST_CASES) throw new BadRequest("This room question has reached the test limit.");
    if (referencePython) {
      await enforceSubmitRateLimit(userId, "sandbox requests");
      const [verdict] = await validateGeneratedTests(referencePython, [{ input, expectedOutput, isHidden }]).catch(() => {
        throw new HttpError(503, "The worker could not check this test. Try again.");
      });
      if (verdict !== "accepted") throw new BadRequest(`The reference check did not pass (${verdict ?? "internal_error"}).`);
    }

    const totalRevision = await db.transaction(async (tx) => {
      const [room] = await tx.select({ status: rooms.status }).from(rooms).where(eq(rooms.id, roomId)).for("update");
      if (room?.status !== "open") throw new BadRequest("Room is closed.");
      const [question] = await tx.select().from(roomQuestions).where(scope(roomId, questionId));
      if (!question) throw new NotFound("Revealed question not found in this room.");
      if (question.testRevision >= MAX_ROOM_TEST_CASES) throw new BadRequest("This room question has reached the test limit.");
      const [bank, additional] = await Promise.all([
        tx.select({ id: testCases.id }).from(testCases)
          .where(and(eq(testCases.versionId, question.questionVersionId), eq(testCases.input, input))).limit(1),
        tx.select({ id: roomTestCases.id }).from(roomTestCases)
          .where(and(eq(roomTestCases.roomQuestionId, questionId), eq(roomTestCases.input, input))).limit(1),
      ]);
      if (bank.length || additional.length) throw new Conflict("This input is already part of the question's tests.");
      const revision = question.testRevision + 1;
      await tx.insert(roomTestCases).values({ roomQuestionId: questionId, revision, input, expectedOutput, isHidden });
      await tx.update(roomQuestions).set({ testRevision: revision }).where(eq(roomQuestions.id, questionId));
      const [versions] = await tx.select({ total: sql<number>`sum(${roomQuestions.testRevision})::int` })
        .from(roomQuestions).where(eq(roomQuestions.roomId, roomId));
      return versions!.total;
    }).catch((error: unknown) => {
      if (error instanceof HttpError) throw error;
      // A database error can contain query parameters, including hidden input and output.
      console.error("Room test insert failed", { roomId, questionId });
      throw new HttpError(500, "Could not add the room test.");
    });

    const event: RoomBusEvent = { type: "room:tests_added", roomId, totalRevision };
    redis.publish(roomEventsChannel(roomId), JSON.stringify(event)).catch(() => {});
    res.status(204).end();
  }));
  return router;
}
