import type { CustomCaseResultRow, Submission, TestResultRow } from "@coderoom/db";
import type { CandidateSubmissionView, CustomCaseResult, InterviewerSubmissionView } from "@coderoom/shared";

type ResultRow = Pick<
  TestResultRow,
  "testCaseId" | "isHidden" | "verdict" | "timeMs" | "memoryKb" | "stdout" | "stderr"
>;

const base = (r: ResultRow) => ({
  testId: r.testCaseId,
  verdict: r.verdict,
  timeMs: r.timeMs,
  ...(r.memoryKb != null ? { memoryKb: r.memoryKb } : {}),
  ...(r.stdout != null ? { stdout: r.stdout } : {}),
  ...(r.stderr != null ? { stderr: r.stderr } : {}),
});

type CustomRow = Pick<CustomCaseResultRow, "position" | "verdict" | "timeMs" | "stdout" | "stderr">;

/**
 * Custom cases (ADR 0010) were written by the participants themselves, so both roles see them in full.
 * Inputs come from the submission row (what was actually run), results from the worker.
 */
export function customResultsOf(s: Submission, rows: CustomRow[]): CustomCaseResult[] {
  const cases = s.customCases ?? [];
  return rows
    .filter((r) => r.position < cases.length)
    .sort((a, b) => a.position - b.position)
    .map((r) => {
      const c = cases[r.position]!;
      return {
        position: r.position,
        input: c.input,
        ...(c.expectedOutput !== undefined ? { expectedOutput: c.expectedOutput } : {}),
        verdict: r.verdict,
        timeMs: r.timeMs,
        ...(r.stdout != null ? { stdout: r.stdout } : {}),
        ...(r.stderr != null ? { stderr: r.stderr } : {}),
      };
    });
}

/** Strip hidden-test detail. This is the ONLY shape candidates may receive. */
export function toCandidateView(s: Submission, results: ResultRow[], custom: CustomRow[] = []): CandidateSubmissionView {
  const hidden = results.filter((r) => r.isHidden);
  return {
    submissionId: s.id,
    roomQuestionId: s.roomQuestionId,
    roomTestRevision: s.roomTestRevision,
    status: s.status,
    mode: s.mode,
    ...(s.overall ? { overall: s.overall } : {}),
    publicResults: results.filter((r) => !r.isHidden).map(base),
    ...(s.mode === "submit" && s.status === "completed"
      ? {
          hiddenPassed: hidden.filter((r) => r.verdict === "accepted").length,
          hiddenTotal: hidden.length,
        }
      : {}),
    customResults: customResultsOf(s, custom),
  };
}

export function toInterviewerView(s: Submission, results: ResultRow[], custom: CustomRow[] = []): InterviewerSubmissionView {
  return {
    submissionId: s.id,
    roomQuestionId: s.roomQuestionId,
    roomTestRevision: s.roomTestRevision,
    userId: s.userId,
    status: s.status,
    mode: s.mode,
    language: s.language,
    code: s.code,
    ...(s.overall ? { overall: s.overall } : {}),
    results: results.map((r) => ({ ...base(r), hidden: r.isHidden })),
    customResults: customResultsOf(s, custom),
    createdAt: s.createdAt.toISOString(),
  };
}
