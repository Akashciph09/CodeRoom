import { Router } from "express";
import { EditSummaryDraftRequest, SummaryDraftRevision } from "@coderoom/shared";
import { requireRoomRole } from "../auth.js";
import { asyncHandler, HttpError, TooManyRequests } from "../errors.js";
import { redis } from "../queue.js";
import { configuredSummaryModel, draftInterviewSummary, type SummaryModel } from "../services/ai.js";
import { roomReview } from "../services/review.js";
import { discardSummaryDraft, editSummaryDraft, readSummaryDraft, saveGeneratedSummary, summaryDraftView } from "../services/summaryDrafts.js";
import { UuidParam } from "./params.js";

export function interviewSummaryRouter(model: SummaryModel = configuredSummaryModel): Router {
  const router = Router();
  router.route("/:id/review/summary")
    .all(asyncHandler(async (req, res, next) => {
      await requireRoomRole(UuidParam.parse(req.params.id), req.user!.userId, "interviewer");
      res.setHeader("Cache-Control", "no-store");
      next();
    }))
    .get(asyncHandler(async (req, res) => {
      res.json(summaryDraftView(await readSummaryDraft(req.params.id!, req.user!.userId)));
    }))
    .post(asyncHandler(async (req, res) => {
      const roomId = req.params.id!;
      const userId = req.user!.userId;
      const previous = await readSummaryDraft(roomId, userId);
      const existing = summaryDraftView(previous);
      if (existing) {
        res.json(existing);
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      const retryAfter = 60 - now % 60;
      const key = `rl:interview-summary:${userId}:${Math.floor(now / 60)}`;
      const counts = await redis.multi().incr(key).expire(key, 61).exec();
      const count = counts?.[0]?.[1];
      if (typeof count !== "number") throw new HttpError(503, "Summary drafting is temporarily unavailable.");
      if (count > 4) throw new TooManyRequests("Too many summary requests. Try again shortly.", retryAfter);
      const review = await roomReview(roomId, userId);
      const generated = await draftInterviewSummary(review, model);
      res.json(await saveGeneratedSummary(roomId, userId, previous, generated));
    }))
    .put(asyncHandler(async (req, res) => {
      res.json(await editSummaryDraft(req.params.id!, req.user!.userId, EditSummaryDraftRequest.parse(req.body)));
    }))
    .delete(asyncHandler(async (req, res) => {
      await discardSummaryDraft(req.params.id!, req.user!.userId, SummaryDraftRevision.parse(req.body).revision);
      res.status(204).end();
    }));
  return router;
}
