import { z } from "zod";

/*
 * The interviewer's structured evaluation (ADR 0017). A human judgement, separate from the automated
 * test score (ADR 0011): nothing here is computed from tests, and nothing computes it. Interviewer-only.
 */

export const RubricDimension = z.enum(["problem_solving", "correctness_testing", "code_quality", "communication"]);
export type RubricDimension = z.infer<typeof RubricDimension>;

export const Rating = z.number().int().min(1).max(4);
export type Rating = 1 | 2 | 3 | 4;

/** The rubric: what each score means, per dimension. Shown next to every choice. */
export const RUBRIC: readonly {
  dimension: RubricDimension;
  title: string;
  question: string;
  levels: Record<Rating, string>;
}[] = [
  {
    dimension: "problem_solving",
    title: "Problem solving",
    question: "How did they get from the problem to an approach?",
    levels: {
      1: "Couldn't reach a workable approach, even with significant hints.",
      2: "Reached a workable approach only with substantial hints; missed simpler or more efficient options.",
      3: "Found a sound approach with little help, and reasoned about trade-offs and complexity.",
      4: "Independently found an efficient approach, compared alternatives and justified the complexity.",
    },
  },
  {
    dimension: "correctness_testing",
    title: "Correctness and testing",
    question: "Does it work, and how did they make sure?",
    levels: {
      1: "Doesn't work for basic cases; little or no testing.",
      2: "Works on the examples but fails edge cases; tested only when prompted.",
      3: "Handles most edge cases; tested deliberately (own cases, reasoning) and fixed what they found.",
      4: "Correct including edge cases; tested systematically and anticipated failures before running.",
    },
  },
  {
    dimension: "code_quality",
    title: "Code quality",
    question: "Could someone else read and change this code?",
    levels: {
      1: "Hard to follow: unclear names, tangled logic, duplication.",
      2: "Works, but hard to read or change in places.",
      3: "Clear structure and naming; reasonable decomposition.",
      4: "Clean and idiomatic throughout; easy to extend.",
    },
  },
  {
    dimension: "communication",
    title: "Communication",
    question: "How well did they explain their thinking and work with you?",
    levels: {
      1: "Rarely explained their thinking; hard to follow even when asked.",
      2: "Explained when asked; reasoning sometimes unclear.",
      3: "Explained the approach and trade-offs while working; used hints well.",
      4: "Clear and structured throughout; asked clarifying questions and acted on feedback.",
    },
  },
];

export const Recommendation = z.enum(["strong_no_hire", "no_hire", "hire", "strong_hire"]);
export type Recommendation = z.infer<typeof Recommendation>;
export const RECOMMENDATION_LABEL: Record<Recommendation, string> = {
  strong_no_hire: "Strong no hire",
  no_hire: "No hire",
  hire: "Hire",
  strong_hire: "Strong hire",
};

export const MAX_EXPLANATION_CHARS = 2000;
export const MAX_SUMMARY_CHARS = 5000;
export const MAX_EVIDENCE_PER_DIMENSION = 10;

/** A link to evidence: one of this room's notes, or one of this candidate's runs/submissions. */
export const EvidenceRef = z.union([
  z.object({ noteId: z.string().uuid() }).strict(),
  z.object({ submissionId: z.string().uuid() }).strict(),
]);
export type EvidenceRef = z.infer<typeof EvidenceRef>;

const chars = (max: number) =>
  z
    .string()
    .max(max * 2)
    .refine((s) => [...s].length <= max, `At most ${max} characters`);

export const DimensionScore = z
  .object({
    dimension: RubricDimension,
    /** 1–4, or null while undecided / when not observed. */
    rating: Rating.nullable(),
    notObserved: z.boolean(),
    explanation: chars(MAX_EXPLANATION_CHARS),
    evidence: z.array(EvidenceRef).max(MAX_EVIDENCE_PER_DIMENSION),
  })
  .strict()
  .refine((d) => !(d.rating !== null && d.notObserved), { message: "Pick a score or “Not observed”, not both" })
  .refine((d) => new Set(d.evidence.map((e) => ("noteId" in e ? `n:${e.noteId}` : `s:${e.submissionId}`))).size === d.evidence.length, {
    message: "The same evidence is linked twice",
  });
export type DimensionScore = z.infer<typeof DimensionScore>;

/** Save a draft (whole document). `baseRevision` is the revision it was edited from (0 = new). */
export const EvaluationDraftInput = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    recommendation: Recommendation.nullable(),
    summary: chars(MAX_SUMMARY_CHARS),
    dimensions: z.array(DimensionScore).length(RUBRIC.length),
  })
  .strict()
  .refine((e) => RUBRIC.every((r) => e.dimensions.some((d) => d.dimension === r.dimension)), {
    message: "Every rubric dimension must be present once",
  });
export type EvaluationDraftInput = z.infer<typeof EvaluationDraftInput>;

export const SubmitEvaluationRequest = z.object({ revision: z.number().int().positive() }).strict();

export const EvaluationView = z.object({
  id: z.string().uuid(),
  candidateId: z.string().uuid(),
  status: z.enum(["draft", "submitted"]),
  revision: z.number().int(),
  recommendation: Recommendation.nullable(),
  summary: z.string(),
  /** In rubric order. */
  dimensions: z.array(DimensionScore),
  updatedAt: z.string(),
  submittedAt: z.string().optional(),
  submittedBy: z.object({ id: z.string().uuid(), name: z.string() }).optional(),
});
export type EvaluationView = z.infer<typeof EvaluationView>;

/**
 * Why this evaluation can't be submitted yet (empty = complete). Shared by the API (which enforces
 * it, as does the database) and the form (which shows it).
 */
export function evaluationProblems(e: Pick<EvaluationDraftInput, "recommendation" | "dimensions">): string[] {
  const problems: string[] = [];
  for (const r of RUBRIC) {
    const d = e.dimensions.find((x) => x.dimension === r.dimension);
    if (!d || (d.rating === null && !d.notObserved)) problems.push(`Score “${r.title}” (1–4 or Not observed).`);
  }
  if (e.dimensions.length > 0 && e.dimensions.every((d) => d.notObserved)) {
    problems.push("Score at least one dimension — not everything can be “Not observed”.");
  }
  if (!e.recommendation) problems.push("Choose an overall recommendation.");
  return problems;
}

/** An empty draft in rubric order. */
export const emptyDimensions = (): DimensionScore[] =>
  RUBRIC.map((r) => ({ dimension: r.dimension, rating: null, notObserved: false, explanation: "", evidence: [] }));
