import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CLI_COMMANDS,
  CLI_USAGE,
  runCli,
  type CliEnvironment,
} from "../../src/cli/index.js";

// The usage text as it was before the commands became a table (2026-10-18).
const PINNED_USAGE = [
  "usage: harness [--state <dir>] <command>",
  "  select --config <path> [--minimum <n>]",
  "  campaign run <slug>|--all --campaign <id> --config <path> [--selection <path>] [--repeat <n>] [--retry-incomplete] [--defer-verification]",
  "  continuous run --config <path> --selection <path> [--campaign-prefix <text>] [--verify-concurrency <n>] [--notify <command>] [--resume]",
  "  continuous stop",
  "  continuous resume",
  "  continuous status",
  "  review [--campaign <id>]",
  "  review parked --campaign <id> | --since <ISO>",
  "  review export --campaign <id> --finding <id>",
  "  review decide --campaign <id> --finding <id> --decision accept|reject|defer --reason <code> [--opened <digest>]... [--duplicate unavailable|no-match|possible-match:<ref>] [--by <name>] [--minutes <n>]",
  "  review reproduced --campaign <id> --finding <id> --result match|mismatch|unavailable [--minutes <n>]",
  "  review dedupe --campaign <id> --finding <id>",
  "  review scope --campaign <id> --finding <id>",
  "  review reverify --campaign <id> --finding <id> --config <path> [--version <target-version>]",
  "  verify next --campaign <id> --config <path> [--handoff <dir> [--finding <id>] [--port <n>] [--db-port <n>]]",
  "  review draft --campaign <id> --finding <id> --programme <id> --file <path> [--prepared-by human|ai]",
  "  review authorize --candidate <id> --draft <digest> --to <destination> [--by <name>]",
  "  review submitted --candidate <id> --draft <digest> --to <destination>",
  "  review outcome --candidate <id> --outcome triaged|resolved|duplicate|informative|not-applicable|rejected [--reward <usd>]",
  "  ledger funnel --campaign <id> | --since <ISO>",
  "  ledger stops [--campaign <id>] [--since <ISO>]",
  "  ledger usage [--campaign <id>]",
  "  ledger runtime [--campaign <id>]",
  "  history status",
  "  runtime check --config <path>",
  "  lab cleanup --config <path> [--remove]",
  "  lab up --for-review --campaign <id> --finding <id>",
  "  lab up --campaign <id> --finding <id> --config <path> [--port <n>] [--db-port <n>]",
  "  lab down [--config <path>]",
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
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

describe("command table", () => {
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
