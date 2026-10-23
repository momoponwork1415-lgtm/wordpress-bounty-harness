import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { canonicalJson } from "../../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../../src/ledger/index.js";
import { admitWordPressFinding } from "../../../src/profiles/wordpress/discovery/finding.js";
import {
  inspectParkedWordPressFinding,
  restoreParkedWordPressFinding,
} from "../../../src/profiles/wordpress/discovery/restore-parked-finding.js";
import { Review } from "../../../src/review/index.js";

const snapshot = `sha256:${"a".repeat(64)}`;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(input: {
  readonly precondition: string;
  readonly reason?:
    "admin-configuration-precondition" | "outside-programme-boundary";
  readonly recordedBeforePark?: boolean;
  readonly verificationParkIdentity?: boolean;
}) {
  const root = await mkdtemp(join(tmpdir(), "wbh-park-restore-"));
  directories.push(root);
  const evidence = new PrivateArtifactStore({
    rootDirectory: join(root, "private"),
    maxEntries: 10,
    maxBytes: 100_000,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: evidence,
  });
  const finding = admitWordPressFinding(
    {
      claim: "Synthetic stored script effect",
      attackerPosition: "subscriber",
      impact: "stored-xss",
      configurationPrecondition: input.precondition,
      brokenProperty: "Stored script cannot execute in a privileged browser",
      sourceTrace: [{ file: "plugin.php", function: "render", line: 1 }],
      existingControls: "None",
      labObservations: "Synthetic evidence only",
    },
    {
      runId: "run-1",
      snapshotDigest: snapshot,
      reportArtifactDigest: snapshot,
    },
  );
  const digest = await evidence.putFiles({
    "finding.json": canonicalJson(finding),
  });
  if (input.recordedBeforePark)
    await ledger.append({
      schemaVersion: 1,
      identity: `discovery-finding-${finding.findingId}`,
      campaignId: "campaign-1",
      snapshotDigest: snapshot,
      occurredAt: "2026-10-24T00:00:00Z",
      type: "finding-recorded",
      findingId: finding.findingId,
      runId: "run-1",
      category: "stored-xss",
      preconditionClass: "unknown",
      artifacts: [{ kind: "finding", digest }],
    });
  await ledger.append({
    schemaVersion: 1,
    identity: input.verificationParkIdentity
      ? `parked-${finding.findingId}`
      : `discovery-finding-parked-${finding.findingId}`,
    campaignId: "campaign-1",
    snapshotDigest: snapshot,
    occurredAt: "2026-10-24T00:00:00Z",
    type: "finding-parked",
    findingId: finding.findingId,
    runId: "run-1",
    category: "stored-xss",
    reason: input.reason ?? "admin-configuration-precondition",
    preconditionClass: "admin-configuration",
    artifacts: [{ kind: "finding", digest }],
  });
  return { ledger, evidence, finding, digest };
}

it("recovers a false-positive park into the review and verification queues without deleting history", async () => {
  const { ledger, evidence, finding } = await fixture({
    precondition:
      "An administrator opens Password-Protected Showcase > Dashboard. Public content does not require password protection.",
  });
  const review = new Review({
    ledger,
    artifactStore: evidence,
    scopeEvaluator: {
      programmeIds: ["wordfence"],
      policyDigest: snapshot,
      assess: async () => [],
    },
    factsProvider: { load: async () => ({}) },
  });
  expect(review.queue({ campaignId: "campaign-1" }).items).toHaveLength(0);
  const options = {
    ledger,
    evidence,
    campaignId: "campaign-1",
    findingId: finding.findingId,
    clock: () => new Date("2026-10-24T01:00:00Z"),
  };
  expect(await inspectParkedWordPressFinding(options)).toMatchObject({
    status: "ready",
    preconditionClass: "unknown",
    snapshotDigest: snapshot,
    partialRecord: false,
  });
  expect(await restoreParkedWordPressFinding(options)).toEqual({
    status: "restored",
  });
  expect(ledger.activeParked({ campaignId: "campaign-1" })).toHaveLength(0);
  expect(ledger.read({ type: "finding-parked" })).toHaveLength(1);
  expect(ledger.read({ type: "finding-park-restored" })).toHaveLength(1);
  expect(ledger.read({ type: "finding-recorded" })).toHaveLength(1);
  expect(ledger.funnel("campaign-1")).toMatchObject({
    accepted: 1,
    parked: 0,
    raw: 1,
  });
  expect(review.queue({ campaignId: "campaign-1" }).items).toMatchObject([
    { status: "not-verified", ref: { findingId: finding.findingId } },
  ]);
  expect(await restoreParkedWordPressFinding(options)).toEqual({
    status: "already-restored",
  });
  expect(await inspectParkedWordPressFinding(options)).toEqual({
    status: "already-restored",
  });
  expect(ledger.read({ type: "finding-recorded" })).toHaveLength(1);
});

