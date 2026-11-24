import { emptyDimensions, type DimensionScore, type EvaluationDraftInput, type EvaluationView, type Recommendation } from "@coderoom/shared";

/*
 * Form state for the evaluation (ADR 0017). Pure, unit-tested.
 */

export type EvaluationForm = { recommendation: Recommendation | null; summary: string; dimensions: DimensionScore[] };

/** The form for a saved evaluation, or an empty one. */
export const formOf = (view: EvaluationView | null): EvaluationForm =>
  view
    ? { recommendation: view.recommendation, summary: view.summary, dimensions: view.dimensions }
    : { recommendation: null, summary: "", dimensions: emptyDimensions() };

export const sameForm = (a: EvaluationForm, b: EvaluationForm) => JSON.stringify(a) === JSON.stringify(b);

export const toInput = (form: EvaluationForm, baseRevision: number): EvaluationDraftInput => ({ baseRevision, ...form });

/**
 * A view arriving from a refresh or a save. Server state only moves forward (by revision), and the
 * form is replaced only if it still shows the previous server state — never over unsaved edits.
 */
export function applyServerView(
  state: { baseline: EvaluationView | null; form: EvaluationForm },
  incoming: EvaluationView | null,
): { baseline: EvaluationView | null; form: EvaluationForm } {
  if (!incoming || (state.baseline && incoming.revision <= state.baseline.revision)) return state;
  if (!sameForm(state.form, formOf(state.baseline))) return state;
  return { baseline: incoming, form: formOf(incoming) };
}

/** Change one dimension. */
export const withDimension = (form: EvaluationForm, dimension: DimensionScore["dimension"], patch: Partial<DimensionScore>): EvaluationForm => ({
  ...form,
  dimensions: form.dimensions.map((d) => (d.dimension === dimension ? { ...d, ...patch } : d)),
});
