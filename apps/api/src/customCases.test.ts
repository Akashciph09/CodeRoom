import { describe, expect, it } from "vitest";
import type { Submission } from "@coderoom/db";
import { CreateSubmissionRequest, MAX_CUSTOM_CASE_BYTES, utf8Length } from "@coderoom/shared";
import { customResultsOf, toCandidateView } from "./views.js";

const body = {
  roomId: "00000000-0000-4000-8000-000000000001",
  roomQuestionId: "00000000-0000-4000-8000-000000000002",
  language: "python",
  code: "print(1)",
};

describe("custom cases in a submission request (ADR 0010)", () => {
  it("are accepted with Run, within the limits", () => {
    expect(CreateSubmissionRequest.safeParse({ ...body, mode: "run", customCases: [{ input: "1 2" }, { input: "3", expectedOutput: "3" }] }).success).toBe(true);
  });
  it("are refused with Submit — grading only uses the question's tests", () => {
    expect(CreateSubmissionRequest.safeParse({ ...body, mode: "submit", customCases: [{ input: "1" }] }).success).toBe(false);
    expect(CreateSubmissionRequest.safeParse({ ...body, mode: "submit", customCases: [] }).success).toBe(true);
  });
  it("are limited in number and size (measured in UTF-8 bytes)", () => {
    const many = Array.from({ length: 11 }, () => ({ input: "1" }));
    expect(CreateSubmissionRequest.safeParse({ ...body, mode: "run", customCases: many }).success).toBe(false);
    const big = "x".repeat(MAX_CUSTOM_CASE_BYTES + 1);
    expect(CreateSubmissionRequest.safeParse({ ...body, mode: "run", customCases: [{ input: big }] }).success).toBe(false);
    expect(CreateSubmissionRequest.safeParse({ ...body, mode: "run", customCases: [{ input: "1", expectedOutput: big }] }).success).toBe(false);
    expect(utf8Length("é€😀")).toBe(2 + 3 + 4);
  });
});

describe("custom results in submission views", () => {
  const submission = {
    id: "s1",
    roomId: "r1",
    roomQuestionId: "rq1",
    questionVersionId: "qv1",
    userId: "u1",
    language: "python",
    mode: "run",
    code: "print(1)",
    status: "completed",
    overall: "accepted",
    idempotencyKey: null,
    customCases: [{ input: "1 2" }, { input: "5 5", expectedOutput: "10" }],
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Submission;
  const rows = [
    { position: 1, verdict: "wrong_answer" as const, timeMs: 3, stdout: "9", stderr: "" },
    { position: 0, verdict: "accepted" as const, timeMs: 2, stdout: "3", stderr: "" },
  ];

  it("pair each result with the input that was run, in order", () => {
    expect(customResultsOf(submission, rows)).toEqual([
      { position: 0, input: "1 2", verdict: "accepted", timeMs: 2, stdout: "3", stderr: "" },
      { position: 1, input: "5 5", expectedOutput: "10", verdict: "wrong_answer", timeMs: 3, stdout: "9", stderr: "" },
    ]);
  });
  it("are visible to the candidate too (they were written by participants)", () => {
    expect(toCandidateView(submission, [], rows).customResults).toHaveLength(2);
  });
});