it("restores a setting park but refuses a Programme Boundary park", async () => {
  const setting = await fixture({
    precondition:
      "An administrator sets the Featured Tile checkbox to checked.",
  });
  await expect(
    restoreParkedWordPressFinding({
      ...setting,
      campaignId: "campaign-1",
      findingId: setting.finding.findingId,
    }),
  ).resolves.toEqual({ status: "restored" });
  expect(
    setting.ledger.activeParked({ campaignId: "campaign-1" }),
  ).toHaveLength(0);

  const excluded = await fixture({
    precondition: "default",
    reason: "outside-programme-boundary",
  });
  await expect(
    restoreParkedWordPressFinding({
      ...excluded,
      campaignId: "campaign-1",
      findingId: excluded.finding.findingId,
    }),
  ).rejects.toThrow("Programme Boundary parks cannot be restored here");
});

it("finishes a correction interrupted after recording but before the marker", async () => {
  const { ledger, evidence, finding, digest } = await fixture({
    precondition:
      "An administrator opens Password-Protected Showcase > Dashboard. Public content does not require password protection.",
  });
  await ledger.append({
    schemaVersion: 1,
    identity: `discovery-finding-${finding.findingId}`,
    campaignId: "campaign-1",
    snapshotDigest: snapshot,
    occurredAt: "2026-10-24T00:30:00Z",
    artifacts: [{ kind: "finding", digest }],
    type: "finding-recorded",
    findingId: finding.findingId,
    runId: "run-1",
    category: "stored-xss",
    preconditionClass: "unknown",
  });
  expect(ledger.activeParked({ campaignId: "campaign-1" })).toHaveLength(1);
  expect(
    await restoreParkedWordPressFinding({
      ledger,
      evidence,
      campaignId: "campaign-1",
      findingId: finding.findingId,
    }),
  ).toEqual({ status: "restored" });
  expect(ledger.read({ type: "finding-recorded" })).toHaveLength(1);
  expect(ledger.activeParked({ campaignId: "campaign-1" })).toHaveLength(0);
});

it("refuses a later Verifier park even when its Finding text now classifies as unknown", async () => {
  const { ledger, evidence, finding, digest } = await fixture({
    precondition: "No password-protected post is needed.",
    recordedBeforePark: true,
    verificationParkIdentity: true,
  });
  await expect(
    restoreParkedWordPressFinding({
      ledger,
      evidence,
      campaignId: "campaign-1",
      findingId: finding.findingId,
    }),
  ).rejects.toThrow("no admission park event");
  await ledger.append({
    schemaVersion: 1,
    identity: `forged-restoration-${finding.findingId}`,
    campaignId: "campaign-1",
    snapshotDigest: snapshot,
    occurredAt: "2026-10-24T01:00:00Z",
    artifacts: [{ kind: "finding", digest }],
    type: "finding-park-restored",
    findingId: finding.findingId,
    parkedIdentity: `parked-${finding.findingId}`,
    recordedIdentity: `discovery-finding-${finding.findingId}`,
    reason: "admission-correction",
  });
  expect(ledger.activeParked({ campaignId: "campaign-1" })).toHaveLength(1);
});

it("refuses an admission-shaped park appended after a Finding was recorded", async () => {
  const { ledger, evidence, finding } = await fixture({
    precondition: "No password-protected post is needed.",
    recordedBeforePark: true,
  });
  await expect(
    restoreParkedWordPressFinding({
      ledger,
      evidence,
      campaignId: "campaign-1",
      findingId: finding.findingId,
    }),
  ).rejects.toThrow("recorded before its admission park");
});
