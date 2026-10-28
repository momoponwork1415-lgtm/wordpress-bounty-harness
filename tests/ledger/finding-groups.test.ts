import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { openState } from "../../src/cli/state.js";
import { canonicalJson } from "../../src/infrastructure/canonical-json.js";
import { deriveWordPressLegacyGroupKeyCache } from "../../src/profiles/wordpress/discovery/finding-group-cache.js";
import { serializeFindingGroupKeyCache } from "../../src/ledger/finding-group-key-cache.js";
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
  it("derives an old Finding's keys from Private Evidence without changing its event", async () => {
    const root = await mkdtemp(join(tmpdir(), "wbh-ledger-groups-"));
    directories.push(root);
    const stateDirectory = join(root, "state");
    const { ledger, store: artifacts } = await openState(stateDirectory);
    const artifactDigest = await artifacts.putFiles({
      "finding.json": canonicalJson({
        sourceTrace: [{ file: "includes/a.php", function: "handle", line: 2 }],
      }),
    });
    const base = {
      schemaVersion: 1 as const,
      campaignId: "old-campaign",
      snapshotDigest: `sha256:${"a".repeat(64)}`,
      occurredAt: "2026-10-28T00:00:00Z",
    };
    await ledger.append({
      ...base,
      identity: "old-finding",
      type: "finding-recorded",
      findingId: "old-finding",
      runId: "old-run",
      category: "sqli",
      artifacts: [{ kind: "finding", digest: artifactDigest }],
    });
    const before = ledger.funnel("old-campaign");
    expect(before.unkeyedFindings).toBe(1);
    const cache = await deriveWordPressLegacyGroupKeyCache(ledger, artifacts);
    const cachePath = join(root, "group-cache.json");
    await writeFile(cachePath, serializeFindingGroupKeyCache(cache));
    const projected = await openState(
      stateDirectory,
      {},
      {
        readOnly: true,
        findingGroupKeyCachePath: cachePath,
      },
    );
    expect(projected.ledger.funnel("old-campaign").unkeyedFindings).toBe(0);
    expect(
      projected.ledger.readAll({
        campaignId: "old-campaign",
        type: "finding-recorded",
      })[0]?.event,
    ).not.toHaveProperty("group");
    expect(cache.get(artifactDigest)).toHaveLength(1);
  });

  it("shows one Snapshot group across campaigns and keeps a different Snapshot separate", async () => {
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
    const snapshotA = `sha256:${"a".repeat(64)}`;
    const snapshotB = `sha256:${"b".repeat(64)}`;
    for (const [campaignId, findingId, snapshotDigest] of [
      ["campaign-1", "first", snapshotA],
      ["campaign-2", "second", snapshotA],
      ["campaign-3", "third", snapshotB],
    ] as const) {
      const group = admitFindingGroup(ledger, {
        campaignId,
        findingId,
        snapshotDigest,
        keys: ["same/plugin.php:handle"],
      });
      await ledger.append({
        schemaVersion: 1,
        campaignId,
        snapshotDigest,
        occurredAt: "2026-10-28T00:00:00Z",
        identity: findingId,
        type: "finding-recorded",
        findingId,
        runId: `run-${campaignId}`,
        category: "sqli",
        group,
      });
    }
    const scoped = readFindingGroups(ledger, { campaignId: "campaign-2" });
    expect(scoped.of("campaign-2", "second")).toEqual({
      id: "first",
      size: 2,
      representative: false,
    });
    expect(readFindingGroups(ledger).of("campaign-3", "third")).toEqual({
      id: "third",
      size: 1,
      representative: true,
    });
  });

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
