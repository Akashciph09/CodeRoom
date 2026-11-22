import { describe, expect, it } from "vitest";
import type { Submission } from "@coderoom/db";
import { toCandidateView, toInterviewerView } from "./views.js";

const submission: Submission = {
  id: "sub-1",
  roomId: "room-1",
  questionVersionId: "qv-1",
  userId: "user-1",
  language: "python",
  mode: "submit",
  code: "print(1)",
  status: "completed",
  overall: "wrong_answer",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const results = [
  { testCaseId: "p1", isHidden: false, verdict: "accepted" as const, timeMs: 5, memoryKb: null, stdout: "3", stderr: "" },
  { testCaseId: "h1", isHidden: true, verdict: "accepted" as const, timeMs: 5, memoryKb: null, stdout: null, stderr: null },
  { testCaseId: "h2", isHidden: true, verdict: "wrong_answer" as const, timeMs: 7, memoryKb: null, stdout: null, stderr: null },
];

describe("toCandidateView", () => {
  const view = toCandidateView(submission, results);

  it("never includes hidden test ids", () => {
    const json = JSON.stringify(view);
    expect(json).not.toContain("h1");
    expect(json).not.toContain("h2");
  });

  it("returns public results and hidden pass counts", () => {
    expect(view.publicResults.map((r) => r.testId)).toEqual(["p1"]);
    expect(view.hiddenPassed).toBe(1);
    expect(view.hiddenTotal).toBe(2);
  });

  it("omits hidden counts for run mode", () => {
    const run = toCandidateView({ ...submission, mode: "run" }, results.slice(0, 1));
    expect(run.hiddenTotal).toBeUndefined();
  });
});

describe("toInterviewerView", () => {
  it("includes every result with its hidden flag", () => {
    const view = toInterviewerView(submission, results);
    expect(view.results.map((r) => [r.testId, r.hidden])).toEqual([
      ["p1", false],
      ["h1", true],
      ["h2", true],
    ]);
    expect(view.code).toBe("print(1)");
  });
});
