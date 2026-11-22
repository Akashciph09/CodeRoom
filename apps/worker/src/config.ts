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
});

export const config = Env.parse(process.env);
