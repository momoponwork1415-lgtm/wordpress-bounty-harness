import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RECOVERY_SETTLE_MS,
  SqliteHostResourceClaims,
} from "../../src/infrastructure/host-resource-claims.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function open(
  limits = { maxTargets: 2, providers: { codex: 1, opus: 2 } },
) {
  const directory = await mkdtemp(join(tmpdir(), "wbh-host-claims-"));
  directories.push(directory);
  const path = join(directory, "claims.sqlite");
  let now = new Date("2026-10-14T00:00:00Z");
  const clock = () => now;
  const first = new SqliteHostResourceClaims(path, limits, clock);
  const second = new SqliteHostResourceClaims(path, limits, clock);
  const request = (
    targetKey: string,
    providerKeys: string[],
    ownerKey = `run:${targetKey}`,
    ownerPid = process.pid,
  ) => ({
    targetKey,
    ownerKey,
    ownerPid,
    stateDirectory: directory,
    campaignId: "campaign-test",
    snapshotDigest: `sha256:${"a".repeat(64)}`,
    providerKeys,
    leaseDurationMs: 60 * 60_000,
  });
  return {
    path,
    first,
    second,
    request,
    clock,
    advance: () => {
      now = new Date("2026-10-14T02:00:00Z");
    },
    advanceBy: (milliseconds: number) => {
      now = new Date(now.getTime() + milliseconds);
    },
  };
}

