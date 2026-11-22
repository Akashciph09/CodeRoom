import { Router } from "express";
import { eq, rooms, submissions } from "@coderoom/db";
import {
  CreateSubmissionRequest,
  roomEventsChannel,
  type CreateSubmissionResponse,
  type RoomBusEvent,
} from "@coderoom/shared";
import { requireRoomRole } from "../auth.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { asyncHandler, BadRequest, NotFound, PayloadTooLarge } from "../errors.js";
import { enqueueExecution, redis } from "../queue.js";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  enforceSubmitRateLimit,
  releaseIdempotencyKey,
} from "../services/submitGuards.js";
import { loadSubmissionWithResults, viewFor } from "../services/submissionViews.js";
import { UuidParam } from "./params.js";

export const submissionsRouter: Router = Router();

/**
 * rate limit → validate → (idempotency) → persist → enqueue. This handler never executes code.
 *
 * The submissions row is the outbox: if enqueueing fails after the insert, we still answer 202 and
 * the worker's outbox sweeper enqueues the row later. A submission can be delayed, never lost.
 */
submissionsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const userId = req.user!.userId;
    await enforceSubmitRateLimit(userId);

    const body = CreateSubmissionRequest.parse(req.body);
    if (Buffer.byteLength(body.code, "utf8") > config.MAX_CODE_BYTES) {
      throw new PayloadTooLarge(`Code exceeds ${config.MAX_CODE_BYTES} bytes`);
    }

    const claim = await claimIdempotencyKey(userId, req.header("idempotency-key"));
    if (claim.kind === "replay") {
      const response: CreateSubmissionResponse = { submissionId: claim.submissionId, status: "queued" };
      res.status(202).setHeader("Idempotent-Replayed", "true").json(response);
      return;
    }

    let submissionId: string;
    try {
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
      submissionId = submission!.id;
    } catch (err) {
      await releaseIdempotencyKey(claim);
      throw err;
    }

    // From here the submission exists; record it for idempotent replays before anything else can fail.
    await completeIdempotencyKey(claim, submissionId).catch(() => {});

    try {
      await enqueueExecution({ submissionId });
    } catch (err) {
      console.error(`enqueue failed for ${submissionId}; outbox sweeper will retry:`, err);
    }

    // Best effort: realtime clients learn about it; REST still works if this fails.
    const event: RoomBusEvent = { type: "submission:queued", roomId: body.roomId, submissionId };
    redis.publish(roomEventsChannel(body.roomId), JSON.stringify(event)).catch(() => {});

    const response: CreateSubmissionResponse = { submissionId, status: "queued" };
    res.status(202).json(response);
  }),
);

submissionsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const parsed = UuidParam.safeParse(req.params.id);
    if (!parsed.success) throw new NotFound();

    const loaded = await loadSubmissionWithResults(parsed.data);
    if (!loaded) throw new NotFound();
    const role = await requireRoomRole(loaded.submission.roomId, req.user!.userId);
    res.json(viewFor(role, loaded));
  }),
);
