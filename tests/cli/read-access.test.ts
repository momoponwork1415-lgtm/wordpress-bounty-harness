import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, type CliProfile, type CliState } from "../../src/cli/index.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger, type LedgerEventInput } from "../../src/ledger/index.js";
import { Review } from "../../src/review/index.js";

const NOW = "2026-10-23T12:00:00Z";
const DIGEST = `sha256:${"a".repeat(64)}`;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function unused(): never {
  throw new Error("This command must not call an operational profile method");
}

/** Only passive review and status interfaces are available in this fixture. */
function profile(overrides: Partial<CliProfile> = {}): CliProfile {
  return {
    review: (state) =>
      new Review({
        ledger: state.ledger,
        artifactStore: state.store,
        scopeEvaluator: {
          programmeIds: ["synthetic"],
          policyDigest: DIGEST,
          assess: unused,
        },
        factsProvider: { load: unused },
        clock: state.clock,
      }),
    historyStatus: () => ({ fresh: true, line: "synthetic history ready" }),
    stateDiffReader: () => ({ read: unused }),
    httpEvidenceReader: () => ({ read: unused }),
    verifierRecordReader: () => ({ read: unused }),
    select: unused,
    runCampaign: unused,
    cleanupLeftovers: unused,
    checkRuntime: unused,
    reverify: unused,
    labDown: unused,
    ...overrides,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wbh-cli-read-"));
  roots.push(root);
  const stateDirectory = join(root, "state");
  const databasePath = join(stateDirectory, "ledger.sqlite");
  return {
    root,
    stateDirectory,
    databasePath,
    async run(argv: readonly string[], testProfile = profile()) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runCli(
        argv,
        {
          stateDirectory,
          profile: testProfile,
          clock: () => new Date(NOW),
        },
        {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        },
      );
      return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
    },
    async seed() {
      await mkdir(stateDirectory);
      const artifactStore = new PrivateArtifactStore({
        rootDirectory: join(stateDirectory, "private-evidence"),
        maxEntries: 4,
        maxBytes: 1024,
      });
      const ledger = new Ledger({ databasePath, artifactStore });
      await ledger.append(effort);
      await ledger.append({
        schemaVersion: 1,
        identity: "finding-1",
        campaignId: "campaign-1",
        snapshotDigest: DIGEST,
        occurredAt: NOW,
        type: "finding-recorded",
        findingId: "finding-1",
        runId: "synthetic-record",
        category: "synthetic",
      });
      // An old, fixed mtime makes accidental writes visible without timing sleeps.
      await utimes(databasePath, new Date(0), new Date(0));
      return ledger;
    },
  };
}

const effort: LedgerEventInput = {
  schemaVersion: 1,
  identity: "effort-1",
  campaignId: "campaign-1",
  snapshotDigest: DIGEST,
  occurredAt: NOW,
  type: "human-effort-recorded",
  action: "read",
  minutes: 7,
};

async function databaseSnapshot(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      bytes: await readFile(databasePath),
      mtime: (await stat(databasePath, { bigint: true })).mtimeNs,
      schema: database
        .prepare(
          "SELECT name, type, tbl_name, sql FROM sqlite_master ORDER BY type, name",
        )
        .all(),
    };
  } finally {
    database.close();
  }
}

const readCommands: readonly (readonly string[])[] = [
  ["review"],
  ["review", "parked", "--campaign", "campaign-1"],
  ["review", "export", "--campaign", "campaign-1", "--finding", "finding-1"],
  ["review", "dedupe", "--campaign", "campaign-1", "--finding", "finding-1"],
  ["review", "held", "--campaign", "campaign-1"],
  ["ledger", "funnel", "--campaign", "campaign-1"],
  ["ledger", "stops"],
  ["ledger", "resumes"],
  ["ledger", "usage"],
  ["ledger", "runtime"],
  ["history", "status"],
  ["continuous", "status"],
];

