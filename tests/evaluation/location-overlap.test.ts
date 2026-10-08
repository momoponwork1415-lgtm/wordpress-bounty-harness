import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Evaluation } from "../../src/evaluation/index.js";
import { canonicalJson } from "../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";
import { wordpressFindingLocations } from "../../src/profiles/wordpress/answer-key.js";

const snapshot = `sha256:${"a".repeat(64)}`;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const syntheticKey = {
  caseId: "synthetic-case",
  allowedLocations: [
    { file: "includes/example.php", function: "synthetic_handler" },
    { file: "includes/whole-file.php" },
  ],
};

async function fixture(
  traces: readonly (readonly { file: string; function: string }[] | null)[],
) {
  const root = await mkdtemp(join(tmpdir(), "wbh-evaluation-"));
  directories.push(root);
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 10,
    maxBytes: 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: store,
  });
  for (const [index, trace] of traces.entries()) {
    const findingId = `finding-${index}`;
    const artifacts =
      trace === null
        ? []
        : [
            {
              kind: "finding",
              digest: await store.putFiles({
                "finding.json": canonicalJson({
                  findingId,
                  sourceTrace: trace.map((location) => ({
                    ...location,
                    line: 1,
                  })),
                }),
              }),
            },
          ];
    await ledger.append({
      schemaVersion: 1,
      identity: findingId,
      campaignId: "campaign-1",
      snapshotDigest: snapshot,
      occurredAt: "2026-10-08T00:00:00Z",
      type: "finding-recorded",
      findingId,
      runId: "run-1",
      category: "account-takeover",
      artifacts,
    });
  }
  return new Evaluation({
    ledger,
    store,
    locationsOf: wordpressFindingLocations,
  });
}

describe("evaluation location-overlap", () => {
  it("counts a finding whose trace reaches an allowed file and function", async () => {
    const evaluation = await fixture([
      [{ file: "includes/other.php", function: "unrelated" }],
      [
        { file: "plugin.php", function: "bootstrap" },
        { file: "includes/example.php", function: "synthetic_handler" },
      ],
    ]);
    expect(
      await evaluation.score({
        campaignId: "campaign-1",
        answerKey: syntheticKey,
      }),
    ).toEqual({
      metric: "location-overlap",
      campaignId: "campaign-1",
      caseId: "synthetic-case",
      findings: 2,
      overlapping: ["finding-1"],
      unreadable: [],
      hit: true,
    });
  });

  it("requires the function when the key names one, and accepts any function otherwise", async () => {
    const evaluation = await fixture([
      [{ file: "includes/example.php", function: "different" }],
      [{ file: "includes/whole-file.php", function: "anything" }],
    ]);
    const score = await evaluation.score({
      campaignId: "campaign-1",
      answerKey: syntheticKey,
    });
    expect(score.overlapping).toEqual(["finding-1"]);
  });

  it("reports unreadable findings as scoring failures instead of misses", async () => {
    const evaluation = await fixture([null]);
    expect(
      await evaluation.score({
        campaignId: "campaign-1",
        answerKey: syntheticKey,
      }),
    ).toMatchObject({
      findings: 1,
      overlapping: [],
      unreadable: ["finding-0"],
      hit: false,
    });
  });
});
