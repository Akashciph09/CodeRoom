import { describe, expect, it } from "vitest";
import { emptyDimensions, EvaluationDraftInput, evaluationProblems, RUBRIC, type DimensionScore } from "@coderoom/shared";

const scored = (ratings: (number | "n/o" | null)[]): DimensionScore[] =>
  emptyDimensions().map((d, i) => {
    const r = ratings[i];
    return { ...d, rating: typeof r === "number" ? r : null, notObserved: r === "n/o" };
  });

describe("evaluationProblems (what blocks submitting)", () => {
  it("is empty for a complete evaluation, Not observed allowed", () => {
    expect(evaluationProblems({ recommendation: "hire", dimensions: scored([3, 4, "n/o", 2]) })).toEqual([]);
  });

  it("names each unscored dimension and a missing recommendation", () => {
    const problems = evaluationProblems({ recommendation: null, dimensions: scored([3, null, null, 2]) });
    expect(problems).toEqual([
      "Score “Correctness and testing” (1–4 or Not observed).",
      "Score “Code quality” (1–4 or Not observed).",
      "Choose an overall recommendation.",
    ]);
  });

  it("needs at least one real score", () => {
    expect(evaluationProblems({ recommendation: "no_hire", dimensions: scored(["n/o", "n/o", "n/o", "n/o"]) })).toEqual([
      "Score at least one dimension — not everything can be “Not observed”.",
    ]);
  });

  it("treats a missing dimension as unscored", () => {
    expect(evaluationProblems({ recommendation: "hire", dimensions: scored([3, 3, 3, 3]).slice(0, 3) })).toEqual([
      `Score “${RUBRIC[3]!.title}” (1–4 or Not observed).`,
    ]);
  });
});

describe("EvaluationDraftInput (the saved document)", () => {
  const valid = { baseRevision: 0, recommendation: null, summary: "", dimensions: emptyDimensions() };

  it("accepts an empty draft — drafting can start with nothing filled in", () => {
    expect(EvaluationDraftInput.safeParse(valid).success).toBe(true);
  });

  it("refuses a score outside 1–4, a score plus Not observed, duplicates and missing dimensions", () => {
    const withDim = (patch: Partial<DimensionScore>) => ({ ...valid, dimensions: [{ ...emptyDimensions()[0]!, ...patch }, ...emptyDimensions().slice(1)] });
    expect(EvaluationDraftInput.safeParse(withDim({ rating: 5 })).success).toBe(false);
    expect(EvaluationDraftInput.safeParse(withDim({ rating: 0 })).success).toBe(false);
    expect(EvaluationDraftInput.safeParse(withDim({ rating: 3, notObserved: true })).success).toBe(false);
    const note = "00000000-0000-4000-8000-000000000009";
    expect(EvaluationDraftInput.safeParse(withDim({ evidence: [{ noteId: note }, { noteId: note }] })).success).toBe(false);
    const twice = [...emptyDimensions().slice(0, 3), emptyDimensions()[0]!];
    expect(EvaluationDraftInput.safeParse({ ...valid, dimensions: twice }).success).toBe(false);
  });

  it("limits the explanation and summary by characters", () => {
    expect(EvaluationDraftInput.safeParse({ ...valid, summary: "😀".repeat(5000) }).success).toBe(true);
    expect(EvaluationDraftInput.safeParse({ ...valid, summary: "x".repeat(5001) }).success).toBe(false);
  });
});
