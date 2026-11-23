import { describe, expect, it } from "vitest";
import type { RoomQuestionView, RoomView } from "@coderoom/shared";
import {
  addCaseRefusal,
  casesToRun,
  codeKey,
  initialLanguage,
  latestRevealed,
  mergeRoom,
  metaKey,
  nextToReveal,
  parseSharedCases,
} from "./roomQuestions";

const question = (title: string, starterCode: RoomQuestionView["question"]["starterCode"] = {}) => ({
  id: "00000000-0000-4000-8000-0000000000ff",
  versionId: "00000000-0000-4000-8000-0000000000fe",
  version: 1,
  title,
  statement: "",
  constraints: "",
  starterCode,
  publicTests: [],
  hiddenTestCount: 0,
});
const rq = (position: number, revealed: boolean): RoomQuestionView => ({
  id: `00000000-0000-4000-8000-00000000000${position}`,
  position,
  revealed,
  question: question(`Q${position}`),
});
const room = (questions: RoomQuestionView[], status: RoomView["status"] = "open"): RoomView => ({
  roomId: "00000000-0000-4000-8000-0000000000aa",
  status,
  role: "interviewer",
  questions,
  createdAt: "2026-01-01T00:00:00.000Z",
  serverTime: "2026-01-01T00:00:00.000Z",
});

describe("room questions", () => {
  it("keeps the original doc names for question 1 so older rooms keep their code", () => {
    expect(codeKey(1)).toBe("code");
    expect(metaKey("language", 1)).toBe("language");
    expect(metaKey("initialized", 1)).toBe("initialized");
    expect(codeKey(3)).toBe("code:3");
    expect(metaKey("language", 2)).toBe("language:2");
    expect(new Set([1, 2, 3, 4, 5].map(codeKey)).size).toBe(5);
  });

  it("finds the latest revealed and the next revealable question", () => {
    const r = room([rq(1, true), rq(2, true), rq(3, false), rq(4, false)]);
    expect(latestRevealed(r)?.position).toBe(2);
    expect(nextToReveal(r)?.position).toBe(3);
    expect(nextToReveal(room([rq(1, true)]))).toBeUndefined();
  });

  it("starts in the language the author wrote starter code for", () => {
    expect(initialLanguage(question("a", { javascript: "x" }))).toBe("javascript");
    expect(initialLanguage(question("b", { python: "x", javascript: "y" }))).toBe("python");
    expect(initialLanguage(question("c"))).toBe("python");
  });

  it("only moves forward: a stale fetch can't un-reveal a question or reopen an ended room", () => {
    const current = room([rq(1, true), rq(2, true), rq(3, false)], "closed");
    const stale = room([rq(1, true), rq(2, false), rq(3, false)], "open");
    const merged = mergeRoom(current, stale);
    expect(merged.status).toBe("closed");
    expect(merged.questions.map((q) => q.revealed)).toEqual([true, true, false]);

    // Candidate view: a stale response without Q2 keeps the Q2 we already had.
    const cand = room([rq(1, true), rq(2, true)]);
    expect(mergeRoom(cand, room([rq(1, true)])).questions.map((q) => q.position)).toEqual([1, 2]);

    // Newer data still applies.
    expect(mergeRoom(stale, current).questions.map((q) => q.revealed)).toEqual([true, true, false]);
    expect(mergeRoom(null, stale)).toBe(stale);
  });

  it("reads shared custom cases defensively (they come from the other participant's client)", () => {
    const by = { name: "Iris", role: "interviewer" };
    expect(
      parseSharedCases([
        { id: "a", input: "1 2", addedBy: by },
        { id: "b", input: "3", expectedOutput: "3", addedBy: { name: 5, role: "admin" } },
        { id: "c", input: 42 },
        null,
        "nope",
        { id: "d", input: "x", expectedOutput: 7 },
      ]),
    ).toEqual([
      { id: "a", input: "1 2", addedBy: { name: "Iris", role: "interviewer" } },
      { id: "b", input: "3", expectedOutput: "3", addedBy: { name: "Someone", role: "candidate" } },
    ]);
  });

  it("runs the first N custom cases in shared order when concurrent adds overflow the limit", () => {
    const merged = Array.from({ length: 11 }, (_, i) => `case-${i}`);
    expect(casesToRun(merged, 10)).toEqual(merged.slice(0, 10));
    expect(casesToRun(["a"], 10)).toEqual(["a"]);
  });

  it("re-checks at the moment of adding: the limit and whether editing is still allowed", () => {
    expect(addCaseRefusal({ count: 9, max: 10, editable: true })).toBeNull();
    expect(addCaseRefusal({ count: 10, max: 10, editable: true })).toMatch(/already has 10/);
    expect(addCaseRefusal({ count: 11, max: 10, editable: true })).toMatch(/already has 10/);
    expect(addCaseRefusal({ count: 0, max: 10, editable: false })).toMatch(/can't be changed/);
  });
});
