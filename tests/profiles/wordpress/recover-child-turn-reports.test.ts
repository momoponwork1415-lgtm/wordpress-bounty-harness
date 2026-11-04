import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  createNativeRunReceipt,
  defineAgentRuntimeProfile,
  ProviderAttachmentStore,
} from "../../../src/discovery/index.js";
import { extractCandidateReport } from "../../../src/discovery/codex-native-agent-runtime.js";
import {
  canonicalDigest,
  canonicalJson,
} from "../../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../../src/ledger/index.js";
import { recordWordPressReport } from "../../../src/profiles/wordpress/discovery/candidate-admission.js";
import { recoverWordPressChildTurnReports } from "../../../src/profiles/wordpress/discovery/recover-child-reports.js";

// #539: 完了した Codex の子の前のターンの報告を、記録済みの報告に無い候補だけ追記する。

const digest = `sha256:${"a".repeat(64)}`;
const now = "2026-10-08T08:00:00Z";
const clock = () => new Date(now);
const profile = defineAgentRuntimeProfile({
  id: "synthetic",
  transportKind: "codex-native/v1",
  sandboxImageDigest: digest,
  requestedModelId: "gpt-6-sol",
  requestedEffort: "high",
  codexCliVersion: "0.161.0",
  bundledCatalogDigest: digest,
  authenticationMethod: "host-private-bearer",
  cyberAccessProgram: "standard",
  serviceTier: "priority",
  subagent: { modelId: "unavailable", effort: "unavailable" },
});
const finding = (claim: string, line: number) => ({
  claim,
  attackerPosition: "subscriber",
  impact: "stored-xss",
  configurationPrecondition: "default",
  brokenProperty: "Output encoding",
  sourceTrace: [{ file: "plugin.php", function: "synthetic", line }],
  existingControls: "None",
  labObservations: "Not run",
});
const lead = {
  summary: "Synthetic consumer edge",
  attackerPosition: "subscriber",
  primitive: "write",
  storage: { kind: "option", key: "synthetic_shared" },
  missingEdge: "consumer",
  sourceTrace: [{ file: "plugin.php", function: "synthetic", line: 1 }],
  labObservations: "No complete effect observed",
};
const turnOne = {
  findings: [finding("Earlier turn effect", 1)],
  leads: [lead],
  examined: "turn one",
  unexamined: "",
};
const turnTwo = {
  findings: [finding("Last turn effect", 2)],
  leads: [lead],
  examined: "turn two",
  unexamined: "",
};
const ROOT = "root-1";
const CHILD = "child-1";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function archivedTrial(
  recordedReport: unknown,
  admissionContract?: "checked/v1",
  turns: readonly unknown[] = [turnOne, turnTwo],
  rootReport?: {
    readonly findings: readonly unknown[];
    readonly leads: readonly unknown[];
    readonly examined: string;
    readonly unexamined: string;
  },
) {
  const root = await mkdtemp(join(tmpdir(), "wbh-child-turns-"));
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
  const rootRollout = JSON.stringify({
    timestamp: now,
    type: "session_meta",
    payload: { id: ROOT, source: "exec" },
  });
  const done = (report: unknown) => ({
    timestamp: now,
    type: "event_msg",
    payload: {
      type: "task_complete",
      last_agent_message: JSON.stringify(report),
    },
  });
  const childRollout = [
    {
      timestamp: now,
      type: "session_meta",
      payload: {
        id: CHILD,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: ROOT,
              depth: 1,
              agent_path: "/root/child-1",
            },
          },
        },
      },
    },
    {
      timestamp: now,
      type: "turn_context",
      payload: {
        model: "gpt-6-sol",
        effort: "high",
        cyber_access_program: "standard",
      },
    },
    ...turns.map(done),
  ]
    .map((value) => JSON.stringify(value))
    .join("\n");
  const [rootDiagnostic, childDiagnostic] = await Promise.all([
    attachments.put("diagnostic", Buffer.from(rootRollout)),
    attachments.put("diagnostic", Buffer.from(childRollout)),
  ]);
  const rootAttachment =
    rootReport === undefined
      ? undefined
      : await attachments.put(
          "findings",
          Buffer.from(canonicalJson(rootReport)),
        );
  const receipt = async (
    runId: string,
    diagnosticArtifactDigest: string,
    reportArtifactDigest?: string,
  ) =>
    evidence.putFiles({
      "receipt.json": canonicalJson(
        createNativeRunReceipt({
          runId,
          targetSnapshotDigest: digest,
          profile,
          terminal: "completed",
          reason: "unavailable",
          startedAt: now,
          completedAt: "2026-10-08T08:00:01Z",
          diagnosticArtifactDigest,
          ...(reportArtifactDigest === undefined
            ? {}
            : { reportArtifactDigest }),
        }),
      ),
    });
  const base = {
    schemaVersion: 1 as const,
    campaignId: "campaign-1",
    snapshotDigest: digest,
    occurredAt: now,
  };
  const configuration = {
    promptVariant: "synthetic",
    ...(admissionContract === undefined ? {} : { admissionContract }),
  };
  for (const [runId, kind] of [
    [ROOT, "explore"],
    [CHILD, "child"],
  ] as const)
    await ledger.append({
      ...base,
      identity: `discovery-start-${runId}`,
      type: "discovery-run-started",
      runId,
      trialId: ROOT,
      runKind: kind,
      ...(kind === "child"
        ? {
            parentRunId: ROOT,
            configuration: { ...configuration, agentPath: "/root/child-1" },
          }
        : { configuration }),
      history: { mode: "none" },
    });
  for (const [runId, receiptDigest] of [
    [ROOT, await receipt(ROOT, rootDiagnostic.digest, rootAttachment?.digest)],
    [
      CHILD,
      await receipt(
        CHILD,
        childDiagnostic.digest,
        canonicalDigest(recordedReport),
      ),
    ],
  ] as const)
    await ledger.append({
      ...base,
      identity: `discovery-finish-${runId}`,
      type: "discovery-run-finished",
      runId,
      outcome:
        runId === ROOT && rootReport !== undefined ? "failed" : "completed",
      costUsd: "unavailable",
      wallTimeMs: 1000,
      ...(runId === ROOT && rootReport !== undefined
        ? { reason: "evidence" as const, reasonDetail: "audit-check-missing" }
        : {}),
      artifacts: [{ kind: "native-run-receipt", digest: receiptDigest }],
    });
  if (rootReport !== undefined && rootAttachment !== undefined)
    await recordWordPressReport(rootReport, {
      ledger,
      evidence,
      base,
      runId: ROOT,
      runKind: "root",
      admissionContract: "checked/v1",
      trialId: ROOT,
      snapshotDigest: digest,
      reportArtifactDigest: rootAttachment.digest,
    });
  return {
    ledger,
    options: { campaignId: "campaign-1", ledger, evidence, attachments, clock },
  };
}

