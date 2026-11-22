import { Router } from "express";
import { asc, eq, questions } from "@coderoom/db";
import type { QuestionSummary } from "@coderoom/shared";
import { db } from "../db.js";
import { asyncHandler } from "../errors.js";

export const questionsRouter: Router = Router();

/** Approved questions an interviewer can open a room with. Titles only — tests stay server-side. */
questionsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows: QuestionSummary[] = await db
      .select({ id: questions.id, title: questions.title })
      .from(questions)
      .where(eq(questions.status, "approved"))
      .orderBy(asc(questions.title));
    res.json(rows);
  }),
);
