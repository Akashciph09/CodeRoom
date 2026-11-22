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

export const RoomView = z.object({
  roomId: z.string().uuid(),
  status: z.enum(["open", "closed"]),
  role: Role,
  question: z.object({
    id: z.string().uuid(),
    title: z.string(),
    prompt: z.string(),
    publicTests: z.array(PublicTestCase),
  }),
});
export type RoomView = z.infer<typeof RoomView>;
