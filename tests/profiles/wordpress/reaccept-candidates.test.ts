import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  createNativeRunReceipt,
  defineAgentRuntimeProfile,
  ProviderAttachmentStore,
} from "../../../src/discovery/index.js";
import { canonicalJson } from "../../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../../src/ledger/index.js";
import { reacceptWordPressRun } from "../../../src/profiles/wordpress/discovery/reaccept-candidates.js";

const digest = `sha256:${"a".repeat(64)}`;
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
const claim = {
  claim: "Synthetic account change",
  attackerPosition: "subscriber",
  impact: "account-takeover",
  configurationPrecondition: "default",
  brokenProperty: "Account ownership",
  sourceTrace: ["../wordpress/wp-includes/user.php / change_user / 42"],
  existingControls: "No capability check",
  labObservations: ["Changed", "Observed"],
};

async function fixture(fromDiagnostic: boolean) {
  const root = await mkdtemp(join(tmpdir(), "wbh-reaccept-"));
  const evidence = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 10,
    maxBytes: 1024 * 1024,
  });
  const attachments = new ProviderAttachmentStore(join(root, "attachments"));
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: evidence,
  });
  const report = {
    findings: [claim, { ...claim, sourceTrace: ["unparseable"] }],
    leads: [],
    examined: "source",
    unexamined: "none",
  };
  const source = fromDiagnostic
    ? await attachments.put(
        "diagnostic",
        Buffer.from(
          JSON.stringify({
            type: "event_msg",
            payload: {
              type: "task_complete",
              last_agent_message: JSON.stringify(report),
            },
          }),
        ),
      )
    : await attachments.put("findings", Buffer.from(canonicalJson(report)));
  const receipt = createNativeRunReceipt({
    runId: "run-1",
    targetSnapshotDigest: digest,
    profile,
    terminal: fromDiagnostic ? "incomplete" : "completed",
    reason: fromDiagnostic ? "schema" : "unavailable",
    startedAt: "2026-10-10T00:00:00Z",
    completedAt: "2026-10-10T00:01:00Z",
    ...(fromDiagnostic
      ? { diagnosticArtifactDigest: source.digest }
      : { reportArtifactDigest: source.digest }),
  });
  const receiptDigest = await evidence.putFiles({
    "receipt.json": canonicalJson(receipt),
  });
  const base = {
    schemaVersion: 1 as const,
    campaignId: "campaign-1",
    snapshotDigest: digest,
    occurredAt: "2026-10-10T00:01:00Z",
  };
  await ledger.append({
    ...base,
    identity: "start",
    type: "discovery-run-started",
    runId: "run-1",
    trialId: "run-1",
    labId: "lab-1",
    history: { mode: "none" },
    configuration: { promptVariant: "synthetic", assignmentUnit: "route" },
  });
  await ledger.append({
    ...base,
    identity: "finish",
    type: "discovery-run-finished",
    runId: "run-1",
    outcome: fromDiagnostic ? "failed" : "completed",
    costUsd: "unavailable",
    wallTimeMs: 60_000,
    artifacts: [{ kind: "native-run-receipt", digest: receiptDigest }],
  });
  if (!fromDiagnostic) {
    for (const index of [0, 1]) {
      const rawDigest = await evidence.putFiles({
        "candidate.json": canonicalJson(report.findings[index]),
      });
      await ledger.append({
        ...base,
        identity: `rejected-${index}`,
        type: "candidate-rejected",
        runId: "run-1",
        candidateKind: "finding",
        candidateIndex: index,
        reason: "schema",
        artifacts: [{ kind: "candidate", digest: rawDigest }],
      });
    }
  }
  return { root, ledger, evidence, attachments };
}

it.each([false, true])(
  "reaccepts archived output with diagnostic=%s, preserving holds and prior events",
  async (fromDiagnostic) => {
    const setup = await fixture(fromDiagnostic);
    try {
      const options = {
        ...setup,
        campaignId: "campaign-1",
        runId: "run-1",
        clock: () => new Date("2026-10-11T00:00:00Z"),
      };
      expect(await reacceptWordPressRun(options)).toEqual({
        reached: 2,
        accepted: 1,
        held: 1,
        alreadyProcessed: 0,
      });
      expect(setup.ledger.read({ type: "finding-recorded" })).toHaveLength(1);
      expect(
        setup.ledger.read({ type: "candidate-held" })[0]?.event,
      ).toMatchObject({
        issuePaths: ["sourceTrace.0"],
        impact: "account-takeover",
      });
      expect(await reacceptWordPressRun(options)).toEqual({
        reached: 2,
        accepted: 0,
        held: 0,
        alreadyProcessed: 2,
      });
      expect(setup.ledger.read({ type: "candidate-rejected" })).toHaveLength(
        fromDiagnostic ? 0 : 2,
      );
      expect(
        setup.ledger.read({ type: "discovery-report-recovered" }),
      ).toHaveLength(fromDiagnostic ? 1 : 0);
    } finally {
      await rm(setup.root, { recursive: true, force: true });
    }
  },
);
