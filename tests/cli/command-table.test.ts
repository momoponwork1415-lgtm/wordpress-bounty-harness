import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CLI_COMMANDS,
  CLI_USAGE,
  runCli,
  type CliEnvironment,
  type CliProfile,
} from "../../src/cli/index.js";

// The usage text as it was before the commands became a table (2026-10-18).
const PINNED_USAGE = [
  "usage: harness [--state <dir>] <command>",
  "  select --config <path> [--minimum <n>]",
  "  campaign run <slug>|--all --campaign <id> --config <path> [--selection <path>] [--repeat <n>]",
  "  continuous run --config <path> --selection <path> [--campaign-prefix <text>] [--notify <command>] [--resume]",
  "  continuous stop [--campaign-prefix <text>]",
  "  continuous resume [--campaign-prefix <text>]",
  "  continuous status",
  "  review [--campaign <id>]",
  "  review parked --campaign <id>",
  "  review restore --campaign <id> --finding <id> --reason <text> [--by <name>]",
  "  review group-cache --output <file>",
  "  review leads --campaign <id>",
  "  review export --campaign <id> --finding <id> [--version 2]",
  "  review observe --campaign <id> --finding <id> --receipt <digest> --result match|mismatch|unavailable --evidence <path> --by <human> [--ordinary-site yes|no --ordinary-site-reason <text>]",
  "  review decide --campaign <id> --finding <id> --decision accept|reject|defer --reason <code> [--opened <digest>]... [--duplicate no-match|unavailable[:<reason>]|possible-match:<ref> [--duplicate-note <path>]] [--reproduced match|mismatch|unavailable [--reproduce-minutes <n>]] [--by <name>] [--minutes <n>]",
  "  review dedupe --campaign <id> --finding <id>",
  "  review scope --campaign <id> --finding <id>",
  "  review reverify --campaign <id> --finding <id> --config <path> [--version <target-version>] [--handoff <dir> [--port <n>] [--db-port <n>]]",
  "  verify next --config <path> --handoff <dir> [--campaign <id> [--finding <id>]] [--port <n>] [--db-port <n>] [--hold-minutes <n>]",
  "  review draft --campaign <id> --finding <id> --programme <id> --file <path> [--prepared-by human|ai]",
  "  review authorize --candidate <id> --draft <digest> --to <destination> --by <name>",
  "  review submitted --candidate <id> --draft <digest> --to <destination>",
  "  review submitted --external --campaign <id> --finding <id> --to <destination> --on <date> --by <who>",
  "  review outcome --candidate <id> --outcome triaged|resolved|duplicate|informative|not-applicable|rejected [--reward <usd>]",
  "  ledger funnel --campaign <id> | --since <ISO>",
  "  ledger stops [--campaign <id>] [--since <ISO>]",
  "  ledger resumes [--campaign <id>] [--since <ISO>]",
  "  ledger usage [--campaign <id>]",
  "  ledger runtime [--campaign <id>]",
  "  history status",
  "  runtime check --config <path>",
  "  lab cleanup --config <path> [--remove]",
  "  lab up --for-review --campaign <id> --finding <id>",
  "  lab down [--lab <id>] [--config <path>]",
  // Added after the table (ADR 0036); registered last so the pinned lines above stay in place.
  "  campaign resume --campaign <id> --run <runId> --config <path>",
  "  continuous concurrency [<n>] [--runtime <name>] --config <path>",
  "  review held --campaign <id>",
].join("\n");

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function run(...argv: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "wbh-command-table-"));
  directories.push(directory);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(
    argv,
    { stateDirectory: directory, profile: {} } as unknown as CliEnvironment,
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );
  return {
    code,
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n"),
    directory,
  };
}