describe("host-common resource claims", () => {
  it("atomically excludes the same target and counts global and provider slots", async () => {
    const { first, second, request } = await open();
    try {
      const a = first.tryAcquire(request("wordpress:plugin:a", ["codex"]));
      expect(a.status).toBe("acquired");
      if (a.status !== "acquired") return;
      expect(
        second.tryAcquire(request("wordpress:plugin:a", ["opus"])),
      ).toEqual({ status: "waiting", reason: "target-busy" });
      expect(
        second.tryAcquire(request("wordpress:plugin:b", ["codex"])),
      ).toEqual({
        status: "waiting",
        reason: "provider-capacity",
        providerKey: "codex",
      });
      const b = second.tryAcquire(request("wordpress:plugin:b", ["opus"]));
      expect(b.status).toBe("acquired");
      if (b.status !== "acquired") return;
      expect(first.tryAcquire(request("wordpress:plugin:c", ["opus"]))).toEqual(
        { status: "waiting", reason: "host-capacity" },
      );
      expect(first.status()).toMatchObject({
        maxTargets: 2,
        usedTargets: 2,
        providers: { codex: { used: 1 }, opus: { used: 1 } },
      });
      first.release(a.handle);
      expect(
        second.tryAcquire(request("wordpress:plugin:c", ["codex", "opus"]))
          .status,
      ).toBe("acquired");
      second.release(b.handle);
    } finally {
      first.close();
      second.close();
    }
  });

  it("never frees an expired claim until ledger and Lab/broker reconciliation succeeds", async () => {
    const { path, first, second, request, clock, advance, advanceBy } =
      await open();
    try {
      const acquired = first.tryAcquire(
        request(
          "wordpress:plugin:a",
          ["opus"],
          "run:dead-owner",
          2_147_483_647,
        ),
      );
      expect(acquired.status).toBe("acquired");
      if (acquired.status !== "acquired") return;
      expect(second.flagOverdueForRecovery(acquired.handle.claimId)).toBe(
        false,
      );
      advance();
      expect(second.status().claims[0]).toMatchObject({ overdue: true });
      expect(
        second.tryAcquire(request("wordpress:plugin:a", ["opus"])),
      ).toEqual({ status: "waiting", reason: "target-busy" });
      expect(second.flagOverdueForRecovery(acquired.handle.claimId)).toBe(true);
      expect(() => first.release(acquired.handle)).toThrow(
        "Only a clean active claim may be released",
      );
      first.close();
      const restarted = new SqliteHostResourceClaims(
        path,
        {
          maxTargets: 2,
          providers: { codex: 1, opus: 2 },
        },
        clock,
      );
      try {
        expect(restarted.status().claims[0]).toMatchObject({
          status: "recovery-needed",
          overdue: true,
        });
        expect(
          await restarted.reconcileAbsent(
            acquired.handle.claimId,
            async () => ({
              ledgerInspected: true,
              unresolvedRunIds: [],
              labHasResources: true,
              brokerHasResources: false,
              evidenceDigest: `sha256:${"a".repeat(64)}`,
            }),
          ),
        ).toBe(false);
        expect(restarted.status().usedTargets).toBe(1);
        expect(
          await restarted.reconcileAbsent(
            acquired.handle.claimId,
            async () => ({
              ledgerInspected: true,
              unresolvedRunIds: ["run-a"],
              labHasResources: false,
              brokerHasResources: false,
              evidenceDigest: `sha256:${"b".repeat(64)}`,
            }),
          ),
        ).toBe(false);
        expect(restarted.status().claims[0]?.recoveryEligibleAt).toBe(
          new Date(clock().getTime() + RECOVERY_SETTLE_MS).toISOString(),
        );
        advanceBy(RECOVERY_SETTLE_MS);
        expect(
          await restarted.reconcileAbsent(
            acquired.handle.claimId,
            async () => ({
              ledgerInspected: true,
              unresolvedRunIds: ["run-a"],
              labHasResources: false,
              brokerHasResources: false,
              evidenceDigest: `sha256:${"c".repeat(64)}`,
            }),
          ),
        ).toBe(true);
        expect(restarted.status().usedTargets).toBe(0);
      } finally {
        restarted.close();
      }
    } finally {
      second.close();
    }
  });

  it("rejects inconsistent host limits and tunes them only while idle", async () => {
    const { path, first, second, request } = await open();
    try {
      const claim = first.tryAcquire(request("wordpress:plugin:a", ["codex"]));
      expect(claim.status).toBe("acquired");
      if (claim.status !== "acquired") return;
      expect(
        () =>
          new SqliteHostResourceClaims(path, {
            maxTargets: 3,
            providers: { codex: 2, opus: 2 },
          }),
      ).toThrow("differ while claims are active");
      expect(() =>
        second.setLimits({ maxTargets: 3, providers: { codex: 2, opus: 2 } }),
      ).toThrow("while claims are active");
      first.release(claim.handle);
      const tuned = new SqliteHostResourceClaims(path, {
        maxTargets: 3,
        providers: { codex: 2, opus: 2 },
      });
      tuned.close();
      expect(first.status()).toMatchObject({
        maxTargets: 3,
        providers: { codex: { limit: 2 } },
      });
    } finally {
      first.close();
      second.close();
    }
  });

  it("reports a wait reason and aborts without creating a second claim", async () => {
    const { first, second, request } = await open();
    try {
      const claim = first.tryAcquire(request("wordpress:plugin:a", ["codex"]));
      expect(claim.status).toBe("acquired");
      if (claim.status !== "acquired") return;
      const controller = new AbortController();
      const reasons: string[] = [];
      const pending = second.waitForClaim(
        request("wordpress:plugin:a", ["codex"]),
        {
          signal: controller.signal,
          pollMs: 100,
          onWait: (waiting) => reasons.push(waiting.reason),
        },
      );
      controller.abort(new Error("operator stopped"));
      await expect(pending).rejects.toThrow("operator stopped");
      expect(reasons).toContain("target-busy");
      expect(second.status().usedTargets).toBe(1);
      first.release(claim.handle);
    } finally {
      first.close();
      second.close();
    }
  });

  it("allows only one of two OS processes to claim the same target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wbh-host-claims-race-"));
    directories.push(directory);
    const database = join(directory, "claims.sqlite");
    const barrier = join(directory, "go");
    const workerFile = join(
      process.cwd(),
      "tests/infrastructure/host-resource-claim-worker.test.ts",
    );
    const vitest = join(process.cwd(), "node_modules/vitest/vitest.mjs");
    const workers = [0, 1].map((index) => {
      const ready = join(directory, `ready-${index}`);
      const outcome = join(directory, `outcome-${index}`);
      const child = spawn(process.execPath, [vitest, "run", workerFile], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          WBH_RESOURCE_RACE_DB: database,
          WBH_RESOURCE_RACE_READY: ready,
          WBH_RESOURCE_RACE_BARRIER: barrier,
          WBH_RESOURCE_RACE_OUTCOME: outcome,
          WBH_RESOURCE_RACE_OWNER: `run:process-${index}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      const done = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0 ? resolve() : reject(new Error(output)),
        );
      });
      return { child, ready, outcome, done };
    });
    try {
      const deadline = Date.now() + 10_000;
      for (const worker of workers) {
        for (;;) {
          try {
            await access(worker.ready);
            break;
          } catch {
            if (Date.now() >= deadline)
              throw new Error("Resource claim worker did not reach barrier");
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
      }
      await writeFile(barrier, "go");
      await Promise.all(workers.map((worker) => worker.done));
      const outcomes = await Promise.all(
        workers.map((worker) => readFile(worker.outcome, "utf8")),
      );
      expect(outcomes.sort()).toEqual(["acquired", "waiting"]);
    } finally {
      for (const worker of workers) worker.child.kill();
    }
  }, 20_000);
});