const eventsOf = (ledger: Ledger) =>
  ledger.readAll({ campaignId: "campaign-1" }).map(({ event }) => event);

async function appendArchivedChild(
  trial: Awaited<ReturnType<typeof archivedTrial>>,
  childId: string,
  recordedReport: unknown,
  turns: readonly unknown[],
) {
  const { ledger, options } = trial;
  const base = {
    schemaVersion: 1 as const,
    campaignId: "campaign-1",
    snapshotDigest: digest,
    occurredAt: now,
  };
  const diagnostic = await options.attachments.put(
    "diagnostic",
    Buffer.from(
      [
        {
          timestamp: now,
          type: "session_meta",
          payload: {
            id: childId,
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: ROOT,
                  depth: 1,
                  agent_path: `/root/${childId}`,
                },
              },
            },
          },
        },
        {
          timestamp: now,
          type: "turn_context",
          payload: {
            model: "gpt-6-sol",
            effort: "high",
            cyber_access_program: "standard",
          },
        },
        ...turns.map((report) => ({
          timestamp: now,
          type: "event_msg",
          payload: {
            type: "task_complete",
            last_agent_message: JSON.stringify(report),
          },
        })),
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    ),
  );
  const receipt = await options.evidence.putFiles({
    "receipt.json": canonicalJson(
      createNativeRunReceipt({
        runId: childId,
        targetSnapshotDigest: digest,
        profile,
        terminal: "completed",
        reason: "unavailable",
        startedAt: now,
        completedAt: "2026-10-08T08:00:01Z",
        diagnosticArtifactDigest: diagnostic.digest,
        reportArtifactDigest: canonicalDigest(recordedReport),
      }),
    ),
  });
  await ledger.append({
    ...base,
    identity: `discovery-start-${childId}`,
    type: "discovery-run-started",
    runId: childId,
    trialId: ROOT,
    runKind: "child",
    parentRunId: ROOT,
    configuration: {
      promptVariant: "synthetic",
      admissionContract: "checked/v1",
      agentPath: `/root/${childId}`,
    },
    history: { mode: "none" },
  });
  await ledger.append({
    ...base,
    identity: `discovery-finish-${childId}`,
    type: "discovery-run-finished",
    runId: childId,
    outcome: "completed",
    costUsd: "unavailable",
    wallTimeMs: 1000,
    artifacts: [{ kind: "native-run-receipt", digest: receipt }],
  });
}

