import { z } from "zod";
import { Verdict } from "./verdicts.js";

/** Per-language starter code; a language may be omitted (the editor then starts empty). */
export const StarterCode = z
  .object({
    python: z.string().max(20_000).optional(),
    javascript: z.string().max(20_000).optional(),
  })
  .strict();
export type StarterCode = z.infer<typeof StarterCode>;

export const MAX_TESTS_PER_QUESTION = 50;
const MAX_TEST_FIELD = 64 * 1024;

export const TestCaseInput = z.object({
  input: z.string().max(MAX_TEST_FIELD),
  expectedOutput: z.string().max(MAX_TEST_FIELD),
  isHidden: z.boolean(),
});
export type TestCaseInput = z.infer<typeof TestCaseInput>;

/**
 * Full content of a draft. Saving replaces the whole draft — test order in `tests` is the order
 * candidates see and the order results are reported in.
 *
 * `baseRevision` is the question revision (`QuestionDetail.revision`) this edit started from. It changes on
 * every save, draft creation, publish and discard, and never resets — so if anything happened to the
 * question since (another tab saved, published, discarded, or started a new draft), the server answers
 * 409 instead of overwriting.
 */
export const QuestionDraftInput = z.object({
  baseRevision: z.number().int().positive(),
  title: z.string().trim().min(1, "Title is required").max(200),
  statement: z.string().max(20_000),
  constraints: z.string().max(5_000).default(""),
  starterCode: StarterCode.default({}),
  tests: z.array(TestCaseInput).max(MAX_TESTS_PER_QUESTION),
});
export type QuestionDraftInput = z.infer<typeof QuestionDraftInput>;

/** Publish / discard / delete act on the question state the client has seen (its `revision`); 409 if it changed. */
export const DraftRevisionRequest = z.object({
  revision: z.number().int().positive(),
});
export type DraftRevisionRequest = z.infer<typeof DraftRevisionRequest>;

/** Body of a 409 from draft endpoints. */
export const DraftConflict = z.object({
  error: z.string(),
  conflict: z.literal("draft_changed"),
  /** The question's current revision on the server. */
  currentRevision: z.number().int(),
});
export type DraftConflict = z.infer<typeof DraftConflict>;

export const CreateQuestionRequest = z.object({
  title: z.string().trim().min(1).max(200).default("Untitled question"),
});
export type CreateQuestionRequest = z.infer<typeof CreateQuestionRequest>;

export const TestCaseView = TestCaseInput.extend({
  id: z.string().uuid(),
  position: z.number().int(),
  referenceVerdict: Verdict.optional(),
});
export type TestCaseView = z.infer<typeof TestCaseView>;

/** One version as its owner sees it (all tests, hidden included). */
export const QuestionVersionView = z.object({
  id: z.string().uuid(),
  version: z.number().int().nullable(),
  status: z.enum(["draft", "published"]),
  title: z.string(),
  statement: z.string(),
  constraints: z.string(),
  starterCode: StarterCode,
  tests: z.array(TestCaseView),
  publishedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type QuestionVersionView = z.infer<typeof QuestionVersionView>;

/** Editor payload: the editable draft (if any) and the latest ready version (if any). Owner only. */
export const QuestionDetail = z.object({
  id: z.string().uuid(),
  /** Question revision: send it back as `baseRevision` / `revision` on the next write. */
  revision: z.number().int().positive(),
  draft: QuestionVersionView.nullable(),
  latest: QuestionVersionView.nullable(),
  versions: z.array(z.object({ id: z.string().uuid(), version: z.number().int(), publishedAt: z.string() })),
  /** How many rooms use any version of this question. */
  roomCount: z.number().int(),
});
export type QuestionDetail = z.infer<typeof QuestionDetail>;

/** "My questions" list row. `draft` = never published; `ready` = has a published version. */
export const MyQuestionSummary = z.object({
  id: z.string().uuid(),
  title: z.string(),
  status: z.enum(["draft", "ready"]),
  latestVersion: z.number().int().nullable(),
  hasUnpublishedChanges: z.boolean(),
  updatedAt: z.string(),
});
export type MyQuestionSummary = z.infer<typeof MyQuestionSummary>;

/**
 * What a candidate sees for a question version — public tests only. Used by rooms AND by the owner's
 * preview, so the preview is the candidate's view by construction.
 */
export const CandidateQuestionView = z.object({
  id: z.string().uuid(),
  versionId: z.string().uuid(),
  version: z.number().int().nullable(),
  title: z.string(),
  statement: z.string(),
  constraints: z.string(),
  starterCode: StarterCode,
  publicTests: z.array(z.object({ id: z.string(), input: z.string(), expectedOutput: z.string() })),
  hiddenTestCount: z.number().int(),
});
export type CandidateQuestionView = z.infer<typeof CandidateQuestionView>;

/** Reasons a draft can't be marked ready. */
export const PublishProblem = z.enum([
  "missing_title",
  "missing_statement",
  "no_tests",
  "no_public_tests",
  "empty_expected_output",
]);
export type PublishProblem = z.infer<typeof PublishProblem>;
