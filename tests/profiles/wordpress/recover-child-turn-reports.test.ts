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

async function archivedTrial(recordedReport: unknown) {
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
    done(turnOne),
    done(turnTwo),
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
  const configuration = { promptVariant: "synthetic" };
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
    [ROOT, await receipt(ROOT, rootDiagnostic.digest)],
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
      outcome: "completed",
      costUsd: "unavailable",
      wallTimeMs: 1000,
      artifacts: [{ kind: "native-run-receipt", digest: receiptDigest }],
    });
  return {
    ledger,
    options: { campaignId: "campaign-1", ledger, evidence, attachments, clock },
  };
}

const eventsOf = (ledger: Ledger) =>
  ledger.readAll({ campaignId: "campaign-1" }).map(({ event }) => event);

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

it("appends nothing when the rollout does not reproduce the recorded report", async () => {
  const { ledger, options } = await archivedTrial({ findings: [], leads: [] });
  const before = eventsOf(ledger).length;
  await expect(recoverWordPressChildTurnReports(options)).rejects.toThrow(
    "Archived child rollout does not reproduce its report",
  );
  expect(eventsOf(ledger)).toHaveLength(before);
});
