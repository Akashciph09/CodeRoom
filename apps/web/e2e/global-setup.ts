import { loadEnv } from "vite";

/**
 * Fail fast with a useful message instead of 2-minute timeouts, and refuse to run anywhere but a
 * local stack: these tests sign up throwaway users and must never touch a real Supabase project.
 */
export default async function globalSetup() {
  const env = loadEnv("", "../..", "");
  const supabaseUrl = env.VITE_SUPABASE_URL ?? "";
  const apiUrl = env.VITE_API_URL ?? "http://localhost:4000";

  const local = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url);
  if (!local(supabaseUrl) || !local(apiUrl)) {
    throw new Error(
      `E2E tests only run against a local stack (VITE_SUPABASE_URL=${supabaseUrl}, VITE_API_URL=${apiUrl}).`,
    );
  }

  const health = await fetch(`${apiUrl}/health`).then(
    (r) => r.json() as Promise<{ ok: boolean }>,
    () => null,
  );
  if (!health?.ok) {
    throw new Error(
      `API at ${apiUrl} is not healthy. Start the stack first: pnpm db:start && pnpm infra:up && pnpm dev`,
    );
  }
}
