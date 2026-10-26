import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../../src/ledger/index.js";
import { createWordPressScopeFacts } from "../../../src/profiles/wordpress/scope-facts.js";
import { retiredWordPressScenario } from "../../../src/profiles/wordpress/lab/retired-scenarios.js";
import {
  assessWordpressScope,
  loadWordpressScopePolicy,
} from "../../../src/profiles/wordpress/scope-policy.js";

const snapshot = `sha256:${"a".repeat(64)}`;
const otherSnapshot = `sha256:${"b".repeat(64)}`;
const setup = `sha256:${"c".repeat(64)}`;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("WordPress scope setup provenance", () => {
  it("requires the exact verification Lab, pinned scenario, Snapshot and target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scope-facts-"));
    directories.push(directory);
    const store = new PrivateArtifactStore({
      rootDirectory: join(directory, "private"),
      maxEntries: 10,
      maxBytes: 100_000,
    });
    const ledger = new Ledger({
      databasePath: join(directory, "ledger.sqlite"),
      artifactStore: store,
    });
    const selectionDigest = await store.putFiles({
      "target-selection.json": JSON.stringify({
        slug: "wpdiscuz",
        activeInstallations: 5_000,
      }),
    });
    const evidenceDigest = await store.putFiles({
      "proof.txt": "nonce observed",
    });
    const reproductionPackageDigest = await store.putFiles({
      "manual.md": "manual reproduction",
    });
    const common = {
      schemaVersion: 1 as const,
      campaignId: "scope-campaign",
      snapshotDigest: snapshot,
      occurredAt: "2026-10-12T00:00:00Z",
    };
    await ledger.append({
      ...common,
      identity: "selection",
      type: "target-selected",
      selectionId: "selection",
      artifacts: [{ kind: "target-selection", digest: selectionDigest }],
    });
    await ledger.append({
      ...common,
      identity: "snapshot",
      type: "snapshot-frozen",
      sourceDigest: snapshot,
    });
    await ledger.append({
      ...common,
      identity: "finding",
      type: "finding-recorded",
      findingId: "finding",
      runId: "run",
      category: "sqli",
    });
    // Past Lab records name scenarios removed in #353; they still read.
    const pinned = (id: string) => {
      const record = retiredWordPressScenario(id);
      if (record === undefined) throw new Error("Expected pinned scenarios");
      return { id, digest: record.digest };
    };
    const ordinary = pinned("public-plugin-comment-v1");
    const wrongPlugin = pinned("public-member-post-v1");
    const cases: readonly {
      readonly name: string;
      readonly scenario?: { readonly id: string; readonly digest: string };
      readonly omitLab?: boolean;
      readonly labSnapshot?: string;
    }[] = [
      { name: "matched", scenario: ordinary },
      { name: "missing-lab", scenario: ordinary, omitLab: true },
      { name: "missing-scenario" },
      {
        name: "unknown-scenario",
        scenario: { id: "unknown-v1", digest: setup },
      },
      {
        name: "changed-scenario",
        scenario: { id: ordinary.id, digest: setup },
      },
      {
        name: "other-snapshot",
        scenario: ordinary,
        labSnapshot: otherSnapshot,
      },
      { name: "historical-lab", scenario: ordinary },
      { name: "other-plugin", scenario: wrongPlugin },
    ];
    const policy = await loadWordpressScopePolicy();
    const provider = createWordPressScopeFacts({ ledger, store });
    for (const testCase of cases) {
      const verificationId = `verification-${testCase.name}`;
      if (testCase.omitLab !== true) {
        await ledger.append({
          ...common,
          identity: `verification-lab-${verificationId}`,
          type: "lab-provisioned",
          labId: `lab-${testCase.name}`,
          status: "ready",
          snapshotDigest: testCase.labSnapshot ?? common.snapshotDigest,
          ...(testCase.name === "historical-lab"
            ? {}
            : { purpose: "verification" as const }),
          ...(testCase.scenario === undefined
            ? {}
            : {
                scenario: {
                  id: testCase.scenario.id,
                  digest: testCase.scenario.digest,
                },
              }),
        });
      }
      await ledger.append({
        ...common,
        identity: `verification-${verificationId}`,
        type: "verification-finished",
        verificationId,
        findingId: "finding",
        labSetupDigest: setup,
        basis: { kind: "latest-version", findingSnapshotDigest: snapshot },
        result: {
          status: "runtime-confirmed",
          judgeId: "sqli-canary",
          proofKind: "nonce-canary",
          conditions: {
            attackerRole: "subscriber",
            defaultSettings: "false",
            observedVia: "canary-row-read",
          },
          evidenceDigest,
          reproductionPackageDigest,
        },
      });
      const verification = ledger
        .read({ campaignId: common.campaignId, type: "verification-finished" })
        .map(({ event }) => event)
        .find(
          (event) =>
            event.type === "verification-finished" &&
            event.verificationId === verificationId,
        );
      if (verification?.type !== "verification-finished")
        throw new Error("Expected verification event");
      const facts = await provider.load({
        ref: {
          campaignId: common.campaignId,
          findingId: "finding",
          verificationId,
          snapshotDigest: snapshot,
        },
        verification,
      });
      expect(
        assessWordpressScope(policy, facts).map((item) => item.status),
        testCase.name,
      ).toEqual(
        testCase.name === "matched"
          ? ["in-scope", "in-scope"]
          : ["ambiguous", "ambiguous"],
      );
    }
  });
});
