import type { Verdict } from "@coderoom/shared";
import type { RunOutput } from "./runner.js";

const normalize = (s: string) => s.replace(/\r\n/g, "\n").trimEnd();

export function judge(run: RunOutput, expectedOutput: string): Verdict {
  if (run.timedOut) return "time_limit_exceeded";
  if (run.oomKilled) return "memory_limit_exceeded";
  if (run.exitCode !== 0) return "runtime_error";
  return normalize(run.stdout) === normalize(expectedOutput) ? "accepted" : "wrong_answer";
}

/**
 * A participant-written custom case (ADR 0010). With an expected output it's judged like a test;
 * without one, "accepted" only means the code ran cleanly — the output is shown, not compared.
 */
export function judgeCustom(run: RunOutput, expectedOutput: string | undefined): Verdict {
  if (expectedOutput !== undefined) return judge(run, expectedOutput);
  if (run.timedOut) return "time_limit_exceeded";
  if (run.oomKilled) return "memory_limit_exceeded";
  return run.exitCode === 0 ? "accepted" : "runtime_error";
}

/** Overall verdict = first non-accepted verdict, else accepted. */
export function overallVerdict(verdicts: Verdict[]): Verdict {
  return verdicts.find((v) => v !== "accepted") ?? "accepted";
}
