import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LANGUAGE_RUNTIMES, type Language } from "@coderoom/shared";
import { buildDockerRunArgs, DEFAULT_PIDS_LIMIT } from "./dockerArgs.js";

export interface RunInput {
  language: Language;
  code: string;
  stdin: string;
  timeoutMs: number;
  memoryMb: number;
  cpus: number;
}

export interface RunOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  /** Heuristic: exit 137 without our timeout => killed by the OOM killer. */
  oomKilled: boolean;
  timeMs: number;
}

const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Run code once in a fresh, locked-down container. First-pass implementation (build step 2):
 * still needs integration tests for infinite loop, fork bomb, memory bomb, network, fs writes.
 */
export async function runInSandbox(input: RunInput): Promise<RunOutput> {
  const runtime = LANGUAGE_RUNTIMES[input.language];
  const containerName = `cr-${randomUUID()}`;
  const dir = await mkdtemp(path.join(os.tmpdir(), "coderoom-"));

  try {
    const file = path.join(dir, runtime.fileName);
    await writeFile(file, input.code, "utf8");
    await chmod(dir, 0o755);
    await chmod(file, 0o644);

    const args = buildDockerRunArgs({
      containerName,
      image: runtime.image,
      hostCodeDir: dir,
      command: runtime.runCommand,
      limits: { memoryMb: input.memoryMb, cpus: input.cpus, pidsLimit: DEFAULT_PIDS_LIMIT },
    });

    return await new Promise<RunOutput>((resolve, reject) => {
      const started = Date.now();
      const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const append = (current: string, chunk: Buffer) =>
        current.length >= MAX_OUTPUT_BYTES ? current : (current + chunk.toString("utf8")).slice(0, MAX_OUTPUT_BYTES);
      child.stdout.on("data", (c: Buffer) => (stdout = append(stdout, c)));
      child.stderr.on("data", (c: Buffer) => (stderr = append(stderr, c)));

      // Killing the docker CLI is not enough; kill the container itself.
      const timer = setTimeout(() => {
        timedOut = true;
        spawn("docker", ["kill", containerName], { stdio: "ignore" });
      }, input.timeoutMs);

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr,
          exitCode,
          timedOut,
          oomKilled: !timedOut && exitCode === 137,
          timeMs: Date.now() - started,
        });
      });

      child.stdin.on("error", () => {
        /* container may exit before reading stdin */
      });
      child.stdin.end(input.stdin);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
