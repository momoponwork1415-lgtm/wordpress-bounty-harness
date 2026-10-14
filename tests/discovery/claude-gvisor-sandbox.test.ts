import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GvisorClaudeSandbox } from "../../src/discovery/index.js";
import { measureCanonicalSourceTree } from "../../src/infrastructure/canonical-source-tree.js";

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
          stdout: "2.1.296 (Claude Code)\n",
          stderr: "",
        };
      },
    });
    expect(await sandbox.probe()).toEqual({
      cliVersion: "2.1.296",
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

  it("passes only a trial grant to the sandbox in subscription mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "gvisor-claude-grant-"));
    try {
      const source = join(root, "source");
      await mkdir(source);
      await writeFile(join(source, "fixed.txt"), "source");
      const tree = await measureCanonicalSourceTree(source, {
        maxEntries: 10,
        maxBytes: 1024,
      });
      const calls: string[][] = [];
      const sandbox = new GvisorClaudeSandbox({
        dockerExecutablePath: "/usr/bin/docker",
        image: `sha256:${"a".repeat(64)}`,
        scratchRootDirectory: root,
        maxOutputBytes: 1024 * 1024,
        timeoutMs: 60_000,
        runDocker: async (args) => {
          calls.push([...args]);
          return {
            kind: "exited",
            exitCode: 0,
            stdout: args.includes("--version") ? "2.1.296 (Claude Code)\n" : "",
            stderr: "",
          };
        },
      });
      const grantToken = "t".repeat(43);
      await sandbox.execute({
        grant: {
          baseUrl: "http://172.20.0.5:8080",
          authorization: `Bearer ${grantToken}`,
          dockerNetworkName: "trial-internal",
          model: "claude-opus-5-5",
          protocol: "anthropic-messages",
          anthropicAuthentication: "subscription-token",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        model: "claude-opus-5-5",
        effort: "high",
        prompt: "Inspect fixed source",
        outputSchema: {},
        source: { directory: source, tree },
        labHost: { name: "wordpress", ipv4: "172.20.0.2" },
        deadline: new Date(Date.now() + 60_000).toISOString(),
      });
      const agentArgs = calls.find((args) =>
        args.includes("--network=trial-internal"),
      );
      expect(agentArgs).toContain(`--env=ANTHROPIC_AUTH_TOKEN=${grantToken}`);
      expect(agentArgs).toContain("--env=ANTHROPIC_BETAS=oauth-2025-04-20");
      expect(agentArgs).toContain("--env=CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0");
      expect(agentArgs).not.toContain(`--env=ANTHROPIC_API_KEY=${grantToken}`);
      expect(agentArgs).toContain("--runtime=runsc");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
