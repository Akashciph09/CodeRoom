import { describe, expect, it } from "vitest";
import { revealWindows, scoreCandidate, type ScoredSubmission } from "./scoring.js";

const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 10, min));
let n = 0;
const sub = (roomQuestionId: string, passed: number, total: number, over: Partial<ScoredSubmission> = {}): ScoredSubmission => ({
  id: `s${++n}`,
  roomQuestionId,
  mode: "submit",
  status: "completed",
  passed,
  total,
  createdAt: at(n),
  ...over,
});

describe("test score", () => {
  const q = (id: string, points = 1, revealed = true) => ({ id, points, revealed });

  it("scores each question by its pass rate, then combines (the example from the design: 20/30/50)", () => {
    const { score, questions } = scoreCandidate(
      [q("q1", 20), q("q2", 30), q("q3", 50)],
      [sub("q1", 10, 10), sub("q2", 6, 8)],
    );
    expect(score).toBe(42.5);
    expect(questions.map((x) => x.earned)).toEqual([20, 22.5, 0]);
  });

  it("normalizes per question, so a question with more tests doesn't weigh more", () => {
    // 20 tests all passed vs 4 tests none passed: 50, not 20/24 ≈ 83.
    expect(scoreCandidate([q("a"), q("b")], [sub("a", 20, 20), sub("b", 0, 4)]).score).toBe(50);
  });

  it("counts only Submit (hidden tests included), not Run", () => {
    const { score } = scoreCandidate([q("a")], [sub("a", 2, 2, { mode: "run" }), sub("a", 3, 8)]);
    expect(score).toBe(37.5);
    expect(scoreCandidate([q("a")], [sub("a", 2, 2, { mode: "run" })]).score).toBe(0);
  });

  it("uses the best Submit, not the last one, and ignores unfinished or failed ones", () => {
    const best = sub("a", 8, 8);
    const { score, questions } = scoreCandidate(
      [q("a")],
      [sub("a", 4, 8), best, sub("a", 5, 8), sub("a", 0, 0, { status: "failed" }), sub("a", 0, 8, { status: "running" })],
    );
    expect(score).toBe(100);
    expect(questions[0]!.best?.submissionId).toBe(best.id);
  });

  it("doesn't count unrevealed questions against the candidate", () => {
    const { score, questions } = scoreCandidate([q("a", 50), q("b", 50, false)], [sub("a", 1, 2)]);
    expect(score).toBe(50); // half of what was asked, not a quarter
    expect(questions[1]).toMatchObject({ counted: false, earned: 0 });
  });

  it("is 0 with nothing submitted or nothing revealed, never NaN", () => {
    expect(scoreCandidate([q("a"), q("b")], []).score).toBe(0);
    expect(scoreCandidate([q("a", 1, false)], [sub("a", 1, 1)]).score).toBe(0);
  });

  it("rounds once, to one decimal", () => {
    expect(scoreCandidate([q("a"), q("b"), q("c")], [sub("a", 1, 3), sub("b", 1, 3), sub("c", 1, 3)]).score).toBe(33.3);
  });
});

describe("reveal windows", () => {
  it("runs from each reveal to the next, the last one to the end; unrevealed get none", () => {
    const times = revealWindows(
      [
        { id: "q1", revealedAt: at(0) },
        { id: "q2", revealedAt: at(15) },
        { id: "q3", revealedAt: null },
      ],
      at(40),
    );
    expect(times.get("q1")).toBe(15 * 60_000);
    expect(times.get("q2")).toBe(25 * 60_000);
    expect(times.has("q3")).toBe(false);
  });
});
