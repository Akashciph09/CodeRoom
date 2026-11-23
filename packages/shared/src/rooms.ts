import { z } from "zod";
import { CandidateQuestionView } from "./questions.js";
import { Role } from "./roles.js";

/** Most questions one interview can hold (ADR 0009). */
export const MAX_ROOM_QUESTIONS = 5;

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
  })
  .refine((b) => !b.questionPoints || b.questionPoints.length === b.questionIds.length, {
    message: "Give points for every question, or for none",
    path: ["questionPoints"],
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

/** A room's candidate as listed for its interviewer (never sent to candidates). */
export const RoomCandidateSummary = z.object({
  name: z.string(),
  email: z.string(),
  /** Test score out of 100 (ADR 0011) — same rules as the review page. */
  score: z.number(),
  /**
   * The candidate's Submits by state (PR #11 review), so the list can tell "nothing submitted" from
   * "still grading" and "grading failed". Only `graded` ones count toward the score.
   */
  submits: z.object({
    graded: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
});
export type RoomCandidateSummary = z.infer<typeof RoomCandidateSummary>;

export const RoomSummary = z.object({
  roomId: z.string().uuid(),
  role: Role,
  status: z.enum(["open", "closed"]),
  questionTitle: z.string(),
  createdAt: z.string(),
  /** Interviewer rows only (ADR 0013). Absent on rooms where the caller is the candidate. */
  candidates: z.array(RoomCandidateSummary).optional(),
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
