import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { recoverHostClaim } from "../../src/cli/resource-recovery.js";
import {
  RECOVERY_SETTLE_MS,
  SqliteHostResourceClaims,
} from "../../src/infrastructure/host-resource-claims.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";
import type { DockerRunner } from "../../src/profiles/wordpress/lab/index.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function setup(ownerPid = 2_147_483_647) {
  const root = await mkdtemp(join(tmpdir(), "wbh-resource-recovery-"));
  directories.push(root);
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory);
  const store = new PrivateArtifactStore({
    rootDirectory: join(stateDirectory, "private-evidence"),
    maxEntries: 64,
    maxBytes: 72 * 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(stateDirectory, "ledger.sqlite"),
    artifactStore: store,
  });
  let now = new Date("2026-10-14T00:00:00Z");
  const clock = () => now;
  const claims = new SqliteHostResourceClaims(
    join(root, "claims.sqlite"),
    { maxTargets: 1, providers: { codex: 1 } },
    clock,
  );
  const snapshotDigest = `sha256:${"a".repeat(64)}`;
  const acquired = claims.tryAcquire({
    targetKey: "wordpress:plugin:example",
    ownerKey: "run:crashed",
    ownerPid,
    stateDirectory,
    campaignId: "campaign-1",
    snapshotDigest,
    providerKeys: ["codex"],
    leaseDurationMs: 60_000,
  });
  if (acquired.status !== "acquired") throw new Error("Fixture claim failed");
  return {
    claims,
    ledger,
    acquired,
    snapshotDigest,
    advance: () => {
      now = new Date(now.getTime() + RECOVERY_SETTLE_MS);
    },
  };
}

const docker = (containerNames: string[]): DockerRunner => ({
  async run({ args }) {
    const names = args[0] === "ps" ? containerNames : [];
    return { exitCode: 0, stdout: names.join("\n"), stderr: "" };
  },
});

describe("orphan claim recovery", () => {
  it("keeps an unfinished Trial in the ledger while releasing a dead, resource-free owner", async () => {
    const { claims, ledger, acquired, snapshotDigest, advance } = await setup();
    try {
      await ledger.append({
        schemaVersion: 1,
        identity: "started-run-1",
        campaignId: "campaign-1",
        snapshotDigest,
        occurredAt: "2026-10-14T00:00:00Z",
        type: "discovery-run-started",
        runId: "run-1",
        labId: "lab-1",
        history: { mode: "none" },
        configuration: {
          promptVariant: "test",
          assignmentUnit: "plugin",
        },
      });
      const first = await recoverHostClaim({
        claims,
        claimId: acquired.handle.claimId,
        docker: docker([]),
      });
      expect(first.released).toBe(false);
      expect(claims.status().usedTargets).toBe(1);
      advance();
      const result = await recoverHostClaim({
        claims,
        claimId: acquired.handle.claimId,
        docker: docker([]),
      });
      expect(result).toMatchObject({
        released: true,
        unresolvedRunIds: ["run-1"],
      });
      expect(claims.status().usedTargets).toBe(0);
      expect(
        ledger.read({
          campaignId: "campaign-1",
          type: "discovery-run-started",
        }),
      ).toHaveLength(1);
      expect(
        claims.tryAcquire({
          targetKey: "wordpress:plugin:example",
          ownerKey: "run:next",
          ownerPid: process.pid,
          stateDirectory: join(tmpdir(), "next"),
          campaignId: "campaign-2",
          snapshotDigest,
          providerKeys: ["codex"],
          leaseDurationMs: 60_000,
        }).status,
      ).toBe("acquired");
    } finally {
      claims.close();
    }
  });

  it("holds capacity when any Lab or broker resource remains", async () => {
    const { claims, acquired } = await setup();
    try {
      const result = await recoverHostClaim({
        claims,
        claimId: acquired.handle.claimId,
        docker: docker(["provider-egress-broker-leftover"]),
      });
      expect(result.released).toBe(false);
      expect(claims.status().claims[0]?.status).toBe("recovery-needed");
      expect(claims.status().usedTargets).toBe(1);
    } finally {
      claims.close();
    }
  });

  it("does not inspect or release a live owner", async () => {
    const { claims, acquired } = await setup(process.pid);
    try {
      await expect(
        recoverHostClaim({
          claims,
          claimId: acquired.handle.claimId,
          docker: {
            async run() {
              throw new Error("Docker must not be inspected for a live owner");
            },
          },
        }),
      ).rejects.toThrow("owner process is still alive");
      expect(claims.status().claims[0]?.status).toBe("active");
    } finally {
      claims.close();
    }
  });
});
