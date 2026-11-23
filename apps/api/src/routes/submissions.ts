import { Router, type Response } from "express";
import { and, eq, submissions, type Submission } from "@coderoom/db";
import {
  CreateSubmissionRequest,
  roomEventsChannel,
  type CreateSubmissionResponse,
  type RoomBusEvent,
} from "@coderoom/shared";
import { requireRoomRole } from "../auth.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { asyncHandler, NotFound, PayloadTooLarge, UnprocessableEntity } from "../errors.js";
import { enqueueExecution, redis } from "../queue.js";
import { submittableQuestion } from "../services/roomQuestions.js";
import { enforceSubmitRateLimit, parseIdempotencyKey } from "../services/submitGuards.js";
import { loadSubmissionWithResults, viewFor } from "../services/submissionViews.js";
import { UuidParam } from "./params.js";

export const submissionsRouter: Router = Router();

async function findByIdempotencyKey(userId: string, key: string) {
  const [row] = await db
    .select()
    .from(submissions)
    .where(and(eq(submissions.userId, userId), eq(submissions.idempotencyKey, key)))
    .limit(1);
  return row ?? null;
}

/** Enqueue is best effort: the row is the outbox, and the worker's sweeper re-enqueues stuck rows. */
async function tryEnqueue(submissionId: string) {
  try {
    await enqueueExecution({ submissionId });
  } catch (err) {
    console.error(`enqueue failed for ${submissionId}; outbox sweeper will retry:`, err);
  }
}

/** A retry of the same key returns the original submission — but only if it's really the same request. */
async function replay(res: Response, existing: Submission, body: CreateSubmissionRequest) {
  const same =
    existing.roomId === body.roomId &&
    existing.roomQuestionId === body.roomQuestionId &&
    existing.language === body.language &&
    existing.mode === body.mode &&
    existing.code === body.code &&
    JSON.stringify(existing.customCases ?? []) === JSON.stringify(body.customCases ?? []);
  if (!same) throw new UnprocessableEntity("Idempotency-Key was already used for a different request");
  // Cheap insurance if the original enqueue failed (jobId dedupes if it didn't).
  if (existing.status === "queued") await tryEnqueue(existing.id);
  const response: CreateSubmissionResponse = { submissionId: existing.id, status: existing.status };
  res.status(202).setHeader("Idempotent-Replayed", "true").json(response);
}

/**
 * rate limit → validate → idempotent replay? → authorize → insert (row + key, atomically) → enqueue.
 * This handler never executes code. If enqueueing fails after the insert we still answer 202: the
 * submissions row is the outbox, so a submission can be delayed but never lost.
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
    const idempotencyKey = parseIdempotencyKey(req.header("idempotency-key"));

    // A retry after a lost response: return what the first attempt created (even if the room closed since).
    if (idempotencyKey) {
      const existing = await findByIdempotencyKey(userId, idempotencyKey);
      if (existing) return replay(res, existing, body);
    }

    await requireRoomRole(body.roomId, userId, "candidate");

    // Check and insert in one transaction, holding a share lock on the room row (see submittableQuestion):
    // a submission can't be accepted into a room that ends between the check and the insert.
    const inserted = await db.transaction(async (tx) => {
      // Revealed question of this room, open room (404 / 400 otherwise).
      const target = await submittableQuestion(tx, body.roomId, body.roomQuestionId);
      const [row] = await tx
        .insert(submissions)
        .values({
          roomId: body.roomId,
          roomQuestionId: body.roomQuestionId,
          questionVersionId: target.versionId, // graded against that question's pinned version
          userId,
          language: body.language,
          mode: body.mode,
          code: body.code,
          customCases: body.customCases?.length ? body.customCases : null,
          idempotencyKey,
        })
        // Two concurrent requests with the same key: exactly one row wins; the other replays it.
        .onConflictDoNothing({ target: [submissions.userId, submissions.idempotencyKey] })
        .returning({ id: submissions.id });
      return row;
    });

    if (!inserted) {
      const existing = idempotencyKey ? await findByIdempotencyKey(userId, idempotencyKey) : null;
      if (!existing) throw new Error("insert conflicted but no submission found for the key");
      return replay(res, existing, body);
    }

    const submissionId = inserted.id;
    await tryEnqueue(submissionId);

    // Best effort: realtime clients learn about it; REST still works if this fails.
    const event: RoomBusEvent = {
      type: "submission:queued",
      roomId: body.roomId,
      submissionId,
      roomQuestionId: body.roomQuestionId,
    };
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
