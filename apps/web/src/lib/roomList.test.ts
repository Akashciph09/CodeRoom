import { describe, expect, it } from "vitest";
import { submitLabel } from "./roomList";

const c = (score: number, graded: number, pending: number, failed: number) => ({ score, submits: { graded, pending, failed } });

describe("room list submit label", () => {
  it("shows the score once a Submit is graded (and notes a newer one still grading)", () => {
    expect(submitLabel(c(85, 2, 0, 1))).toBe("Score 85/100");
    expect(submitLabel(c(85, 1, 1, 0))).toBe("Score 85/100 · grading…");
    expect(submitLabel(c(0, 1, 0, 0))).toBe("Score 0/100"); // graded and failed every test: a real 0
  });
  it("tells still grading, grading failed and never submitted apart", () => {
    expect(submitLabel(c(0, 0, 1, 0))).toBe("Grading…");
    expect(submitLabel(c(0, 0, 1, 1))).toBe("Grading…");
    expect(submitLabel(c(0, 0, 0, 1))).toBe("Grading failed");
    expect(submitLabel(c(0, 0, 0, 0))).toBe("No Submit yet");
  });
});
