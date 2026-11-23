import type { Submission, TestResultRow } from "@coderoom/db";
import type { CandidateSubmissionView, InterviewerSubmissionView } from "@coderoom/shared";

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

/** Strip hidden-test detail. This is the ONLY shape candidates may receive. */
export function toCandidateView(s: Submission, results: ResultRow[]): CandidateSubmissionView {
  const hidden = results.filter((r) => r.isHidden);
  return {
    submissionId: s.id,
    roomQuestionId: s.roomQuestionId,
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
  };
}

export function toInterviewerView(s: Submission, results: ResultRow[]): InterviewerSubmissionView {
  return {
    submissionId: s.id,
    roomQuestionId: s.roomQuestionId,
    userId: s.userId,
    status: s.status,
    mode: s.mode,
    language: s.language,
    code: s.code,
    ...(s.overall ? { overall: s.overall } : {}),
    results: results.map((r) => ({ ...base(r), hidden: r.isHidden })),
    createdAt: s.createdAt.toISOString(),
  };
}
