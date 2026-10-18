import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { formatCoverage } from "../../src/cli/index.js";
import { summarizeCampaignCoverage } from "../../src/discovery/index.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger, type LedgerEventInput } from "../../src/ledger/index.js";

const sha = (value: string) => `sha256:${value.repeat(64)}`;
const snapshot = sha("a");
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

/** A fixture ledger and its Private Evidence; `bare` references a record that holds no coverage file. */
async function fixture(): Promise<{
  ledger: Ledger;
  store: PrivateArtifactStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), "coverage-report-"));
  directories.push(directory);
  const store = new PrivateArtifactStore({
    rootDirectory: join(directory, "artifacts"),
    maxEntries: 10,
    maxBytes: 4096,
  });
  const ledger = new Ledger({
    databasePath: join(directory, "ledger.sqlite"),
    artifactStore: store,
  });
  const put = (name: string, value: unknown) =>
    store.putFiles({ [name]: JSON.stringify(value) });
  const coverage = await put("coverage.json", {
    indexDigest: sha("5"),
    incomplete: false,
    entries: [
      { id: "e-1", status: "observed", reason: null },
      { id: "e-2", status: "blocked", reason: "precondition" },
      { id: "e-3", status: "unvisited", reason: null },
      { id: "e-4", status: "observed", reason: null },
    ],
  });
  const rootPaths = await put("read-paths.json", ["a.php", "b.php", "x.txt"]);
  const childPaths = await put("read-paths.json", ["b.php", "c.php"]);
  const other = await put("other.json", {});
  const rows: Record<string, unknown>[] = [];
  const run = (
    runId: string,
    runKind: string,
    artifacts: { kind: string; digest: string }[],
  ) =>
    rows.push(
      {
        type: "discovery-run-started",
        runId,
        runKind,
        history: { mode: "none" },
        configuration: { promptVariant: "v6", assignmentUnit: "cooperative" },
      },
      {
        type: "discovery-run-finished",
        runId,
        outcome: "completed",
        costUsd: "unavailable",
        wallTimeMs: 1,
        artifacts,
      },
    );
  const lead = (leadId: string, runId: string, missingEdge: string) =>
    rows.push({
      type: "lead-recorded",
      leadId,
      runId,
      trialId: "trial-1",
      missingEdge,
      primitive: "stored-write",
      storageKind: "option",
      artifacts: [{ kind: "lead", digest: other }],
    });
  run("root", "explore", [
    { kind: "coverage", digest: coverage },
    { kind: "read-paths", digest: rootPaths },
  ]);
  run("child", "child", [{ kind: "read-paths", digest: childPaths }]);
  run("bare", "explore", [{ kind: "coverage", digest: other }]);
  lead("lead-1", "root", "producer");
  lead("lead-2", "child", "consumer");
  lead("lead-3", "child", "reachability");
  for (const [index, event] of rows.entries())
    expect(
      (
        await ledger.append({
          schemaVersion: 1,
          identity: `event-${index}`,
          campaignId: "campaign-1",
          snapshotDigest: snapshot,
          occurredAt: "2026-10-18T00:00:00.000Z",
          ...event,
        } as LedgerEventInput)
      ).status,
    ).toBe("appended");
  return { ledger, store };
}

const sourceFiles = async (digest: string) =>
  digest === snapshot
    ? { all: ["a.php", "b.php", "c.php", "d.php"], indexed: ["a.php", "d.php"] }
    : null;

describe("ledger coverage", () => {
  it("aggregates entry, file and missingEdge coverage per run and in total", async () => {
    const coverage = await summarizeCampaignCoverage({
      ...(await fixture()),
      campaignId: "campaign-1",
      sourceFiles,
    });
    const [root, child, bare] = coverage.runs;
    expect(root).toMatchObject({
      runKind: "explore",
      entries: coverage.total.entries,
      sourceFiles: { covered: 2, total: 4 },
      indexedFiles: { covered: 1, total: 2 },
      missingEdges: { producer: 1, consumer: 0, unclassified: 0 },
    });
    expect(child).toMatchObject({
      runKind: "child",
      entries: "unavailable",
      sourceFiles: { covered: 2, total: 4 },
      missingEdges: { producer: 0, consumer: 1, reachability: 1 },
    });
    // A coverage digest without a stored record and no read paths stay unavailable.
    expect(bare).toMatchObject({
      entries: "unavailable",
      sourceFiles: "unavailable",
      indexedFiles: "unavailable",
    });
    expect(coverage.total).toEqual({
      entries: {
        observed: 2,
        blocked: 1,
        unvisited: 1,
        blockedReasons: { precondition: 1 },
      },
      sourceFiles: { covered: 3, total: 4 },
      indexedFiles: { covered: 1, total: 2 },
      missingEdges: {
        producer: 1,
        consumer: 1,
        reachability: 1,
        unclassified: 0,
      },
    });
    const lines = formatCoverage(coverage);
    expect(lines[1]).toBe(
      "runs 3  total  entries observed 2 blocked 1 unvisited 1 (observed 50.0%) blocked by precondition 1  files 3/4 (75.0%)  indexed files 1/2 (50.0%)  missingEdge consumer 1, producer 1, reachability 1, unclassified 0",
    );
    expect(lines[4]).toContain(
      "explore bare  entries unavailable  files unavailable  indexed files unavailable",
    );
  });

  it("prints unavailable file cells when the profile has no source files", async () => {
    const coverage = await summarizeCampaignCoverage({
      ...(await fixture()),
      campaignId: "campaign-1",
      sourceFiles: () => Promise.reject(new Error("source unavailable")),
    });
    expect(coverage.runs[0]).toMatchObject({
      sourceFiles: "unavailable",
      indexedFiles: "unavailable",
    });
    expect(coverage.total.sourceFiles).toBe("unavailable");
    const empty = await summarizeCampaignCoverage({
      ...(await fixture()),
      campaignId: "campaign-none",
    });
    expect(formatCoverage(empty)).toEqual([
      "campaign campaign-none",
      "runs 0  total  entries unavailable  files unavailable  indexed files unavailable  missingEdge consumer 0, producer 0, unclassified 0",
    ]);
  });
});
