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
import {
  admitWordPressLead,
  readWordPressLead,
  wordPressLeadSignature,
} from "../../src/profiles/wordpress/discovery/lead.js";
import {
  classifyWordPressCandidate,
  normalizeWordPressCandidate,
} from "../../src/profiles/wordpress/discovery/normalize-candidate.js";

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

async function campaign(
  findingRuns: readonly number[],
  options: {
    readonly childSurvivesBrokenRoot?: boolean;
    readonly heldOnly?: boolean;
    readonly rootTranscriptInvalid?: boolean;
    readonly screening?: boolean;
    readonly leadOnly?: boolean;
    readonly coverageContinuation?: boolean;
    readonly salvagedInitial?: boolean;
    readonly salvagedReport?: boolean;
    readonly continuedChild?: boolean;
    readonly reusedChild?: boolean;
  } = {},
) {
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
    stopRules: options.screening
      ? { maxRuns: 1, noFindingRuns: 1 }
      : { maxRuns: 6, noFindingRuns: 2 },
    lab: { setupDigest: digest },
    history,
    ...(options.screening
      ? { entryIndex: { enabled: true as const, digest } }
      : {}),
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
    labObservations: options.screening ? "none" : "Canary user changed",
  };
  let calls = 0;
  const result = await runDiscoveryCampaign({
    campaignId: "campaign-1",
    labId: "lab-1",
    input,
    historyFraction: 0.5,
    runWallTimeMs: (options.screening ? 30 : 90) * 60_000,
    ...(options.screening
      ? {}
      : {
          ablation: { axes: [{ axis: "history" as const, armBFraction: 0.5 }] },
        }),
    ledger,
    attachments,
    evidence,
    admitFinding: admitWordPressFinding,
    admitLead: admitWordPressLead,
    leadSignature: (lead) => wordPressLeadSignature(readWordPressLead(lead)),
    normalizeCandidate: normalizeWordPressCandidate,
    classifyCandidate: classifyWordPressCandidate,
    executor: {
      async execute(run) {
        expect(run.expiresAt).toBe(
          options.screening
            ? "2026-10-08T07:30:00.000Z"
            : "2026-10-08T08:30:00.000Z",
        );
        const ordinal = calls++;
        if (ordinal === 0 && options.rootTranscriptInvalid) {
          const attachment = await attachments.put(
            "findings",
            Buffer.from(
              JSON.stringify({
                findings: [claim],
                leads: [],
                examined: "source",
                unexamined: "none",
              }),
            ),
          );
          return {
            attachment,
            receipt: createNativeRunReceipt({
              runId: run.runId,
              targetSnapshotDigest: run.targetSnapshotDigest,
              profile: run.profile,
              terminal: "incomplete",
              reason: "schema",
              reasonDetail: "invalid-event-shape",
              startedAt: "2026-10-08T07:00:00Z",
              completedAt: "2026-10-08T07:00:01Z",
              reportArtifactDigest: attachment.digest,
            }),
          };
        }
        if (ordinal === 0 && options.childSurvivesBrokenRoot) {
          const childAttachment = await attachments.put(
            "findings",
            Buffer.from(
              JSON.stringify({
                findings: options.reusedChild
                  ? [claim, { ...claim, claim: "Second child claim" }]
                  : [{ broken: true }, claim],
                leads: [],
                examined: "child examined source",
                unexamined: "none",
              }),
            ),
          );
          return {
            receipt: createNativeRunReceipt({
              runId: run.runId,
              targetSnapshotDigest: run.targetSnapshotDigest,
              profile: run.profile,
              terminal: "incomplete",
              reason: "schema",
              reasonDetail: "final-message-not-report",
              startedAt: "2026-10-08T07:00:00Z",
              completedAt: "2026-10-08T07:00:01Z",
            }),
            agentRuns: [
              {
                agentPath: "/root/child-1",
                attachment: childAttachment,
                ...(options.reusedChild
                  ? { initialFindingCount: 1, initialLeadCount: 0 }
                  : {}),
                ...(options.continuedChild
                  ? { continuationOrdinal: 1 as const }
                  : {}),
                receipt: createNativeRunReceipt({
                  runId: "child-1",
                  targetSnapshotDigest: run.targetSnapshotDigest,
                  profile: run.profile,
                  terminal: "completed",
                  reason: "unavailable",
                  startedAt: "2026-10-08T07:00:00Z",
                  completedAt: "2026-10-08T07:00:01Z",
                  reportArtifactDigest: childAttachment.digest,
                }),
              },
            ],
          };
        }
        const report = {
          findings:
            options.heldOnly && ordinal === 0
              ? [{ ...claim, sourceTrace: ["invalid trace"] }]
              : findingRuns.includes(ordinal)
                ? [claim]
                : [],
          leads: options.leadOnly
            ? [
                {
                  summary: "Synthetic reachable route with an unresolved edge",
                  attackerPosition: "subscriber",
                  primitive: "read",
                  storage: null,
                  missingEdge: "reachability",
                  sourceTrace: [
                    {
                      file: "includes/example.php",
                      function: "fixture",
                      line: 12,
                    },
                  ],
                  labObservations: "none",
                },
              ]
            : [],
          examined: "source",
          unexamined: "none",
        };
        const attachment = await attachments.put(
          "findings",
          Buffer.from(JSON.stringify(report)),
        );
        return {
          attachment,
          ...(options.salvagedInitial
            ? { salvagedInitialReport: true as const }
            : {}),
          ...(options.salvagedReport ? { salvagedReport: true as const } : {}),
          ...(options.coverageContinuation
            ? {
                continuation: {
                  injected: true,
                  mode: "thread-resume" as const,
                  reason: "coverage-incomplete" as const,
                  remainingMinutes: 29,
                  entriesHandedBack: 1,
                  initialFindingCount: 0,
                  initialLeadCount: 0,
                },
              }
            : {}),
          receipt: createNativeRunReceipt({
            runId: run.runId,
            targetSnapshotDigest: run.targetSnapshotDigest,
            profile: run.profile,
            terminal:
              options.salvagedInitial || options.salvagedReport
                ? "incomplete"
                : "completed",
            reason:
              options.salvagedInitial || options.salvagedReport
                ? "evidence"
                : "unavailable",
            startedAt: "2026-10-08T07:00:00Z",
            completedAt: "2026-10-08T07:00:01Z",
            reportArtifactDigest: attachment.digest,
          }),
        };
      },
    },
    plannedTrials: Array.from(
      { length: options.screening ? 1 : 6 },
      (_, index) => ({
        trialId: `run-${index}`,
        trialOrdinal: index,
        ...(options.screening ? { stage: "screening" as const } : {}),
        explore: {
          configuration: {
            promptVariant: options.screening
              ? "screening-v1"
              : index % 2
                ? "wp2shell-derived"
                : "short-objective",
            assignmentUnit: "route",
            ...(options.screening
              ? { entryIndex: { enabled: true as const, digest } }
              : {}),
          },
          run: {
            runId: `run-${index}`,
            targetSnapshotDigest: digest,
            profile,
            ...(options.screening ? { coordination: "solo" as const } : {}),
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
      }),
    ),
    clock: () => new Date("2026-10-08T07:00:00Z"),
  });
  return { result, calls, ledger, evidence };
}

it("records valid child claims even when Root formatting and a sibling claim fail", async () => {
  const { ledger, evidence } = await campaign([], {
    childSurvivesBrokenRoot: true,
  });
  const findings = ledger.read({ type: "finding-recorded" });
  expect(findings).toHaveLength(1);
  expect(findings[0]?.event).toMatchObject({ runId: "child-1" });
  expect(ledger.read({ type: "candidate-held" })).toHaveLength(1);
  const childFinish = ledger
    .read({ type: "discovery-run-finished" })
    .find(
      ({ event }) =>
        event.type === "discovery-run-finished" && event.runId === "child-1",
    );
  expect(childFinish?.event).toMatchObject({ outcome: "completed" });
  expect(ledger.funnel("campaign-1")).toMatchObject({
    runCount: 2,
    discoveryAttempts: 1,
  });
  const reference = findings[0]?.event.artifacts[0];
  expect(reference?.kind).toBe("finding");
  expect(
    reference &&
      (await evidence.readFile(reference.digest, "finding.json", 100_000))
        .status,
  ).toBe("resolved");
});

it("marks candidates from a child started after the resume boundary", async () => {
  const { ledger } = await campaign([], {
    childSurvivesBrokenRoot: true,
    continuedChild: true,
  });
  expect(ledger.read({ type: "finding-recorded" })[0]?.event).toMatchObject({
    continuationOrdinal: 1,
  });
});

it("marks only the new candidate when an existing child is followed up", async () => {
  const { ledger } = await campaign([], {
    childSurvivesBrokenRoot: true,
    reusedChild: true,
  });
  const findings = ledger.read({ type: "finding-recorded" });
  expect(findings).toHaveLength(2);
  expect(findings[0]?.event).not.toHaveProperty("continuationOrdinal");
  expect(findings[1]?.event).toMatchObject({ continuationOrdinal: 1 });
});

it("keeps initial candidates when a resumed run loses rollout evidence", async () => {
  const { ledger } = await campaign([], {
    screening: true,
    leadOnly: true,
    salvagedInitial: true,
  });
  expect(ledger.read({ type: "lead-recorded" })).toHaveLength(1);
  expect(
    ledger.read({ type: "discovery-run-finished" })[0]?.event,
  ).toMatchObject({
    outcome: "failed",
    reason: "evidence",
  });
});

it("records candidates recovered from stdout when rollout capture fails", async () => {
  const { ledger } = await campaign([], {
    screening: true,
    leadOnly: true,
    coverageContinuation: true,
    salvagedReport: true,
  });
  expect(ledger.read({ type: "lead-recorded" })[0]?.event).toMatchObject({
    continuationOrdinal: 1,
  });
  expect(
    ledger.read({ type: "discovery-run-finished" })[0]?.event,
  ).toMatchObject({
    outcome: "failed",
    reason: "evidence",
    continuation: { injected: true },
  });
});

it("admits an extracted Root candidate without treating the transcript as completed", async () => {
  const { result, ledger } = await campaign([], {
    rootTranscriptInvalid: true,
  });
  expect(result).toMatchObject({
    runCount: 1,
    findingsRecorded: 1,
    stoppedBy: "incomplete",
  });
  expect(ledger.read({ type: "finding-recorded" })).toHaveLength(1);
  expect(ledger.read({ type: "candidate-normalized" })).toHaveLength(1);
});

it("keeps raw held candidates and stops at the output boundary", async () => {
  const { result, ledger, evidence } = await campaign([], { heldOnly: true });
  expect(result).toMatchObject({ runCount: 1, stoppedBy: "output-boundary" });
  const held = ledger.read({ type: "candidate-held" })[0]?.event;
  expect(held).toMatchObject({
    issuePaths: ["sourceTrace.0"],
    impact: "account-takeover",
  });
  const ref = held?.artifacts[0];
  expect(
    ref &&
      (await evidence.readFile(ref.digest, "candidate.json", 100_000)).status,
  ).toBe("resolved");
});

it("records one indexed screening Trial and leaves zero candidates unexplored", async () => {
  const { result, calls, ledger } = await campaign([], { screening: true });
  expect(result).toEqual({
    runCount: 1,
    findingsRecorded: 0,
    stoppedBy: "screened-no-candidate",
  });
  expect(calls).toBe(1);
  expect(
    ledger.read({ type: "discovery-run-started" })[0]?.event,
  ).toMatchObject({
    stage: "screening",
    trialId: "run-0",
    configuration: {
      promptVariant: "screening-v1",
      entryIndex: { enabled: true, digest },
    },
  });
  expect(ledger.read({ type: "discovery-concluded" })[0]?.event).toMatchObject({
    stoppedBy: "screened-no-candidate",
  });
});

it("does not treat a screening Lead or held candidate as a negative result", async () => {
  const finding = await campaign([0], { screening: true });
  expect(finding.result.stoppedBy).toBe("max-runs");
  expect(finding.ledger.read({ type: "finding-recorded" })).toHaveLength(1);
  const lead = await campaign([], { screening: true, leadOnly: true });
  expect(lead.result.stoppedBy).toBe("max-runs");
  expect(lead.ledger.read({ type: "lead-recorded" })).toHaveLength(1);
  const held = await campaign([], { screening: true, heldOnly: true });
  expect(held.result.stoppedBy).toBe("output-boundary");
});

it("records the continuation decision and marks candidates added after resume", async () => {
  const finding = await campaign([0], {
    screening: true,
    coverageContinuation: true,
  });
  expect(
    finding.ledger.read({ type: "discovery-run-finished" })[0]?.event,
  ).toMatchObject({
    continuation: {
      injected: true,
      mode: "thread-resume",
      entriesHandedBack: 1,
    },
  });
  expect(
    finding.ledger.read({ type: "finding-recorded" })[0]?.event,
  ).toMatchObject({ continuationOrdinal: 1 });
  const lead = await campaign([], {
    screening: true,
    leadOnly: true,
    coverageContinuation: true,
  });
  expect(lead.ledger.read({ type: "lead-recorded" })[0]?.event).toMatchObject({
    continuationOrdinal: 1,
  });
});

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
          ? [
              event.trialId,
              event.trialOrdinal,
              event.runKind,
              event.configuration.promptDigest,
              event.configuration.trustBoundaryVersion,
              event.configuration.sourcePack?.dependency,
            ]
          : null,
      ),
  ).toEqual([
    ["run-0", 0, "explore", digest, "v1", "none"],
    ["run-1", 1, "explore", digest, "v1", "none"],
    ["run-2", 2, "explore", digest, "v1", "none"],
  ]);
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

it("records the history arm the runner allocated to each run and counts runs and Findings per arm", async () => {
  const { ledger } = await campaign([1]);
  expect(
    ledger
      .read({ type: "discovery-run-started" })
      .map(({ event }) =>
        event.type === "discovery-run-started"
          ? [event.history.mode, event.configuration.arms?.history]
          : null,
      ),
  ).toEqual([
    ["none", "a"],
    ["catalog", "b"],
    ["none", "a"],
    ["catalog", "b"],
  ]);
  expect(ledger.funnel("campaign-1").byArm).toEqual({
    "history:a": { runs: 2, findings: 0, confirmed: 0 },
    "history:b": { runs: 2, findings: 1, confirmed: 0 },
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
