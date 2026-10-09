import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import {
  createNativeRunReceipt,
  defineAgentRuntimeProfile,
  ProviderAttachmentStore,
  runDiscoveryCampaign,
  type DiscoveryTransportResult,
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
const validClaim = {
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
/** The shape an agent produces when it was never shown the contract. */
const malformedClaim = {
  attackerPosition: "Unauthenticated visitor",
  impactClassification: "Sensitive-object-access",
  sourceTrace: ["class-translate-press.php / define_admin_hooks / line 361"],
  privateRecipeReference: "none",
};
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function open() {
  const root = await mkdtemp(join(tmpdir(), "wbh-admission-"));
  directories.push(root);
  const attachments = new ProviderAttachmentStore(join(root, "reports"));
  const evidence = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 10,
    maxBytes: 8 * 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: evidence,
  });
  const campaign = (
    reply: (run: {
      runId: string;
      targetSnapshotDigest: string;
      profile: typeof profile;
    }) => Promise<DiscoveryTransportResult>,
  ) =>
    runDiscoveryCampaign({
      campaignId: "campaign-1",
      labId: "lab-1",
      input: {
        schemaVersion: 1,
        snapshotDigest: digest,
        trustBoundary: { version: "v1", text: "Low privilege only" },
        programmeBoundary: { version: "v1", text: "Synthetic boundary" },
        modelProfileDigest: profile.digest,
        promptDigest: digest,
        stopRules: { maxRuns: 1, noFindingRuns: 1 },
        lab: { setupDigest: digest },
        history: { mode: "none" },
      },
      historyFraction: 0,
      ledger,
      attachments,
      evidence,
      admitFinding: admitWordPressFinding,
      executor: { execute: reply },
      plannedRuns: [
        {
          configuration: {
            promptVariant: "short-objective",
            assignmentUnit: "plugin",
          },
          run: {
            runId: "run-0",
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
        },
      ],
      clock: () => new Date("2026-10-08T07:00:00Z"),
    });
  const finished = () => {
    const event = ledger
      .read({ type: "discovery-run-finished" })
      .map(({ event }) => event)
      .at(0);
    if (event?.type !== "discovery-run-finished") throw new Error("missing");
    return event;
  };
  return { attachments, evidence, ledger, campaign, finished };
}

it("keeps the admitted Findings of a run and sets aside the malformed ones instead of failing the run", async () => {
  const { attachments, evidence, ledger, campaign, finished } = await open();
  const result = await campaign(async (run) => {
    const attachment = await attachments.put(
      "findings",
      Buffer.from(
        JSON.stringify({
          findings: [malformedClaim, validClaim],
          examined: "source",
          unexamined: "none",
        }),
      ),
    );
    return {
      attachment,
      receipt: createNativeRunReceipt({
        ...run,
        terminal: "completed",
        reason: "unavailable",
        startedAt: "2026-10-08T07:00:00Z",
        completedAt: "2026-10-08T07:00:01Z",
        reportArtifactDigest: attachment.digest,
      }),
    };
  });
  expect(result).toMatchObject({ findingsRecorded: 1, stoppedBy: "max-runs" });
  expect(ledger.read({ type: "finding-recorded" })).toHaveLength(1);
  const event = finished();
  expect(event.outcome).toBe("completed");
  const rejected = event.artifacts.find(
    (artifact) => artifact.kind === "rejected-findings",
  );
  expect(rejected).toBeDefined();
  const file = await evidence.readFile(
    rejected!.digest,
    "rejected-findings.json",
    1024 * 1024,
  );
  expect(file.status).toBe("resolved");
  const parsed =
    file.status === "resolved"
      ? (JSON.parse(file.bytes.toString("utf8")) as {
          rejected: { candidate: unknown; reason: string }[];
        })
      : undefined;
  expect(parsed?.rejected).toHaveLength(1);
  expect(parsed?.rejected[0]?.candidate).toEqual(malformedClaim);
  expect(parsed?.rejected[0]?.reason).toMatch(/impact|attackerPosition/);
});

it("preserves the transport's diagnostic next to the finished run", async () => {
  const { attachments, evidence, campaign, finished } = await open();
  await campaign(async (run) => {
    const diagnostic = await attachments.put(
      "diagnostic",
      Buffer.from(
        JSON.stringify({ reason: "item type not admitted: web_search" }),
      ),
    );
    return {
      diagnostic,
      receipt: createNativeRunReceipt({
        ...run,
        terminal: "incomplete",
        reason: "schema",
        startedAt: "2026-10-08T07:00:00Z",
        completedAt: "2026-10-08T07:00:01Z",
      }),
    };
  });
  const event = finished();
  expect(event.outcome).toBe("failed");
  const kept = event.artifacts.find(
    (artifact) => artifact.kind === "transport-diagnostic",
  );
  expect(kept).toBeDefined();
  const file = await evidence.readFile(
    kept!.digest,
    "diagnostic.json",
    1024 * 1024,
  );
  expect(file.status).toBe("resolved");
});
