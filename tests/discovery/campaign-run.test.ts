import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import {
  createNativeRunReceipt,
  defineAgentRuntimeProfile,
  ProviderAttachmentStore,
  runDiscoveryCampaign,
} from "../../src/discovery/index.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";
import { recordWordPressReport } from "../../src/profiles/wordpress/discovery/candidate-admission.js";

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
    readonly wallOnFirstRun?: boolean;
    readonly ignoreAbort?: boolean;
    /** One planned Trial with stop rules 1/1, like the production campaign. */
    readonly singleTrial?: boolean;
    readonly leadOnly?: boolean;
    /** Report a Finding whose impact lies outside the Programme Boundary (#185). */
    readonly parkedImpact?: boolean;
    readonly precondition?: string;
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
  const input = {
    schemaVersion: 1 as const,
    snapshotDigest: digest,
    trustBoundary: { version: "v1", text: "Low privilege only" },
    programmeBoundary: { version: "v1", text: "Synthetic boundary" },
    modelProfileDigest: profile.digest,
    promptDigest: digest,
    stopRules: options.singleTrial
      ? { maxRuns: 1, noFindingRuns: 1 }
      : { maxRuns: 6, noFindingRuns: 2 },
    lab: { setupDigest: digest },
    history: { mode: "none" as const },
  };
  const claim = {
    claim: "Synthetic account state change",
    attackerPosition: "subscriber",
    impact: options.parkedImpact ? "other" : "account-takeover",
    configurationPrecondition: options.precondition ?? "default",
    brokenProperty: "Account ownership",
    sourceTrace: [
      { file: "includes/example.php", function: "fixture", line: 12 },
    ],
    existingControls: "Capability check elsewhere",
    labObservations: "Canary user changed",
  };
  // The child finished before cancellation; fixture I/O must not race shutdown.
  const wallChildAttachment =
    options.wallOnFirstRun && options.childSurvivesBrokenRoot
      ? await attachments.put(
          "findings",
          Buffer.from(
            JSON.stringify({
              findings: [claim],
              leads: [],
              examined: "child source",
              unexamined: "none",
            }),
          ),
        )
      : undefined;
  let calls = 0;
  const result = await runDiscoveryCampaign({
    campaignId: "campaign-1",
    labId: "lab-1",
    input,
    runWallTimeMs: options.wallOnFirstRun ? 30 : 60 * 60_000,
    ledger,
    attachments,
    evidence,
    recordReport: recordWordPressReport,
    executor: {
      async execute(run, signal) {
        expect(run.expiresAt).toBe(
          options.wallOnFirstRun
            ? "2026-10-08T07:00:00.030Z"
            : "2026-10-08T08:00:00.000Z",
        );
        const ordinal = calls++;
        if (ordinal === 0 && options.wallOnFirstRun) {
          if (options.ignoreAbort)
            return await new Promise<never>(() => undefined);
          if (signal === undefined)
            throw new Error(
              "Synthetic wall executor needs a cancellation signal",
            );
          if (!signal.aborted)
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            );
          return {
            receipt: createNativeRunReceipt({
              runId: run.runId,
              targetSnapshotDigest: run.targetSnapshotDigest,
              profile: run.profile,
              terminal: "incomplete",
              reason: "wall",
              startedAt: "2026-10-08T07:00:00Z",
              completedAt: "2026-10-08T07:00:01Z",
            }),
            ...(wallChildAttachment === undefined
              ? {}
              : {
                  agentRuns: [
                    {
                      agentPath: "/root/child-1",
                      attachment: wallChildAttachment,
                      receipt: createNativeRunReceipt({
                        runId: "child-1",
                        targetSnapshotDigest: run.targetSnapshotDigest,
                        profile: run.profile,
                        terminal: "completed",
                        reason: "unavailable",
                        startedAt: "2026-10-08T07:00:00Z",
                        completedAt: "2026-10-08T07:00:01Z",
                        reportArtifactDigest: wallChildAttachment.digest,
                      }),
                    },
                  ],
                }),
          };
        }
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
          const diagnostic = await attachments.put(
            "diagnostic",
            Buffer.from(
              JSON.stringify({
                type: "event_msg",
                payload: {
                  type: "item_completed",
                  item: {
                    type: "CommandExecution",
                    command: ["bash", "-lc", "cat includes/example.php"],
                  },
                },
              }),
            ),
          );
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
                  diagnosticArtifactDigest: diagnostic.digest,
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
      { length: options.singleTrial ? 1 : 6 },
      (_, index) => ({
        trialId: `run-${index}`,
        trialOrdinal: index,
        explore: {
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
        },
      }),
    ),
    clock: () => new Date("2026-10-08T07:00:00Z"),
  });
  return { result, calls, ledger, evidence, attachments };
}

