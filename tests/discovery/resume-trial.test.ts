import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assessTrialResume,
  createNativeRunReceipt,
  defineAgentRuntimeProfile,
  executeTrialResume,
  ProviderAttachmentStore,
  RESUME_WALL_FLOOR_MS,
  sealNativeRunReceipt,
  type DiscoveryTransportRun,
  type NativeRunSession,
} from "../../src/discovery/index.js";
import { sessionFileContentFromDiagnostic } from "../../src/discovery/resume-trial.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";
import { recordWordPressReport } from "../../src/profiles/wordpress/discovery/candidate-admission.js";

const digest = `sha256:${"a".repeat(64)}`;
const otherDigest = `sha256:${"b".repeat(64)}`;
const promptDigest = `sha256:${"c".repeat(64)}`;
const now = "2026-10-19T00:00:00.000Z";
const profile = defineAgentRuntimeProfile({
  id: "cooperative",
  transportKind: "codex-native/v1",
  sandboxImageDigest: digest,
  requestedModelId: "gpt-6-sol",
  requestedEffort: "high",
  codexCliVersion: "0.161.0",
  bundledCatalogDigest: digest,
  authenticationMethod: "host-private-bearer",
  cyberAccessProgram: "daybreak_blue",
  serviceTier: "priority",
  subagent: { modelId: "gpt-6-sol", effort: "high" },
});
const otherProfile = defineAgentRuntimeProfile({
  id: "other",
  transportKind: "codex-native/v1",
  sandboxImageDigest: digest,
  requestedModelId: "gpt-6-sol",
  requestedEffort: "medium",
  codexCliVersion: "0.161.0",
  bundledCatalogDigest: digest,
  authenticationMethod: "host-private-bearer",
  cyberAccessProgram: "daybreak_blue",
  serviceTier: "priority",
  subagent: { modelId: "gpt-6-sol", effort: "medium" },
});
const resumePrompt = "Before giving up, keep exploring the fixed source.";
const prompt = `Find impact in the fixed source.\n\n${resumePrompt}\n\n## Trust boundary\n\nLow privilege only.`;
const WALL_MS = 120 * 60_000;
const MINIMUM_MS = 60 * 60_000;
const ROOT_THREAD = "11111111-2222-4333-8444-555555555555";
const CHILD_THREAD = "66666666-7777-4888-9999-000000000000";
const ROOT_PATH = "2026/10/19/rollout-2026-10-19T00-00-00-root.jsonl";
const CHILD_PATH = "2026/10/19/rollout-2026-10-19T00-01-00-child.jsonl";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const rootRollout = [
  {
    timestamp: now,
    type: "session_meta",
    payload: { id: ROOT_THREAD, source: "exec" },
  },
  {
    type: "event_msg",
    payload: {
      type: "task_complete",
      error: { message: "refused", codex_error_info: "cyber_policy" },
    },
  },
]
  .map((event) => JSON.stringify(event))
  .join("\n");
const processDiagnostic = JSON.stringify({
  type: "sandbox_process_diagnostic",
  payload: { status: "exited", exitCode: 1, stderrTail: "", stdoutTail: "" },
});
const childRollout = JSON.stringify({
  timestamp: now,
  type: "session_meta",
  payload: {
    id: CHILD_THREAD,
    source: {
      subagent: {
        thread_spawn: {
          parent_thread_id: ROOT_THREAD,
          depth: 1,
          agent_path: "/root/child_1",
        },
      },
    },
  },
});

async function open() {
  const root = await mkdtemp(join(tmpdir(), "wbh-resume-"));
  directories.push(root);
  const attachments = new ProviderAttachmentStore(join(root, "attachments"));
  const evidence = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 20,
    maxBytes: 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: evidence,
  });
  return { attachments, evidence, ledger };
}

type Stores = Awaited<ReturnType<typeof open>>;

