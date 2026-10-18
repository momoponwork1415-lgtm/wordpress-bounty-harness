import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  defineAgentRuntimeProfile,
  ProviderAttachmentStore,
  type DiscoveryTransportResult,
} from "../../../src/discovery/index.js";
import { canonicalJson } from "../../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../../src/ledger/index.js";
import { admitWordPressFinding } from "../../../src/profiles/wordpress/discovery/finding.js";
import { refutePendingFindings } from "../../../src/profiles/wordpress/verification/refute.js";

const digest = `sha256:${"a".repeat(64)}`;

it("parks only a source-refuted Finding and passes no Lab to the refuter", async () => {
  const root = await mkdtemp(join(tmpdir(), "refute-service-"));
  try {
    const store = new PrivateArtifactStore({
      rootDirectory: join(root, "evidence"),
      maxEntries: 10,
      maxBytes: 1024 * 1024,
    });
    const ledger = new Ledger({
      databasePath: join(root, "ledger.sqlite"),
      artifactStore: store,
    });
    const attachments = new ProviderAttachmentStore(join(root, "attachments"));
    const finding = admitWordPressFinding(
      {
        claim: "A guard is bypassed",
        attackerPosition: "subscriber",
        impact: "sqli",
        configurationPrecondition: "default",
        brokenProperty: "query integrity",
        sourceTrace: [{ file: "plugin.php", function: "entry", line: 4 }],
        existingControls: "guard may apply",
        labObservations: "none",
      },
      {
        runId: "discover-1",
        snapshotDigest: digest,
        reportArtifactDigest: digest,
      },
    );
    const stored = await store.putFiles({
      "finding.json": canonicalJson(finding),
    });
    await ledger.append({
      schemaVersion: 1,
      identity: "finding-1",
      campaignId: "campaign-1",
      snapshotDigest: digest,
      occurredAt: "2026-10-18T00:00:00Z",
      type: "finding-recorded",
      findingId: finding.findingId,
      runId: "discover-1",
      category: "sqli",
      artifacts: [{ kind: "finding", digest: stored }],
    });
    const profile = defineAgentRuntimeProfile({
      id: "refute-test",
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
    const report = await attachments.put(
      "refutation",
      Buffer.from(
        canonicalJson({
          verdict: "refuted",
          reasonCode: "guard-effective",
          sourceTrace: [{ file: "plugin.php", function: "entry", line: 4 }],
          note: "guard holds",
        }),
      ),
    );
    let seenRun: unknown;
    const result = await refutePendingFindings({
      campaignId: "campaign-1",
      ledger,
      store,
      attachments,
      profile,
      prompt: { id: "refute-v1", digest, text: "Refute the claim" },
      resolveSource: async () => ({
        directory: "/fixed/source",
        tree: { digest, entries: 1, bytes: 1 },
      }),
      runtime: {
        execute: async (run) => {
          seenRun = run;
          return {
            receipt: {
              terminal: "completed",
              reportArtifactDigest: report.digest,
            },
            attachment: report,
          } as unknown as DiscoveryTransportResult;
        },
      },
      clock: () => new Date("2026-10-18T00:00:00Z"),
      newId: () => "refute-1",
    });
    expect(result).toEqual([
      { findingId: finding.findingId, verdict: "refuted" },
    ]);
    expect(seenRun).toMatchObject({
      outputKind: "refutation",
      coordination: "solo",
    });
    expect(seenRun).not.toHaveProperty("lab");
    expect(seenRun).not.toHaveProperty("refutationClaim.labObservations");
    expect(
      ledger.read({ campaignId: "campaign-1", type: "finding-parked" })[0]
        ?.event,
    ).toMatchObject({ reason: "refuted" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
