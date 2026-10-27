import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../../src/ledger/index.js";
import { recordWordPressReport } from "../../../src/profiles/wordpress/discovery/candidate-admission.js";

// ADR 0042: a tracer's report records the partition it was assigned on each
// Finding and Lead; the group keys and the admission path are unchanged.

const digest = `sha256:${"a".repeat(64)}`;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const trace = [{ file: "inc/forms.php", function: "demo_save", line: 12 }];
const report = {
  findings: [
    {
      claim: "Synthetic stored effect",
      attackerPosition: "subscriber",
      impact: "stored-xss",
      configurationPrecondition: "default",
      brokenProperty: "Output encoding",
      sourceTrace: trace,
      existingControls: "None",
      labObservations: "Not observed",
    },
    // Outside the Programme Boundary: parked, and a park carries no partition.
    {
      claim: "Synthetic low-value effect",
      attackerPosition: "subscriber",
      impact: "other",
      configurationPrecondition: "default",
      brokenProperty: "None",
      sourceTrace: trace,
      existingControls: "None",
      labObservations: "Not observed",
    },
  ],
  leads: [
    {
      summary: "Synthetic consumer edge",
      attackerPosition: "subscriber",
      primitive: "write",
      storage: { kind: "option", key: "synthetic_shared" },
      missingEdge: "consumer",
      sourceTrace: trace,
      labObservations: "No complete effect observed",
    },
  ],
};

it("stamps the tracer's partition on the recorded Finding and Lead only", async () => {
  const root = await mkdtemp(join(tmpdir(), "wbh-partition-admission-"));
  directories.push(root);
  const evidence = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 100,
    maxBytes: 10 * 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: evidence,
  });
  const context = {
    ledger,
    evidence,
    base: {
      schemaVersion: 1 as const,
      campaignId: "campaign-1",
      snapshotDigest: digest,
      occurredAt: "2026-10-28T00:00:00Z",
    },
    runId: "run-trace-1",
    trialId: "trial-1",
    snapshotDigest: digest,
    reportArtifactDigest: digest,
  };
  await recordWordPressReport(report, { ...context, partition: "p1" });
  const events = ledger
    .readAll({ campaignId: "campaign-1" })
    .map(({ event }) => event);
  expect(
    events.flatMap((event): [string, string][] =>
      event.type === "finding-recorded" || event.type === "lead-recorded"
        ? [[event.type, event.partition ?? "none"]]
        : event.type === "finding-parked"
          ? [[event.type, "partition" in event ? "present" : "absent"]]
          : [],
    ),
  ).toEqual([
    ["finding-recorded", "p1"],
    ["finding-parked", "absent"],
    ["lead-recorded", "p1"],
  ]);
  // The same report from a cooperative Trial carries no partition.
  await recordWordPressReport(report, {
    ...context,
    runId: "run-root-1",
    trialId: "trial-2",
  });
  expect(
    ledger
      .readAll({ campaignId: "campaign-1" })
      .map(({ event }) => event)
      .filter(
        (event) =>
          event.type === "finding-recorded" && event.runId === "run-root-1",
      )
      .map((event) => "partition" in event),
  ).toEqual([false]);
});