/** One finished exploration as the transport, `executeTrial` and the sandbox leave it. */
async function recordRun(
  stores: Stores,
  options: {
    readonly runId: string;
    readonly trialId?: string;
    readonly trialOrdinal?: number;
    readonly outcome?: "failed" | "completed";
    readonly reason?: "provider" | "schema" | "wall";
    readonly reasonDetail?: string;
    readonly providerLimit?: "quota";
    readonly wallTimeMs?: number;
    readonly session?: "recorded" | "none" | "evidence-missing";
    readonly labAttached?: boolean;
    readonly snapshotDigest?: string;
    readonly promptDigest?: string;
    readonly runKind?: "explore" | "child";
    readonly resumesRun?: string;
    readonly resumeSegment?: number;
    readonly profile?: typeof profile;
    readonly research?: boolean;
    readonly finish?: boolean;
  },
): Promise<{ readonly session: NativeRunSession | undefined }> {
  const { ledger, evidence, attachments } = stores;
  const snapshotDigest = options.snapshotDigest ?? digest;
  const base = {
    schemaVersion: 1 as const,
    campaignId: "campaign-1",
    snapshotDigest,
    occurredAt: now,
  };
  const rootAttachment = await attachments.put(
    "diagnostic",
    Buffer.from(`${rootRollout}\n${processDiagnostic}`),
  );
  const childAttachment = await attachments.put(
    "diagnostic",
    Buffer.from(childRollout),
  );
  const sessionMode = options.session ?? "recorded";
  const session: NativeRunSession | undefined =
    sessionMode === "none"
      ? undefined
      : {
          rootThreadId: ROOT_THREAD,
          rootTurns: 1,
          segment: options.resumeSegment ?? 0,
          files: [
            {
              path: ROOT_PATH,
              threadId: ROOT_THREAD,
              kind: "root",
              diagnosticArtifactDigest:
                sessionMode === "evidence-missing"
                  ? otherDigest
                  : rootAttachment.digest,
            },
            {
              path: CHILD_PATH,
              threadId: CHILD_THREAD,
              kind: "child",
              diagnosticArtifactDigest: childAttachment.digest,
            },
          ],
        };
  const research =
    options.research === false
      ? undefined
      : await attachments.put(
          "research",
          Buffer.from(
            JSON.stringify({
              kind: "research-directory-archive",
              schemaVersion: 1,
              truncated: false,
              collectedBytes: 5,
              entries: [
                { path: "notes", type: "directory" },
                {
                  path: "notes/plan.md",
                  type: "file",
                  contentBase64: Buffer.from("plan\n").toString("base64"),
                },
                {
                  path: "notes/partial.md",
                  type: "file",
                  contentBase64: "",
                  truncated: true,
                },
              ],
            }),
          ),
        );
  const receipt = createNativeRunReceipt({
    runId: options.runId,
    targetSnapshotDigest: snapshotDigest,
    profile: options.profile ?? profile,
    terminal: options.outcome === "completed" ? "completed" : "incomplete",
    reason:
      options.outcome === "completed"
        ? "unavailable"
        : (options.reason ?? "provider"),
    ...(options.outcome === "completed"
      ? {}
      : { reasonDetail: options.reasonDetail ?? "provider-cyber-policy" }),
    ...(options.providerLimit === undefined
      ? {}
      : { providerLimit: options.providerLimit }),
    startedAt: now,
    completedAt: now,
    diagnosticArtifactDigest: rootAttachment.digest,
    ...(session === undefined ? {} : { session }),
  });
  const receiptDigest = await sealNativeRunReceipt(evidence, receipt);
  const started = await ledger.append({
    ...base,
    identity: `discovery-start-${options.runId}`,
    type: "discovery-run-started",
    runId: options.runId,
    trialId: options.trialId ?? options.runId,
    trialOrdinal: options.trialOrdinal ?? 0,
    runKind: options.runKind ?? "explore",
    ...(options.runKind === "child" ? { parentRunId: "parent" } : {}),
    ...(options.resumesRun === undefined
      ? {}
      : {
          resumesRun: options.resumesRun,
          resumeSegment: options.resumeSegment ?? 1,
        }),
    ...(options.labAttached === true
      ? { labId: "lab-1", labAttached: true }
      : { labAttached: false }),
    history: { mode: "none" },
    configuration: {
      promptVariant: "wp2shell-bounty-v8",
      promptDigest: options.promptDigest ?? promptDigest,
      objectiveDigest: options.promptDigest ?? promptDigest,
      contractDigest: otherDigest,
      trustBoundaryVersion: "trust-boundary-v1",
      sourcePack: { dependency: "mounted" },
      assignmentUnit: "plugin",
      labAccess: { database: "none" },
    },
  });
  expect(started.status).toBe("appended");
  if (options.finish === false) return { session };
  const finished = await ledger.append({
    ...base,
    identity: `discovery-finish-${options.runId}`,
    type: "discovery-run-finished",
    runId: options.runId,
    outcome:
      options.providerLimit !== undefined
        ? "provider-limited"
        : (options.outcome ?? "failed"),
    costUsd: "unavailable",
    wallTimeMs: options.wallTimeMs ?? 10 * 60_000,
    ...(options.outcome === "completed"
      ? {}
      : {
          reason: options.reason ?? "provider",
          reasonDetail: options.reasonDetail ?? "provider-cyber-policy",
          ...(options.providerLimit === undefined
            ? {}
            : { providerLimit: options.providerLimit }),
        }),
    diagnosticArtifactDigest: rootAttachment.digest,
    ...(research === undefined
      ? {}
      : { researchArtifact: { digest: research.digest, truncated: false } }),
    artifacts: [{ kind: "native-run-receipt", digest: receiptDigest }],
  });
  expect(finished.status).toBe("appended");
  return { session };
}

