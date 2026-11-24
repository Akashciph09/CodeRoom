import { describe, expect, it } from "vitest";
import type { EvaluationView } from "@coderoom/shared";
import { applyServerView, formOf, sameForm, toInput, withDimension } from "./evaluation";

const view = (revision: number, summary = `rev ${revision}`): EvaluationView => ({
  id: "00000000-0000-4000-8000-0000000000e1",
  candidateId: "00000000-0000-4000-8000-0000000000c1",
  status: "draft",
  revision,
  recommendation: null,
  summary,
  dimensions: formOf(null).dimensions,
  updatedAt: "2026-11-24T10:00:00.000Z",
});

describe("evaluation form", () => {
  it("starts empty, in rubric order, and builds the request with the base revision", () => {
    const empty = formOf(null);
    expect(empty.dimensions.map((d) => d.dimension)).toEqual(["problem_solving", "correctness_testing", "code_quality", "communication"]);
    expect(toInput(empty, 0)).toMatchObject({ baseRevision: 0, recommendation: null, summary: "" });
  });

  it("edits one dimension without touching the others", () => {
    const f = withDimension(formOf(null), "code_quality", { rating: 3 });
    expect(f.dimensions.map((d) => d.rating)).toEqual([null, null, 3, null]);
  });

  it("adopts a newer server view only when there are no unsaved edits", () => {
    const start = { baseline: view(1), form: formOf(view(1)) };
    // Untouched form → replaced by the newer version.
    expect(applyServerView(start, view(2)).form.summary).toBe("rev 2");
    // The edited form retains the revision it was based on.
    const edited = { ...start, form: { ...start.form, summary: "typing…" } };
    const next = applyServerView(edited, view(2));
    expect(next.form.summary).toBe("typing…");
    expect(toInput(next.form, next.baseline?.revision ?? 0).baseRevision).toBe(1);
    const unsaved = { baseline: null, form: { ...formOf(null), summary: "new draft" } };
    expect(applyServerView(unsaved, view(1))).toBe(unsaved);
  });

  it("never goes back to an older revision (a slow refresh arriving after a save)", () => {
    const state = { baseline: view(3), form: formOf(view(3)) };
    expect(applyServerView(state, view(2))).toBe(state);
    expect(applyServerView(state, null)).toBe(state);
    expect(sameForm(applyServerView({ baseline: null, form: formOf(null) }, view(1)).form, formOf(view(1)))).toBe(true);
  });
});
