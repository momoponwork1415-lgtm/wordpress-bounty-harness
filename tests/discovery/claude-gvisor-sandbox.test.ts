import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GvisorClaudeSandbox } from "../../src/discovery/index.js";
import { measureCanonicalSourceTree } from "../../src/infrastructure/canonical-source-tree.js";

describe("Claude gVisor sandbox", () => {
  it("runs the pinned image under runsc with only the Trial grant, passed outside argv", async () => {
    const root = await mkdtemp(join(tmpdir(), "gvisor-claude-"));
    try {
      const source = join(root, "source");
      await mkdir(source);
      await writeFile(join(source, "fixed.php"), "<?php");
      const tree = await measureCanonicalSourceTree(source, {
        maxEntries: 10,
        maxBytes: 1024,
      });
      const calls: {
        args: string[];
        stdin: string | undefined;
        hostEnvironment: Readonly<Record<string, string>> | undefined;
      }[] = [];
      const sandbox = new GvisorClaudeSandbox({
        dockerExecutablePath: "/usr/bin/docker",
        image: `claude@sha256:${"a".repeat(64)}`,
        scratchRootDirectory: root,
        maxOutputBytes: 1024 * 1024,
        timeoutMs: 60_000,
        runDocker: async (
          args,
          stdin,
          _timeoutMs,
          _signal,
          hostEnvironment,
        ) => {
          calls.push({ args: [...args], stdin, hostEnvironment });
          return {
            kind: "exited",
            exitCode: 0,
            stdout: args.includes("--version") ? "2.1.296 (Claude Code)\n" : "",
            stderr: "",
          };
        },
      });
      const grantToken = "t".repeat(43);
      const result = await sandbox.execute({
        grant: {
          baseUrl: "http://172.20.0.5:8080",
          authorization: `Bearer ${grantToken}`,
          dockerNetworkName: "trial-internal",
          model: "claude-opus-5-5",
          protocol: "anthropic-messages",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        input: {
          prompt: "Objective.",
          resumePrompt: "Before giving up.",
          minimumActiveMs: 1,
          model: "claude-opus-5-5",
          effort: "high",
          outputSchema: {},
        },
        sourceMount: { directory: source, expectedTree: tree },
        dependencyMounts: [],
        labHost: { name: "wordpress", ipv4: "172.20.0.2" },
      });
      expect(result).toMatchObject({
        status: "exited",
        cliVersion: "2.1.296",
        isolation: { backend: "gvisor", runtime: "runsc", fallbackUsed: false },
      });
      const probe = calls.find(({ args }) => args.includes("--version"));
      expect(probe?.args).toContain("--network=none");
      const agent = calls.find(({ args }) =>
        args.includes("--network=trial-internal"),
      );
      expect(agent?.args).toEqual(
        expect.arrayContaining([
          "--runtime=runsc",
          "--read-only",
          "--cap-drop=ALL",
          "--env=ANTHROPIC_AUTH_TOKEN",
          "--env=ANTHROPIC_BASE_URL=http://172.20.0.5:8080",
          "--env=CLAUDE_CODE_SUBAGENT_MODEL=claude-opus-5-5",
          "--add-host=wordpress:172.20.0.2",
          expect.stringMatching(/dst=\/workspace\/main,readonly$/),
        ]),
      );
      expect(JSON.stringify(calls.map(({ args }) => args))).not.toContain(
        grantToken,
      );
      expect(agent?.hostEnvironment).toEqual({
        ANTHROPIC_AUTH_TOKEN: grantToken,
      });
      expect(JSON.parse(agent?.stdin ?? "{}")).toMatchObject({
        prompt: "Objective.",
      });
      expect(calls.at(-1)?.args.slice(0, 2)).toEqual(["rm", "--force"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a grant for another protocol before starting anything", async () => {
    const calls: string[][] = [];
    const sandbox = new GvisorClaudeSandbox({
      dockerExecutablePath: "/usr/bin/docker",
      image: `claude@sha256:${"a".repeat(64)}`,
      scratchRootDirectory: tmpdir(),
      maxOutputBytes: 1024,
      timeoutMs: 1000,
      runDocker: async (args) => {
        calls.push([...args]);
        return { kind: "exited", exitCode: 0, stdout: "", stderr: "" };
      },
    });
    await expect(
      sandbox.execute({
        grant: {
          baseUrl: "http://172.20.0.5:8080",
          authorization: `Bearer ${"t".repeat(43)}`,
          dockerNetworkName: "trial-internal",
          model: "gpt-6-sol",
          protocol: "responses",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        input: {
          prompt: "p",
          resumePrompt: "r",
          minimumActiveMs: 1,
          model: "gpt-6-sol",
          effort: "high",
          outputSchema: {},
        },
        sourceMount: {
          directory: tmpdir(),
          expectedTree: {
            digest: `sha256:${"a".repeat(64)}`,
            entries: 1,
            bytes: 1,
          },
        },
        dependencyMounts: [],
      }),
    ).rejects.toThrow("Claude sandbox command is not admitted");
    expect(calls).toEqual([]);
  });
});
