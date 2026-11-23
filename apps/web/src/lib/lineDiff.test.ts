import { describe, expect, it } from "vitest";
import { lineDiff } from "./lineDiff";

const show = (before: string, after: string) =>
  lineDiff(before, after)
    .map((l) => ({ same: " ", added: "+", removed: "-" })[l.kind] + l.text)
    .join("\n");

describe("lineDiff", () => {
  it("marks changed lines and keeps unchanged ones", () => {
    expect(show("a = 1\nprint(a - b)\nend", "a = 1\nprint(a + b)\nend")).toBe(" a = 1\n-print(a - b)\n+print(a + b)\n end");
  });
  it("handles added and removed blocks at the edges", () => {
    expect(show("x", "import sys\nx\ny")).toBe("+import sys\n x\n+y");
    expect(show("a\nb\nc", "b")).toBe("-a\n b\n-c");
  });
  it("identical code is all unchanged", () => {
    expect(lineDiff("a\nb", "a\nb").every((l) => l.kind === "same")).toBe(true);
  });
  it("falls back instead of building a huge table", () => {
    const out = lineDiff("a\nb", "c\nd", 1);
    expect(out.map((l) => l.kind)).toEqual(["removed", "removed", "added", "added"]);
  });
});
