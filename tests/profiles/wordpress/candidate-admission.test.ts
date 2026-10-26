import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createNativeRunReceipt,
  defineAgentRuntimeProfile,
  ProviderAttachmentStore,
  runDiscoveryCampaign,
  type PlannedTrial,
} from "../../../src/discovery/index.js";
import { canonicalJson } from "../../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import { Ledger, type LedgerEventV1 } from "../../../src/ledger/index.js";
import { recordWordPressReport } from "../../../src/profiles/wordpress/discovery/candidate-admission.js";
import { recoverWordPressChildReports } from "../../../src/profiles/wordpress/discovery/recover-child-reports.js";

// 同じ報告が「campaign 中の記録」「子報告の復旧 script」の
// どちらの入口から来ても、台帳に残る event は同じでなければならない（ADR 0018、#185）。

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
const report = {
  findings: [
    finding,
    // Programme Boundary の外: 全入口で finding-parked になり、検証 queue に入らない。
    { ...finding, claim: "Synthetic low-value effect", impact: "other" },
    // 構文が直らない候補: 全入口で candidate-held になる。
    { ...finding, sourceTrace: ["invalid trace"] },
  ],
  leads: [
    {
      summary: "Synthetic consumer edge",
      attackerPosition: "subscriber",
      primitive: "write",
      storage: { kind: "option", key: "synthetic_shared" },
      missingEdge: "consumer",
      sourceTrace: [{ file: "plugin.php", function: "synthetic", line: 1 }],
      labObservations: "No complete effect observed",
    },
  ],
  examined: "",
  unexamined: "",
};
const RUN_ID = "run-1";
const CANDIDATE_EVENTS = new Set([
  "candidate-normalized",
  "candidate-held",
  "finding-recorded",
  "finding-parked",
  "lead-recorded",
]);

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function stores() {
  const root = await mkdtemp(join(tmpdir(), "wbh-admission-"));
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
  return { evidence, attachments, ledger };
}

function candidateEvents(ledger: Ledger): LedgerEventV1[] {
  return ledger
    .readAll({ campaignId: "campaign-1" })
    .map(({ event }) => event)
    .filter((event) => CANDIDATE_EVENTS.has(event.type))
    .sort((a, b) => a.identity.localeCompare(b.identity));
}