describe("command table", () => {
  it("passes a bounded human observation hold window from verify next to the profile (#605)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wbh-hold-window-"));
    directories.push(directory);
    let wallMs: number | undefined;
    const lines: string[] = [];
    const code = await runCli(
      [
        "verify",
        "next",
        "--config",
        "/unused/campaign.json",
        "--handoff",
        join(directory, "handoff"),
        "--hold-minutes",
        "180",
      ],
      {
        stateDirectory: directory,
        profile: {
          verifyNext: async (
            _state: unknown,
            input: Parameters<NonNullable<CliProfile["verifyNext"]>>[1],
          ) => {
            wallMs = input.observation?.wallMs;
            await input.observation?.present({
              ref: { campaignId: "c", findingId: "f", verificationId: "v" },
              labId: "0f0e0d0c-0b0a-4908-8706-050403020100",
              endpoint: "http://wordpress",
              attackerAccounts: {
                subscriber: {
                  username: "attacker",
                  password: "attacker-secret",
                },
              },
              administrator: { username: "admin", password: "admin-secret" },
              host: {
                url: "http://127.0.0.1:80",
                hostHeader: "wordpress",
                port: 80,
              },
              receipt: { digest: `sha256:${"a".repeat(64)}`, path: "/receipt" },
              expiresAt: new Date(0).toISOString(),
            });
            return null;
          },
        },
      } as unknown as CliEnvironment,
      {
        stdout: (line) => lines.push(line),
        stderr: (line) => lines.push(line),
      },
    );
    expect(code).toBe(0);
    expect(wallMs).toBe(180 * 60_000);
    expect(lines).toContain("no verification pending");
    const accessLine = lines.find((line) =>
      line.startsWith("review administrator: private Lab access file "),
    );
    expect(accessLine).toBeDefined();
    const accessPath = accessLine!.slice(
      "review administrator: private Lab access file ".length,
    );
    expect(JSON.parse(await readFile(accessPath, "utf8"))).toMatchObject({
      administrator: { password: "admin-secret" },
      attackerAccounts: { subscriber: { password: "attacker-secret" } },
    });
    expect((await stat(accessPath)).mode & 0o777).toBe(0o600);
    expect(lines.join("\n")).not.toContain("admin-secret");
    expect(lines.join("\n")).not.toContain("attacker-secret");
  });

  it("routes lab down --lab to the named Lab without choosing another Lab (#605)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wbh-lab-id-down-"));
    directories.push(directory);
    const labId = "0f0e0d0c-0b0a-4908-8706-050403020100";
    let requested: string | undefined;
    const lines: string[] = [];
    const code = await runCli(
      ["lab", "down", "--lab", labId],
      {
        stateDirectory: directory,
        profile: {
          labDown: async (
            _state: unknown,
            input: Parameters<CliProfile["labDown"]>[1],
          ) => {
            requested = input.labId;
            return {
              labId,
              removed: { containers: [], networks: [], volumes: [] },
              remaining: { containers: [], networks: [], volumes: [] },
            };
          },
        },
      } as unknown as CliEnvironment,
      {
        stdout: (line) => lines.push(line),
        stderr: (line) => lines.push(line),
      },
    );
    expect(code).toBe(0);
    expect(requested).toBe(labId);
    expect(lines[0]).toBe(`lab ${labId} down`);
  });

  it("renders the usage text from the rows, byte for byte as before", () => {
    expect(CLI_USAGE).toBe(PINNED_USAGE);
  });

  it("prints the usage text and exits 2 for an unknown or incomplete command", async () => {
    for (const argv of [[], ["nonsense"], ["review", "nonsense"], ["lab"]]) {
      const result = await run(...argv);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(PINNED_USAGE);
    }
  });

  it("names an unknown flag, then prints the usage text, and exits 2", async () => {
    const result = await run("select", "--no-such-flag");
    expect(result.code).toBe(2);
    expect(result.stderr.startsWith("Unknown option '--no-such-flag'")).toBe(
      true,
    );
    expect(result.stderr.endsWith(`\n${PINNED_USAGE}`)).toBe(true);
  });

  it("rejects the retired campaign retry override before initializing state", async () => {
    const result = await run(
      "campaign",
      "run",
      "--all",
      "--campaign",
      "synthetic",
      "--config",
      "/unused/campaign.json",
      "--retry-incomplete",
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown option '--retry-incomplete'");
    expect(result.stdout).toBe("");
    expect(await readdir(result.directory)).toEqual([]);
  });

  it("keeps each usage line under its own row and every flag it names declared by that row", () => {
    const names = CLI_COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    for (const command of CLI_COMMANDS) {
      expect(command.usage.length).toBeGreaterThan(0);
      for (const line of command.usage) {
        expect(
          line === command.name || line.startsWith(`${command.name} `),
        ).toBe(true);
        for (const [, flag] of line.matchAll(/--([a-z-]+)/g))
          expect(Object.keys(command.options)).toContain(flag);
      }
    }
  });
});
