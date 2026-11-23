import { describe, expect, it } from "vitest";
import type { CandidateSubmissionView } from "@coderoom/shared";
import { mergeHistory, questionOf, upsertEntry, type SubmissionEntry } from "./submissions";

const view = (id: string, status: CandidateSubmissionView["status"]): CandidateSubmissionView => ({
  submissionId: id,
  roomQuestionId: "rq-1",
  customResults: [],
  status,
  mode: "run",
  publicResults: [],
  ...(status === "completed" ? { overall: "accepted" as const } : {}),
});
const entry = (id: string, status: CandidateSubmissionView["status"]): SubmissionEntry => ({
  submissionId: id,
  pending: false,
  view: view(id, status),
});
const statusOf = (list: SubmissionEntry[], id: string) => {
  const e = list.find((x) => x.submissionId === id)!;
  return e.pending ? "pending" : e.view.status;
};

describe("mergeHistory", () => {
  it("does not roll a completed result back to an older queued snapshot", () => {
    // Result event arrived while the history request (started earlier) was in flight.
    const current = [entry("a", "completed")];
    const staleHistory = [view("a", "queued")];
    expect(statusOf(mergeHistory(current, staleHistory), "a")).toBe("completed");
  });

  it("takes newer server state over older local state", () => {
    const current: SubmissionEntry[] = [{ submissionId: "a", pending: true }, entry("b", "running")];
    const merged = mergeHistory(current, [view("a", "queued"), view("b", "completed")]);
    expect(statusOf(merged, "a")).toBe("queued");
    expect(statusOf(merged, "b")).toBe("completed");
  });

  it("keeps local placeholders the server doesn't know about yet, on top", () => {
    const current: SubmissionEntry[] = [{ submissionId: "new", pending: true }];
    const merged = mergeHistory(current, [view("old", "completed")]);
    expect(merged.map((e) => e.submissionId)).toEqual(["new", "old"]);
  });
});

describe("upsertEntry", () => {
  it("ignores a late 'queued' after the result", () => {
    const list = upsertEntry([entry("a", "completed")], { submissionId: "a", pending: true });
    expect(statusOf(list, "a")).toBe("completed");
  });

  it("files a run under its question from submit until the result, without losing it in between", () => {
    // Our own submit knows the question; a queued event arriving later (e.g. from an older API) may not.
    let list = upsertEntry([], { submissionId: "a", pending: true, roomQuestionId: "rq-2" });
    list = upsertEntry(list, { submissionId: "a", pending: true });
    expect(questionOf(list[0]!)).toBe("rq-2");
    list = upsertEntry(list, { submissionId: "a", pending: false, view: { ...view("a", "completed"), roomQuestionId: "rq-2" } });
    expect(questionOf(list[0]!)).toBe("rq-2");
  });

  it("adds unknown submissions on top", () => {
    const list = upsertEntry([entry("a", "completed")], entry("b", "queued"));
    expect(list.map((e) => e.submissionId)).toEqual(["b", "a"]);
  });
});
