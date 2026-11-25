import { z } from "zod";
import { config } from "../config.js";
import { BadRequest, TooManyRequests } from "../errors.js";
import { redis } from "../queue.js";

const WINDOW_SECONDS = 60;

/**
 * Fixed-window rate limit per user, counted in Redis so it holds across API instances.
 * Counts every submit attempt (valid or not) — the point is to cap load on the sandbox and DB.
 */
export async function enforceSubmitRateLimit(userId: string, label = "submissions") {
  const window = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
  const key = `rl:submit:${userId}:${window}`;
  const [[, count]] = (await redis.multi().incr(key).expire(key, WINDOW_SECONDS + 1).exec()) as [
    [Error | null, number],
    unknown,
  ];
  if (count > config.SUBMIT_RATE_LIMIT_PER_MIN) {
    const retryAfter = WINDOW_SECONDS - (Math.floor(Date.now() / 1000) % WINDOW_SECONDS);
    throw new TooManyRequests(`Too many ${label}; try again in ${retryAfter}s`, retryAfter);
  }
}

const IdempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);

/**
 * `Idempotency-Key` header: a client-generated id for one logical submit, reused on every retry of it.
 * The key is stored on the submission row itself (unique per user) — see routes/submissions.ts.
 */
export function parseIdempotencyKey(header: string | undefined): string | null {
  if (header === undefined) return null;
  const parsed = IdempotencyKey.safeParse(header);
  if (!parsed.success) throw new BadRequest("Invalid Idempotency-Key");
  return parsed.data;
}
