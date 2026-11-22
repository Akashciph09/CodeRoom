import type { Verdict } from "@coderoom/shared";
import type { RunOutput } from "./runner.js";

const normalize = (s: string) => s.replace(/\r\n/g, "\n").trimEnd();

export function judge(run: RunOutput, expectedOutput: string): Verdict {
  if (run.timedOut) return "time_limit_exceeded";
  if (run.oomKilled) return "memory_limit_exceeded";
  if (run.exitCode !== 0) return "runtime_error";
  return normalize(run.stdout) === normalize(expectedOutput) ? "accepted" : "wrong_answer";
}

/** Overall verdict = first non-accepted verdict, else accepted. */
export function overallVerdict(verdicts: Verdict[]): Verdict {
  return verdicts.find((v) => v !== "accepted") ?? "accepted";
}
