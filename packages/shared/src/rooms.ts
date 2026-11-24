import { z } from "zod";
import { CandidateQuestionView } from "./questions.js";
import { Role } from "./roles.js";

/** Most questions one interview can hold (ADR 0009). */
export const MAX_ROOM_QUESTIONS = 5;

/** Longest room name (ADR 0014). */
export const MAX_ROOM_NAME = 80;

/**
 * A room name as typed: trimmed; empty means "no name" (null); at most MAX_ROOM_NAME characters.
 * The database enforces the same rule.
 */
export const RoomName = z
  .string()
  .max(1000)
  .transform((s) => s.trim())
  .pipe(z.string().max(MAX_ROOM_NAME, `Room names can be at most ${MAX_ROOM_NAME} characters`))
  .transform((s) => (s === "" ? null : s));

/** Rename (or clear, with null or "") a room — interviewer only. */
export const RenameRoomRequest = z.object({ name: z.union([RoomName, z.null()]) });
export type RenameRoomRequest = z.input<typeof RenameRoomRequest>;

/** The room's questions, in order. Each is pinned to its latest ready version at creation. */
export const CreateRoomRequest = z
  .object({
    questionIds: z
      .array(z.string().uuid())
      .min(1, "Pick at least one question")
      .max(MAX_ROOM_QUESTIONS, `At most ${MAX_ROOM_QUESTIONS} questions per room`)
      .refine((ids) => new Set(ids).size === ids.length, "Each question can only be used once per room"),
    /** Optional weight per question for the test score (ADR 0011), same order as `questionIds`. Default: equal. */
    questionPoints: z.array(z.number().int().min(1).max(100)).optional(),
    /** Optional label, e.g. "Backend interview" (ADR 0014). Interviewer-only. */
    name: RoomName.optional(),
  })
  .refine((b) => !b.questionPoints || b.questionPoints.length === b.questionIds.length, {
    message: "Give points for every question, or for none",
    path: ["questionPoints"],
  });
export type CreateRoomRequest = z.input<typeof CreateRoomRequest>;

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

/** A room's candidate as listed for its interviewer (never sent to candidates). */
export const RoomCandidate = z.object({
  name: z.string(),
  email: z.string(),
});
export type RoomCandidate = z.infer<typeof RoomCandidate>;

export const RoomSummary = z.object({
  roomId: z.string().uuid(),
  role: Role,
  status: z.enum(["open", "closed"]),
  questionTitle: z.string(),
  createdAt: z.string(),
  /** The room's name (ADR 0014) — interviewer rows only, when set. */
  name: z.string().optional(),
  /**
   * Interviewer rows only (ADR 0013), in join order. Absent on rooms where the caller is the candidate.
   * More than one only for rooms from before ADR 0012.
   */
  candidates: z.array(RoomCandidate).optional(),
});
export type RoomSummary = z.infer<typeof RoomSummary>;

/** One of a room's questions: the pinned version, as a candidate sees it (public tests only). */
export const RoomQuestionView = z.object({
  /** `room_questions.id` — what a submission names. */
  id: z.string().uuid(),
  /** 1-based order; also the key of the question's code buffer in the shared doc. */
  position: z.number().int().min(1),
  revealed: z.boolean(),
  question: CandidateQuestionView,
});
export type RoomQuestionView = z.infer<typeof RoomQuestionView>;

export const RoomView = z.object({
  roomId: z.string().uuid(),
  status: z.enum(["open", "closed"]),
  role: Role,
  /** Only returned to the interviewer, so they can share it. */
  inviteCode: z.string().optional(),
  /** The room's name (ADR 0014) — only returned to the interviewer, when set. */
  name: z.string().optional(),
  /**
   * In order. The interviewer gets every question (with `revealed`); the candidate gets only the
   * revealed ones — unrevealed questions are never sent to the candidate, not even their count.
   */
  questions: z.array(RoomQuestionView),
  /** For the interviewer's timer (ADR 0010): when the room was created / ended, and the server's clock now. */
  createdAt: z.string(),
  closedAt: z.string().optional(),
  serverTime: z.string(),
});
export type RoomView = z.infer<typeof RoomView>;
