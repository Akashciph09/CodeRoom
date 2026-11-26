import { apiUrl, supabaseUrl, webUrl } from "./targets";

/**
 * Fail fast with a useful message instead of 2-minute timeouts, and refuse to run anywhere but a
 * local stack: these tests sign up throwaway users and must never touch a real Supabase project.
 */
export default async function globalSetup() {
  const local = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url);
  if (![webUrl, apiUrl, supabaseUrl].every(local)) {
    throw new Error(
      `E2E tests only run against a local stack (web=${webUrl}, auth=${supabaseUrl}, api=${apiUrl}).`,
    );
  }

  const health = await fetch(`${apiUrl}/health`).then(
    (r) => r.json() as Promise<{ ok: boolean }>,
    () => null,
  );
  if (!health?.ok) {
    throw new Error(`API at ${apiUrl} is not healthy. Start the configured local stack first.`);
  }
}
