import { Router } from "express";
import { z } from "zod";
import { requireRoomRole } from "../auth.js";
import { asyncHandler, HttpError, TooManyRequests } from "../errors.js";
import { redis } from "../queue.js";
import { claudeSummary, draftInterviewSummary, type SummaryModel } from "../services/ai.js";
import { roomReview } from "../services/review.js";

export function interviewSummaryRouter(model: SummaryModel = claudeSummary): Router {
  const router = Router();
  router.post("/:id/review/summary", asyncHandler(async (req, res) => {
    const roomId = z.string().uuid().parse(req.params.id);
    const userId = req.user!.userId;
    await requireRoomRole(roomId, userId, "interviewer");
    const now = Math.floor(Date.now() / 1000);
    const retryAfter = 60 - now % 60;
    const key = `rl:interview-summary:${userId}:${Math.floor(now / 60)}`;
    const counts = await redis.multi().incr(key).expire(key, 61).exec();
    const count = counts?.[0]?.[1];
    if (typeof count !== "number") throw new HttpError(503, "Summary drafting is temporarily unavailable.");
    if (count > 4) throw new TooManyRequests("Too many summary requests. Try again shortly.", retryAfter);
    const review = await roomReview(roomId, userId);
    res.setHeader("Cache-Control", "no-store");
    res.json(await draftInterviewSummary(review, model));
  }));
  return router;
}
