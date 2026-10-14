import { access, writeFile } from "node:fs/promises";

import { it } from "vitest";

import { SqliteHostResourceClaims } from "../../src/infrastructure/host-resource-claims.js";

it.skipIf(process.env.WBH_RESOURCE_RACE_DB === undefined)(
  "claims one target from a separate process",
  async () => {
    const database = process.env.WBH_RESOURCE_RACE_DB!;
    const ready = process.env.WBH_RESOURCE_RACE_READY!;
    const barrier = process.env.WBH_RESOURCE_RACE_BARRIER!;
    const outcome = process.env.WBH_RESOURCE_RACE_OUTCOME!;
    const owner = process.env.WBH_RESOURCE_RACE_OWNER!;
    const claims = new SqliteHostResourceClaims(database, {
      maxTargets: 2,
      providers: { codex: 2 },
    });
    try {
      await writeFile(ready, "ready");
      for (;;) {
        try {
          await access(barrier);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      const result = claims.tryAcquire({
        targetKey: "wordpress:plugin:shared",
        ownerKey: owner,
        ownerPid: process.pid,
        stateDirectory: "/tmp/worker-state",
        campaignId: "worker-campaign",
        snapshotDigest: `sha256:${"a".repeat(64)}`,
        providerKeys: ["codex"],
        leaseDurationMs: 60_000,
      });
      await writeFile(outcome, result.status);
    } finally {
      claims.close();
    }
  },
);
