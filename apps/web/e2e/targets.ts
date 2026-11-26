import { loadEnv } from "vite";

const env = loadEnv("", "../..", "");

export const webUrl = process.env.E2E_WEB_URL ?? "http://localhost:5173";
export const apiUrl = process.env.E2E_API_URL ?? env.VITE_API_URL ?? "http://localhost:4000";
export const supabaseUrl = process.env.E2E_SUPABASE_URL ?? env.VITE_SUPABASE_URL ?? "";