async function viaCampaign() {
  const { evidence, attachments, ledger } = await stores();
  const plannedTrials: PlannedTrial[] = [
    {
      trialId: RUN_ID,
      trialOrdinal: 0,
      explore: {
        configuration: { promptVariant: "synthetic" },
        run: {
          runId: RUN_ID,
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
      },
    },
  ];
  const result = await runDiscoveryCampaign({
    campaignId: "campaign-1",
    input: {
      schemaVersion: 1,
      snapshotDigest: digest,
      trustBoundary: { version: "v1", text: "Synthetic trust" },
      programmeBoundary: { version: "v1", text: "Synthetic programme" },
      modelProfileDigest: profile.digest,
      promptDigest: digest,
      stopRules: { maxRuns: 1, noFindingRuns: 1 },
      lab: { setupDigest: digest },
      history: { mode: "none" },
    },
    plannedTrials,
    ledger,
    evidence,
    attachments,
    recordReport: recordWordPressReport,
    clock,
    executor: {
      async execute(run) {
        const attachment = await attachments.put(
          "findings",
          Buffer.from(canonicalJson(report)),
        );
        return {
          receipt: createNativeRunReceipt({
            runId: run.runId,
            targetSnapshotDigest: digest,
            profile,
            terminal: "completed",
            reason: "unavailable",
            startedAt: now,
            completedAt: "2026-10-08T08:00:01Z",
            reportArtifactDigest: attachment.digest,
          }),
          attachment,
        };
      },
    },
  });
  expect(result.findingsRecorded).toBe(1);
  return ledger;
}

async function viaChildRecovery() {
  const { evidence, attachments, ledger } = await stores();
  const parentThreadId = "root-1";
  const rootRollout = JSON.stringify({
    timestamp: now,
    type: "session_meta",
    payload: { id: parentThreadId, source: "exec" },
  });
  const childRollout = [
    {
      timestamp: now,
      type: "session_meta",
      payload: {
        id: RUN_ID,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: parentThreadId,
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
    {
      timestamp: now,
      type: "event_msg",
      payload: {
        type: "task_complete",
        last_agent_message: JSON.stringify(report),
      },
    },
  ]
    .map((value) => JSON.stringify(value))
    .join("\n");
  const [rootDiagnostic, childDiagnostic] = await Promise.all([
    attachments.put("diagnostic", Buffer.from(rootRollout)),
    attachments.put("diagnostic", Buffer.from(childRollout)),
  ]);
  const receipt = async (
    runId: string,
    diagnosticArtifactDigest: string,
    child: boolean,
  ) =>
    evidence.putFiles({
      "receipt.json": canonicalJson(
        createNativeRunReceipt({
          runId,
          targetSnapshotDigest: digest,
          profile,
          terminal: child ? "incomplete" : "completed",
          reason: child ? "schema" : "unavailable",
          ...(child ? { reasonDetail: "child-final-message-not-report" } : {}),
          startedAt: now,
          completedAt: "2026-10-08T08:00:01Z",
          diagnosticArtifactDigest,
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
    assignmentUnit: "plugin",
  };
  await ledger.append({
    ...base,
    identity: `discovery-start-${parentThreadId}`,
    type: "discovery-run-started",
    runId: parentThreadId,
    trialId: RUN_ID,
    runKind: "explore",
    history: { mode: "none" },
    configuration,
  });
  await ledger.append({
    ...base,
    identity: `discovery-finish-${parentThreadId}`,
    type: "discovery-run-finished",
    runId: parentThreadId,
    outcome: "completed",
    costUsd: "unavailable",
    wallTimeMs: 1000,
    artifacts: [
      {
        kind: "native-run-receipt",
        digest: await receipt(parentThreadId, rootDiagnostic.digest, false),
      },
    ],
  });
  await ledger.append({
    ...base,
    identity: `discovery-start-${RUN_ID}`,
    type: "discovery-run-started",
    runId: RUN_ID,
    trialId: RUN_ID,
    runKind: "child",
    parentRunId: parentThreadId,
    history: { mode: "none" },
    configuration: { ...configuration, agentPath: "/root/child-1" },
  });
  await ledger.append({
    ...base,
    identity: `discovery-finish-${RUN_ID}`,
    type: "discovery-run-finished",
    runId: RUN_ID,
    outcome: "failed",
    reason: "schema",
    reasonDetail: "child-final-message-not-report",
    costUsd: "unavailable",
    wallTimeMs: 1000,
    artifacts: [
      {
        kind: "native-run-receipt",
        digest: await receipt(RUN_ID, childDiagnostic.digest, true),
      },
    ],
  });
  const options = {
    campaignId: "campaign-1",
    ledger,
    evidence,
    attachments,
    clock,
  };
  expect(await recoverWordPressChildReports(options)).toEqual({
    recovered: 1,
    findings: 1,
    leads: 1,
  });
  // 再実行は何も足さない。
  expect(await recoverWordPressChildReports(options)).toEqual({
    recovered: 0,
    findings: 0,
    leads: 0,
  });
  return ledger;
}

it("records the same report identically through the campaign and child recovery", async () => {
  const [campaign, recovered] = await Promise.all([
    viaCampaign(),
    viaChildRecovery(),
  ]);
  const expected = candidateEvents(campaign);
  expect(expected.map((event) => event.type).sort()).toEqual([
    "candidate-held",
    "candidate-normalized",
    "candidate-normalized",
    "candidate-normalized",
    "candidate-normalized",
    "finding-parked",
    "finding-recorded",
    "lead-recorded",
  ]);
  expect(
    expected.find((event) => event.type === "finding-parked"),
  ).toMatchObject({
    category: "other",
    reason: "outside-programme-boundary",
    preconditionClass: "default",
  });
  expect(
    expected.find((event) => event.type === "candidate-held"),
  ).toMatchObject({
    issuePaths: ["sourceTrace.0"],
    impact: "account-takeover",
  });
  expect(candidateEvents(recovered)).toEqual(expected);
  // 範囲外の Finding はどの入口でも検証 queue（finding-recorded）に入らない。
  for (const ledger of [campaign, recovered])
    expect(
      ledger
        .read({ type: "finding-recorded" })
        .map(
          ({ event }) => event.type === "finding-recorded" && event.category,
        ),
    ).toEqual(["account-takeover"]);
});

// 2026-10-18 以降の本番で保留された 6 件の形（2026-10-20 報告 §2.7）を、本文を使わずに再現する。
async function recordDirectly(findings: unknown[]) {
  const { evidence, ledger } = await stores();
  const report = await recordWordPressReport(
    { findings, leads: [] },
    {
      ledger,
      evidence,
      base: {
        schemaVersion: 1,
        campaignId: "campaign-1",
        snapshotDigest: digest,
        occurredAt: now,
      },
      runId: RUN_ID,
      trialId: RUN_ID,
      snapshotDigest: digest,
      reportArtifactDigest: digest,
    },
  );
  const events = candidateEvents(ledger);
  const changes = events.flatMap((event) =>
    event.type === "candidate-normalized" ? event.changes : [],
  );
  return { evidence, events, changes, report };
}

it("records a Finding whose precondition is over the schema limit and keeps the raw candidate", async () => {
  const long = "p".repeat(1100);
  const { evidence, events, changes } = await recordDirectly([
    { ...finding, impact: "stored-xss", configurationPrecondition: long },
  ]);
  expect(events.map((event) => event.type)).toEqual([
    "candidate-normalized",
    "finding-recorded",
  ]);
  expect(changes).toEqual([
    { path: "configurationPrecondition", operation: "text-truncated" },
  ]);
  const raw = events[0]!.artifacts[0]!.digest;
  const stored = await evidence.readJson(
    raw,
    "candidate.json",
    z.object({ configurationPrecondition: z.string() }),
    1024 * 1024,
  );
  expect(
    stored.status === "resolved" &&
      stored.value.configurationPrecondition.length,
  ).toBe(1100);
});

it("admits a Finding when password protection is absent and only a product name mentions it", async () => {
  const { events, report } = await recordDirectly([
    {
      ...finding,
      impact: "stored-xss",
      configurationPrecondition:
        "An administrator opens Password-Protected Showcase > Dashboard. Public content does not require password protection.",
    },
  ]);
  expect(report.candidates.map((candidate) => candidate.outcome)).toEqual([
    "recorded",
  ]);
  expect(
    events.find((event) => event.type === "finding-recorded"),
  ).toMatchObject({
    category: "stored-xss",
    preconditionClass: "unknown",
  });
  expect(events.some((event) => event.type === "finding-parked")).toBe(false);
});

it("records a Finding whose attacker position and impact are free text with one label", async () => {
  const { events, changes } = await recordDirectly([
    {
      ...finding,
      attackerPosition: "Authenticated Subscriber (any registered account)",
      impact: "Stored XSS in an administrator screen, a step towards RCE",
    },
    { ...finding, claim: "Second effect", impact: { kind: "stored-xss" } },
  ]);
  expect(
    events
      .filter((event) => event.type === "finding-recorded")
      .map((event) => event.type === "finding-recorded" && event.category),
  ).toEqual(["stored-xss", "stored-xss"]);
  expect(changes).toEqual([
    { path: "attackerPosition", operation: "attacker-position-coerced" },
    { path: "impact", operation: "impact-label-coerced" },
    { path: "impact", operation: "impact-lifted" },
  ]);
});

it("holds a candidate whose position names two roles and records the issue codes", async () => {
  const { events, report } = await recordDirectly([
    { ...finding, attackerPosition: "subscriber or customer" },
  ]);
  expect(report.candidates.map((candidate) => candidate.outcome)).toEqual([
    "held",
  ]);
  expect(events.find((event) => event.type === "candidate-held")).toMatchObject(
    {
      issuePaths: ["attackerPosition"],
      issueCodes: ["invalid_value"],
      impact: "account-takeover",
    },
  );
});

// #613（ADR 0038 追記 13）: agent が申告欄で選んだ値だけで出口 park する。文言からは判定しない。
describe("declared precondition park", () => {
  const declared = (
    configurationClass?: string,
    attackerInputPath?: string,
    exploitTiming?: string,
    impact = "stored-xss",
  ) => ({
    ...finding,
    claim: `Synthetic ${configurationClass ?? "none"} ${attackerInputPath ?? "none"} ${exploitTiming ?? "none"} ${impact}`,
    impact,
    ...declaration(configurationClass, attackerInputPath, exploitTiming),
  });
  const declaration = (
    configurationClass?: string,
    attackerInputPath?: string,
    exploitTiming?: string,
  ) => ({
    ...(configurationClass === undefined ? {} : { configurationClass }),
    ...(attackerInputPath === undefined ? {} : { attackerInputPath }),
    ...(exploitTiming === undefined ? {} : { exploitTiming }),
  });

  it.each([
    ["admin-authored-unsafe-content", undefined, undefined],
    ["admin-setting-change", undefined, undefined],
    ["developer-mode", undefined, undefined],
    [undefined, "vendor-controlled-data", undefined],
    ["default", "vendor-controlled-data", undefined],
    ["admin-setting-change", "direct-request", undefined],
    [undefined, undefined, "time-window"],
    [undefined, undefined, "race"],
    ["default", "direct-request", "race"],
  ])(
    "parks a Finding declared %s / %s / %s with reason declared-precondition",
    async (configurationClass, attackerInputPath, exploitTiming) => {
      const { events, report } = await recordDirectly([
        declared(configurationClass, attackerInputPath, exploitTiming),
      ]);
      expect(report.candidates.map((candidate) => candidate.outcome)).toEqual([
        "parked",
      ]);
      const parked = events.find((event) => event.type === "finding-parked");
      expect(parked).toMatchObject({
        category: "stored-xss",
        reason: "declared-precondition",
      });
      // 台帳には申告の enum 値だけが残る（不変条件 8）。
      expect(
        parked?.type === "finding-parked" && parked.declaredPrecondition,
      ).toEqual(
        declaration(configurationClass, attackerInputPath, exploitTiming),
      );
      expect(events.some((event) => event.type === "finding-recorded")).toBe(
        false,
      );
    },
  );

  it.each([
    [undefined, undefined, undefined],
    ["default", undefined, undefined],
    ["ordinary-feature-use", undefined, undefined],
    [undefined, "direct-request", undefined],
    [undefined, "own-account-data", undefined],
    ["ordinary-feature-use", "public-third-party-content", undefined],
    [undefined, undefined, "any-time"],
    ["default", "direct-request", "any-time"],
  ])(
    "records a Finding declared %s / %s / %s without parking it",
    async (configurationClass, attackerInputPath, exploitTiming) => {
      const { events, report } = await recordDirectly([
        declared(configurationClass, attackerInputPath, exploitTiming),
      ]);
      expect(report.candidates.map((candidate) => candidate.outcome)).toEqual([
        "recorded",
      ]);
      expect(events.some((event) => event.type === "finding-parked")).toBe(
        false,
      );
    },
  );

  it("does not park on wording when nothing is declared", async () => {
    const { report } = await recordDirectly([
      {
        ...finding,
        impact: "stored-xss",
        configurationPrecondition:
          "An administrator has created a popup that contains their own shortcode; the vendor API response must carry the payload within a five-minute window.",
      },
    ]);
    expect(report.candidates.map((candidate) => candidate.outcome)).toEqual([
      "recorded",
    ]);
  });

  it("keeps the Programme Boundary park first and without the declaration", async () => {
    const { events } = await recordDirectly([
      declared("developer-mode", "vendor-controlled-data", "race", "other"),
    ]);
    const parked = events.find((event) => event.type === "finding-parked");
    expect(parked).toMatchObject({ reason: "outside-programme-boundary" });
    expect(
      parked?.type === "finding-parked" && parked.declaredPrecondition,
    ).toBeUndefined();
  });

  it("holds a candidate whose declaration is not one of the values", async () => {
    const { events, report } = await recordDirectly([
      declared("admin-misconfiguration"),
      declared(undefined, undefined, "sometimes"),
    ]);
    expect(report.candidates.map((candidate) => candidate.outcome)).toEqual([
      "held",
      "held",
    ]);
    expect(
      events
        .filter((event) => event.type === "candidate-held")
        .map((event) => event.type === "candidate-held" && event.issuePaths),
    ).toEqual([["configurationClass"], ["exploitTiming"]]);
  });
});
