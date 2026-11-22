import { z } from "zod";
import { CandidateSubmissionView, InterviewerSubmissionView } from "./submissions.js";

/**
 * Realtime endpoints (both on the API's HTTP server):
 *   ws://<api>/yjs/<roomId>           — Yjs sync + awareness (y-websocket protocol)
 *   ws://<api>/rooms/<roomId>/events  — server → client JSON ServerEvents
 *
 * Auth: send the Supabase access token as a WebSocket subprotocol, never in the URL:
 *   new WebSocket(url, [REALTIME_PROTOCOL, accessToken])
 */
export const REALTIME_PROTOCOL = "coderoom.v1";

/** Close codes (4000–4999 are application-defined). */
export const CloseCode = {
  Unauthorized: 4401,
  Forbidden: 4403,
  RoomClosed: 4410,
} as const;

export const ServerEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), roomId: z.string() }),
  z.object({ type: z.literal("submission:queued"), roomId: z.string(), submissionId: z.string() }),
  z.object({
    type: z.literal("submission:result"),
    roomId: z.string(),
    /** Shape depends on the receiving participant's role in the room. */
    result: z.union([InterviewerSubmissionView, CandidateSubmissionView]),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;
