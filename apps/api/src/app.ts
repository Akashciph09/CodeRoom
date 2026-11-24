import cors from "cors";
import express, { type Express } from "express";
import { sql } from "@coderoom/db";
import { authenticate } from "./auth.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { errorMiddleware } from "./errors.js";
import { redis } from "./queue.js";
import { interviewSummaryRouter } from "./routes/interviewSummary.js";
import { questionGenerationRouter } from "./routes/questionGeneration.js";
import type { QuestionModel, SummaryModel } from "./services/ai.js";
import { questionsRouter } from "./routes/questions.js";
import { roomsRouter } from "./routes/rooms.js";
import { submissionsRouter } from "./routes/submissions.js";

export function createApp(summaryModel?: SummaryModel, questionModel?: QuestionModel): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: config.CORS_ORIGIN }));
  // Hard cap on body size; code-size check in the route is the finer-grained limit.
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", async (_req, res) => {
    const postgres = await db
      .execute(sql`select 1`)
      .then(() => true)
      .catch(() => false);
    const redisOk = redis.status === "ready";
    res.status(postgres && redisOk ? 200 : 503).json({ ok: postgres && redisOk, postgres, redis: redisOk });
  });

  app.use("/questions", authenticate, questionGenerationRouter(questionModel), questionsRouter);
  app.use("/rooms", authenticate, roomsRouter, interviewSummaryRouter(summaryModel));
  app.use("/submissions", authenticate, submissionsRouter);

  app.use(errorMiddleware);
  return app;
}
