import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

// pnpm runs scripts from the package dir; the shared .env lives at the repo root.
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  SUPABASE_URL: z.string().url(),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  MAX_CODE_BYTES: z.coerce.number().int().positive().default(65536),
  /** Max single WebSocket message. Yjs updates are small; this caps abuse. */
  WS_MAX_PAYLOAD_BYTES: z.coerce.number().int().positive().default(1_048_576),
  /** Editor state is written to Postgres this long after the last change (and when the room empties). */
  DOC_PERSIST_DEBOUNCE_MS: z.coerce.number().int().positive().default(2000),
});

export const config = Env.parse(process.env);
export type Config = typeof config;
