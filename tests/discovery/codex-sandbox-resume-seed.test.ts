import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { measureCanonicalSourceTree } from "../../src/infrastructure/canonical-source-tree.js";
import {
  GvisorCodexSandbox,
  type CodexSandboxCommand,
} from "../../src/discovery/index.js";

const digest = `sha256:${"a".repeat(64)}`;
const ROOT_THREAD = "11111111-2222-4333-8444-555555555555";
const ROOT_PATH = "2026/10/19/rollout-2026-10-19T00-00-00-root.jsonl";
const CHILD_PATH = "2026/10/19/rollout-2026-10-19T00-01-00-child.jsonl";
const rootRollout = `${JSON.stringify({
  timestamp: "2026-10-19T00:00:00Z",
  type: "session_meta",
  payload: { id: ROOT_THREAD, source: "exec" },
})}\nROOT_HISTORY\n`;
const childRollout = `${JSON.stringify({
  timestamp: "2026-10-19T00:01:00Z",
  type: "session_meta",
  payload: {
    id: "child-1",
    source: {
      subagent: {
        thread_spawn: {
          parent_thread_id: ROOT_THREAD,
          depth: 1,
          agent_path: "/root/child_1",
        },
      },
    },
  },
})}\nCHILD_HISTORY\n`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gvisor-resume-seed-"));
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "main.php"), "<?php");
  const expectedTree = await measureCanonicalSourceTree(source, {
    maxEntries: 10,
    maxBytes: 1024,
  });
  const seen: {
    sessions: Record<string, string>;
    research: Record<string, string>;
    args: string[];
    codexHome: string | undefined;
    researchDirectory: string | undefined;
  } = {
    sessions: {},
    research: {},
    args: [],
    codexHome: undefined,
    researchDirectory: undefined,
  };
  const sandbox = new GvisorCodexSandbox({
    dockerExecutablePath: "/usr/bin/docker",
    image: `node@${digest}`,
    bundledCatalogPath: "/opt/codex/model-catalog.json",
    scratchRootDirectory: root,
    ownerDirectory: join(root, "discovery-owners"),
    maxOutputBytes: 1024 * 1024,
    timeoutMs: 60_000,
    runDocker: async (args) => {
      if (args.includes("--entrypoint=node")) {
        seen.args = [...args];
        const mountOf = (dst: string) =>
          new RegExp(`^--mount=type=bind,src=(.+),dst=${dst}$`).exec(
            args.find((arg) => arg.endsWith(`,dst=${dst}`)) ?? "",
          )?.[1];
        const codexHome = mountOf("/tmp/codex");
        const researchDirectory = mountOf("/workspace/research");
        seen.codexHome = codexHome;
        seen.researchDirectory = researchDirectory;
        for (const path of [ROOT_PATH, CHILD_PATH]) {
          const file = join(codexHome!, "sessions", ...path.split("/"));
          if ((await stat(file).catch(() => undefined)) !== undefined)
            seen.sessions[path] = await readFile(file, "utf8");
        }
        for (const path of ["notes/plan.md"]) {
          const file = join(researchDirectory!, ...path.split("/"));
          if ((await stat(file).catch(() => undefined)) !== undefined)
            seen.research[path] = await readFile(file, "utf8");
        }
        // The resumed CLI appends to the restored Root rollout, as a real run would.
        await writeFile(
          join(codexHome!, "sessions", ...ROOT_PATH.split("/")),
          `${rootRollout}RESUMED_TURN\n`,
        );
      }
      return {
        kind: "exited" as const,
        exitCode: 0,
        stdout: args.includes("--version")
          ? "codex-cli 0.161.0\n"
          : args.includes("--entrypoint=sha256sum")
            ? `${"b".repeat(64)}  /opt/codex/model-catalog.json\n`
            : `${JSON.stringify({ type: "thread.started", thread_id: ROOT_THREAD })}\n`,
        stderr: "",
      };
    },
  });
  const command = (
    resume: CodexSandboxCommand["resume"],
    overrides: Partial<CodexSandboxCommand> = {},
  ): CodexSandboxCommand => ({
    executable: "codex",
    args: ["exec", "--json", "-"],
    stdin: "Initial objective",
    minimumActiveMs: 1000,
    resumeArgs: ["exec", "resume", "--json"],
    resumePrompt: "Before giving up, keep exploring.",
    ...(resume === undefined ? {} : { resume }),
    supportFiles: [
      { path: "/opt/codex-support/report-schema.json", content: "{}" },
    ],
    grant: {
      baseUrl: "http://172.28.0.2:8080",
      authorization: `Bearer ${randomBytes(32).toString("hex")}`,
      dockerNetworkName: "internal-run",
      model: "gpt-6-sol",
      protocol: "responses",
      expiresAt: "2026-10-19T02:00:00Z",
    },
    sourceMount: {
      directory: source,
      path: "/workspace/main",
      mode: "ro",
      expectedTree,
    },
    researchMount: { path: "/workspace/research", mode: "rw" },
    ...overrides,
  });
  return { root, source, sandbox, command, seen };
}

