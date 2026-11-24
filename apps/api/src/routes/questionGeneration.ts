import { Router } from "express";
import { GenerateQuestionRequest } from "@coderoom/shared";
import { asyncHandler, HttpError, TooManyRequests } from "../errors.js";
import { redis, validateGeneratedTests } from "../queue.js";
import { configuredQuestionModel, generateQuestion, type QuestionModel } from "../services/ai.js";
import { createQuestion } from "../services/questions.js";

export function questionGenerationRouter(model: QuestionModel = configuredQuestionModel): Router {
  const router = Router();
  router.post("/generate", asyncHandler(async (req, res) => {
    const { brief } = GenerateQuestionRequest.parse(req.body);
    const userId = req.user!.userId;
    const now = Math.floor(Date.now() / 1000);
    const key = `rl:question-generation:${userId}:${Math.floor(now / 60)}`;
    const counts = await redis.multi().incr(key).expire(key, 61).exec();
    const count = counts?.[0]?.[1];
    if (typeof count !== "number") throw new HttpError(503, "Question generation is temporarily unavailable.");
    if (count > 2) throw new TooManyRequests("Too many generation requests. Try again shortly.", 60 - now % 60);

    const { title, tests, referencePython, ...content } = await generateQuestion(brief, model);
    const verdicts = await validateGeneratedTests(referencePython, tests).catch(() => {
      throw new HttpError(503, "The worker could not validate this draft. Try again when the worker is available.");
    });
    if (verdicts.length !== tests.length) throw new HttpError(503, "The worker returned incomplete validation.");
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json(await createQuestion(userId, title, { content, tests, verdicts }));
  }));
  return router;
}
