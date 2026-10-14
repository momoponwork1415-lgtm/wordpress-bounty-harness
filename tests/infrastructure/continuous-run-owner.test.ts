import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  observeContinuousRunOwner,
  SqliteContinuousRunOwner,
  type PidLiveness,
} from "../../src/infrastructure/continuous-run-owner.js";

const directories: string[] = [];
const evidenceDigest = `sha256:${"a".repeat(64)}`;

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "wbh-parent-owner-"));
  directories.push(directory);
  const path = join(directory, "owner.sqlite");
  const liveness = new Map<number, PidLiveness>();
  let now = new Date("2026-10-14T00:00:00Z");
  const options = {
    clock: () => now,
    pidLiveness: (pid: number) => liveness.get(pid) ?? "unknown",
  };
  return {
    path,
    liveness,
    options,
    advanceWeek: () => {
      now = new Date(now.getTime() + 7 * 24 * 60 * 60_000);
    },
  };
}

describe("host-common continuous-run ownership", () => {
  it("observes absent, live, dead, and uncertain claims without opening the store for writes", async () => {
    const { path, liveness, options } = await setup();
    expect(observeContinuousRunOwner(path, "parent-one", options)).toEqual({
      pidLiveness: "no-claim",
      claimStatus: null,
      ownerPid: null,
    });
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });

    liveness.set(101, "alive");
    const owner = new SqliteContinuousRunOwner(path, options);
    try {
      const claim = owner.tryAcquire("parent-one", 101);
      expect(claim.status).toBe("acquired");
      if (claim.status !== "acquired") return;
      expect(observeContinuousRunOwner(path, "parent-one", options)).toEqual({
        pidLiveness: "alive",
        claimStatus: "active",
        ownerPid: 101,
      });
      liveness.set(101, "dead");
      expect(observeContinuousRunOwner(path, "parent-one", options)).toEqual({
        pidLiveness: "dead",
        claimStatus: "active",
        ownerPid: 101,
      });
      liveness.set(101, "unknown");
      expect(
        observeContinuousRunOwner(path, "parent-one", options),
      ).toMatchObject({
        pidLiveness: "unknown",
        claimStatus: "active",
        ownerPid: 101,
      });
      expect(
        observeContinuousRunOwner(path, "another-parent", options),
      ).toEqual({
        pidLiveness: "no-claim",
        claimStatus: null,
        ownerPid: null,
      });
      owner.assertReady(claim.handle);
    } finally {
      owner.close();
    }
  });

  it("excludes a live owner regardless of age, and uses a private SQLite file", async () => {
    const { path, liveness, options, advanceWeek } = await setup();
    liveness.set(101, "alive");
    const first = new SqliteContinuousRunOwner(path, options);
    const second = new SqliteContinuousRunOwner(path, options);
    try {
      const initial = first.tryAcquire("parent-one", 101);
      expect(initial.status).toBe("acquired");
      if (initial.status !== "acquired") return;
      expect(initial.recoveryRequired).toBe(false);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      advanceWeek();
      expect(second.tryAcquire("parent-one", 202)).toEqual({
        status: "busy",
        reason: "live-owner",
        ownerPid: 101,
      });
      first.assertReady(initial.handle);
      first.release(initial.handle);
      expect(second.tryAcquire("parent-one", 202)).toMatchObject({
        status: "acquired",
        recoveryRequired: false,
      });
    } finally {
      first.close();
      second.close();
    }
  });

  it("atomically reclaims a dead owner into recovery and rejects stale capabilities", async () => {
    const { path, liveness, options } = await setup();
    liveness.set(101, "alive");
    liveness.set(202, "alive");
    const first = new SqliteContinuousRunOwner(path, options);
    const second = new SqliteContinuousRunOwner(path, options);
    try {
      const initial = first.tryAcquire("parent-one", 101);
      expect(initial.status).toBe("acquired");
      if (initial.status !== "acquired") return;
      liveness.set(101, "dead");
      const reclaimed = second.tryAcquire("parent-one", 202);
      expect(reclaimed.status).toBe("acquired");
      if (reclaimed.status !== "acquired") return;
      expect(reclaimed.recoveryRequired).toBe(true);
      expect(first.tryAcquire("parent-one", 303)).toEqual({
        status: "busy",
        reason: "live-owner",
        ownerPid: 202,
      });
      expect(() => first.release(initial.handle)).toThrow("capability");
      expect(() => second.assertReady(initial.handle)).toThrow("capability");
      expect(() =>
        second.markReconciled(initial.handle, evidenceDigest),
      ).toThrow("capability");
      expect(() => second.assertReady(reclaimed.handle)).toThrow(
        "requires recovery",
      );
      expect(() => second.release(reclaimed.handle)).toThrow(
        "Only a reconciled",
      );
      expect(() =>
        second.markReconciled(reclaimed.handle, "not-a-digest"),
      ).toThrow();
      second.markReconciled(reclaimed.handle, evidenceDigest);
      second.assertReady(reclaimed.handle);
      second.release(reclaimed.handle);
      expect(first.tryAcquire("parent-one", 303)).toMatchObject({
        status: "acquired",
        recoveryRequired: false,
      });
    } finally {
      first.close();
      second.close();
    }
  });

  it("fails closed when PID liveness is unknown or the check throws", async () => {
    const { path, liveness, options } = await setup();
    liveness.set(101, "alive");
    const first = new SqliteContinuousRunOwner(path, options);
    const second = new SqliteContinuousRunOwner(path, options);
    try {
      const initial = first.tryAcquire("parent-one", 101);
      expect(initial.status).toBe("acquired");
      if (initial.status !== "acquired") return;
      liveness.set(101, "unknown");
      expect(second.tryAcquire("parent-one", 202)).toEqual({
        status: "busy",
        reason: "owner-liveness-unknown",
        ownerPid: 101,
      });
      const failing = new SqliteContinuousRunOwner(path, {
        pidLiveness: () => {
          throw new Error("PID inspection unavailable");
        },
      });
      try {
        expect(() => failing.tryAcquire("parent-one", 303)).toThrow(
          "PID inspection unavailable",
        );
      } finally {
        failing.close();
      }
      liveness.set(101, "alive");
      first.requireRecovery(initial.handle);
      expect(() => first.release(initial.handle)).toThrow("Only a reconciled");
      expect(second.tryAcquire("parent-one", 202)).toEqual({
        status: "busy",
        reason: "live-owner",
        ownerPid: 101,
      });
      liveness.set(101, "dead");
      expect(second.tryAcquire("parent-one", 202)).toMatchObject({
        status: "acquired",
        recoveryRequired: true,
      });
    } finally {
      first.close();
      second.close();
    }
  });
});
