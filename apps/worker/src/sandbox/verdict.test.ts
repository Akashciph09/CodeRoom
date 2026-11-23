import { describe, expect, it } from "vitest";
import type { RunOutput } from "./runner.js";
import { judge, judgeCustom, overallVerdict } from "./verdict.js";

const run = (over: Partial<RunOutput>): RunOutput => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  oomKilled: false,
  timeMs: 10,
  ...over,
});

describe("judge", () => {
  it("accepts matching output ignoring trailing whitespace / CRLF", () => {
    expect(judge(run({ stdout: "42\r\n" }), "42")).toBe("accepted");
  });
  it("flags wrong answers", () => {
    expect(judge(run({ stdout: "41" }), "42")).toBe("wrong_answer");
  });
  it("timeout beats everything", () => {
    expect(judge(run({ timedOut: true, exitCode: 137 }), "42")).toBe("time_limit_exceeded");
  });
  it("detects OOM", () => {
    expect(judge(run({ oomKilled: true, exitCode: 137 }), "42")).toBe("memory_limit_exceeded");
  });
  it("non-zero exit is a runtime error", () => {
    expect(judge(run({ exitCode: 1, stdout: "42" }), "42")).toBe("runtime_error");
  });
});

describe("overallVerdict", () => {
  it("returns first failure", () => {
    expect(overallVerdict(["accepted", "wrong_answer", "runtime_error"])).toBe("wrong_answer");
  });
  it("accepted when all pass", () => {
    expect(overallVerdict(["accepted", "accepted"])).toBe("accepted");
  });
});

describe("judgeCustom", () => {
  it("compares like a test when an expected output is given", () => {
    expect(judgeCustom(run({ stdout: "6\n" }), "6")).toBe("accepted");
    expect(judgeCustom(run({ stdout: "5" }), "6")).toBe("wrong_answer");
  });
  it("without an expected output only reports whether the code ran cleanly", () => {
    expect(judgeCustom(run({ stdout: "anything" }), undefined)).toBe("accepted");
    expect(judgeCustom(run({ exitCode: 1 }), undefined)).toBe("runtime_error");
    expect(judgeCustom(run({ timedOut: true }), undefined)).toBe("time_limit_exceeded");
    expect(judgeCustom(run({ oomKilled: true }), undefined)).toBe("memory_limit_exceeded");
  });
});