it("appends only the claims of earlier child turns, once, bound to the child run", async () => {
  // The capture recorded the last turn's report as written (before #539).
  const { ledger, options } = await archivedTrial(
    extractCandidateReport(JSON.stringify(turnTwo)),
  );
  const before = eventsOf(ledger).length;
  expect(
    await recoverWordPressChildTurnReports({ ...options, dryRun: true }),
  ).toEqual({ recovered: 1, findings: 1, leads: 0, skipped: 0 });
  expect(eventsOf(ledger)).toHaveLength(before);

  expect(await recoverWordPressChildTurnReports(options)).toEqual({
    recovered: 1,
    findings: 1,
    leads: 0,
    skipped: 0,
  });
  const appended = eventsOf(ledger).slice(before);
  expect(appended.map((event) => event.type)).toEqual([
    "child-report-recovered",
    "candidate-normalized",
    "finding-recorded",
  ]);
  expect(appended[0]).toMatchObject({
    identity: `child-report-recovered-${CHILD}-child-turns-merge-v1`,
    runId: CHILD,
    parserVersion: "child-turns-merge-v1",
  });
  expect(appended[2]).toMatchObject({
    runId: CHILD,
    snapshotDigest: digest,
    category: "stored-xss",
  });
  // 再実行は何も足さない。
  expect(await recoverWordPressChildTurnReports(options)).toEqual({
    recovered: 0,
    findings: 0,
    leads: 0,
    skipped: 0,
  });
  expect(eventsOf(ledger)).toHaveLength(before + appended.length);
});

it("cannot backfill a checked/v1 child claim directly into the Finding queue", async () => {
  const { ledger, options } = await archivedTrial(
    extractCandidateReport(JSON.stringify(turnTwo)),
    "checked/v1",
  );
  expect(
    await recoverWordPressChildTurnReports({ ...options, dryRun: true }),
  ).toEqual({ recovered: 1, findings: 0, leads: 0, skipped: 0 });
  expect(await recoverWordPressChildTurnReports(options)).toEqual({
    recovered: 1,
    findings: 0,
    leads: 0,
    skipped: 0,
  });
  const events = eventsOf(ledger);
  expect(
    events.filter((event) => event.type === "finding-recorded"),
  ).toHaveLength(0);
  expect(
    events.filter((event) => event.type === "audit-candidate-pending"),
  ).toHaveLength(1);
});

it("recovers a child check from an earlier turn without admitting a claim", async () => {
  const last = { ...turnTwo, findings: [], leads: [], checks: [] };
  const first = {
    ...turnOne,
    findings: [],
    leads: [],
    checks: [
      {
        kind: "finding",
        candidate: finding("Earlier turn effect", 1),
        verdict: "verified",
        explanation: "Source re-read in an earlier child turn",
      },
    ],
  };
  const { ledger, options } = await archivedTrial(
    extractCandidateReport(JSON.stringify(last)),
    "checked/v1",
    [first, last],
  );
  expect(await recoverWordPressChildTurnReports(options)).toEqual({
    recovered: 1,
    findings: 0,
    leads: 0,
    skipped: 0,
  });
  expect(
    eventsOf(ledger).filter((event) => event.type === "audit-check-recorded"),
  ).toHaveLength(1);
  expect(
    eventsOf(ledger).filter((event) => event.type === "finding-recorded"),
  ).toHaveLength(0);
});

