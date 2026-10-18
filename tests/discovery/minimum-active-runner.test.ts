import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { MINIMUM_ACTIVE_RUNNER_SOURCE } from "../../src/discovery/minimum-active-runner.js";
import { GvisorCodexSandbox } from "../../src/discovery/codex-gvisor-sandbox.js";
import { measureCanonicalSourceTree } from "../../src/infrastructure/canonical-source-tree.js";

it("resumes the same Root session with the short directive until the active time floor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minimum-active-runner-"));
  try {
    const runner = join(directory, "runner.mjs");
    const fakeCodex = join(directory, "codex");
    await writeFile(runner, MINIMUM_ACTIVE_RUNNER_SOURCE);
    await writeFile(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        "let prompt = '';",
        "process.stdin.on('data', (chunk) => prompt += chunk);",
        "process.stdin.on('end', () => {",
        "  const args = process.argv.slice(2);",
        "  if (args.includes('resume') && !args.includes('root-thread')) process.exit(2);",
        "  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'root-thread' }));",
        "  console.log(JSON.stringify({ type: 'turn.started' }));",
        "  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: prompt } }));",
        "  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));",
        "});",
      ].join("\n"),
      { mode: 0o755 },
    );
    const startedAt = Date.now();
    const child = spawn(
      process.execPath,
      [
        runner,
        "1000",
        JSON.stringify(["exec", "--json", "-"]),
        JSON.stringify(["exec", "resume", "--json"]),
        "Continue active source analysis.",
      ],
      {
        env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.stdin.end("Initial full objective");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    const exitCode = await new Promise<number | null>((resolve) =>
      child.on("close", resolve),
    );
    expect(exitCode, stderr).toBe(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1000);
    const messages = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.type === "item.completed")
      .map((event) => (event.item as Record<string, unknown>).text);
    expect(messages[0]).toBe("Initial full objective");
    expect(messages.length).toBeGreaterThan(1);
    expect(
      messages
        .slice(1)
        .every((text) => text === "Continue active source analysis."),
    ).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("runs the continuation driver only inside the gVisor agent container", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minimum-active-sandbox-"));
  try {
    const source = join(directory, "source");
    await mkdir(source);
    await writeFile(join(source, "main.php"), "<?php");
    const expectedTree = await measureCanonicalSourceTree(source, {
      maxEntries: 10,
      maxBytes: 1024,
    });
    const digest = `sha256:${"a".repeat(64)}`;
    const image = `node@${digest}`;
    const calls: string[][] = [];
    let driverSource = "";
    const sandbox = new GvisorCodexSandbox({
      dockerExecutablePath: "/usr/bin/docker",
      image,
      bundledCatalogPath: "/opt/codex/model-catalog.json",
      scratchRootDirectory: directory,
      maxOutputBytes: 1024 * 1024,
      timeoutMs: 10_000,
      runDocker: async (args) => {
        calls.push([...args]);
        if (args.includes("--entrypoint=node")) {
          const support = args.find((arg) =>
            arg.endsWith(",dst=/opt/codex-support,readonly"),
          );
          const staging =
            /^--mount=type=bind,src=(.+),dst=\/opt\/codex-support,readonly$/.exec(
              support ?? "",
            )?.[1];
          if (staging !== undefined)
            driverSource = await readFile(
              join(staging, "minimum-active-runner.mjs"),
              "utf8",
            );
        }
        return {
          kind: "exited" as const,
          exitCode: 0,
          stdout: args.includes("--version")
            ? "codex-cli 0.161.0\n"
            : args.includes("--entrypoint=sha256sum")
              ? `${"b".repeat(64)}  /opt/codex/model-catalog.json\n`
              : "{}\n",
          stderr: "",
        };
      },
    });
    await sandbox.execute({
      executable: "codex",
      args: ["exec", "--json", "-"],
      stdin: "Initial objective",
      minimumActiveMs: 1000,
      resumeArgs: ["exec", "resume", "--json"],
      resumePrompt: "Continue active source analysis.",
      supportFiles: [
        { path: "/opt/codex-support/report-schema.json", content: "{}" },
      ],
      grant: {
        baseUrl: "http://172.28.0.2:8080",
        authorization: `Bearer ${randomBytes(32).toString("hex")}`,
        dockerNetworkName: "internal-run",
        model: "gpt-6.1-sol",
        protocol: "responses",
        expiresAt: "2026-10-18T12:00:00Z",
      },
      sourceMount: {
        directory: source,
        path: "/workspace/main",
        mode: "ro",
        expectedTree,
      },
      researchMount: { path: "/workspace/research", mode: "rw" },
    });
    const invocation = calls.find((args) => args.includes("--entrypoint=node"));
    expect(invocation).toContain("--runtime=runsc");
    expect(invocation).toContain(
      "/opt/codex-support/minimum-active-runner.mjs",
    );
    expect(invocation).toContain("1000");
    expect(invocation).toContain("Continue active source analysis.");
    expect(driverSource).toBe(MINIMUM_ACTIVE_RUNNER_SOURCE);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
