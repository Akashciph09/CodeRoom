import { z } from "zod";
import { QuestionDraftInput } from "./questions.js";
import { Verdict } from "./verdicts.js";

export const GenerateQuestionRequest = z.object({
  brief: z.string().trim().min(5).max(3000),
}).strict();

export const QUESTION_VALIDATION_JOB = "validate-question-draft";
export const MAX_GENERATED_TESTS = 8;

const boundedText = (max: number) => z.string().max(max).refine((s) => !s.includes("\0"));
const GeneratedTest = z.object({
  input: boundedText(4096),
  expectedOutput: boundedText(4096).refine((s) => Boolean(s.trim())),
  isHidden: z.boolean(),
}).strict();

const ReferenceSolution = boundedText(12_000).refine((s) => Boolean(s.trim()));

export const GeneratedQuestion = QuestionDraftInput.omit({ baseRevision: true }).extend({
  title: z.string().trim().min(1).max(200).refine((s) => !s.includes("\0")),
  statement: boundedText(8000).refine((s) => Boolean(s.trim())),
  constraints: boundedText(3000).refine((s) => Boolean(s.trim())),
  starterCode: z.object({
    python: boundedText(4000).refine((s) => Boolean(s.trim())),
    javascript: boundedText(4000).refine((s) => Boolean(s.trim())),
  }).strict(),
  referencePython: ReferenceSolution,
  tests: z.array(GeneratedTest).min(2).max(MAX_GENERATED_TESTS),
}).strict().refine(({ tests }) => tests.some((t) => t.isHidden) && tests.some((t) => !t.isHidden));
export type GeneratedQuestion = z.infer<typeof GeneratedQuestion>;

export const QuestionValidationJob = z.object({
  referencePython: ReferenceSolution,
  tests: z.array(GeneratedTest).min(1).max(MAX_GENERATED_TESTS),
  expiresAt: z.number().int().positive(),
}).strict();
export type QuestionValidationJob = z.infer<typeof QuestionValidationJob>;

export const QuestionValidationResult = z.array(Verdict).min(1).max(MAX_GENERATED_TESTS);
