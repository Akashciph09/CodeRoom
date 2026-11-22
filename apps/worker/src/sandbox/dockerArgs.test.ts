import { describe, expect, it } from "vitest";
import { buildDockerRunArgs } from "./dockerArgs.js";

const args = buildDockerRunArgs({
  containerName: "cr-test",
  image: "coderoom-runner-python",
  hostCodeDir: "/tmp/cr-test",
  command: ["python3", "/sandbox/main.py"],
  limits: { memoryMb: 256, cpus: 0.5, pidsLimit: 64 },
});

const flagValue = (flag: string) => args[args.indexOf(flag) + 1];

describe("buildDockerRunArgs", () => {
  it("disables networking", () => {
    expect(flagValue("--network")).toBe("none");
  });

  it("caps memory with no swap", () => {
    expect(flagValue("--memory")).toBe("256m");
    expect(flagValue("--memory-swap")).toBe("256m");
  });

  it("applies cpu and pid limits", () => {
    expect(flagValue("--cpus")).toBe("0.5");
    expect(flagValue("--pids-limit")).toBe("64");
  });

  it("locks down the filesystem and privileges", () => {
    expect(args).toContain("--read-only");
    expect(flagValue("--cap-drop")).toBe("ALL");
    expect(flagValue("--security-opt")).toBe("no-new-privileges");
    expect(flagValue("--user")).toBe("65534:65534");
  });

  it("mounts code read-only", () => {
    expect(flagValue("-v")).toBe("/tmp/cr-test:/sandbox:ro");
  });

  it("puts the image right before the command", () => {
    const i = args.indexOf("coderoom-runner-python");
    expect(args.slice(i + 1)).toEqual(["python3", "/sandbox/main.py"]);
  });
});
