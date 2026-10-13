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
import { isWordPressProgrammeImpact } from "../../src/profiles/wordpress/discovery/programme-impacts.js";
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
    readonly indexed?: boolean;
    readonly leadOnly?: boolean;
    /** Report a Finding whose impact lies outside the Programme Boundary (#185). */
    readonly parkedImpact?: boolean;
    readonly rootChildCounts?: {
      readonly observed: number;
      readonly admitted: number;
    };
    readonly research?: { readonly truncated: boolean };
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
    stopRules: options.indexed
      ? { maxRuns: 1, noFindingRuns: 1 }
      : { maxRuns: 6, noFindingRuns: 2 },
    lab: { setupDigest: digest },
    history,
    ...(options.indexed
      ? { entryIndex: { enabled: true as const, digest } }
      : {}),
  };
  const claim = {
    claim: "Synthetic account state change",
    attackerPosition: "subscriber",
    impact: options.parkedImpact ? "other" : "account-takeover",
    configurationPrecondition: "default",
    brokenProperty: "Account ownership",
    sourceTrace: [
      { file: "includes/example.php", function: "fixture", line: 12 },
    ],
    existingControls: "Capability check elsewhere",
    labObservations: options.indexed ? "none" : "Canary user changed",
  };
  let calls = 0;
  const result = await runDiscoveryCampaign({
    campaignId: "campaign-1",
    labId: "lab-1",
    input,
    historyFraction: 0.5,
    runWallTimeMs: 60 * 60_000,
    ...(options.indexed
      ? {}
      : {
          ablation: { axes: [{ axis: "history" as const, armBFraction: 0.5 }] },
        }),
    ledger,
    attachments,
    evidence,
    admitFinding: admitWordPressFinding,
    isProgrammeImpact: isWordPressProgrammeImpact,
    admitLead: admitWordPressLead,
    leadSignature: (lead) => wordPressLeadSignature(readWordPressLead(lead)),
    normalizeCandidate: normalizeWordPressCandidate,
    classifyCandidate: classifyWordPressCandidate,
    executor: {
      async execute(run) {
        expect(run.expiresAt).toBe("2026-10-08T08:00:00.000Z");
        const ordinal = calls++;
        const researchArtifact =
          options.research === undefined
            ? undefined
            : {
                attachment: await attachments.put(
                  "research",
                  Buffer.from(
                    JSON.stringify({
                      kind: "research-directory-archive",
                      entries: [{ path: "REGISTRY.md" }],
                    }),
                  ),
                ),
                truncated: options.research.truncated,
              };
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
            ...(researchArtifact === undefined ? {} : { researchArtifact }),
            receipt: createNativeRunReceipt({
              runId: run.runId,
              targetSnapshotDigest: run.targetSnapshotDigest,
              profile: run.profile,
              terminal: "incomplete",
              reason: "schema",
              reasonDetail: "invalid-event-shape",
              startedAt: "2026-10-08T07:00:00Z",
              completedAt: "2026-10-08T07:00:01Z",
              ...(options.rootChildCounts === undefined
                ? {}
                : {
                    childThreadsObserved: options.rootChildCounts.observed,
                    childThreadsAdmitted: options.rootChildCounts.admitted,
                  }),
              reportArtifactDigest: attachment.digest,
            }),
          };
        }
        if (ordinal === 0 && options.childSurvivesBrokenRoot) {
          const childAttachment = await attachments.put(
            "findings",
            Buffer.from(
              JSON.stringify({
                findings: [{ broken: true }, claim],
                leads: [],
                examined: "child examined source",
                unexamined: "none",
              }),
            ),
          );
          return {
            ...(researchArtifact === undefined ? {} : { researchArtifact }),
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
          ...(researchArtifact === undefined ? {} : { researchArtifact }),
          receipt: createNativeRunReceipt({
            runId: run.runId,
            targetSnapshotDigest: run.targetSnapshotDigest,
            profile: run.profile,
            terminal: "completed",
            reason: "unavailable",
            startedAt: "2026-10-08T07:00:00Z",
            completedAt: "2026-10-08T07:00:01Z",
            ...(options.rootChildCounts === undefined
              ? {}
              : {
                  childThreadsObserved: options.rootChildCounts.observed,
                  childThreadsAdmitted: options.rootChildCounts.admitted,
                }),
            reportArtifactDigest: attachment.digest,
          }),
        };
      },
    },
    plannedTrials: Array.from(
      { length: options.indexed ? 1 : 6 },
      (_, index) => ({
        trialId: `run-${index}`,
        trialOrdinal: index,
        explore: {
          configuration: {
            promptVariant: index % 2 ? "wp2shell-derived" : "short-objective",
            assignmentUnit: "route",
            ...(options.indexed
              ? { entryIndex: { enabled: true as const, digest } }
              : {}),
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
        },
      }),
    ),
    clock: () => new Date("2026-10-08T07:00:00Z"),
  });
  return { result, calls, ledger, evidence, attachments };
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

