import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

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
const at = "2026-10-08T07:00:00Z";
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

it("ends a checked/v1 Trial incomplete when its Root claim remains pending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wbh-pending-check-"));
  try {
    const attachments = new ProviderAttachmentStore(join(directory, "reports"));
    const evidence = new PrivateArtifactStore({
      rootDirectory: join(directory, "evidence"),
      maxEntries: 10,
      maxBytes: 1024 * 1024,
    });
    const ledger = new Ledger({
      databasePath: join(directory, "ledger.sqlite"),
      artifactStore: evidence,
    });
    const input = {
      schemaVersion: 1 as const,
      snapshotDigest: digest,
      trustBoundary: { version: "v1", text: "Low privilege" },
      programmeBoundary: { version: "v1", text: "Synthetic boundary" },
      modelProfileDigest: profile.digest,
      promptDigest: digest,
      stopRules: { maxRuns: 1, noFindingRuns: 1 },
      lab: { mode: "none" as const },
      history: { mode: "none" as const },
    };
    const outcome = await runDiscoveryCampaign({
      campaignId: "campaign-1",
      input,
      plannedTrials: [
        {
          trialId: "root-1",
          trialOrdinal: 0,
          explore: {
            configuration: {
              promptVariant: "synthetic-checked",
              admissionContract: "checked/v1",
            },
            run: {
              runId: "root-1",
              targetSnapshotDigest: digest,
              profile,
              prompt: "Inspect source",
              sourceDirectory: "/private/source",
              sourceTree: { digest, entries: 1, bytes: 1 },
              expiresAt: "2026-10-08T08:00:00Z",
            },
          },
        },
      ],
      executor: {
        async execute(run) {
          const attachment = await attachments.put(
            "findings",
            Buffer.from(
              JSON.stringify({
                findings: [
                  {
                    claim: "Synthetic account state change",
                    attackerPosition: "subscriber",
                    impact: "account-takeover",
                    configurationPrecondition: "default",
                    brokenProperty: "Account ownership",
                    sourceTrace: [
                      {
                        file: "includes/example.php",
                        function: "fixture",
                        line: 12,
                      },
                    ],
                    existingControls: "Capability check elsewhere",
                    labObservations: "Canary user changed",
                  },
                ],
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
              targetSnapshotDigest: digest,
              profile,
              terminal: "completed",
              reason: "unavailable",
              startedAt: at,
              completedAt: "2026-10-08T07:00:01Z",
              reportArtifactDigest: attachment.digest,
              observed: {
                toolCalls: 1,
                filesRead: 1,
                uniqueFilesRead: 1,
                labRequests: 0,
                dbQueries: 0,
              },
            }),
          };
        },
      },
      attachments,
      evidence,
      ledger,
      async recordReport(report, context) {
        expect(context).toMatchObject({
          runKind: "root",
          admissionContract: "checked/v1",
        });
        expect(report.findings).toHaveLength(1);
        return await recordWordPressReport(report, context);
      },
      clock: () => new Date(at),
    });
    expect(outcome).toMatchObject({
      runCount: 1,
      stoppedBy: "incomplete",
    });
    expect(ledger.read({ type: "audit-candidate-pending" })).toHaveLength(1);
    expect(ledger.read({ type: "finding-recorded" })).toHaveLength(0);
    expect(
      ledger.read({ type: "discovery-run-finished" })[0]?.event,
    ).toMatchObject({
      runId: "root-1",
      outcome: "failed",
      reason: "evidence",
      reasonDetail: "audit-check-missing",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