it("promotes a previously pending Root claim after recovering its completed child's check", async () => {
  const candidate = finding("Earlier turn effect", 1);
  const last = { ...turnTwo, findings: [], leads: [], checks: [] };
  const first = {
    ...turnOne,
    findings: [],
    leads: [],
    checks: [
      {
        kind: "finding",
        candidate,
        verdict: "verified",
        explanation: "Reopened the current source and checked the guard",
      },
    ],
  };
  const { ledger, options } = await archivedTrial(
    extractCandidateReport(JSON.stringify(last)),
    "checked/v1",
    [first, last],
    {
      findings: [candidate],
      leads: [],
      examined: "source",
      unexamined: "none",
    },
  );
  expect(ledger.read({ type: "audit-candidate-pending" })).toHaveLength(1);
  expect(ledger.read({ type: "finding-recorded" })).toHaveLength(0);
  const laterOptions = {
    ...options,
    clock: () => new Date("2026-11-04T00:00:00Z"),
  };
  expect(await recoverWordPressChildTurnReports(laterOptions)).toEqual({
    recovered: 1,
    findings: 1,
    leads: 0,
    skipped: 0,
  });
  expect(ledger.read({ type: "finding-recorded" })).toHaveLength(1);
  expect(ledger.read({ type: "audit-candidate-promoted" })).toHaveLength(1);
  expect(ledger.read({ type: "finding-recorded" })[0]?.event.occurredAt).toBe(
    "2026-11-04T00:00:00.000Z",
  );
  expect(ledger.funnel("campaign-1").auditPending).toBe(0);
  const count = eventsOf(ledger).length;
  expect(await recoverWordPressChildTurnReports(laterOptions)).toEqual({
    recovered: 0,
    findings: 0,
    leads: 0,
    skipped: 0,
  });
  expect(eventsOf(ledger)).toHaveLength(count);
  expect(
    ledger.read({ type: "discovery-run-finished" })[0]?.event,
  ).toMatchObject({
    runId: ROOT,
    outcome: "failed",
    reasonDetail: "audit-check-missing",
  });
});

it("appends a dispute when another recovered child refutes a promoted Root claim", async () => {
  const candidate = finding("Earlier turn effect", 1);
  const empty = {
    findings: [],
    leads: [],
    checks: [],
    examined: "source",
    unexamined: "none",
  };
  const verified = {
    ...empty,
    checks: [
      {
        kind: "finding",
        candidate,
        verdict: "verified",
        explanation: "Reopened the current source and checked the guard",
      },
    ],
  };
  const trial = await archivedTrial(
    extractCandidateReport(JSON.stringify(empty)),
    "checked/v1",
    [verified, empty],
    { ...empty, findings: [candidate] },
  );
  const { ledger, options } = trial;
  expect(await recoverWordPressChildTurnReports(options)).toMatchObject({
    recovered: 1,
    findings: 1,
  });
  const original = ledger.read({ type: "finding-recorded" })[0]?.event;
  expect(original?.type).toBe("finding-recorded");
  expect(ledger.read({ type: "audit-candidate-promoted" })).toHaveLength(1);
  await appendArchivedChild(
    trial,
    "child-2",
    extractCandidateReport(JSON.stringify(empty)),
    [
      {
        ...empty,
        checks: [
          {
            kind: "finding",
            candidate,
            verdict: "refuted",
            explanation: "The route is denied by a newly observed guard",
          },
        ],
      },
      empty,
    ],
  );
  expect(await recoverWordPressChildTurnReports(options)).toMatchObject({
    recovered: 1,
    findings: 0,
  });
  const disputes = ledger.read({ type: "audit-candidate-disputed" });
  expect(disputes).toHaveLength(1);
  expect(disputes[0]?.event).toMatchObject({
    runId: ROOT,
    candidateKind: "finding",
    recordIds: [
      original?.type === "finding-recorded" ? original.findingId : "",
    ],
    causingEventIdentity: `audit-check-child-2-0-child-turns-merge-v1`,
  });
  expect(ledger.read({ type: "finding-recorded" })).toHaveLength(1);
  expect(ledger.funnel("campaign-1").auditDisputed).toBe(1);
  expect(ledger.funnel("campaign-1").auditPending).toBe(0);
  const count = eventsOf(ledger).length;
  await recoverWordPressChildTurnReports(options);
  expect(eventsOf(ledger)).toHaveLength(count);
});