describe("CLI validates input before opening state", () => {
  it.each([
    { label: "unknown command", argv: ["unknown"] },
    { label: "missing command", argv: [] },
    {
      label: "known flag belonging to another command",
      argv: ["ledger", "usage", "--finding", "finding-1"],
    },
    { label: "unknown flag", argv: ["ledger", "usage", "--unknown"] },
    {
      label: "missing required flag",
      argv: ["review", "export", "--campaign", "campaign-1"],
    },
    { label: "extra positional", argv: ["ledger", "usage", "extra"] },
  ])(
    "rejects $label without creating the state directory",
    async ({ argv }) => {
      const setup = await fixture();
      const result = await setup.run(argv);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("usage: harness");
      expect(result.stdout).toBe("");
      expect(await readdir(setup.root)).toEqual([]);
    },
  );

  it("does not create a --state override when command input is invalid", async () => {
    const setup = await fixture();
    const result = await setup.run([
      "--state",
      join(setup.root, "override"),
      "review",
      "export",
    ]);
    expect(result.code).toBe(2);
    expect(await readdir(setup.root)).toEqual([]);
  });

  const decide = (options: readonly string[]) => [
    "review",
    "decide",
    "--campaign",
    "campaign-1",
    "--finding",
    "finding-1",
    "--decision",
    "accept",
    "--reason",
    "synthetic-review",
    ...options,
  ];

  it.each([
    {
      label: "duplicate note without duplicate result",
      argv: decide(["--duplicate-note", "note.md"]),
    },
    {
      label: "reproduction minutes without reproduction result",
      argv: decide(["--reproduce-minutes", "5"]),
    },
    {
      label: "invalid decision",
      argv: decide([]).map((value) => (value === "accept" ? "invalid" : value)),
    },
    {
      label: "AI decision claiming human minutes",
      argv: decide(["--by", "ai", "--minutes", "5"]),
    },
    {
      label: "AI decision claiming human reproduction",
      argv: decide(["--by", "ai", "--reproduced", "match"]),
    },
    {
      label: "authorization without an authorizer",
      argv: [
        "review",
        "authorize",
        "--candidate",
        "candidate-1",
        "--draft",
        DIGEST,
        "--to",
        "synthetic-destination",
      ],
    },
    ...["-1", "1441", "0.001", "not-a-number"].map((value) => ({
      label: `invalid minutes ${value}`,
      argv: decide([`--minutes=${value}`]),
    })),
    {
      label: "invalid draft author",
      argv: [
        "review",
        "draft",
        "--campaign",
        "campaign-1",
        "--finding",
        "finding-1",
        "--programme",
        "synthetic",
        "--file",
        "draft.md",
        "--prepared-by",
        "invalid",
      ],
    },
    { label: "funnel without a scope", argv: ["ledger", "funnel"] },
    {
      label: "invalid since instant",
      argv: ["ledger", "stops", "--since", "not-a-date"],
    },
    {
      label: "configuration flag on continuous status",
      argv: ["continuous", "status", "--config", "config.json"],
    },
    {
      label: "target positional together with all targets",
      argv: [
        "campaign",
        "run",
        "synthetic",
        "--all",
        "--campaign",
        "campaign-1",
        "--config",
        "config.json",
      ],
    },
    ...["port", "db-port"].map((flag) => ({
      label: `${flag} without handoff`,
      argv: [
        "review",
        "reverify",
        "--campaign",
        "campaign-1",
        "--finding",
        "finding-1",
        "--config",
        "config.json",
        `--${flag}`,
        "1234",
      ],
    })),
    {
      label: "verification finding without campaign",
      argv: [
        "verify",
        "next",
        "--config",
        "config.json",
        "--handoff",
        "handoff",
        "--finding",
        "finding-1",
      ],
    },
    {
      label: "lab command without the review flag",
      argv: ["lab", "up", "--campaign", "campaign-1", "--finding", "finding-1"],
    },
    {
      label: "empty verification handoff directory",
      argv: ["verify", "next", "--config", "config.json", "--handoff="],
    },
    {
      label: "empty reverification handoff directory",
      argv: [
        "review",
        "reverify",
        "--campaign",
        "campaign-1",
        "--finding",
        "finding-1",
        "--config",
        "config.json",
        "--handoff=",
      ],
    },
    {
      label: "invalid campaign prefix",
      argv: [
        "continuous",
        "run",
        "--config",
        "config.json",
        "--selection",
        "selection.json",
        "--campaign-prefix",
        "INVALID",
      ],
    },
    {
      label: "nonnumeric concurrency",
      argv: ["continuous", "concurrency", "invalid", "--config", "config.json"],
    },
  ])("rejects $label before state or profile access", async ({ argv }) => {
    const setup = await fixture();
    const profileMethod = vi.fn(unused);
    const testProfile = profile({
      review: profileMethod,
      historyStatus: profileMethod,
      stateDiffReader: profileMethod,
      httpEvidenceReader: profileMethod,
      verifierRecordReader: profileMethod,
      select: profileMethod,
      runCampaign: profileMethod,
      cleanupLeftovers: profileMethod,
      checkRuntime: profileMethod,
      reverify: profileMethod,
      labDown: profileMethod,
      verifyNext: profileMethod,
      reviewLab: profileMethod,
      targetCeiling: profileMethod,
      runtimeCeilings: profileMethod,
      hostStatus: profileMethod,
    });
    const result = await setup.run(argv, testProfile);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("usage: harness");
    expect(result.stdout).toBe("");
    expect(profileMethod).not.toHaveBeenCalled();
    expect(await readdir(setup.root)).toEqual([]);
  });
});

