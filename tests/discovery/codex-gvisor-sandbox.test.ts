import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { measureCanonicalSourceTree } from "../../src/infrastructure/canonical-source-tree.js";
import { GvisorCodexSandbox } from "../../src/discovery/index.js";

const digest = `sha256:${"a".repeat(64)}`;

describe("gVisor Codex sandbox", () => {
  it("measures the source and CLI before a pinned runsc execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "gvisor-codex-"));
    try {
      const source = join(root, "source");
      await mkdir(source);
      await writeFile(join(source, "main.txt"), "fixed source");
      const expectedTree = await measureCanonicalSourceTree(source, {
        maxEntries: 10,
        maxBytes: 1024,
      });
      const calls: { args: readonly string[]; stdin: string | undefined }[] =
        [];
      const sandbox = new GvisorCodexSandbox({
        dockerExecutablePath: "/usr/bin/docker",
        image: `node@${digest}`,
        bundledCatalogPath: "/opt/codex/model-catalog.json",
        scratchRootDirectory: root,
        maxOutputBytes: 1024 * 1024,
        timeoutMs: 60_000,
        clock: () => new Date("2026-10-08T07:00:00Z"),
        runDocker: async (args, stdin) => {
          calls.push({ args, stdin });
          const output = args.includes("--version")
            ? "codex-cli 0.161.0\n"
            : args.includes("--entrypoint=sha256sum")
              ? `${"b".repeat(64)}  /opt/codex/model-catalog.json\n`
              : "{}\n";
          return { kind: "exited", exitCode: 0, stdout: output, stderr: "" };
        },
      });
      const grantToken = randomBytes(32).toString("hex");
      const command = {
        executable: "codex" as const,
        args: ["exec", "--json"],
        stdin: "Inspect the source.",
        supportFiles: [
          { path: "/opt/codex-support/report-schema.json", content: "{}" },
        ],
        grant: {
          baseUrl: "http://172.28.0.2:8080",
          authorization: `Bearer ${grantToken}`,
          dockerNetworkName: "internal-run",
          model: "gpt-6.1-sol",
          protocol: "responses" as const,
          expiresAt: "2026-10-08T07:30:00Z",
        },
        sourceMount: {
          directory: source,
          path: "/workspace/main" as const,
          mode: "ro" as const,
          expectedTree,
        },
      };
      const result = await sandbox.execute(command);
      expect(result).toMatchObject({
        status: "exited",
        cliVersion: "0.161.0",
        bundledCatalogDigest: `sha256:${"b".repeat(64)}`,
        isolation: { backend: "gvisor", runtime: "runsc", fallbackUsed: false },
      });
      expect(calls).toHaveLength(3);
      expect(calls.every(({ args }) => args.includes("--runtime=runsc"))).toBe(
        true,
      );
      expect(calls[0]?.args).toContain("--network=none");
      expect(calls[1]?.args).toContain("--network=none");
      expect(calls[2]?.args).toContain("--network=internal-run");
      expect(calls[2]?.args).toContain(
        `--mount=type=bind,src=${source},dst=/workspace/main,readonly`,
      );
      expect(calls[2]?.stdin).toBe(command.stdin);
      await expect(
        sandbox.execute({
          ...command,
          sourceMount: {
            ...command.sourceMount,
            expectedTree: { ...expectedTree, digest },
          },
        }),
      ).rejects.toThrow();
      expect(calls).toHaveLength(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
