import { Router } from "express";
import { GenerateQuestionRequest, MAX_TESTS_PER_QUESTION, SuggestTestsRequest, type CheckedTestSuggestion } from "@coderoom/shared";
import { asyncHandler, BadRequest, HttpError, NotFound, TooManyRequests } from "../errors.js";
import { redis, validateGeneratedTests } from "../queue.js";
import { configuredQuestionModel, configuredTestSuggestionModel, generateQuestion, proposeQuestionTests, type QuestionModel, type TestSuggestionModel } from "../services/ai.js";
import { createQuestion, DraftChanged, questionDetail, requireOwnedQuestion } from "../services/questions.js";
import { UuidParam } from "./params.js";

async function enforceQuestionAiLimit(userId: string) {
  const now = Math.floor(Date.now() / 1000);
  const key = `rl:question-generation:${userId}:${Math.floor(now / 60)}`;
  const counts = await redis.multi().incr(key).expire(key, 61).exec();
  const count = counts?.[0]?.[1];
  if (typeof count !== "number") throw new HttpError(503, "Question generation is temporarily unavailable.");
  if (count > 2) throw new TooManyRequests("Too many generation requests. Try again shortly.", 60 - now % 60);
}

export function questionGenerationRouter(
  model: QuestionModel = configuredQuestionModel,
  suggestionsModel: TestSuggestionModel = configuredTestSuggestionModel,
): Router {
  const router = Router();
  router.post("/generate", asyncHandler(async (req, res) => {
    const { brief } = GenerateQuestionRequest.parse(req.body);
    const userId = req.user!.userId;
    await enforceQuestionAiLimit(userId);

    const { title, tests, referencePython, ...content } = await generateQuestion(brief, model);
    const verdicts = await checkWithReference(referencePython, tests);
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json(await createQuestion(userId, title, { content, tests, verdicts }));
  }));
  router.post("/:id/test-suggestions", asyncHandler(async (req, res) => {
    const questionId = UuidParam.parse(req.params.id);
    const userId = req.user!.userId;
    await requireOwnedQuestion(questionId, userId);
    const { revision, referencePython } = SuggestTestsRequest.parse(req.body);
    const detail = await questionDetail(questionId);
    if (detail.revision !== revision) throw new DraftChanged(detail.revision);
    const version = detail.draft ?? detail.latest;
    if (!version) throw new NotFound("Question version not found.");
    if (!version.statement.trim()) throw new BadRequest("Write and save the problem statement first.");
    const remaining = MAX_TESTS_PER_QUESTION - version.tests.length;
    if (remaining <= 0) throw new BadRequest("This question has reached the test limit.");
    const { title, statement, constraints } = version;
    const publicExamples = version.tests.filter((test) => !test.isHidden)
      .map(({ input, expectedOutput }) => ({ input, expectedOutput }));
    const evidence = JSON.stringify({ untrustedQuestion: { title, statement, constraints, publicExamples } });
    if (Buffer.byteLength(evidence) > 32_000) throw new BadRequest("This question has too much public example data for AI suggestions.");

    await enforceQuestionAiLimit(userId);
    const proposals = await proposeQuestionTests(evidence, suggestionsModel);
    const seen = new Set(version.tests.map((test) => test.input));
    const tests = proposals.filter(({ input }) => {
      if (seen.has(input)) return false;
      seen.add(input);
      return true;
    }).slice(0, remaining).map((test) => ({ ...test, isHidden: true as const }));
    const verdicts = tests.length > 0 ? await checkWithReference(referencePython, tests) : [];
    const suggestions: CheckedTestSuggestion[] = tests.map((test, i) => ({ ...test, verdict: verdicts[i]! }));
    res.setHeader("Cache-Control", "no-store");
    res.json({ suggestions });
  }));
  return router;
}
async function checkWithReference(referencePython: Parameters<typeof validateGeneratedTests>[0], tests: Parameters<typeof validateGeneratedTests>[1]) {
  const verdicts = await validateGeneratedTests(referencePython, tests).catch(() => {
    throw new HttpError(503, "The worker could not check these tests. Try again when the worker is available.");
  });
  if (verdicts.length !== tests.length) throw new HttpError(503, "The worker returned incomplete validation.");
  return verdicts;
}
