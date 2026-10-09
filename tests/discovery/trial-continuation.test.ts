import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  createNativeRunReceipt,
  defineAgentRuntimeProfile,
  ProviderAttachmentStore,
  runDiscoveryCampaign,
  type AdmittedLead,
  type PlannedTrial,
} from "../../src/discovery/index.js";
import { Evaluation } from "../../src/evaluation/index.js";
import { canonicalJson } from "../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";
import { wordpressFindingLocations } from "../../src/profiles/wordpress/answer-key.js";
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
  readonly continueTrials: readonly number[];
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
      return {
        trialId,
        trialOrdinal,
        explore,
        ...(options.continueTrials.includes(trialOrdinal)
          ? {
              continuation: {
                maxRuns: 2,
                wallTimeMs: 30 * 60_000,
                plan: (candidate: AdmittedLead) => ({
                  configuration: explore.configuration,
                  run: {
                    ...explore.run,
                    runId: `continue-${trialOrdinal}-${candidate.missingEdge}`,
                    prompt: `Synthetic purpose\n\n## Lead\n${canonicalJson(candidate)}\n\n## Neighbourhood\nSynthetic source facts`,
                  },
                }),
              },
            }
          : {}),
      };
    },
  );
  const result = await runDiscoveryCampaign({
    campaignId: "campaign-1",
    labId: "lab-1",
    input,
    historyFraction: 0,
    ablation: { axes: [{ axis: "prompt", armBFraction: 0.5 }] },
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

it("selects two Leads in priority order and records parent links", async () => {
  const { result, calls, ledger, evidence } = await trialCampaign({
    trialCount: 1,
    continueTrials: [0],
    noFindingRuns: 1,
    replies: {
      "trial-0": {
        leads: [
          lead("precondition"),
          { invalid: true },
          lead("consumer"),
          lead("auth-use"),
        ],
      },
    },
  });
  expect(result).toMatchObject({ runCount: 1, stoppedBy: "max-runs" });
  expect(calls.map((call) => call.runId)).toEqual([
    "trial-0",
    "continue-0-auth-use",
    "continue-0-consumer",
  ]);
  expect(calls[1]?.prompt).toContain("## Lead");
  expect(calls[1]?.prompt).toContain("## Neighbourhood");
  expect(calls[1]?.prompt).not.toContain("Synthetic precondition edge");
  const leads = ledger
    .read({ type: "lead-recorded" })
    .map(({ event }) => event);
  expect(leads).toHaveLength(3);
  expect(JSON.stringify(leads)).not.toContain("synthetic_shared");
  const started = ledger
    .read({ type: "discovery-run-started" })
    .map(({ event }) => event);
  expect(
    started.map((event) =>
      event.type === "discovery-run-started" ? event.runKind : null,
    ),
  ).toEqual(["explore", "continue", "continue"]);
  expect(
    started
      .slice(1)
      .every(
        (event) =>
          event.type === "discovery-run-started" &&
          event.trialId === "trial-0" &&
          leads.some(
            (candidate) =>
              candidate.type === "lead-recorded" &&
              candidate.leadId === event.continuationOf,
          ),
      ),
  ).toBe(true);
  const reference = leads[0]?.artifacts[0];
  expect(reference?.kind).toBe("lead");
  if (reference !== undefined)
    expect(
      (await evidence.readFile(reference.digest, "lead.json", 1024 * 1024))
        .status,
    ).toBe("resolved");
  expect(
    ledger
      .read({ type: "discovery-run-finished" })
      .every(
        ({ event }) =>
          event.type === "discovery-run-finished" &&
          event.outcome === "completed",
      ),
  ).toBe(true);
});

it("does not continue when the optional block is absent", async () => {
  const { calls } = await trialCampaign({
    trialCount: 1,
    continueTrials: [],
    noFindingRuns: 1,
    replies: { "trial-0": { leads: [lead("consumer")] } },
  });
  expect(calls.map((call) => call.runId)).toEqual(["trial-0"]);
});

it("credits a continued Finding to its Trial and keeps a failed continuation from failing exploration", async () => {
  const base = {
    trialCount: 3,
    continueTrials: [1],
    noFindingRuns: 1,
    replies: {
      "trial-0": { leads: [lead("consumer")] },
      "trial-1": { leads: [lead("consumer")] },
      "continue-1-consumer": { findings: [finding] },
    },
  };
  const success = await trialCampaign(base);
  expect(success.result).toMatchObject({
    runCount: 3,
    stoppedBy: "no-new-finding",
  });
  expect(success.ledger.funnel("campaign-1").byArm["prompt:b"]?.findings).toBe(
    1,
  );
  const comparison = new Evaluation({
    ledger: success.ledger,
    store: success.evidence,
    locationsOf: wordpressFindingLocations,
  }).compare({ axis: "prompt" });
  expect(comparison.pooled.b.findings).toBe(1);

  const failed = await trialCampaign({
    ...base,
    replies: { ...base.replies, "continue-1-consumer": { fail: true } },
  });
  expect(failed.result).toMatchObject({
    runCount: 2,
    stoppedBy: "no-new-finding",
  });
  const outcomes = failed.ledger
    .read({ type: "discovery-run-finished" })
    .map(({ event }) =>
      event.type === "discovery-run-finished"
        ? [event.runId, event.outcome]
        : null,
    );
  expect(outcomes).toContainEqual(["trial-1", "completed"]);
  expect(outcomes).toContainEqual(["continue-1-consumer", "failed"]);
});
