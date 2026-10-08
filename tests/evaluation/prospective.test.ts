import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Evaluation } from "../../src/evaluation/index.js";
import { canonicalJson } from "../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";
import { parseWordPressAdvisories } from "../../src/profiles/wordpress/advisory.js";
import { wordpressFindingLocations } from "../../src/profiles/wordpress/answer-key.js";

const digest = (value: string) => `sha256:${value.repeat(64)}`;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

type SyntheticTarget = {
  readonly campaignId: string;
  readonly snapshot: string;
  readonly selectionId: string;
  readonly searched: boolean;
  /** A trace per Finding; null stands for an unreadable private record. */
  readonly findings: readonly ({ file: string; function: string } | null)[];
};

async function ledgerWith(targets: readonly SyntheticTarget[]) {
  const root = await mkdtemp(join(tmpdir(), "wbh-prospective-"));
  directories.push(root);
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 20,
    maxBytes: 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: store,
  });
  let findings = 0;
  for (const target of targets) {
    const base = {
      schemaVersion: 1 as const,
      campaignId: target.campaignId,
      snapshotDigest: target.snapshot,
      occurredAt: "2026-10-01T00:00:00Z",
    };
    await ledger.append({
      ...base,
      identity: `selected-${target.snapshot}`,
      type: "target-selected",
      selectionId: target.selectionId,
    });
    if (!target.searched) continue;
    const runId = `run-${target.snapshot.slice(7, 8)}`;
    await ledger.append({
      ...base,
      identity: `start-${runId}`,
      type: "discovery-run-started",
      runId,
      labId: "lab-1",
      history: { mode: "none" },
      configuration: {
        promptVariant: "short-objective-v1",
        assignmentUnit: "plugin",
        axis: "history",
        arm: "b",
      },
    });
    for (const trace of target.findings) {
      const findingId = `finding-${++findings}`;
      await ledger.append({
        ...base,
        identity: findingId,
        type: "finding-recorded",
        findingId,
        runId,
        category: "account-takeover",
        artifacts:
          trace === null
            ? []
            : [
                {
                  kind: "finding",
                  digest: await store.putFiles({
                    "finding.json": canonicalJson({
                      findingId,
                      sourceTrace: [{ ...trace, line: 1 }],
                    }),
                  }),
                },
              ],
      });
    }
  }
  return new Evaluation({
    ledger,
    store,
    locationsOf: wordpressFindingLocations,
  });
}

const advisory = (
  advisoryId: string,
  slug: string,
  affected: {
    fromVersion: string;
    fromInclusive: boolean;
    toVersion: string;
    toInclusive: boolean;
  },
  publishedAt: string,
  file: string,
) => ({
  schemaVersion: 1,
  advisoryId,
  slug,
  affectedVersions: [affected],
  publishedAt,
  impact: "account-takeover",
  allowedLocations: [{ file, function: "synthetic_handler" }],
});
const upTo = (version: string) => ({
  fromVersion: "*",
  fromInclusive: true,
  toVersion: version,
  toInclusive: false,
});

describe("evaluation prospective scoring", () => {
  it("scores later public advisories against searched snapshots and counts misses apart from scoring failures", async () => {
    const evaluation = await ledgerWith([
      {
        campaignId: "campaign-1",
        snapshot: digest("1"),
        selectionId: "wporg:plugin-x@1.2.0",
        searched: true,
        findings: [
          { file: "includes/a.php", function: "synthetic_handler" },
          { file: "includes/b.php", function: "other" },
        ],
      },
      {
        campaignId: "campaign-1",
        snapshot: digest("2"),
        selectionId: "wporg:plugin-y@2.0.0",
        searched: false,
        findings: [],
      },
      {
        campaignId: "campaign-2",
        snapshot: digest("3"),
        selectionId: "wporg:plugin-z@3.0.0",
        searched: true,
        findings: [null],
      },
      {
        campaignId: "campaign-2",
        snapshot: digest("4"),
        selectionId: "wporg:plugin-w@1.0.0",
        searched: true,
        findings: [{ file: "includes/elsewhere.php", function: "other" }],
      },
    ]);
    const advisories = parseWordPressAdvisories([
      advisory(
        "adv-found",
        "plugin-x",
        upTo("1.3.0"),
        "2026-11-01",
        "includes/a.php",
      ),
      advisory(
        "adv-missed",
        "plugin-w",
        {
          fromVersion: "1.0.0",
          fromInclusive: true,
          toVersion: "1.0.0",
          toInclusive: true,
        },
        "2026-11-01",
        "includes/c.php",
      ),
      advisory(
        "adv-unscorable",
        "plugin-z",
        upTo("4.0.0"),
        "2026-11-01",
        "includes/a.php",
      ),
      advisory(
        "adv-old",
        "plugin-x",
        upTo("1.3.0"),
        "2026-09-01",
        "includes/a.php",
      ),
      advisory(
        "adv-unsearched",
        "plugin-y",
        upTo("3.0.0"),
        "2026-11-01",
        "includes/a.php",
      ),
      advisory(
        "adv-other-version",
        "plugin-x",
        {
          fromVersion: "1.3.0",
          fromInclusive: true,
          toVersion: "1.4.0",
          toInclusive: false,
        },
        "2026-11-01",
        "includes/a.php",
      ),
    ]);
    const result = await evaluation.prospective({ advisories });
    expect(
      result.advisories.map(({ caseId, status }) => [caseId, status]),
    ).toEqual([
      ["adv-found", "found"],
      ["adv-missed", "missed"],
      ["adv-unscorable", "unscorable"],
      ["adv-old", "predates-run"],
      ["adv-unsearched", "not-searched"],
      ["adv-other-version", "not-searched"],
    ]);
    expect(result.counts).toEqual({
      found: 1,
      missed: 1,
      unscorable: 1,
      "predates-run": 1,
      "not-searched": 2,
    });
    // The blind rubric sees only the pair, never the arm or verification result.
    expect(result.rubric).toEqual([
      { caseId: "adv-found", findingId: "finding-1" },
    ]);
  });

  it("rejects an advisory without a version interval or a location", () => {
    const valid = advisory(
      "adv",
      "plugin-x",
      upTo("1.0.0"),
      "2026-11-01",
      "a.php",
    );
    expect(() =>
      parseWordPressAdvisories([{ ...valid, affectedVersions: [] }]),
    ).toThrow();
    expect(() =>
      parseWordPressAdvisories([{ ...valid, allowedLocations: [] }]),
    ).toThrow();
    expect(() =>
      parseWordPressAdvisories([
        { ...valid, allowedLocations: [{ file: "../wp-config.php" }] },
      ]),
    ).toThrow();
  });
});
