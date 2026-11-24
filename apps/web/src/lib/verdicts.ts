import type { Verdict } from "@coderoom/shared";

export const VERDICT_LABEL: Record<Verdict, string> = {
  accepted: "Accepted",
  wrong_answer: "Wrong answer",
  time_limit_exceeded: "Time limit exceeded",
  memory_limit_exceeded: "Memory limit exceeded",
  runtime_error: "Runtime error",
  compile_error: "Compile error",
  internal_error: "Internal error",
};