describe("CLI read-only commands", () => {
  it.each(readCommands.map((argv) => ({ name: argv.join(" "), argv })))(
    "$name reads an existing ledger without changing bytes, schema, mtime or directory contents",
    async ({ argv }) => {
      const setup = await fixture();
      await setup.seed();
      const before = await databaseSnapshot(setup.databasePath);
      const result = await setup.run(argv);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
      expect(await databaseSnapshot(setup.databasePath)).toEqual(before);
      expect(await readdir(setup.stateDirectory)).toEqual(["ledger.sqlite"]);
    },
  );

  it.each(readCommands.map((argv) => ({ name: argv.join(" "), argv })))(
    "$name fails without creating missing state",
    async ({ argv }) => {
      const setup = await fixture();
      const result = await setup.run(argv);
      expect(result.code).toBe(1);
      expect(result.stderr.length).toBeGreaterThan(0);
      expect(result.stdout).toBe("");
      expect(await readdir(setup.root)).toEqual([]);
    },
  );

  it("does not initialize an existing state directory without a database", async () => {
    const setup = await fixture();
    await mkdir(setup.stateDirectory);
    const result = await setup.run(["ledger", "usage"]);
    expect(result.code).toBe(1);
    expect(await readdir(setup.stateDirectory)).toEqual([]);
  });

  it("passes write-protected ledger and artifact storage through the CLI entry point", async () => {
    const setup = await fixture();
    const writer = await setup.seed();
    const before = await databaseSnapshot(setup.databasePath);
    let captured: CliState | undefined;
    const result = await setup.run(
      ["history", "status"],
      profile({
        historyStatus: (state) => {
          captured = state;
          expect(state.ledger.readAll()).toEqual(writer.readAll());
          return { fresh: true, line: "synthetic history ready" };
        },
      }),
    );
    expect(result).toEqual({
      code: 0,
      stdout: "synthetic history ready",
      stderr: "",
    });
    if (captured === undefined)
      throw new Error("Profile did not receive state");
    await expect(
      captured.ledger.append({ ...effort, identity: "unexpected-write" }),
    ).rejects.toThrow("read-only ledger");
    await expect(captured.store.stage()).rejects.toThrow(
      "read-only artifact store",
    );
    await expect(
      captured.store.putFiles({ "note.txt": "unexpected write" }),
    ).rejects.toThrow("read-only artifact store");
    await expect(
      captured.store.commit("unexpected-write", {
        rootDirectory: join(
          captured.store.rootDirectory,
          ".active-artifact-test",
        ),
        contentDirectory: join(
          captured.store.rootDirectory,
          ".active-artifact-test/content",
        ),
      }),
    ).rejects.toThrow("read-only artifact store");
    expect(await databaseSnapshot(setup.databasePath)).toEqual(before);
    expect(await readdir(setup.stateDirectory)).toEqual(["ledger.sqlite"]);
  });
});
