import { z } from "zod";
import { Language } from "./languages.js";
import { TestResult, Verdict } from "./verdicts.js";

/** Limits for participant-written cases sent with a Run (ADR 0010). */
export const MAX_CUSTOM_CASES = 10;
export const MAX_CUSTOM_CASE_BYTES = 10_000;
/** UTF-8 byte length (this package runs in both Node and the browser, without either's encoder types). */
export function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}
const withinBytes = (s: string) => utf8Length(s) <= MAX_CUSTOM_CASE_BYTES;

/** A custom case: stdin, and optionally the output to compare against. */
export const CustomCase = z.object({
  input: z.string().refine(withinBytes, `Custom case input is limited to ${MAX_CUSTOM_CASE_BYTES} bytes`),
  expectedOutput: z
    .string()
    .refine(withinBytes, `Custom case expected output is limited to ${MAX_CUSTOM_CASE_BYTES} bytes`)
    .optional(),
});
export type CustomCase = z.infer<typeof CustomCase>;

/** Result of one custom case. Without `expectedOutput`, `verdict` only says whether the code ran cleanly. */
export const CustomCaseResult = z.object({
  position: z.number().int().min(0),
  input: z.string(),
  expectedOutput: z.string().optional(),
  verdict: Verdict,
  timeMs: z.number().nonnegative(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
});
export type CustomCaseResult = z.infer<typeof CustomCaseResult>;

/** "run" = public tests only; "submit" = public + hidden tests. */
export const SubmissionMode = z.enum(["run", "submit"]);
export type SubmissionMode = z.infer<typeof SubmissionMode>;

export const SubmissionStatus = z.enum(["queued", "running", "completed", "failed"]);
export type SubmissionStatus = z.infer<typeof SubmissionStatus>;

/**
 * `roomQuestionId` names one of the room's revealed questions; the graded version is taken from it on
 * the server, so the client can't submit against a different version.
 */
export const CreateSubmissionRequest = z
  .object({
    roomId: z.string().uuid(),
    roomQuestionId: z.string().uuid(),
    language: Language,
    mode: SubmissionMode,
    code: z.string().min(1),
    /** Run only: extra participant-written cases (ADR 0010). Never used for grading. */
    customCases: z.array(CustomCase).max(MAX_CUSTOM_CASES, `At most ${MAX_CUSTOM_CASES} custom cases per run`).optional(),
  })
  .refine((b) => b.mode === "run" || !b.customCases?.length, {
    message: "Custom cases can only be sent with Run — Submit is graded on the question's tests",
    path: ["customCases"],
  });
export type CreateSubmissionRequest = z.infer<typeof CreateSubmissionRequest>;

export const CreateSubmissionResponse = z.object({
  submissionId: z.string().uuid(),
  status: SubmissionStatus,
});
export type CreateSubmissionResponse = z.infer<typeof CreateSubmissionResponse>;

/** What a candidate is allowed to see about a submission. No hidden-test detail. */
export const CandidateSubmissionView = z.object({
  roomTestRevision: z.number().int().nonnegative().optional(),
  submissionId: z.string(),
  roomQuestionId: z.string(),
  status: SubmissionStatus,
  mode: SubmissionMode,
  overall: Verdict.optional(),
  publicResults: z.array(TestResult),
  hiddenPassed: z.number().int().optional(),
  hiddenTotal: z.number().int().optional(),
  customResults: z.array(CustomCaseResult),
});
export type CandidateSubmissionView = z.infer<typeof CandidateSubmissionView>;

/** Interviewer view: every test result, flagged hidden or not. */
export const InterviewerSubmissionView = z.object({
  roomTestRevision: z.number().int().nonnegative().optional(),
  submissionId: z.string(),
  roomQuestionId: z.string(),
  userId: z.string(),
  status: SubmissionStatus,
  mode: SubmissionMode,
  language: Language,
  code: z.string(),
  overall: Verdict.optional(),
  results: z.array(TestResult.extend({ hidden: z.boolean() })),
  customResults: z.array(CustomCaseResult),
  createdAt: z.string(),
});
export type InterviewerSubmissionView = z.infer<typeof InterviewerSubmissionView>;