const seed = {
  threadId: ROOT_THREAD,
  sessions: [
    { path: ROOT_PATH, content: rootRollout },
    { path: CHILD_PATH, content: childRollout },
  ],
  research: [{ path: "notes/plan.md", content: Buffer.from("plan\n") }],
};

describe("gVisor sandbox resume seed (ADR 0036)", () => {
  it("restores session files and notes at their relative paths and starts the runner on the thread", async () => {
    const { root, sandbox, command, seen } = await fixture();
    try {
      const result = await sandbox.execute(command(seed));
      expect(seen.sessions).toEqual({
        [ROOT_PATH]: rootRollout,
        [CHILD_PATH]: childRollout,
      });
      expect(seen.research).toEqual({ "notes/plan.md": "plan\n" });
      // Same isolation flags as any run; the thread id is the runner's last argument.
      expect(seen.args).toContain("--runtime=runsc");
      expect(seen.args).toContain("--read-only");
      expect(seen.args.at(-1)).toBe(ROOT_THREAD);
      expect(seen.args.at(-2)).toBe("Before giving up, keep exploring.");
      // The seeded files are captured back with their paths, Root appended.
      expect(result.rolloutPaths).toEqual([ROOT_PATH, CHILD_PATH]);
      expect(result.rollouts?.[0]).toContain("RESUMED_TURN");
      expect(result.rollouts?.[1]).toBe(childRollout);
      // Codex home and notes are disposable: gone after the run.
      expect(await stat(seen.codexHome!).catch(() => "gone")).toBe("gone");
      expect(await stat(seen.researchDirectory!).catch(() => "gone")).toBe(
        "gone",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a seed outside the sessions layout, a thread without a Root file, or one without the runner", async () => {
    const { root, sandbox, command } = await fixture();
    try {
      for (const bad of [
        {
          ...seed,
          sessions: [{ path: "../escape/rollout-x.jsonl", content: "x" }],
        },
        { ...seed, sessions: [{ path: "2026/10/19/notes.txt", content: "x" }] },
        { ...seed, sessions: [] },
        {
          ...seed,
          research: [{ path: "../plan.md", content: Buffer.from("x") }],
        },
        {
          ...seed,
          research: [{ path: "/abs/plan.md", content: Buffer.from("x") }],
        },
        { ...seed, threadId: "not a thread id" },
      ])
        await expect(sandbox.execute(command(bad))).rejects.toThrow(
          "Codex sandbox command is not admitted",
        );
      const {
        minimumActiveMs: _minimum,
        resumeArgs: _resumeArgs,
        resumePrompt: _resumePrompt,
        ...withoutRunner
      } = command(seed);
      await expect(sandbox.execute(withoutRunner)).rejects.toThrow(
        "Codex sandbox command is not admitted",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not start when the source differs from the fixed Snapshot tree", async () => {
    const { root, source, sandbox, command, seen } = await fixture();
    try {
      await writeFile(join(source, "main.php"), "<?php // changed");
      await expect(sandbox.execute(command(seed))).rejects.toThrow(
        "Codex source differs from the fixed snapshot tree",
      );
      expect(seen.args).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
