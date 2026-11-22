export interface SandboxLimits {
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
}

export interface DockerRunSpec {
  containerName: string;
  image: string;
  /** Host directory holding the solution file; mounted read-only at /sandbox. */
  hostCodeDir: string;
  command: string[];
  limits: SandboxLimits;
}

export const DEFAULT_PIDS_LIMIT = 64;

/**
 * Build `docker run` arguments for one untrusted execution.
 * Every flag here is a security control — see CLAUDE.md before removing any.
 */
export function buildDockerRunArgs(spec: DockerRunSpec): string[] {
  const { limits } = spec;
  return [
    "run",
    "--rm",
    "-i", // test input arrives on stdin
    "--name", spec.containerName,
    "--network", "none",
    "--memory", `${limits.memoryMb}m`,
    "--memory-swap", `${limits.memoryMb}m`, // equal to --memory => no swap
    "--cpus", String(limits.cpus),
    "--pids-limit", String(limits.pidsLimit),
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--user", "65534:65534", // nobody
    "--ulimit", "nofile=64:64",
    "--ulimit", "fsize=1048576:1048576", // max 1MB per written file
    "-v", `${spec.hostCodeDir}:/sandbox:ro`,
    "-w", "/sandbox",
    spec.image,
    ...spec.command,
  ];
}
