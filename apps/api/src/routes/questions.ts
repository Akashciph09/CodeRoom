import { Router } from "express";
import { z } from "zod";
import { CreateQuestionRequest, QuestionDraftInput } from "@coderoom/shared";
import { asyncHandler, NotFound } from "../errors.js";
import {
  candidateView,
  createQuestion,
  deleteQuestion,
  discardDraft,
  latestPublished,
  myQuestions,
  publishDraft,
  questionDetail,
  requireOwnedQuestion,
  saveDraft,
  usableQuestions,
} from "../services/questions.js";
import { UuidParam } from "./params.js";

export const questionsRouter: Router = Router();

/** Questions the caller can open an interview with (own ready questions + shared library). */
questionsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await usableQuestions(req.user!.userId));
  }),
);

/** The caller's own questions, with draft/ready status. */
questionsRouter.get(
  "/mine",
  asyncHandler(async (req, res) => {
    res.json(await myQuestions(req.user!.userId));
  }),
);

questionsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { title } = CreateQuestionRequest.parse(req.body ?? {});
    res.status(201).json(await createQuestion(req.user!.userId, title));
  }),
);

// Everything below acts on one question and is owner-only (404 for anyone else).
const owned = (handler: (questionId: string, req: Parameters<Parameters<typeof asyncHandler>[0]>[0]) => Promise<unknown>) =>
  asyncHandler(async (req, res) => {
    const questionId = UuidParam.parse(req.params.id);
    await requireOwnedQuestion(questionId, req.user!.userId);
    const result = await handler(questionId, req);
    if (result === undefined) res.status(204).end();
    else res.json(result);
  });

questionsRouter.get("/:id", owned((id) => questionDetail(id)));

/** Save the full draft (creates one if the question is currently ready). */
questionsRouter.put("/:id/draft", owned((id, req) => saveDraft(id, QuestionDraftInput.parse(req.body))));

questionsRouter.delete("/:id/draft", owned((id) => discardDraft(id)));

/** Mark the draft ready → next immutable version. 400 with `problems` if it isn't complete. */
questionsRouter.post("/:id/publish", owned((id) => publishDraft(id)));

questionsRouter.delete("/:id", owned(async (id) => void (await deleteQuestion(id))));

/**
 * Exactly what a candidate would see, produced by the same code rooms use (public tests only).
 * `?of=draft` (default when a draft exists) or `?of=latest`.
 */
questionsRouter.get(
  "/:id/preview",
  owned(async (id, req) => {
    const of = z.enum(["draft", "latest"]).optional().parse(req.query.of);
    const detail = await questionDetail(id);
    const versionId =
      of === "latest"
        ? detail.latest?.id
        : of === "draft"
          ? detail.draft?.id
          : (detail.draft?.id ?? (await latestPublished(id))?.id);
    if (!versionId) throw new NotFound(`No ${of ?? "version"} to preview`);
    return candidateView(versionId);
  }),
);
