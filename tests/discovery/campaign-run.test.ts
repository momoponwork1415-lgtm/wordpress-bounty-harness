import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import {
  createHistoryCatalog,
  createNativeRunReceipt,
  defineAgentRuntimeProfile,
  ProviderAttachmentStore,
  runDiscoveryCampaign,
} from "../../src/discovery/index.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";
import { admitWordPressFinding } from "../../src/profiles/wordpress/discovery/finding.js";

const digest = `sha256:${"a".repeat(64)}`;
const profile = defineAgentRuntimeProfile({
  id: "synthetic",
  transportKind: "codex-native/v1",
  sandboxImageDigest: digest,
  requestedModelId: "gpt-6.1-sol",
  requestedEffort: "high",
  codexCliVersion: "0.161.0",
  bundledCatalogDigest: digest,
  authenticationMethod: "host-private-bearer",
  cyberAccessProgram: "standard",
  serviceTier: "priority",
  subagent: { modelId: "unavailable", effort: "unavailable" },
});
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function campaign(findingRuns: readonly number[]) {
  const root = await mkdtemp(join(tmpdir(), "wbh-campaign-"));
  directories.push(root);
  const attachments = new ProviderAttachmentStore(join(root, "reports"));
  const evidence = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 10,
    maxBytes: 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: evidence,
  });
  await ledger.append({
    schemaVersion: 1,
    identity: "lab-ready",
    campaignId: "campaign-1",
    snapshotDigest: digest,
    occurredAt: "2026-10-08T07:00:00Z",
    type: "lab-provisioned",
    labId: "lab-1",
    status: "ready",
  });
  const history = createHistoryCatalog("2026-02-01T00:00:00Z", [
    {
      id: "public-1",
      kind: "sql-injection",
      affectedVersions: ["1.0"],
      fixedVersions: ["1.1"],
      publishedAt: "2026-01-01T00:00:00Z",
      title: "Synthetic public record",
      changedFiles: [],
    },
  ]);
  const input = {
    schemaVersion: 1 as const,
    snapshotDigest: digest,
    trustBoundary: { version: "v1", text: "Low privilege only" },
    programmeBoundary: { version: "v1", text: "Synthetic boundary" },
    modelProfileDigest: profile.digest,
    promptDigest: digest,
    stopRules: { maxRuns: 6, noFindingRuns: 2 },
    lab: { setupDigest: digest },
    history,
  };
  const claim = {
    claim: "Synthetic account state change",
    attackerPosition: "subscriber",
    impact: "account-takeover",
    configurationPrecondition: "default",
    brokenProperty: "Account ownership",
    sourceTrace: [
      { file: "includes/example.php", function: "fixture", line: 12 },
    ],
    existingControls: "Capability check elsewhere",
    labObservations: "Canary user changed",
  };
  let calls = 0;
  const result = await runDiscoveryCampaign({
    campaignId: "campaign-1",
    labId: "lab-1",
    input,
    historyFraction: 0.5,
    ledger,
    attachments,
    evidence,
    admitFinding: admitWordPressFinding,
    executor: {
      async execute(run) {
        const report = {
          findings: findingRuns.includes(calls++) ? [claim] : [],
          examined: "source",
          unexamined: "none",
        };
        const attachment = await attachments.put(
          "findings",
          Buffer.from(JSON.stringify(report)),
        );
        return {
          attachment,
          receipt: createNativeRunReceipt({
            runId: run.runId,
            targetSnapshotDigest: run.targetSnapshotDigest,
            profile: run.profile,
            terminal: "completed",
            reason: "unavailable",
            startedAt: "2026-10-08T07:00:00Z",
            completedAt: "2026-10-08T07:00:01Z",
            reportArtifactDigest: attachment.digest,
          }),
        };
      },
    },
    plannedRuns: Array.from({ length: 6 }, (_, index) => ({
      configuration: {
        promptVariant: index % 2 ? "wp2shell-derived" : "short-objective",
        assignmentUnit: "route",
      },
      run: {
        runId: `run-${index}`,
        targetSnapshotDigest: digest,
        profile,
        prompt: "Synthetic objective",
        sourceDirectory: "/private/source",
        sourceTree: { digest, entries: 1, bytes: 1 },
        lab: {
          endpoint: "http://wordpress",
          networkName: "lab-internal",
          internalIp: "172.20.0.2",
        },
        expiresAt: "2026-10-08T07:30:00Z",
      },
    })),
    clock: () => new Date("2026-10-08T07:00:00Z"),
  });
  return { result, calls, ledger, evidence };
}

it("stops after consecutive completed runs without a new Finding and records each run configuration", async () => {
  const { result, calls, ledger } = await campaign([0]);
  expect(result).toEqual({
    runCount: 3,
    findingsRecorded: 1,
    stoppedBy: "no-new-finding",
  });
  expect(calls).toBe(3);
  expect(
    ledger
      .read({ type: "discovery-run-started" })
      .map(({ event }) =>
        event.type === "discovery-run-started"
          ? [event.history.mode, event.configuration.promptVariant]
          : null,
      ),
  ).toEqual([
    ["none", "short-objective"],
    ["catalog", "wp2shell-derived"],
    ["none", "short-objective"],
  ]);
  expect(ledger.funnel("campaign-1")).toMatchObject({
    raw: 1,
    runCount: 3,
    discoveryAttempts: 3,
    knownCostUsd: 0,
    unpricedRuns: 3,
    wallTimeMs: 3000,
  });
});

it("keeps the admitted Finding trace in Private Evidence and references it from the ledger", async () => {
  const { ledger, evidence } = await campaign([0]);
  const [recorded] = ledger.read({ type: "finding-recorded" });
  const reference = recorded?.event.artifacts.find(
    (artifact) => artifact.kind === "finding",
  );
  expect(reference).toBeDefined();
  const stored = await evidence.readFile(
    reference!.digest,
    "finding.json",
    100_000,
  );
  expect(stored.status).toBe("resolved");
  const finding = JSON.parse(
    stored.status === "resolved" ? stored.bytes.toString("utf8") : "{}",
  ) as { findingId: string; sourceTrace: unknown };
  expect(finding.findingId).toBe(
    recorded?.event.type === "finding-recorded" ? recorded.event.findingId : "",
  );
  expect(finding.sourceTrace).toEqual([
    { file: "includes/example.php", function: "fixture", line: 12 },
  ]);
});
