import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  createNativeRunReceipt,
  defineAgentRuntimeProfile,
  ProviderAttachmentStore,
  runDiscoveryCampaign,
  type PlannedTrial,
} from "../../src/discovery/index.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";
import { admitWordPressFinding } from "../../src/profiles/wordpress/discovery/finding.js";
import {
  admitWordPressLead,
  readWordPressLead,
  wordPressLeadSignature,
} from "../../src/profiles/wordpress/discovery/lead.js";

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

const lead = (
  missingEdge: "precondition" | "consumer" | "auth-use",
  file = "plugin.php",
) => ({
  summary: `Synthetic ${missingEdge} edge`,
  attackerPosition: "subscriber",
  primitive: "write",
  storage: { kind: "option", key: "synthetic_shared" },
  missingEdge,
  sourceTrace: [{ file, function: "synthetic", line: 1 }],
  labObservations: "No complete effect observed",
});
const finding = {
  claim: "Synthetic account effect",
  attackerPosition: "subscriber",
  impact: "account-takeover",
  configurationPrecondition: "default",
  brokenProperty: "Account ownership",
  sourceTrace: [{ file: "plugin.php", function: "synthetic", line: 1 }],
  existingControls: "None",
  labObservations: "Synthetic effect observed",
};
type Reply = {
  readonly leads?: readonly unknown[];
  readonly findings?: readonly unknown[];
  readonly fail?: boolean;
};

async function trialCampaign(options: {
  readonly replies: Readonly<Record<string, Reply>>;
  readonly trialCount: number;
  readonly noFindingRuns: number;
}) {
  const root = await mkdtemp(join(tmpdir(), "wbh-trial-continuation-"));
  directories.push(root);
  const evidence = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 100,
    maxBytes: 10 * 1024 * 1024,
  });
  const attachments = new ProviderAttachmentStore(join(root, "reports"));
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: evidence,
  });
  const calls: { runId: string; prompt: string }[] = [];
  const input = {
    schemaVersion: 1 as const,
    snapshotDigest: digest,
    trustBoundary: { version: "v1", text: "Synthetic trust" },
    programmeBoundary: { version: "v1", text: "Synthetic programme" },
    modelProfileDigest: profile.digest,
    promptDigest: digest,
    stopRules: {
      maxRuns: options.trialCount,
      noFindingRuns: options.noFindingRuns,
    },
    lab: { setupDigest: digest },
    history: { mode: "none" as const },
  };
  const plannedTrials: PlannedTrial[] = Array.from(
    { length: options.trialCount },
    (_, trialOrdinal) => {
      const trialId = `trial-${trialOrdinal}`;
      const explore = {
        configuration: { promptVariant: "synthetic", assignmentUnit: "plugin" },
        run: {
          runId: trialId,
          targetSnapshotDigest: digest,
          profile,
          prompt: "Synthetic purpose",
          lab: {
            endpoint: "http://wordpress",
            networkName: "lab-net",
            internalIp: "172.20.0.2",
          },
          sourceDirectory: "/synthetic/source",
          sourceTree: { digest, entries: 1, bytes: 1 },
          expiresAt: "2026-10-08T10:00:00Z",
        },
      };
      return { trialId, trialOrdinal, explore };
    },
  );
  const result = await runDiscoveryCampaign({
    campaignId: "campaign-1",
    labId: "lab-1",
    input,
    plannedTrials,
    ledger,
    evidence,
    attachments,
    admitFinding: admitWordPressFinding,
    admitLead: admitWordPressLead,
    leadSignature: (candidate) =>
      wordPressLeadSignature(readWordPressLead(candidate)),
    clock: () => new Date("2026-10-08T08:00:00Z"),
    executor: {
      async execute(run) {
        calls.push({ runId: run.runId, prompt: run.prompt });
        const reply = options.replies[run.runId] ?? {};
        if (reply.fail === true)
          return {
            receipt: createNativeRunReceipt({
              runId: run.runId,
              targetSnapshotDigest: digest,
              profile,
              terminal: "incomplete",
              reason: "schema",
              startedAt: "2026-10-08T08:00:00Z",
              completedAt: "2026-10-08T08:00:01Z",
            }),
          };
        const attachment = await attachments.put(
          "findings",
          Buffer.from(
            JSON.stringify({
              findings: reply.findings ?? [],
              leads: reply.leads ?? [],
              examined: "synthetic",
              unexamined: "none",
            }),
          ),
        );
        return {
          attachment,
          receipt: createNativeRunReceipt({
            runId: run.runId,
            targetSnapshotDigest: digest,
            profile,
            terminal: "completed",
            reason: "unavailable",
            startedAt: "2026-10-08T08:00:00Z",
            completedAt: "2026-10-08T08:00:01Z",
            reportArtifactDigest: attachment.digest,
          }),
        };
      },
    },
  });
  return { result, calls, ledger, evidence };
}

it("records Leads without injecting a Harness continuation", async () => {
  const { result, calls, ledger, evidence } = await trialCampaign({
    trialCount: 1,
    noFindingRuns: 1,
    replies: {
      "trial-0": {
        leads: [lead("precondition"), { invalid: true }, lead("consumer")],
      },
    },
  });
  expect(result).toMatchObject({ runCount: 1, stoppedBy: "max-runs" });
  expect(calls.map((call) => call.runId)).toEqual(["trial-0"]);
  const leads = ledger
    .read({ type: "lead-recorded" })
    .map(({ event }) => event);
  expect(leads).toHaveLength(2);
  expect(JSON.stringify(leads)).not.toContain("synthetic_shared");
  const started = ledger
    .read({ type: "discovery-run-started" })
    .map(({ event }) => event);
  expect(started).toHaveLength(1);
  expect(started[0]).toMatchObject({ runKind: "explore" });
  expect(started[0]).not.toHaveProperty("continuationOf");
  const reference = leads[0]?.artifacts[0];
  expect(reference?.kind).toBe("lead");
  if (reference !== undefined)
    expect(
      (await evidence.readFile(reference.digest, "lead.json", 1024 * 1024))
        .status,
    ).toBe("resolved");
});

it("records a later Trial's Finding after an earlier Lead", async () => {
  const { result, calls, ledger } = await trialCampaign({
    trialCount: 2,
    noFindingRuns: 2,
    replies: {
      "trial-0": { leads: [lead("consumer")] },
      "trial-1": { findings: [finding] },
    },
  });
  expect(result).toMatchObject({ runCount: 2, stoppedBy: "max-runs" });
  expect(calls.map((call) => call.runId)).toEqual(["trial-0", "trial-1"]);
  expect(ledger.read({ type: "finding-recorded" })).toHaveLength(1);
});
