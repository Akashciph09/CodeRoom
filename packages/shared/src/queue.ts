import { z } from "zod";

export const EXECUTION_QUEUE = "execution";

/** Job payload carries ONLY the submission id; the worker loads everything else. */
export const ExecutionJob = z.object({
  submissionId: z.string().min(1),
});
export type ExecutionJob = z.infer<typeof ExecutionJob>;

/**
 * Internal room event bus (Redis pub/sub), published by the API and worker and consumed by
 * every realtime gateway instance. Carries ids only — gateways load data and apply role views.
 */
export const roomEventsChannel = (roomId: string) => `room:${roomId}:events`;
export const ROOM_EVENTS_PATTERN = "room:*:events";

export const RoomBusEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("submission:queued"), roomId: z.string(), submissionId: z.string() }),
  z.object({
    type: z.literal("submission:done"),
    roomId: z.string(),
    submissionId: z.string(),
    status: z.enum(["completed", "failed"]),
  }),
]);
export type RoomBusEvent = z.infer<typeof RoomBusEvent>;
