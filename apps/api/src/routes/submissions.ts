import { Router } from "express";
import { asc, eq, rooms, submissions, testResults } from "@coderoom/db";
import { CreateSubmissionRequest, type CreateSubmissionResponse } from "@coderoom/shared";
import { requireRoomRole } from "../auth.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { asyncHandler, BadRequest, NotFound, PayloadTooLarge } from "../errors.js";
import { enqueueExecution } from "../queue.js";
import { toCandidateView, toInterviewerView } from "../views.js";
import { UuidParam } from "./params.js";

export const submissionsRouter: Router = Router();

/**
 * Validate → persist → enqueue. This handler must NEVER execute the submitted code.
 * TODO: per-user rate limit.
 */
submissionsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = CreateSubmissionRequest.parse(req.body);
    const userId = req.user!.userId;
    if (Buffer.byteLength(body.code, "utf8") > config.MAX_CODE_BYTES) {
      throw new PayloadTooLarge(`Code exceeds ${config.MAX_CODE_BYTES} bytes`);
    }

    await requireRoomRole(body.roomId, userId, "candidate");
    const [room] = await db
      .select({ questionId: rooms.questionId, status: rooms.status })
      .from(rooms)
      .where(eq(rooms.id, body.roomId))
      .limit(1);
    if (!room) throw new NotFound();
    if (room.status !== "open") throw new BadRequest("Room is closed");

    const [submission] = await db
      .insert(submissions)
      .values({
        roomId: body.roomId,
        questionId: room.questionId,
        userId,
        language: body.language,
        mode: body.mode,
        code: body.code,
      })
      .returning({ id: submissions.id });

    await enqueueExecution({ submissionId: submission!.id });

    const response: CreateSubmissionResponse = { submissionId: submission!.id, status: "queued" };
    res.status(202).json(response);
  }),
);

submissionsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const parsed = UuidParam.safeParse(req.params.id);
    if (!parsed.success) throw new NotFound();

    const [submission] = await db
      .select()
      .from(submissions)
      .where(eq(submissions.id, parsed.data))
      .limit(1);
    if (!submission) throw new NotFound();

    const role = await requireRoomRole(submission.roomId, req.user!.userId);
    const results = await db
      .select()
      .from(testResults)
      .where(eq(testResults.submissionId, submission.id))
      .orderBy(asc(testResults.testCaseId));

    res.json(
      role === "interviewer" ? toInterviewerView(submission, results) : toCandidateView(submission, results),
    );
  }),
);
