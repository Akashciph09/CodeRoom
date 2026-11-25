import { z } from "zod";
import { Language } from "./languages.js";
import { SubmissionMode } from "./submissions.js";
import { Verdict } from "./verdicts.js";

export const EXECUTION_QUEUE = "execution";

/** Job payload carries ONLY the submission id; the worker loads everything else. */
export const ExecutionJob = z.object({
  submissionId: z.string().min(1),
});
export type ExecutionJob = z.infer<typeof ExecutionJob>;

export const HIDDEN_CASE_REPLAY_JOB = "hidden-case-replay";
export const HiddenCaseReplayJob = z.object({
  submissionId: z.string().uuid(),
  testId: z.string().uuid(),
  requestId: z.string().uuid(),
  expiresAt: z.number().int().positive(),
});
export type HiddenCaseReplayJob = z.infer<typeof HiddenCaseReplayJob>;
export const hiddenCaseReplayChannel = (requestId: string) => `replay:hidden-case:${requestId}`;

export const HiddenCaseReplayResult = z.object({
  stdout: z.string(),
  stderr: z.string(),
  verdict: Verdict,
});
export type HiddenCaseReplayResult = z.infer<typeof HiddenCaseReplayResult>;

/** Job options used by every producer (API and the worker's outbox sweeper). */
export const EXECUTION_JOB_OPTIONS = {
  attempts: 2,
  backoff: { type: "exponential" as const, delay: 500 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

/**
 * Internal room event bus (Redis pub/sub), published by the API and worker and consumed by
 * every realtime gateway instance. Carries identifiers and safe queue metadata. Gateways load results
 * and apply role views.
 */
export const roomEventsChannel = (roomId: string) => `room:${roomId}:events`;
export const ROOM_EVENTS_PATTERN = "room:*:events";

export const SubmissionQueuedEvent = z.object({
  type: z.literal("submission:queued"),
  roomId: z.string(),
  submissionId: z.string(),
  /** Which room question it answers, so clients file it under the right question before the result. */
  roomQuestionId: z.string().optional(),
  mode: SubmissionMode.optional(),
  language: Language.optional(),
  createdAt: z.string().optional(),
  roomTestRevision: z.number().int().nonnegative().optional(),
});

export const RoomBusEvent = z.discriminatedUnion("type", [
  SubmissionQueuedEvent,
  z.object({
    type: z.literal("submission:done"),
    roomId: z.string(),
    submissionId: z.string(),
    status: z.enum(["completed", "failed"]),
  }),
  z.object({ type: z.literal("room:closed"), roomId: z.string() }),
  /**
   * `revealedCount` = how many of the room's questions are revealed after this reveal. Gateways forward
   * a reveal only when the count goes up, so the fast path (this event) and the durable path (the
   * reconciler re-reading the DB) never notify a client twice for the same reveal.
   */
  z.object({ type: z.literal("room:tests_added"), roomId: z.string(), totalRevision: z.number().int().positive() }),
  z.object({ type: z.literal("room:question_revealed"), roomId: z.string(), revealedCount: z.number().int().min(1) }),
]);
export type RoomBusEvent = z.infer<typeof RoomBusEvent>;
