import { z } from "zod";
import { Role } from "./roles.js";
import { CandidateSubmissionView } from "./submissions.js";

/** Room/control events over WebSocket. Editor text sync is handled by Yjs, not these. */
export const ClientEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("room:join"), roomId: z.string(), token: z.string() }),
  z.object({ type: z.literal("room:leave"), roomId: z.string() }),
]);
export type ClientEvent = z.infer<typeof ClientEvent>;

export const ServerEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("room:presence"),
    roomId: z.string(),
    participants: z.array(z.object({ userId: z.string(), role: Role })),
  }),
  z.object({
    type: z.literal("submission:queued"),
    roomId: z.string(),
    submissionId: z.string(),
  }),
  z.object({
    type: z.literal("submission:result"),
    roomId: z.string(),
    result: CandidateSubmissionView,
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;
