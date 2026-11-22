import { z } from "zod";
import { config } from "../config.js";
import { BadRequest, Conflict, TooManyRequests } from "../errors.js";
import { redis } from "../queue.js";

const WINDOW_SECONDS = 60;

/**
 * Fixed-window rate limit per user, counted in Redis so it holds across API instances.
 * Counts every submit attempt (valid or not) — the point is to cap load on the sandbox and DB.
 */
export async function enforceSubmitRateLimit(userId: string) {
  const window = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
  const key = `rl:submit:${userId}:${window}`;
  const [[, count]] = (await redis.multi().incr(key).expire(key, WINDOW_SECONDS + 1).exec()) as [
    [Error | null, number],
    unknown,
  ];
  if (count > config.SUBMIT_RATE_LIMIT_PER_MIN) {
    const retryAfter = WINDOW_SECONDS - (Math.floor(Date.now() / 1000) % WINDOW_SECONDS);
    throw new TooManyRequests(`Too many submissions; try again in ${retryAfter}s`, retryAfter);
  }
}

const IdempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
const IDEMPOTENCY_TTL_SECONDS = 10 * 60;
const PENDING = "pending";

export type IdempotencyClaim =
  | { kind: "none" }
  | { kind: "new"; key: string }
  | { kind: "replay"; submissionId: string };

/**
 * `Idempotency-Key` header: a client-generated id per logical submit. Retrying the same request
 * (network timeout, double send) returns the original submission instead of creating another.
 * Keys are scoped per user and expire after 10 minutes.
 */
export async function claimIdempotencyKey(userId: string, header: string | undefined): Promise<IdempotencyClaim> {
  if (header === undefined) return { kind: "none" };
  const parsed = IdempotencyKey.safeParse(header);
  if (!parsed.success) throw new BadRequest("Invalid Idempotency-Key");

  const key = `idem:submit:${userId}:${parsed.data}`;
  const claimed = await redis.set(key, PENDING, "EX", IDEMPOTENCY_TTL_SECONDS, "NX");
  if (claimed === "OK") return { kind: "new", key };

  const existing = await redis.get(key);
  if (existing && existing !== PENDING) return { kind: "replay", submissionId: existing };
  throw new Conflict("A request with this Idempotency-Key is still being processed");
}

export async function completeIdempotencyKey(claim: IdempotencyClaim, submissionId: string) {
  if (claim.kind === "new") await redis.set(claim.key, submissionId, "EX", IDEMPOTENCY_TTL_SECONDS);
}

/** On failure, free the key so the client can retry with it. */
export async function releaseIdempotencyKey(claim: IdempotencyClaim) {
  if (claim.kind === "new") await redis.del(claim.key).catch(() => {});
}