function assess(
  stores: Stores,
  overrides: Partial<Parameters<typeof assessTrialResume>[0]> = {},
) {
  return assessTrialResume({
    ledger: stores.ledger,
    evidence: stores.evidence,
    attachments: stores.attachments,
    campaignId: "campaign-1",
    runId: "run-1",
    snapshotDigest: digest,
    promptDigest,
    prompt,
    resumePrompt,
    profileDigest: profile.digest,
    wallTimeMs: WALL_MS,
    minimumActiveMs: MINIMUM_MS,
    ...overrides,
  });
}

describe("resumability rule (ADR 0036)", () => {
  it("admits the latest segment of a provider-refused cooperative run and gathers its session", async () => {
    const stores = await open();
    await recordRun(stores, { runId: "run-1", wallTimeMs: 25 * 60_000 });
    const assessment = await assess(stores);
    expect(assessment.status).toBe("resumable");
    if (assessment.status !== "resumable") return;
    expect(assessment.plan).toMatchObject({
      originalRunId: "run-1",
      resumesRun: "run-1",
      trialId: "run-1",
      trialOrdinal: 0,
      segment: 1,
      consumedWallMs: 25 * 60_000,
      remainingWallMs: 95 * 60_000,
      minimumActiveMs: 35 * 60_000,
      researchRestored: true,
      configuration: {
        promptVariant: "wp2shell-bounty-v8",
        promptDigest,
        assignmentUnit: "plugin",
      },
    });
    expect(assessment.plan.resume.threadId).toBe(ROOT_THREAD);
    expect(assessment.plan.resume.sessions.map((file) => file.path)).toEqual([
      ROOT_PATH,
      CHILD_PATH,
    ]);
    // The Harness process diagnostic appended after the failure is not part of the CLI's file.
    const root = assessment.plan.resume.sessions[0]!;
    expect(root.content).toBe(rootRollout);
    expect(root.content).not.toContain("sandbox_process_diagnostic");
    // Only complete notes files come back; the truncated one does not.
    expect(assessment.plan.resume.research).toEqual([
      {
        path: "notes/plan.md",
        contentBase64: Buffer.from("plan\n").toString("base64"),
      },
    ]);
  });

  it("refuses every other finish reason and failed-run shape with a named reason and no event", async () => {
    const cases: readonly {
      readonly label: string;
      readonly run: Parameters<typeof recordRun>[1];
      readonly reason: string;
      readonly detail?: string;
    }[] = [
      {
        label: "provider limit",
        run: {
          runId: "run-1",
          providerLimit: "quota",
          reasonDetail: "cli-exit:1",
        },
        reason: "not-a-provider-refusal",
        detail: "provider-limited/provider/cli-exit:1",
      },
      {
        label: "schema failure",
        run: {
          runId: "run-1",
          reason: "schema",
          reasonDetail: "missing-final-message",
        },
        reason: "not-a-provider-refusal",
        detail: "failed/schema/missing-final-message",
      },
      {
        label: "wall",
        run: { runId: "run-1", reason: "wall", reasonDetail: "timed-out" },
        reason: "not-a-provider-refusal",
      },
      {
        label: "completed",
        run: { runId: "run-1", outcome: "completed" },
        reason: "not-a-provider-refusal",
        detail: "completed",
      },
      {
        label: "attached Lab",
        run: { runId: "run-1", labAttached: true },
        reason: "lab-attached",
      },
      {
        label: "other snapshot",
        run: { runId: "run-1", snapshotDigest: otherDigest },
        reason: "snapshot-digest-differs",
        detail: otherDigest,
      },
      {
        label: "other prompt version",
        run: { runId: "run-1", promptDigest: otherDigest },
        reason: "prompt-version-differs",
        detail: otherDigest,
      },
      {
        label: "old receipt without session",
        run: { runId: "run-1", session: "none" },
        reason: "session-unrecorded",
      },
      {
        label: "session evidence gone",
        run: { runId: "run-1", session: "evidence-missing" },
        reason: "session-evidence-missing",
      },
      {
        label: "other runtime profile",
        run: { runId: "run-1", profile: otherProfile },
        reason: "runtime-profile-differs",
        detail: otherProfile.digest,
      },
      {
        label: "wall exhausted",
        run: { runId: "run-1", wallTimeMs: WALL_MS - RESUME_WALL_FLOOR_MS + 1 },
        reason: "wall-exhausted",
      },
      {
        label: "child run",
        run: { runId: "run-1", runKind: "child" },
        reason: "not-an-exploration",
        detail: "child",
      },
      {
        label: "unfinished run",
        run: { runId: "run-1", finish: false },
        reason: "run-unfinished",
      },
    ];
    for (const testCase of cases) {
      const stores = await open();
      await recordRun(stores, testCase.run);
      const before = stores.ledger.readAll({}).length;
      const assessment = await assess(stores);
      expect(assessment, testCase.label).toMatchObject({
        status: "refused",
        reason: testCase.reason,
        ...(testCase.detail === undefined ? {} : { detail: testCase.detail }),
      });
      expect(stores.ledger.readAll({}).length, testCase.label).toBe(before);
    }
  });

  it("refuses an unknown run, a prompt without the resume paragraph, and a run already resumed", async () => {
    const stores = await open();
    expect(await assess(stores, { runId: "missing" })).toMatchObject({
      status: "refused",
      reason: "run-unknown",
    });
    await recordRun(stores, { runId: "run-1" });
    expect(
      await assess(stores, { prompt: "An objective without the directive." }),
    ).toMatchObject({ status: "refused", reason: "resume-paragraph-missing" });
    await recordRun(stores, {
      runId: "run-1-resume",
      trialId: "run-1",
      resumesRun: "run-1",
      resumeSegment: 1,
      wallTimeMs: 20 * 60_000,
    });
    expect(await assess(stores)).toMatchObject({
      status: "refused",
      reason: "already-resumed",
      detail: "run-1-resume",
    });
    // The second segment was refused too: it is resumable with the wall of both segments spent.
    const second = await assess(stores, { runId: "run-1-resume" });
    expect(second).toMatchObject({
      status: "resumable",
      plan: {
        originalRunId: "run-1",
        resumesRun: "run-1-resume",
        trialId: "run-1",
        segment: 2,
        consumedWallMs: 30 * 60_000,
        remainingWallMs: 90 * 60_000,
        minimumActiveMs: 30 * 60_000,
      },
    });
  });

  it("keeps at least one resume turn when the earlier segments already spent the active minimum", async () => {
    const stores = await open();
    await recordRun(stores, { runId: "run-1", wallTimeMs: 70 * 60_000 });
    const assessment = await assess(stores);
    expect(assessment).toMatchObject({
      status: "resumable",
      plan: { remainingWallMs: 50 * 60_000, minimumActiveMs: 1_000 },
    });
  });

  it("strips only the Harness process diagnostic from a sealed Root rollout", () => {
    const partial = `${rootRollout}\n${processDiagnostic}\n{"type":"event_msg","pa`;
    expect(sessionFileContentFromDiagnostic(partial)).toBe(
      `${rootRollout}\n{"type":"event_msg","pa`,
    );
  });
});

