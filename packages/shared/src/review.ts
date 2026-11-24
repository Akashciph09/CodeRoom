import { z } from "zod";
import { Language } from "./languages.js";
import { SubmissionMode, SubmissionStatus } from "./submissions.js";
import { Verdict } from "./verdicts.js";

/**
 * Interviewer-only post-interview review (ADR 0011). The test score is evidence for the human
 * evaluation, never a decision: correctness on Submit only, per question, best attempt, revealed
 * questions only, weighted by `points`.
 */

export const ReviewQuestion = z.object({
  id: z.string().uuid(),
  position: z.number().int(),
  title: z.string(),
  version: z.number().int().nullable(),
  points: z.number().int(),
  revealedAt: z.string().optional(),
  /**
   * Reveal window: from this question's reveal to the next reveal, or to the end (or now, while live).
   * NOT the candidate's time on it — participants can revisit questions, and Q1 is revealed at room
   * creation, possibly long before anyone joined.
   */
  revealWindowMs: z.number().int().nonnegative().optional(),
});
export type ReviewQuestion = z.infer<typeof ReviewQuestion>;

export const QuestionScore = z.object({
  roomQuestionId: z.string().uuid(),
  points: z.number().int(),
  /** False for unrevealed questions: they don't count against the candidate. */
  counted: z.boolean(),
  /** Contribution to the score out of 100. */
  earned: z.number(),
  best: z.object({ submissionId: z.string(), passed: z.number().int(), total: z.number().int() }).optional(),
});
export type QuestionScore = z.infer<typeof QuestionScore>;

export const ReviewSubmission = z.object({
  submissionId: z.string(),
  roomQuestionId: z.string(),
  mode: SubmissionMode,
  status: SubmissionStatus,
  overall: Verdict.optional(),
  language: Language,
  code: z.string(),
  createdAt: z.string(),
  /** Tests passed / run (hidden included for Submit). */
  passed: z.number().int(),
  total: z.number().int(),
  hiddenPassed: z.number().int(),
  hiddenTotal: z.number().int(),
  customCases: z.number().int(),
});
export type ReviewSubmission = z.infer<typeof ReviewSubmission>;

export const ReviewCandidate = z.object({
  userId: z.string(),
  name: z.string(),
  /** Out of 100, one decimal. */
  score: z.number(),
  questions: z.array(QuestionScore),
  /** Oldest first. */
  submissions: z.array(ReviewSubmission),
});
export type ReviewCandidate = z.infer<typeof ReviewCandidate>;

export const RoomReview = z.object({
  roomId: z.string().uuid(),
  /** The room's name, when set (ADR 0014). */
  name: z.string().optional(),
  status: z.enum(["open", "closed"]),
  createdAt: z.string(),
  closedAt: z.string().optional(),
  serverTime: z.string(),
  questions: z.array(ReviewQuestion),
  candidates: z.array(ReviewCandidate),
});
export type RoomReview = z.infer<typeof RoomReview>;
