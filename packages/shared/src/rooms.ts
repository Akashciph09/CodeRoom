import { z } from "zod";
import { CandidateQuestionView } from "./questions.js";
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

/** A question the caller can open a room with: their own ready questions plus shared library ones. */
export const QuestionSummary = z.object({
  id: z.string().uuid(),
  title: z.string(),
  version: z.number().int(),
  owned: z.boolean(),
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
  /** The pinned version the room was created with — later edits to the question don't change it. */
  question: CandidateQuestionView,
});
export type RoomView = z.infer<typeof RoomView>;
