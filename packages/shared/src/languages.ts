import { z } from "zod";

export const Language = z.enum(["javascript", "python"]);
export type Language = z.infer<typeof Language>;

/** Docker image + command used by the worker to run a solution file. */
export const LANGUAGE_RUNTIMES: Record<
  Language,
  { image: string; fileName: string; runCommand: string[] }
> = {
  javascript: {
    image: "coderoom-runner-javascript",
    fileName: "main.js",
    runCommand: ["node", "/sandbox/main.js"],
  },
  python: {
    image: "coderoom-runner-python",
    fileName: "main.py",
    runCommand: ["python3", "-u", "/sandbox/main.py"],
  },
};