it("reconciles a recovered check already admitted before an interrupted reconciliation", async () => {
  const candidate = finding("Earlier turn effect", 1);
  const empty = {
    findings: [],
    leads: [],
    checks: [],
    examined: "source",
    unexamined: "none",
  };
  const verified = {
    ...empty,
    checks: [
      {
        kind: "finding",
        candidate,
        verdict: "verified",
        explanation: "Reopened the current source and checked the guard",
      },
    ],
  };
  const trial = await archivedTrial(
    extractCandidateReport(JSON.stringify(empty)),
    "checked/v1",
    [verified, empty],
    { ...empty, findings: [candidate] },
  );
  const { ledger, options } = trial;
  expect(await recoverWordPressChildTurnReports(options)).toMatchObject({
    recovered: 1,
    findings: 1,
  });
  const original = ledger.read({ type: "finding-recorded" })[0]?.event;
  const refuted = {
    ...empty,
    checks: [
      {
        kind: "finding",
        candidate,
        verdict: "refuted",
        explanation: "A guard denies the route",
      },
    ],
  };
  await appendArchivedChild(
    trial,
    "child-2",
    extractCandidateReport(JSON.stringify(empty)),
    [refuted, empty],
  );
  // Model an interruption after the recovered report's admission but before
  // reconcilePromotedRoots. Its audit-check identity already exists on replay.
  await recordWordPressReport(refuted, {
    ledger,
    evidence: options.evidence,
    base: {
      schemaVersion: 1,
      campaignId: "campaign-1",
      snapshotDigest: digest,
      occurredAt: now,
    },
    runId: "child-2",
    runKind: "child",
    admissionContract: "checked/v1",
    trialId: ROOT,
    snapshotDigest: digest,
    reportArtifactDigest: canonicalDigest(refuted),
    parserVersion: "child-turns-merge-v1",
  });
  expect(ledger.read({ type: "audit-candidate-disputed" })).toHaveLength(0);
  expect(await recoverWordPressChildTurnReports(options)).toMatchObject({
    recovered: 1,
    findings: 0,
  });
  expect(ledger.read({ type: "audit-candidate-disputed" })).toHaveLength(1);
  expect(
    ledger.read({ type: "audit-candidate-disputed" })[0]?.event,
  ).toMatchObject({
    causingEventIdentity: "audit-check-child-2-0-child-turns-merge-v1",
    recordIds: [
      original?.type === "finding-recorded" ? original.findingId : "",
    ],
  });
  const count = eventsOf(ledger).length;
  expect(await recoverWordPressChildTurnReports(options)).toMatchObject({
    recovered: 0,
    findings: 0,
  });
  expect(eventsOf(ledger)).toHaveLength(count);
});

it("attributes a same-batch verified then refuted recovery to the refuting check", async () => {
  const candidate = finding("Earlier turn effect", 1);
  const empty = {
    findings: [],
    leads: [],
    checks: [],
    examined: "source",
    unexamined: "none",
  };
  const verified = {
    ...empty,
    checks: [
      {
        kind: "finding",
        candidate,
        verdict: "verified",
        explanation: "Source check supports the claim",
      },
    ],
  };
  const trial = await archivedTrial(
    extractCandidateReport(JSON.stringify(empty)),
    "checked/v1",
    [verified, empty],
    { ...empty, findings: [candidate] },
  );
  const { ledger, options } = trial;
  await recoverWordPressChildTurnReports(options);
  expect(ledger.read({ type: "audit-candidate-promoted" })).toHaveLength(1);
  await appendArchivedChild(
    trial,
    "child-2",
    extractCandidateReport(JSON.stringify(empty)),
    [verified, empty],
  );
  await appendArchivedChild(
    trial,
    "child-3",
    extractCandidateReport(JSON.stringify(empty)),
    [
      {
        ...empty,
        checks: [
          {
            kind: "finding",
            candidate,
            verdict: "refuted",
            explanation: "A guard denies the route",
          },
        ],
      },
      empty,
    ],
  );
  expect(await recoverWordPressChildTurnReports(options)).toMatchObject({
    recovered: 2,
    findings: 0,
  });
  expect(ledger.read({ type: "audit-candidate-disputed" })).toHaveLength(1);
  expect(
    ledger.read({ type: "audit-candidate-disputed" })[0]?.event,
  ).toMatchObject({
    causingEventIdentity: "audit-check-child-3-0-child-turns-merge-v1",
  });
});

