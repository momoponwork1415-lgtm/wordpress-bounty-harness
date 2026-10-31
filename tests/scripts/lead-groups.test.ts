import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, expect, test } from "vitest";

import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";

const script = fileURLToPath(
  new URL("../../scripts/lead-groups.mjs", import.meta.url),
);
const snapshotA = `sha256:${"a".repeat(64)}`;
const snapshotB = `sha256:${"b".repeat(64)}`;
let state: string;
let database: DatabaseSync;
let store: PrivateArtifactStore;
let sequence: number;

beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), "wbh-lead-groups-"));
  database = new DatabaseSync(join(state, "ledger.sqlite"));
  database.exec(`CREATE TABLE ledger_events (
    sequence INTEGER PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_json TEXT NOT NULL
  )`);
  store = new PrivateArtifactStore({
    rootDirectory: join(state, "private-evidence"),
    maxEntries: 64,
    maxBytes: 1024 * 1024,
  });
  sequence = 0;
});

afterEach(async () => {
  database.close();
  await rm(state, { recursive: true, force: true });
});

type Frame = readonly [file: string, fn: string];
const trace = (frames: readonly Frame[]) =>
  frames.map(([file, fn], index) => ({ file, function: fn, line: index + 1 }));

function event(value: Record<string, unknown>, campaignId: string) {
  database
    .prepare("INSERT INTO ledger_events VALUES (?, ?, ?, ?)")
    .run(
      ++sequence,
      campaignId,
      value.type as string,
      JSON.stringify({ campaignId, ...value }),
    );
}

async function lead(
  leadId: string,
  frames: readonly Frame[],
  options: {
    readonly snapshot?: string;
    readonly trial?: string;
    readonly campaign?: string;
    readonly primitive?: string;
  } = {},
) {
  const snapshotDigest = options.snapshot ?? snapshotA;
  const primitive = options.primitive ?? "write";
  const digest = await store.putFiles({
    "lead.json": JSON.stringify({
      leadId,
      snapshotDigest,
      summary: `secret summary of ${leadId}`,
      attackerPosition: "subscriber",
      primitive,
      sourceTrace: trace(frames),
      labObservations: "http://wordpress/secret-path?payload=1",
    }),
  });
  event(
    {
      type: "lead-recorded",
      leadId,
      runId: `run-${options.trial ?? "t1"}`,
      trialId: options.trial ?? "t1",
      snapshotDigest,
      primitive,
      missingEdge: "consumer",
      storageKind: "option",
      artifacts: [{ kind: "lead", digest }],
    },
    options.campaign ?? "campaign-a",
  );
}

async function finding(
  findingId: string,
  frames: readonly Frame[],
  options: {
    readonly trial?: string;
    readonly derivationKind?: string;
  } = {},
) {
  const digest = await store.putFiles({
    "finding.json": JSON.stringify({
      findingId,
      snapshotDigest: snapshotA,
      claim: `secret claim of ${findingId}`,
      attackerPosition: "unauthenticated",
      impact: "stored-xss",
      sourceTrace: trace(frames),
    }),
  });
  event(
    {
      type: "finding-recorded",
      findingId,
      runId: `run-${options.trial ?? "t1"}`,
      trialId: options.trial ?? "t1",
      snapshotDigest: snapshotA,
      category: "stored-xss",
      ...(options.derivationKind === undefined
        ? {}
        : { derivationKind: options.derivationKind }),
      artifacts: [{ kind: "finding", digest }],
    },
    "campaign-a",
  );
}

type Output = {
  summary: Record<string, unknown>;
  groups: {
    snapshotDigest: string;
    representative: { kind: string; id: string };
    members: number;
    leads: number;
    findings: number;
    trials: number;
    impacts: string[];
    actors: string[];
  }[];
};

function run(...args: string[]): string {
  return execFileSync(process.execPath, [script, "--state", state, ...args], {
    encoding: "utf8",
  });
}
const json = (...args: string[]) =>
  JSON.parse(run(...args, "--json")) as Output;

const entry: Frame = ["includes/class-ajax.php", "handle_save"];
const store1: Frame = ["includes/class-store.php", "save_value"];
const render: Frame = ["includes/class-render.php", "print_value"];

test("groups Leads and Findings of one Snapshot by their sourceTrace endpoints", async () => {
  // A Finding recorded first in Trial t1, then two Leads in Trial t2.
  await finding("finding-1", [
    entry,
    ["@wordpress/wp-includes/x.php", "f"],
    render,
  ]);
  await lead("lead-1", [entry, store1], { trial: "t2" });
  await lead(
    "lead-2",
    [["@wordpress/wp-admin/admin-ajax.php", "core"], entry, render],
    {
      trial: "t2",
      primitive: "read",
    },
  );
  // Same endpoints, other Snapshot: never joins.
  await lead("lead-3", [entry, render], { snapshot: snapshotB });
  // A fixed-version control is not a group member.
  await finding("finding-control", [entry, render], {
    derivationKind: "fixed-version-control",
  });

  const overlap = json("--campaign", "campaign-a");
  expect(overlap.summary).toMatchObject({
    rule: "overlap",
    leads: 3,
    findings: 1,
    groups: 2,
    groupsWithAtLeastTwoMembers: 1,
    groupsInAtLeastTwoTrials: 1,
    groupsWithLeadAndFinding: 1,
  });
  expect(overlap.groups[0]).toMatchObject({
    snapshotDigest: snapshotA,
    // The first-recorded Lead represents the group even after a Finding.
    representative: { kind: "lead", id: "lead-1" },
    members: 3,
    leads: 2,
    findings: 1,
    trials: 2,
    impacts: ["finding:stored-xss", "lead:read", "lead:write"],
    actors: ["subscriber", "unauthenticated"],
  });
  expect(overlap.groups[1]).toMatchObject({
    snapshotDigest: snapshotB,
    members: 1,
  });

  // pair: lead-2 skips the core frame, so its entry and effect equal the Finding's.
  const pair = json("--campaign", "campaign-a", "--rule", "pair");
  expect(pair.summary).toMatchObject({ groups: 3 });
  expect(pair.groups.find((group) => group.members === 2)).toMatchObject({
    representative: { kind: "lead", id: "lead-2" },
    findings: 1,
    trials: 2,
  });
});

test("an effect equal to another member's entry does not join it", async () => {
  await lead("lead-1", [entry, store1]);
  await lead("lead-2", [store1, render]);
  expect(json("--snapshot", snapshotA).summary).toMatchObject({ groups: 2 });
});

test("selects campaigns by pattern and prints no body, place or URL", async () => {
  await lead("lead-1", [entry, store1], { campaign: "prod-x-1" });
  await lead("lead-2", [entry, render], { campaign: "prod-x-2", trial: "t2" });
  await lead("lead-3", [entry, render], { campaign: "other" });

  expect(json("--campaign-like", "prod-x-%").summary).toMatchObject({
    leads: 2,
    groups: 1,
    groupsInAtLeastTwoTrials: 1,
  });
  for (const text of [
    run("--campaign-like", "prod-x-%"),
    run("--campaign-like", "prod-x-%", "--json"),
  ]) {
    expect(text).not.toContain("secret");
    expect(text).not.toContain("http://");
    expect(text).not.toContain("class-ajax");
    expect(text).not.toContain("handle_save");
  }
});

test("needs exactly one scope", () => {
  expect(() =>
    execFileSync(process.execPath, [script, "--state", state], {
      encoding: "utf8",
      stdio: "pipe",
    }),
  ).toThrow(/exactly one/);
});
