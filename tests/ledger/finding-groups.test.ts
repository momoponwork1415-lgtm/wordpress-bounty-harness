import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import {
  admitFindingGroup,
  overlapComponents,
  readFindingGroups,
} from "../../src/ledger/finding-groups.js";
import { Ledger } from "../../src/ledger/index.js";

// #424 受入条件 1: 群は「鍵を 1 つでも共有する」の連結成分で、代表は受理順で最初の Finding。

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("overlapComponents", () => {
  it("joins items that share a key, through chains, within one scope only", () => {
    expect(
      overlapComponents([
        { scope: "s", keys: ["a", "b"] },
        { scope: "s", keys: ["c"] },
        { scope: "s", keys: ["b", "d"] },
        { scope: "s", keys: ["d", "c"] },
        { scope: "t", keys: ["a"] },
        { scope: "s", keys: [] },
        { scope: "s", keys: ["e"] },
      ]),
    ).toEqual([0, 0, 0, 0, 4, 5, 6]);
  });
});

describe("finding groups in the ledger", () => {
  it("reads two groups that a later Finding joins as one, while each event keeps its admission id", async () => {
    const root = await mkdtemp(join(tmpdir(), "wbh-ledger-groups-"));
    directories.push(root);
    const ledger = new Ledger({
      databasePath: join(root, "ledger.sqlite"),
      artifactStore: new PrivateArtifactStore({
        rootDirectory: join(root, "evidence"),
        maxEntries: 10,
        maxBytes: 100_000,
      }),
    });
    const base = {
      schemaVersion: 1 as const,
      campaignId: "campaign-1",
      snapshotDigest: `sha256:${"a".repeat(64)}`,
      occurredAt: "2026-10-21T00:00:00Z",
    };
    const admitted: Record<string, string> = {};
    for (const [findingId, keys] of [
      ["first", ["k1"]],
      ["second", ["k2"]],
      ["bridge", ["k1", "k2"]],
    ] as const) {
      const group = admitFindingGroup(ledger, { ...base, findingId, keys });
      admitted[findingId] = group.id;
      await ledger.append({
        ...base,
        identity: findingId,
        type: "finding-recorded",
        findingId,
        runId: "run-1",
        category: "sqli",
        group,
      });
    }
    expect(admitted).toEqual({
      first: "first",
      second: "second",
      bridge: "first",
    });
    const groups = readFindingGroups(ledger, { campaignId: "campaign-1" });
    expect(
      ["first", "second", "bridge"].map((id) => groups.of("campaign-1", id)),
    ).toEqual([
      { id: "first", size: 3, representative: true },
      { id: "first", size: 3, representative: false },
      { id: "first", size: 3, representative: false },
    ]);
  });
});
