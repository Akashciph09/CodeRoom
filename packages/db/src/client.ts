import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = PostgresJsDatabase<typeof schema>;

/**
 * Server-side connection as the database owner (bypasses RLS by design).
 * Only apps/api and apps/worker may call this — never ship DATABASE_URL to the browser.
 */
export function createDb(databaseUrl: string, opts: { max?: number } = {}) {
  const client = postgres(databaseUrl, { max: opts.max ?? 10, prepare: false });
  const db: Db = drizzle(client, { schema });
  return { db, close: () => client.end({ timeout: 5 }) };
}
