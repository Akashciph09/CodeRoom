import { z } from "zod";
import { Role } from "./roles.js";

export const CreateRoomRequest = z.object({
  questionId: z.string().uuid(),
});
export type CreateRoomRequest = z.infer<typeof CreateRoomRequest>;

export const CreateRoomResponse = z.object({
  roomId: z.string().uuid(),
  inviteCode: z.string(),
});
export type CreateRoomResponse = z.infer<typeof CreateRoomResponse>;

export const JoinRoomRequest = z.object({
  inviteCode: z.string().min(8).max(64),
});
export type JoinRoomRequest = z.infer<typeof JoinRoomRequest>;

export const JoinRoomResponse = z.object({
  roomId: z.string().uuid(),
  role: Role,
});
export type JoinRoomResponse = z.infer<typeof JoinRoomResponse>;

export const PublicTestCase = z.object({
  id: z.string(),
  input: z.string(),
  expectedOutput: z.string(),
});

export const QuestionSummary = z.object({
  id: z.string().uuid(),
  title: z.string(),
});
export type QuestionSummary = z.infer<typeof QuestionSummary>;

export const RoomSummary = z.object({
  roomId: z.string().uuid(),
  role: Role,
  status: z.enum(["open", "closed"]),
  questionTitle: z.string(),
  createdAt: z.string(),
});
export type RoomSummary = z.infer<typeof RoomSummary>;

export const RoomView = z.object({
  roomId: z.string().uuid(),
  status: z.enum(["open", "closed"]),
  role: Role,
  /** Only returned to the interviewer, so they can share it. */
  inviteCode: z.string().optional(),
  question: z.object({
    id: z.string().uuid(),
    title: z.string(),
    prompt: z.string(),
    publicTests: z.array(PublicTestCase),
  }),
});
export type RoomView = z.infer<typeof RoomView>;
