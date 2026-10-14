import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { continuousReviewExportCheck } from "../../src/cli/continuous-review-readiness.js";
import type { CliState } from "../../src/cli/index.js";
import { canonicalJson } from "../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";
import { admitWordPressFinding } from "../../src/profiles/wordpress/discovery/finding.js";
import { wordPressReviewFindingReady } from "../../src/profiles/wordpress/review-finding-readiness.js";

const snapshotDigest = `sha256:${"a".repeat(64)}`;

describe("continuous review export readiness", () => {
  it("rejects the exporter's placeholder for malformed Finding evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wbh-review-ready-"));
    try {
      const evidenceDirectory = join(directory, "evidence");
      const store = new PrivateArtifactStore({
        rootDirectory: evidenceDirectory,
        maxEntries: 10,
        maxBytes: 1024 * 1024,
      });
      const ledger = new Ledger({
        databasePath: join(directory, "ledger.sqlite"),
        artifactStore: store,
      });
      const invalid = await store.putFiles({ "finding.json": "not json" });
      const finding = admitWordPressFinding(
        {
          claim: "Synthetic finding for readiness check",
          attackerPosition: "unauthenticated",
          impact: "other",
          configurationPrecondition: "synthetic",
          brokenProperty: "Synthetic property",
          sourceTrace: [
            { file: "includes/example.php", function: "example", line: 1 },
          ],
          existingControls: "none",
          labObservations: "synthetic observation",
        },
        {
          runId: "run-one",
          snapshotDigest,
          reportArtifactDigest: `sha256:${"b".repeat(64)}`,
        },
      );
      const valid = await store.putFiles({
        "finding.json": canonicalJson(finding),
      });
      for (const [findingId, artifact] of [
        ["finding-invalid", invalid],
        [finding.findingId, valid],
      ] as const)
        await ledger.append({
          schemaVersion: 1,
          identity: findingId,
          campaignId: "campaign-one",
          snapshotDigest,
          occurredAt: "2026-10-14T00:00:00Z",
          type: "finding-recorded",
          findingId,
          runId: "run-one",
          category: "other",
          artifacts: [{ kind: "finding", digest: artifact }],
        });
      const parseableButInvalid = await store.putFiles({
        "finding.json": canonicalJson({ ...finding, sourceTrace: [] }),
      });
      await ledger.append({
        schemaVersion: 1,
        identity: "finding-tampered",
        campaignId: "campaign-two",
        snapshotDigest,
        occurredAt: "2026-10-14T00:00:00Z",
        type: "finding-recorded",
        findingId: finding.findingId,
        runId: "run-one",
        category: "other",
        artifacts: [{ kind: "finding", digest: parseableButInvalid }],
      });
      const state: CliState = {
        ledger,
        store,
        evidenceDirectory,
        stateDirectory: directory,
        clock: () => new Date("2026-10-14T00:00:00Z"),
        newId: () => "unused",
      };
      const ready = continuousReviewExportCheck(state, undefined, (request) =>
        wordPressReviewFindingReady(state, request),
      );
      expect(
        await continuousReviewExportCheck(state)({
          campaignId: "campaign-one",
          snapshotDigest,
          findingId: finding.findingId,
        }),
      ).toBe(false);
      expect(
        await ready({
          campaignId: "campaign-one",
          snapshotDigest,
          findingId: "finding-invalid",
        }),
      ).toBe(false);
      expect(
        await ready({
          campaignId: "campaign-one",
          snapshotDigest,
          findingId: finding.findingId,
        }),
      ).toBe(true);
      expect(
        await ready({
          campaignId: "campaign-two",
          snapshotDigest,
          findingId: finding.findingId,
        }),
      ).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
