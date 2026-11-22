import { describe, expect, it } from "vitest";
import { publishProblems } from "./questions.js";

const pub = (expectedOutput = "3") => ({ expectedOutput, isHidden: false });
const hid = (expectedOutput = "3") => ({ expectedOutput, isHidden: true });

describe("publishProblems", () => {
  it("accepts a complete question", () => {
    expect(publishProblems({ title: "Sum", statement: "Add them.", tests: [pub(), hid()] })).toEqual([]);
  });

  it("requires a title and a statement (whitespace doesn't count)", () => {
    expect(publishProblems({ title: " ", statement: "\n", tests: [pub()] })).toEqual([
      "missing_title",
      "missing_statement",
    ]);
  });

  it("requires at least one test, and at least one the candidate can see", () => {
    expect(publishProblems({ title: "t", statement: "s", tests: [] })).toEqual(["no_tests"]);
    expect(publishProblems({ title: "t", statement: "s", tests: [hid(), hid()] })).toEqual(["no_public_tests"]);
  });

  it("rejects tests with an empty expected output", () => {
    expect(publishProblems({ title: "t", statement: "s", tests: [pub(), hid("  ")] })).toEqual([
      "empty_expected_output",
    ]);
  });
});
