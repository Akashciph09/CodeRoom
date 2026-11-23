import type { QuestionScore, SubmissionMode, SubmissionStatus } from "@coderoom/shared";

/**
 * The test score (ADR 0011): evidence for the human evaluation, never a decision.
 *  - per question, then combined (a question with many tests doesn't outweigh one with few);
 *  - Submit only, hidden tests included (Run can be gamed with the visible examples);
 *  - best Submit per question (a late regression doesn't remove credit);
 *  - only revealed questions count (the interviewer's pacing isn't the candidate's fault);
 *  - weighted by each question's `points`, normalized to 100.
 */

export interface ScoredQuestion {
  id: string;
  points: number;
  revealed: boolean;
}

export interface ScoredSubmission {
  id: string;
  roomQuestionId: string;
  mode: SubmissionMode;
  status: SubmissionStatus;
  /** Tests passed / run, hidden included. */
  passed: number;
  total: number;
  createdAt: Date;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function scoreCandidate(
  questions: ScoredQuestion[],
  submissions: ScoredSubmission[],
): { score: number; questions: QuestionScore[] } {
  const countedPoints = questions.filter((q) => q.revealed).reduce((sum, q) => sum + q.points, 0);
  let total = 0;
  const perQuestion = questions.map((q): QuestionScore => {
    const graded = submissions
      .filter((s) => s.roomQuestionId === q.id && s.mode === "submit" && s.status === "completed" && s.total > 0)
      // Best fraction first; on a tie, the earliest (when it was first achieved).
      .sort((a, b) => b.passed / b.total - a.passed / a.total || a.createdAt.getTime() - b.createdAt.getTime());
    const best = graded[0];
    const earned =
      q.revealed && best && countedPoints > 0 ? (100 * q.points * (best.passed / best.total)) / countedPoints : 0;
    total += earned;
    return {
      roomQuestionId: q.id,
      points: q.points,
      counted: q.revealed,
      earned: round1(earned),
      ...(best ? { best: { submissionId: best.id, passed: best.passed, total: best.total } } : {}),
    };
  });
  // Sum unrounded contributions and round once, so the total doesn't drift from per-question rounding.
  return { score: round1(total), questions: perQuestion };
}

/**
 * Reveal window per question: from its reveal to the next reveal (in reveal order), or to `end` for
 * the last one. Unrevealed questions get none. It's when the question was the newest one on screen,
 * not measured candidate effort (they can go back to earlier questions; Q1 starts at room creation).
 */
export function revealWindows(questions: { id: string; revealedAt: Date | null }[], end: Date): Map<string, number> {
  const revealed = questions
    .filter((q): q is { id: string; revealedAt: Date } => q.revealedAt !== null)
    .sort((a, b) => a.revealedAt.getTime() - b.revealedAt.getTime());
  const out = new Map<string, number>();
  revealed.forEach((q, i) => {
    const until = revealed[i + 1]?.revealedAt ?? end;
    out.set(q.id, Math.max(0, until.getTime() - q.revealedAt.getTime()));
  });
  return out;
}