it("writes discovery-run-finished with wall after a silent executor reaches its limit", async () => {
  const { result, ledger } = await campaign([], {
    wallOnFirstRun: true,
    singleTrial: true,
    childSurvivesBrokenRoot: true,
  });
  expect(result).toMatchObject({ runCount: 1, stoppedBy: "incomplete" });
  expect(ledger.read({ type: "finding-recorded" })).toHaveLength(1);
  expect(
    ledger
      .read({ type: "discovery-run-finished" })
      .find(
        ({ event }) =>
          event.type === "discovery-run-finished" && event.runId === "run-0",
      )?.event,
  ).toMatchObject({
    outcome: "failed",
    reason: "wall",
  });
});

it("finishes the ledger when an executor ignores the wall cancellation", async () => {
  const { ledger } = await campaign([], {
    wallOnFirstRun: true,
    singleTrial: true,
    ignoreAbort: true,
  });
  expect(
    ledger.read({ type: "discovery-run-finished" })[0]?.event,
  ).toMatchObject({
    outcome: "failed",
    reason: "wall",
  });
});

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
  const readPaths = childFinish?.event.artifacts.find(
    (artifact) => artifact.kind === "read-paths",
  );
  const stored = await evidence.readFile(
    readPaths!.digest,
    "read-paths.json",
    1024,
  );
  expect(stored.status === "resolved" && stored.bytes.toString()).toBe(
    '["includes/example.php"]',
  );
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
      singleTrial: true,
      rootTranscriptInvalid,
      rootChildCounts: { observed: 4, admitted: 4 },
    });
    expect(
      ledger.read({ type: "discovery-run-finished" })[0]?.event,
    ).toMatchObject({
      runId: "run-0",
      outcome: rootTranscriptInvalid ? "failed" : "completed",
      childThreadsObserved: 4,
      childThreadsAdmitted: 4,
    });
  }
});

it("references bounded Trial research evidence from completed and failed Root runs", async () => {
  for (const rootTranscriptInvalid of [false, true]) {
    const { ledger, attachments } = await campaign([], {
      singleTrial: true,
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
    ["none", "wp2shell-derived"],
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

it("records an in-scope Finding with an admin setting for validation", async () => {
  const { result, ledger, evidence } = await campaign([0], {
    precondition:
      "An administrator selects Password protected visibility for a published block.",
  });
  const recorded = ledger.read({ type: "finding-recorded" });
  expect(recorded).toHaveLength(1);
  expect(recorded[0]?.event).toMatchObject({
    preconditionClass: "admin-configuration",
  });
  expect(ledger.read({ type: "finding-parked" })).toHaveLength(0);
  const reference = recorded[0]?.event.artifacts[0];
  expect(reference?.kind).toBe("finding");
  expect(
    reference &&
      (await evidence.readFile(reference.digest, "finding.json", 100_000))
        .status,
  ).toBe("resolved");
  expect(result.findingsRecorded).toBe(1);
  expect(ledger.funnel("campaign-1")).toMatchObject({ parked: 0, raw: 1 });
});
