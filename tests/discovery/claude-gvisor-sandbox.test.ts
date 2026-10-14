import { describe, expect, it } from "vitest";

import { GvisorClaudeSandbox } from "../../src/discovery/index.js";

describe("Claude cooperative gVisor resource admission", () => {
  it("probes the pinned image inside runsc with the six-CPU, eight-GiB ceiling", async () => {
    let args: readonly string[] = [];
    const sandbox = new GvisorClaudeSandbox({
      dockerExecutablePath: "/usr/bin/docker",
      image: `sha256:${"a".repeat(64)}`,
      scratchRootDirectory: "/tmp",
      maxOutputBytes: 1024 * 1024,
      timeoutMs: 60_000,
      runDocker: async (command) => {
        args = command;
        return {
          kind: "exited",
          exitCode: 0,
          stdout: "2.1.278 (Claude Code)\n",
          stderr: "",
        };
      },
    });
    expect(await sandbox.probe()).toEqual({
      cliVersion: "2.1.278",
      bundledCatalogDigest: "unavailable",
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "--runtime=runsc",
        "--network=none",
        "--memory=8192m",
        "--cpus=6",
        "--pids-limit=256",
        "--read-only",
        "--cap-drop=ALL",
      ]),
    );
  });
});
