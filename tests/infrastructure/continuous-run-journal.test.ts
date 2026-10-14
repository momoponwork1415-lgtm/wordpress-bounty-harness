import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertContinuousStateDirectory,
  SqliteContinuousRunJournal,
  continuousChildCampaignId,
} from "../../src/infrastructure/continuous-run-journal.js";

const directories: string[] = [];
const a = `sha256:${"a".repeat(64)}`;
const b = `sha256:${"b".repeat(64)}`;
const c = `sha256:${"c".repeat(64)}`;

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "wbh-continuous-run-"));
  directories.push(directory);
  const path = join(directory, "journal.sqlite");
  let now = new Date("2026-10-14T00:00:00Z");
  const clock = () => now;
  return {
    path,
    clock,
    advance: () => {
      now = new Date(now.getTime() + 60_000);
    },
  };
}

const input = {
  parentRunId: "week-one",
  stateDirectory: join(tmpdir(), "wbh-pinned-state"),
  configDigest: a,
  policyDigest: b,
  inventoryDigest: c,
};

describe("continuous run journal", () => {
  it("requires an absolute state identity and rejects unpinned legacy rows", async () => {
    const { path } = await setup();
    const journal = new SqliteContinuousRunJournal(path);
    try {
      expect(() =>
        journal.create({ ...input, stateDirectory: "relative-state" }),
      ).toThrow();
      expect(() =>
        assertContinuousStateDirectory(
          { stateDirectory: "" },
          input.stateDirectory,
        ),
      ).toThrow("predates the state directory pin");
      expect(journal.get(input.parentRunId)).toBeNull();
    } finally {
      journal.close();
    }
  });

  it("pins each child before execution and recovers the same reservation after restart", async () => {
    const { path, clock, advance } = await setup();
    const first = new SqliteContinuousRunJournal(path, clock);
    let created = first.create(input);
    expect(created).toMatchObject({
      state: "RUNNING",
      revision: 0,
      stateDirectory: input.stateDirectory,
      configDigest: a,
      policyDigest: b,
      inventoryDigest: c,
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    created = first.reserveChild(input.parentRunId, created.revision);
    const original = created.children[0]!;
    expect(original).toMatchObject({
      ordinal: 0,
      campaignId: continuousChildCampaignId(input.parentRunId, 0),
      inventoryDigest: c,
      status: "reserved",
    });
    first.close();

    advance();
    const restarted = new SqliteContinuousRunJournal(path, clock);
    try {
      const recovered = restarted.get(input.parentRunId)!;
      expect(recovered.children).toEqual([original]);
      expect(() =>
        assertContinuousStateDirectory(
          recovered,
          join(tmpdir(), "other-state"),
        ),
      ).toThrow("different state directory");
      expect(() =>
        assertContinuousStateDirectory(recovered, input.stateDirectory),
      ).not.toThrow();
      expect(
        restarted.reserveChild(input.parentRunId, recovered.revision),
      ).toEqual(recovered);
      expect(() =>
        restarted.settleChild(input.parentRunId, recovered.revision, 0, 12),
      ).toThrow("binding is required");
      const binding = {
        selectionBatchId: "batch-one",
        snapshotDigests: [a, b],
      };
      const bound = restarted.bindChild(
        input.parentRunId,
        recovered.revision,
        0,
        binding,
      );
      expect(bound.children[0]?.binding).toEqual(binding);
      expect(
        restarted.bindChild(input.parentRunId, bound.revision, 0, binding),
      ).toEqual(bound);
      expect(() =>
        restarted.bindChild(input.parentRunId, bound.revision, 0, {
          selectionBatchId: "batch-two",
          snapshotDigests: [a],
        }),
      ).toThrow("binding conflict");
      const settled = restarted.settleChild(
        input.parentRunId,
        bound.revision,
        0,
        12,
      );
      const refilled = restarted.transition(
        input.parentRunId,
        settled.revision,
        {
          state: "RUNNING",
          reason: null,
          nextCheckAt: null,
          inventoryDigest: a,
        },
      );
      const next = restarted.reserveChild(input.parentRunId, refilled.revision);
      expect(next.children).toMatchObject([
        { ordinal: 0, status: "settled", inventoryDigest: c },
        {
          ordinal: 1,
          status: "reserved",
          inventoryDigest: a,
          campaignId: continuousChildCampaignId(input.parentRunId, 1),
        },
      ]);
      expect(next.lastLedgerSequence).toBe(12);
      expect(next.initialInventoryDigest).toBe(c);
    } finally {
      restarted.close();
    }
  });

  it("rejects stale transitions after a stop request from another process", async () => {
    const { path, clock } = await setup();
    const worker = new SqliteContinuousRunJournal(path, clock);
    const operator = new SqliteContinuousRunJournal(path, clock);
    try {
      const running = worker.create(input);
      const stopped = operator.requestStop(input.parentRunId);
      expect(stopped).toMatchObject({
        state: "STOPPING",
        stopRequested: true,
        reason: "operator-stop",
      });
      expect(operator.requestStop(input.parentRunId)).toEqual(stopped);
      expect(() =>
        worker.reserveChild(input.parentRunId, running.revision),
      ).toThrow("revision conflict");
      expect(() =>
        worker.transition(input.parentRunId, running.revision, {
          state: "RUNNING",
          reason: null,
          nextCheckAt: null,
        }),
      ).toThrow("revision conflict");
      const done = worker.transition(input.parentRunId, stopped.revision, {
        state: "STOPPED",
        reason: "operator-stop",
        nextCheckAt: null,
      });
      expect(() =>
        worker.reserveChild(input.parentRunId, done.revision),
      ).toThrow("not accepting children");
      expect(worker.resume(input.parentRunId, done.revision)).toMatchObject({
        state: "RUNNING",
        stopRequested: false,
      });
    } finally {
      worker.close();
      operator.close();
    }
  });

  it("retains a reserved child across an explicitly reconciled stop and resume", async () => {
    const { path, clock } = await setup();
    const journal = new SqliteContinuousRunJournal(path, clock);
    try {
      const created = journal.create(input);
      const reserved = journal.reserveChild(
        input.parentRunId,
        created.revision,
      );
      const stopped = journal.requestStop(input.parentRunId);
      expect(() =>
        journal.bindChild(input.parentRunId, stopped.revision, 0, {
          selectionBatchId: "batch-one",
          snapshotDigests: [a],
        }),
      ).toThrow("not accepting child binding");
      const drained = journal.transition(input.parentRunId, stopped.revision, {
        state: "STOPPED",
        reason: "operator-stop",
        nextCheckAt: null,
      });
      expect(() => journal.resume(input.parentRunId, drained.revision)).toThrow(
        "Reconcile the reserved child",
      );
      const resumed = journal.resume(input.parentRunId, drained.revision, {
        reservedChildReconciled: true,
      });
      expect(resumed).toMatchObject({
        state: "RUNNING",
        stopRequested: false,
        children: [{ campaignId: reserved.children[0]?.campaignId }],
      });
      expect(resumed.children[0]?.status).toBe("reserved");
    } finally {
      journal.close();
    }
  });

  it("advances only the active unbound child's inventory", async () => {
    const { path, clock } = await setup();
    const journal = new SqliteContinuousRunJournal(path, clock);
    try {
      const created = journal.create(input);
      const reserved = journal.reserveChild(
        input.parentRunId,
        created.revision,
      );
      const advanced = journal.advanceUnboundChildInventory(
        input.parentRunId,
        reserved.revision,
        0,
        a,
      );
      expect(advanced.inventoryDigest).toBe(a);
      expect(advanced.children[0]?.inventoryDigest).toBe(a);
      expect(() =>
        journal.advanceUnboundChildInventory(
          input.parentRunId,
          reserved.revision,
          0,
          b,
        ),
      ).toThrow("revision conflict");
      const bound = journal.bindChild(input.parentRunId, advanced.revision, 0, {
        selectionBatchId: "batch-one",
        snapshotDigests: [a],
      });
      expect(() =>
        journal.advanceUnboundChildInventory(
          input.parentRunId,
          bound.revision,
          0,
          b,
        ),
      ).toThrow("Only the active unbound child");
    } finally {
      journal.close();
    }
  });

  it("retains quota and progress conditions across restart", async () => {
    const { path, clock } = await setup();
    const first = new SqliteContinuousRunJournal(path, clock);
    const running = first.create(input);
    expect(() =>
      first.transition(input.parentRunId, running.revision, {
        state: "WAIT_QUOTA",
        reason: "codex-quota",
        nextCheckAt: null,
      }),
    ).toThrow("next check time");
    const waiting = first.transition(input.parentRunId, running.revision, {
      state: "WAIT_QUOTA",
      reason: "codex-quota",
      nextCheckAt: "2026-10-14T05:00:00Z",
      lastLedgerSequence: 9,
    });
    first.close();
    const restarted = new SqliteContinuousRunJournal(path, clock);
    try {
      expect(restarted.get(input.parentRunId)).toEqual(waiting);
      expect(() =>
        restarted.reserveChild(input.parentRunId, waiting.revision),
      ).toThrow("not accepting children");
      expect(() =>
        restarted.transition(input.parentRunId, waiting.revision, {
          state: "RUNNING",
          reason: null,
          nextCheckAt: null,
          lastLedgerSequence: 8,
        }),
      ).toThrow("cannot move backwards");
    } finally {
      restarted.close();
    }
  });
});