describe("executeTrialResume", () => {
  it("runs the segment under the same Trial, links it in the ledger and counts the Trial once in the funnel", async () => {
    const stores = await open();
    await recordRun(stores, { runId: "run-1", wallTimeMs: 25 * 60_000 });
    const assessment = await assess(stores);
    if (assessment.status !== "resumable") throw new Error(assessment.reason);
    const runs: DiscoveryTransportRun[] = [];
    const clock = () => new Date(now);
    const outcome = await executeTrialResume(
      {
        campaignId: "campaign-1",
        input: {
          schemaVersion: 1,
          snapshotDigest: digest,
          trustBoundary: {
            version: "trust-boundary-v1",
            text: "Low privilege only.",
          },
          programmeBoundary: { version: "v1", text: "Boundary" },
          modelProfileDigest: profile.digest,
          promptDigest,
          stopRules: { maxRuns: 1, noFindingRuns: 1 },
          lab: { mode: "none" },
          history: { mode: "none" },
        },
        executor: {
          async execute(run) {
            runs.push(run);
            const report = await stores.attachments.put(
              "findings",
              Buffer.from(
                JSON.stringify({
                  findings: [],
                  leads: [],
                  examined: "resumed routes",
                  unexamined: "none",
                }),
              ),
            );
            return {
              attachment: report,
              receipt: createNativeRunReceipt({
                runId: run.runId,
                targetSnapshotDigest: run.targetSnapshotDigest,
                profile: run.profile,
                terminal: "completed",
                reason: "unavailable",
                startedAt: now,
                completedAt: "2026-10-19T00:40:00.000Z",
                reportArtifactDigest: report.digest,
                observed: {
                  toolCalls: 3,
                  filesRead: 2,
                  uniqueFilesRead: 2,
                  labRequests: 0,
                  dbQueries: 0,
                },
              }),
            };
          },
        },
        attachments: stores.attachments,
        evidence: stores.evidence,
        ledger: stores.ledger,
        recordReport: recordWordPressReport,
        clock,
      },
      assessment.plan,
      {
        runId: "run-1-segment-1",
        targetSnapshotDigest: digest,
        profile,
        coordination: "cooperative",
        prompt,
        resumePrompt,
        sourceDirectory: "/private/frozen-source",
        sourceTree: { digest, entries: 1, bytes: 1 },
      },
    );
    expect(outcome).toMatchObject({
      runId: "run-1-segment-1",
      outcome: "completed",
      counted: true,
    });
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run).toMatchObject({
      runId: "run-1-segment-1",
      minimumActiveMs: 35 * 60_000,
      resumePrompt,
      resume: { threadId: ROOT_THREAD, segment: 1 },
      // The remaining wall, not a fresh 120 minutes.
      expiresAt: "2026-10-19T01:35:00.000Z",
    });
    expect(run?.prompt).toContain(resumePrompt);
    const starts = stores.ledger
      .readAll({ campaignId: "campaign-1", type: "discovery-run-started" })
      .map(({ event }) => event);
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatchObject({
      runId: "run-1-segment-1",
      trialId: "run-1",
      trialOrdinal: 0,
      runKind: "explore",
      resumesRun: "run-1",
      resumeSegment: 1,
      labAttached: false,
      configuration: { promptVariant: "wp2shell-bounty-v8", promptDigest },
    });
    // The original failed finish and its event count are untouched.
    const finishes = stores.ledger
      .readAll({ campaignId: "campaign-1", type: "discovery-run-finished" })
      .map(({ event }) => event);
    expect(
      finishes.map((event) =>
        event.type === "discovery-run-finished"
          ? [event.runId, event.outcome]
          : [],
      ),
    ).toEqual([
      ["run-1", "failed"],
      ["run-1-segment-1", "completed"],
    ]);
    const funnel = stores.ledger.funnel("campaign-1");
    expect(funnel).toMatchObject({
      discoveryAttempts: 1,
      runCount: 2,
      wallTimeMs: 25 * 60_000 + 40 * 60_000,
      byLab: { none: { runs: 1, findings: 0, confirmed: 0 } },
    });
    expect(funnel.byObjective["wp2shell-bounty-v8"]).toMatchObject({ runs: 1 });
  });
});
