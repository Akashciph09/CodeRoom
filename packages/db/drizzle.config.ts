import { defineConfig } from "drizzle-kit";

// Migrations are written into supabase/migrations with Supabase's timestamp naming,
// so `supabase start` / `supabase db reset` apply them (and supabase/seed.sql) automatically.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "../../supabase/migrations",
  migrations: { prefix: "supabase" },
  entities: { roles: { provider: "supabase" } },
  schemaFilter: ["public"],
});
