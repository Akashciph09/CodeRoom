import { z } from "zod";
import { Language } from "./languages.js";
import { TestResult, Verdict } from "./verdicts.js";

/** "run" = public tests only; "submit" = public + hidden tests. */
export const SubmissionMode = z.enum(["run", "submit"]);
export type SubmissionMode = z.infer<typeof SubmissionMode>;

export const SubmissionStatus = z.enum(["queued", "running", "completed", "failed"]);
export type SubmissionStatus = z.infer<typeof SubmissionStatus>;

/** The question is taken from the room, so the client can't submit against a different one. */
export const CreateSubmissionRequest = z.object({
  roomId: z.string().uuid(),
  language: Language,
  mode: SubmissionMode,
  code: z.string().min(1),
});
export type CreateSubmissionRequest = z.infer<typeof CreateSubmissionRequest>;

export const CreateSubmissionResponse = z.object({
  submissionId: z.string().uuid(),
  status: SubmissionStatus,
});
export type CreateSubmissionResponse = z.infer<typeof CreateSubmissionResponse>;

/** What a candidate is allowed to see about a submission. No hidden-test detail. */
export const CandidateSubmissionView = z.object({
  submissionId: z.string(),
  status: SubmissionStatus,
  mode: SubmissionMode,
  overall: Verdict.optional(),
  publicResults: z.array(TestResult),
  hiddenPassed: z.number().int().optional(),
  hiddenTotal: z.number().int().optional(),
});
export type CandidateSubmissionView = z.infer<typeof CandidateSubmissionView>;

/** Interviewer view: every test result, flagged hidden or not. */
export const InterviewerSubmissionView = z.object({
  submissionId: z.string(),
  userId: z.string(),
  status: SubmissionStatus,
  mode: SubmissionMode,
  language: Language,
  code: z.string(),
  overall: Verdict.optional(),
  results: z.array(TestResult.extend({ hidden: z.boolean() })),
  createdAt: z.string(),
});
export type InterviewerSubmissionView = z.infer<typeof InterviewerSubmissionView>;
