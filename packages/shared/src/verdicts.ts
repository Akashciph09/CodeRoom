import { z } from "zod";

export const Verdict = z.enum([
  "accepted",
  "wrong_answer",
  "time_limit_exceeded",
  "memory_limit_exceeded",
  "runtime_error",
  "compile_error",
  "internal_error",
]);
export type Verdict = z.infer<typeof Verdict>;

export const TestResult = z.object({
  testId: z.string(),
  verdict: Verdict,
  timeMs: z.number().nonnegative(),
  memoryKb: z.number().nonnegative().optional(),
  /** Only populated for public tests. Never for hidden tests. */
  stdout: z.string().optional(),
  stderr: z.string().optional(),
});
export type TestResult = z.infer<typeof TestResult>;
