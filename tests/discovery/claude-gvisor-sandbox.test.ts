import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GvisorClaudeSandbox } from "../../src/discovery/index.js";
import { measureCanonicalSourceTree } from "../../src/infrastructure/canonical-source-tree.js";
import { readDiscoveryOwners } from "../../src/infrastructure/lab-owner-record.js";

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
      const ownerDirectory = join(root, "discovery-owners");
      /** What a sweep in another state directory reads while the agent runs (#550). */
      let ownedWhileRunning: ReadonlySet<string> | undefined;
      const sandbox = new GvisorClaudeSandbox({
        dockerExecutablePath: "/usr/bin/docker",
        image: `claude@sha256:${"a".repeat(64)}`,
        scratchRootDirectory: root,
        ownerDirectory,
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
          if (args.includes("--network=trial-internal"))
            ownedWhileRunning = (await readDiscoveryOwners(ownerDirectory))
              .live;
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
          subagentModel: "claude-sonnet-5-5",
          protocol: "anthropic-messages",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        input: {
          prompt: "Objective.",
          resumePrompt: "Before giving up.",
          minimumActiveMs: 1,
          maxChildren: 4,
          model: "claude-opus-5-5",
          effort: "high",
          outputSchema: {},
        },
        subagentModel: "claude-sonnet-5-5",
        sourceMount: { directory: source, expectedTree: tree },
        dependencyMounts: [],
        labHost: { name: "wordpress", ipv4: "172.20.0.2" },
        controlHost: { name: "labctl", ipv4: "172.20.0.130" },
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
          // The Root and its side requests stay on the Root model.
          "--env=ANTHROPIC_MODEL=claude-opus-5-5",
          "--env=ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-opus-5-5",
          "--env=ANTHROPIC_SMALL_FAST_MODEL=claude-opus-5-5",
          // Every child runs on the profile's subagent model, whatever the Root asks.
          "--env=CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-5-5",
          "--env=CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1",
          // A refusal ends on Opus; Claude Code does not switch models.
          "--env=CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1",
          "--env=CLAUDE_CODE_NO_MODEL_FALLBACK=1",
          "--add-host=wordpress:172.20.0.2",
          "--add-host=labctl:172.20.0.130",
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
      // The runner's stdin is unchanged; only Claude Code reads the child model.
      expect(JSON.parse(agent?.stdin ?? "{}")).not.toHaveProperty(
        "subagentModel",
      );
      expect(calls.at(-1)?.args.slice(0, 2)).toEqual(["rm", "--force"]);
      const name = agent?.args.find((arg) => arg.startsWith("--name="));
      expect(name).toMatch(/^--name=claude-agent-[0-9a-f-]{36}$/);
      expect(ownedWhileRunning).toEqual(
        new Set([name?.slice("--name=".length)]),
      );
      expect((await readDiscoveryOwners(ownerDirectory)).live.size).toBe(0);
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
          maxChildren: 4,
          model: "gpt-6-sol",
          effort: "high",
          outputSchema: {},
        },
        subagentModel: "gpt-6-sol",
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

describe("Claude gVisor sandbox skills (ADR 0043)", () => {
  const skill =
    "---\nname: wbh-recon\ndescription: Use first.\n---\n\n# wbh-recon v1\n\nMap the plugin.\n";
  async function execute(
    root: string,
    command: {
      skills?: { name: string; content: string }[];
      inputSkills?: string[];
    },
    onRun: (home: string, stdin: string | undefined) => Promise<void>,
  ) {
    const source = await mkdtemp(join(root, "source-"));
    await writeFile(join(source, "fixed.php"), "<?php");
    const tree = await measureCanonicalSourceTree(source, {
      maxEntries: 10,
      maxBytes: 1024,
    });
    const sandbox = new GvisorClaudeSandbox({
      dockerExecutablePath: "/usr/bin/docker",
      image: `claude@sha256:${"a".repeat(64)}`,
      scratchRootDirectory: root,
      ownerDirectory: join(root, "discovery-owners"),
      maxOutputBytes: 1024 * 1024,
      timeoutMs: 60_000,
      runDocker: async (args, stdin) => {
        if (args.includes("--network=trial-internal")) {
          const home = args
            .map((arg) =>
              /^--mount=type=bind,src=(.+),dst=\/tmp\/claude$/.exec(arg),
            )
            .find((match) => match !== null)?.[1];
          await onRun(home!, stdin);
        }
        return {
          kind: "exited",
          exitCode: 0,
          stdout: args.includes("--version") ? "2.1.296 (Claude Code)\n" : "",
          stderr: "",
        };
      },
    });
    return sandbox.execute({
      grant: {
        baseUrl: "http://172.20.0.5:8080",
        authorization: `Bearer ${"t".repeat(43)}`,
        dockerNetworkName: "trial-internal",
        model: "claude-opus-5-5",
        subagentModel: "claude-opus-5-5",
        protocol: "anthropic-messages",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      input: {
        prompt: "Objective.",
        resumePrompt: "Before giving up.",
        minimumActiveMs: 1,
        maxChildren: 4,
        model: "claude-opus-5-5",
        effort: "high",
        outputSchema: {},
        ...(command.inputSkills === undefined
          ? {}
          : { skills: command.inputSkills }),
      },
      subagentModel: "claude-opus-5-5",
      sourceMount: { directory: source, expectedTree: tree },
      dependencyMounts: [],
      ...(command.skills === undefined ? {} : { skills: command.skills }),
    });
  }

  it("stages each skill under the config directory and names it on the runner's stdin", async () => {
    const root = await mkdtemp(join(tmpdir(), "gvisor-claude-skills-"));
    try {
      let staged: string | undefined;
      let input: unknown;
      const result = await execute(
        root,
        {
          skills: [{ name: "wbh-recon", content: skill }],
          inputSkills: ["wbh-recon"],
        },
        async (home, stdin) => {
          staged = await readFile(
            join(home, "skills", "wbh-recon", "SKILL.md"),
            "utf8",
          );
          input = JSON.parse(stdin ?? "{}");
        },
      );
      expect(result.status).toBe("exited");
      expect(staged).toBe(skill);
      expect(input).toMatchObject({ skills: ["wbh-recon"] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses names on stdin that differ from the staged skills, before starting anything", async () => {
    const root = await mkdtemp(join(tmpdir(), "gvisor-claude-badskills-"));
    try {
      let started = false;
      const onRun = async () => {
        started = true;
      };
      await expect(
        execute(root, { inputSkills: ["wbh-recon"] }, onRun),
      ).rejects.toThrow("not admitted");
      await expect(
        execute(
          root,
          {
            skills: [{ name: "wbh-recon", content: skill }],
            inputSkills: ["wbh-other"],
          },
          onRun,
        ),
      ).rejects.toThrow("not admitted");
      await expect(
        execute(
          root,
          { skills: [{ name: "wbh-recon", content: skill }] },
          onRun,
        ),
      ).rejects.toThrow("not admitted");
      expect(started).toBe(false);
      let input: unknown;
      await execute(root, {}, async (_, stdin) => {
        input = JSON.parse(stdin ?? "{}");
      });
      expect(input).not.toHaveProperty("skills");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