it("records child thread counts on both completed and incomplete Root runs", async () => {
  for (const rootTranscriptInvalid of [false, true]) {
    const { ledger } = await campaign([], {
      indexed: true,
      rootTranscriptInvalid,
      rootChildCounts: { observed: 4, admitted: 3 },
    });
    expect(
      ledger.read({ type: "discovery-run-finished" })[0]?.event,
    ).toMatchObject({
      runId: "run-0",
      outcome: rootTranscriptInvalid ? "failed" : "completed",
      childThreadsObserved: 4,
      childThreadsAdmitted: 3,
    });
  }
});

it("references bounded Trial research evidence from completed and failed Root runs", async () => {
  for (const rootTranscriptInvalid of [false, true]) {
    const { ledger, attachments } = await campaign([], {
      indexed: true,
      rootTranscriptInvalid,
      research: { truncated: true },
    });
    const finished = ledger.read({ type: "discovery-run-finished" })[0]?.event;
    expect(finished).toMatchObject({
      runId: "run-0",
      outcome: rootTranscriptInvalid ? "failed" : "completed",
      researchArtifact: {
        digest: expect.stringMatching(/^sha256:/),
        truncated: true,
      },
    });
    if (
      finished?.type !== "discovery-run-finished" ||
      finished.researchArtifact === undefined
    )
      throw new Error("Missing research artifact reference");
    expect(
      await attachments.readByDigest(
        "research",
        finished.researchArtifact.digest,
      ),
    ).toMatchObject({ status: "resolved" });
    expect(JSON.stringify(finished)).not.toContain("REGISTRY.md");
  }
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

it("passes the fixed source entry index to one cooperative Trial without a stage", async () => {
  const { result, calls, ledger } = await campaign([], { indexed: true });
  expect(result).toEqual({
    runCount: 1,
    findingsRecorded: 0,
    stoppedBy: "no-new-finding",
  });
  expect(calls).toBe(1);
  const started = ledger.read({ type: "discovery-run-started" })[0]?.event;
  expect(started).toMatchObject({
    trialId: "run-0",
    runKind: "explore",
    configuration: {
      promptVariant: "short-objective",
      entryIndex: { enabled: true, digest },
    },
  });
  expect(started).not.toHaveProperty("stage");
  expect(started).not.toHaveProperty("continuationOf");
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

it("parks a Finding outside the Programme Boundary without verifying or counting it (#185)", async () => {
  const { result, ledger, evidence } = await campaign([0], {
    parkedImpact: true,
  });
  expect(ledger.read({ type: "finding-recorded" })).toHaveLength(0);
  const parked = ledger.read({ type: "finding-parked" });
  expect(parked).toHaveLength(1);
  expect(parked[0]?.event).toMatchObject({
    category: "other",
    reason: "outside-programme-boundary",
  });
  const reference = parked[0]?.event.artifacts[0];
  expect(reference?.kind).toBe("finding");
  expect(
    reference &&
      (await evidence.readFile(reference.digest, "finding.json", 100_000))
        .status,
  ).toBe("resolved");
  expect(result.findingsRecorded).toBe(0);
  expect(ledger.funnel("campaign-1")).toMatchObject({
    parked: 1,
    raw: 0,
    accepted: 0,
  });
});
