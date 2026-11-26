/**
 * Browser config. Only public values belong here: the API URL, the Auth URL and Supabase's
 * publishable key (sign-in only — RLS blocks table access, ADR 0006).
 *
 * Two sources, runtime first:
 *  - `window.CODEROOM_CONFIG`, set by `/config.js`. A deployment (deploy/, ADR 0022) serves it from
 *    its own settings, so one prebuilt web image works for any hostname. In dev the file in
 *    `public/` sets nothing.
 *  - `VITE_*` variables baked in at build time (dev: the repo-root .env).
 */
interface RuntimeConfig {
  apiUrl?: string;
  supabaseUrl?: string;
  supabasePublishableKey?: string;
}

declare global {
  interface Window {
    CODEROOM_CONFIG?: RuntimeConfig;
  }
}

const runtime: RuntimeConfig = typeof window !== "undefined" ? (window.CODEROOM_CONFIG ?? {}) : {};

/** Only absolute http(s) URLs: anything else in /config.js is a deployment mistake, not a value. */
function url(name: string, value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^https?:\/\/[^\s"'<>]+$/.test(value)) throw new Error(`Invalid ${name} in /config.js: ${value}`);
  return value.replace(/\/+$/, "");
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing ${name} — copy .env.example to .env at the repo root`);
  return value;
}

export const API_URL = url("apiUrl", runtime.apiUrl) ?? import.meta.env.VITE_API_URL ?? "http://localhost:4000";
export const WS_URL = API_URL.replace(/^http/, "ws");
export const SUPABASE_URL = required("VITE_SUPABASE_URL", url("supabaseUrl", runtime.supabaseUrl) ?? import.meta.env.VITE_SUPABASE_URL);
export const SUPABASE_PUBLISHABLE_KEY = required(
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  runtime.supabasePublishableKey || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
);