it("disputes a promoted claim when recovery shows its verifying child was also the claimant", async () => {
  const candidate = finding("Earlier turn effect", 1);
  const empty = {
    findings: [],
    leads: [],
    examined: "source",
    unexamined: "none",
  };
  const rootReport = { ...empty, findings: [candidate] };
  const last = {
    ...empty,
    checks: [
      {
        kind: "finding",
        candidate,
        verdict: "verified",
        explanation: "Reopened the current source and checked the guard",
      },
    ],
  };
  const trial = await archivedTrial(
    extractCandidateReport(JSON.stringify(last)),
    "checked/v1",
    [{ ...empty, findings: [candidate], checks: [] }, last],
    rootReport,
  );
  const { ledger, options } = trial;
  const base = {
    schemaVersion: 1 as const,
    campaignId: "campaign-1",
    snapshotDigest: digest,
    occurredAt: now,
  };
  await recordWordPressReport(last, {
    ledger,
    evidence: options.evidence,
    base,
    runId: CHILD,
    runKind: "child",
    admissionContract: "checked/v1",
    trialId: ROOT,
    snapshotDigest: digest,
    reportArtifactDigest: digest,
  });
  const rootRef = await options.attachments.put(
    "findings",
    Buffer.from(canonicalJson(rootReport)),
  );
  await recordWordPressReport(rootReport, {
    ledger,
    evidence: options.evidence,
    base,
    runId: ROOT,
    runKind: "root",
    admissionContract: "checked/v1",
    trialId: ROOT,
    snapshotDigest: digest,
    reportArtifactDigest: rootRef.digest,
  });
  expect(ledger.read({ type: "audit-candidate-promoted" })).toHaveLength(1);
  expect(await recoverWordPressChildTurnReports(options)).toMatchObject({
    recovered: 1,
    findings: 0,
  });
  expect(
    ledger.read({ type: "audit-candidate-disputed" })[0]?.event,
  ).toMatchObject({
    causingEventIdentity: `audit-candidate-pending-${CHILD}-finding-0-child-turns-merge-v1`,
  });
  expect(ledger.read({ type: "finding-recorded" })).toHaveLength(1);
});

it("replays a full A-B-A check sequence when the final A was already captured", async () => {
  const candidate = finding("Earlier turn effect", 1);
  const verified = {
    kind: "finding",
    candidate,
    verdict: "verified",
    explanation: "The current source supports the exact draft",
  };
  const refuted = {
    ...verified,
    verdict: "refuted",
    explanation: "A guard appeared to deny the route",
  };
  const report = (check: typeof verified) => ({
    findings: [],
    leads: [],
    examined: "source",
    unexamined: "none",
    checks: [check],
  });
  const { ledger, options } = await archivedTrial(
    extractCandidateReport(JSON.stringify(report(verified))),
    "checked/v1",
    [report(verified), report(refuted), report(verified)],
  );
  expect(await recoverWordPressChildTurnReports(options)).toEqual({
    recovered: 1,
    findings: 0,
    leads: 0,
    skipped: 0,
  });
  expect(
    ledger
      .read({ type: "audit-check-recorded" })
      .map(({ event }) =>
        event.type === "audit-check-recorded"
          ? [event.checkIndex, event.verdict]
          : [],
      ),
  ).toEqual([
    [0, "verified"],
    [1, "refuted"],
    [2, "verified"],
  ]);
});

it("does not replay parser-specific pending claims against the original Root report", async () => {
  const original = finding("Original Root claim", 1);
  const reinterpretation = finding("Later parser claim", 2);
  const last = {
    findings: [],
    leads: [],
    examined: "last",
    unexamined: "",
    checks: [],
  };
  const first = {
    ...last,
    checks: [
      {
        kind: "finding",
        candidate: reinterpretation,
        verdict: "verified",
        explanation: "The later parser claim was checked",
      },
    ],
  };
  const { ledger, options } = await archivedTrial(
    extractCandidateReport(JSON.stringify(last)),
    "checked/v1",
    [first, last],
    { findings: [original], leads: [], examined: "source", unexamined: "none" },
  );
  await recordWordPressReport(
    { findings: [reinterpretation], leads: [] },
    {
      ledger,
      evidence: options.evidence,
      base: {
        schemaVersion: 1,
        campaignId: "campaign-1",
        snapshotDigest: digest,
        occurredAt: now,
      },
      runId: ROOT,
      runKind: "root",
      admissionContract: "checked/v1",
      trialId: ROOT,
      snapshotDigest: digest,
      reportArtifactDigest: digest,
      parserVersion: "reparse-v1",
    },
  );
  expect(
    await recoverWordPressChildTurnReports({
      ...options,
      clock: () => new Date("2026-11-04T00:00:00Z"),
    }),
  ).toEqual({ recovered: 1, findings: 0, leads: 0, skipped: 0 });
  expect(ledger.read({ type: "finding-recorded" })).toHaveLength(0);
  expect(ledger.read({ type: "audit-candidate-promoted" })).toHaveLength(0);
});

it("appends nothing when the rollout does not reproduce the recorded report", async () => {
  const { ledger, options } = await archivedTrial({ findings: [], leads: [] });
  const before = eventsOf(ledger).length;
  await expect(recoverWordPressChildTurnReports(options)).rejects.toThrow(
    "Archived child rollout does not reproduce its report",
  );
  expect(eventsOf(ledger)).toHaveLength(before);
});
