import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // One .env at the repo root. Vite only exposes VITE_* variables to the browser bundle.
  envDir: "../..",
  server: { port: 5173 },
});
