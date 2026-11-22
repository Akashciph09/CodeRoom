/**
 * Browser config. Only VITE_* variables reach the bundle, and only public values belong there:
 * the API URL and Supabase's publishable key (sign-in only — RLS blocks table access, ADR 0006).
 */
function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing ${name} — copy .env.example to .env at the repo root`);
  return value;
}

export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
export const WS_URL = API_URL.replace(/^http/, "ws");
export const SUPABASE_URL = required("VITE_SUPABASE_URL", import.meta.env.VITE_SUPABASE_URL);
export const SUPABASE_PUBLISHABLE_KEY = required(
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
);
