import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

const Env = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  SANDBOX_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  SANDBOX_MEMORY_MB: z.coerce.number().int().positive().default(256),
  SANDBOX_CPUS: z.coerce.number().positive().default(0.5),
  /** Outbox sweeper: how often to look for, and how old before re-enqueueing, stuck `queued` rows. */
  OUTBOX_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  OUTBOX_STALE_AFTER_MS: z.coerce.number().int().positive().default(30_000),
});

export const config = Env.parse(process.env);
