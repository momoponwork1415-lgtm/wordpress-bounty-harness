import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { reconcileContinuousRestart } from "../../src/discovery/continuous-restart-reconciliation.js";
import {
  SqliteContinuousRunJournal,
  continuousChildCampaignId,
} from "../../src/infrastructure/continuous-run-journal.js";
import {
  ledgerEventV1Schema,
  type Ledger,
  type LedgerEventInput,
  type LedgerRecord,
} from "../../src/ledger/index.js";

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const snapshot = digest("a");
const otherSnapshot = digest("e");
const policyDigest = digest("b");
const parentRunId = "parent-one";
const batchId = "selection-one";
const campaignId = continuousChildCampaignId(parentRunId, 0);
const base = (snapshotDigest = snapshot, childId = campaignId) => ({
  schemaVersion: 1 as const,
  campaignId: childId,
  snapshotDigest,
  occurredAt: "2026-10-14T00:00:00Z",
  artifacts: [],
});

function batchBound(id = batchId): LedgerEventInput {
  return {
    ...base(),
    type: "selection-batch-bound",
    identity: "batch-bound",
    selectionBatchId: id,
    policyDigest,
    selectionIds: ["wporg:synthetic@1.0"],
  };
}

function selected(snapshotDigest = snapshot): LedgerEventInput {
  return {
    ...base(snapshotDigest),
    type: "target-selected",
    identity: `selected-${snapshotDigest}`,
    selectionId: "wporg:synthetic@1.0",
  };
}

function frozen(): LedgerEventInput {
  return {
    ...base(),
    type: "snapshot-frozen",
    identity: "frozen",
    sourceDigest: digest("c"),
  };
}

function started(
  runId = "run-one",
  trialOrdinal = 0,
): Extract<LedgerEventInput, { type: "discovery-run-started" }> {
  return {
    ...base(),
    type: "discovery-run-started",
    identity: `started-${runId}`,
    runId,
    labId: "lab-one",
    trialOrdinal,
    history: { mode: "none" },
    configuration: { promptVariant: "synthetic", assignmentUnit: "target" },
  };
}

function finished(
  input: {
    readonly runId?: string;
    readonly outcome?: "completed" | "provider-limited";
    readonly providerLimit?: "quota" | "rate-limit";
  } = {},
): LedgerEventInput {
  const runId = input.runId ?? "run-one";
  return {
    ...base(),
    type: "discovery-run-finished",
    identity: `finished-${runId}`,
    runId,
    outcome: input.outcome ?? "completed",
    costUsd: "unavailable",
    wallTimeMs: 1000,
    ...(input.providerLimit === undefined
      ? {}
      : { reason: "provider" as const, providerLimit: input.providerLimit }),
  };
}

function concluded(): LedgerEventInput {
  return {
    ...base(),
    type: "discovery-concluded",
    identity: "concluded",
    stoppedBy: "max-runs",
  };
}

function finding(): LedgerEventInput {
  return {
    ...base(),
    type: "finding-recorded",
    identity: "finding-one",
    findingId: "finding-one",
    runId: "run-one",
    category: "synthetic",
  };
}

function incompleteVerification(): LedgerEventInput {
  return {
    ...base(),
    type: "verification-finished",
    identity: "verification-one",
    verificationId: "verification-one",
    findingId: "finding-one",
    labSetupDigest: digest("d"),
    result: {
      status: "incomplete",
      reason: "observation",
      nextStep: "Check the Lab observation",
    },
  };
}

function ledgerFor(events: readonly LedgerEventInput[]): Pick<Ledger, "read"> {
  const records: LedgerRecord[] = events.map((event, index) => ({
    sequence: index + 1,
    event: ledgerEventV1Schema.parse(event),
  }));
  return {
    read(query = {}) {
      return records
        .filter(
          ({ sequence, event }) =>
            sequence > (query.afterSequence ?? 0) &&
            (query.campaignId === undefined ||
              event.campaignId === query.campaignId) &&
            (query.type === undefined || event.type === query.type),
        )
        .slice(0, query.limit ?? 100);
    },
  };
}

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "wbh-restart-reconcile-"));
  directories.push(directory);
  const path = join(directory, "journal.sqlite");
  const journal = new SqliteContinuousRunJournal(path);
  const ownerHandle = { parentRunId, token: "a".repeat(64) };
  let ownerReady = true;
  let claims: {
    readonly campaignId: string;
    readonly snapshotDigest: string;
    readonly status: "active" | "recovery-needed";
  }[] = [];
  let record = journal.create({
    parentRunId,
    stateDirectory: directory,
    configDigest: digest("f"),
    policyDigest,
    inventoryDigest: digest("1"),
  });
  return {
    path,
    journal,
    get record() {
      return record;
    },
    reserve() {
      record = journal.reserveChild(parentRunId, record.revision);
      return record;
    },
    bind() {
      record = journal.bindChild(parentRunId, record.revision, 0, {
        selectionBatchId: batchId,
        snapshotDigests: [snapshot],
      });
      return record;
    },
    settle(sequence: number) {
      record = journal.settleChild(parentRunId, record.revision, 0, sequence);
      return record;
    },
    setClaims(value: typeof claims) {
      claims = value;
    },
    setOwnerReady(value: boolean) {
      ownerReady = value;
    },
    inspect(
      events: readonly LedgerEventInput[],
      reviewExportReady?: () => boolean,
      allowStoppedResume = false,
      allowRecoveringResume = false,
      allowReviewResume = false,
      auditPriorSettled = false,
    ) {
      return reconcileContinuousRestart({
        parentRunId,
        journal,
        ledger: ledgerFor(events),
        claims: { status: () => ({ claims }) },
        owner: {
          assertReady() {
            if (!ownerReady) throw new Error("Recovery required");
          },
        },
        ownerHandle,
        ...(reviewExportReady === undefined ? {} : { reviewExportReady }),
        ...(allowStoppedResume ? { allowStoppedResume } : {}),
        ...(allowRecoveringResume ? { allowRecoveringResume } : {}),
        ...(allowReviewResume ? { allowReviewResume } : {}),
        ...(auditPriorSettled ? { auditPriorSettled } : {}),
      });
    },
  };
}

const completed = [
  batchBound(),
  selected(),
  frozen(),
  started(),
  finished(),
  concluded(),
];

describe("continuous restart reconciliation", () => {
  it("audits settled predecessor evidence before advancing a later child", async () => {
    const state = await setup();
    try {
      state.reserve();
      state.bind();
      state.settle(8);
      const next = state.journal.get(parentRunId)!;
      state.journal.reserveChild(parentRunId, next.revision);
      const past = [...completed, finding(), incompleteVerification()];
      expect(
        await state.inspect(past, () => false, false, false, false, true),
      ).toMatchObject({
        action: "hold",
        reason: "settled-child-incomplete",
        campaignId,
      });
      expect(
        await state.inspect(past, () => true, false, false, false, true),
      ).toMatchObject({
        action: "resume-child",
        campaignId: continuousChildCampaignId(parentRunId, 1),
      });
    } finally {
      state.journal.close();
    }
  });

  it("rechecks the assessed child before reopening an operational review hold", async () => {
    const state = await setup();
    try {
      state.reserve();
      state.bind();
      state.journal.transition(parentRunId, state.record.revision, {
        state: "WAIT_REVIEW",
        reason: "config-or-policy-changed",
        nextCheckAt: null,
      });
      const failed = [
        batchBound(),
        selected(),
        frozen(),
        started(),
        finished({ outcome: "provider-limited", providerLimit: "quota" }),
      ];
      expect(
        await state.inspect(failed, undefined, false, false, true),
      ).toMatchObject({ action: "hold", reason: "quota" });
      expect(
        await state.inspect([batchBound(), selected(), frozen()]),
      ).toMatchObject({
        action: "hold",
        reason: "parent-not-running",
      });
      expect(
        await state.inspect(
          [batchBound(), selected(), frozen()],
          undefined,
          false,
          false,
          true,
        ),
      ).toMatchObject({ action: "resume-child", campaignId });
    } finally {
      state.journal.close();
    }
  });

  it("allows an explicit recovery recheck only after the claim clears", async () => {
    const state = await setup();
    try {
      state.reserve();
      state.bind();
      state.setClaims([
        { campaignId, snapshotDigest: snapshot, status: "recovery-needed" },
      ]);
      state.journal.transition(parentRunId, state.record.revision, {
        state: "RECOVERING",
        reason: "resource-recovery-needed",
        nextCheckAt: null,
      });
      expect(
        await state.inspect(completed, undefined, false, true),
      ).toMatchObject({
        action: "hold",
        reason: "resource-recovery-needed",
      });
      state.setClaims([]);
      expect(await state.inspect(completed)).toMatchObject({
        action: "hold",
        reason: "parent-not-running",
      });
      expect(
        await state.inspect(completed, undefined, false, true),
      ).toMatchObject({
        action: "settle-child",
        ordinal: 0,
      });
    } finally {
      state.journal.close();
    }
  });

  it("requires explicit stopped-parent inspection before resuming its reserved child", async () => {
    const state = await setup();
    try {
      state.reserve();
      state.bind();
      const stopping = state.journal.requestStop(parentRunId);
      state.journal.transition(parentRunId, stopping.revision, {
        state: "STOPPED",
        reason: "operator-stop",
        nextCheckAt: null,
      });
      const drained = [...completed.slice(0, -1)];
      expect(await state.inspect(drained)).toMatchObject({
        action: "hold",
        reason: "stop-requested",
      });
      expect(await state.inspect(drained, undefined, true)).toMatchObject({
        action: "resume-child",
        campaignId,
      });
      state.setClaims([
        { campaignId, snapshotDigest: snapshot, status: "recovery-needed" },
      ]);
      expect(await state.inspect(drained, undefined, true)).toMatchObject({
        action: "hold",
        reason: "resource-recovery-needed",
      });
    } finally {
      state.journal.close();
    }
  });

  it("requires settlement and a fresh recheck before reserving the next child", async () => {
    const state = await setup();
    try {
      expect(await state.inspect([])).toMatchObject({
        action: "reserve-next-child",
        nextOrdinal: 0,
      });
      state.reserve();
      state.bind();
      const first = await state.inspect(completed);
      expect(first).toMatchObject({
        action: "settle-child",
        ordinal: 0,
        lastLedgerSequence: 6,
      });
      if (first.action !== "settle-child")
        throw new Error("Expected settlement");
      state.settle(first.lastLedgerSequence);
      expect(await state.inspect(completed)).toMatchObject({
        action: "reserve-next-child",
        nextOrdinal: 1,
        expectedRevision: state.record.revision,
      });
    } finally {
      state.journal.close();
    }
  });

  it("accepts recorded incomplete verification only with a materializable review export", async () => {
    const state = await setup();
    try {
      state.reserve();
      state.bind();
      const events = [...completed, finding(), incompleteVerification()];
      expect(await state.inspect(events)).toMatchObject({
        action: "hold",
        reason: "review-required",
      });
      expect(await state.inspect(events, () => false)).toMatchObject({
        action: "hold",
        reason: "review-required",
      });
      expect(await state.inspect(events, () => true)).toMatchObject({
        action: "settle-child",
        assessment: {
          progress: { verificationIncomplete: 1, verificationComplete: 0 },
        },
      });
    } finally {
      state.journal.close();
    }
  });

  it("holds quota and unfinished Trials, then resumes a drained Trial without conclusion", async () => {
    const state = await setup();
    try {
      state.reserve();
      state.bind();
      const prefix = [batchBound(), selected(), frozen(), started()];
      expect(
        await state.inspect([
          ...prefix,
          finished({ outcome: "provider-limited", providerLimit: "quota" }),
        ]),
      ).toMatchObject({ action: "hold", reason: "quota" });
      expect(
        await state.inspect([
          ...prefix,
          finished({ outcome: "provider-limited" }),
        ]),
      ).toMatchObject({ action: "hold", reason: "review-required" });
      expect(await state.inspect(prefix)).toMatchObject({
        action: "hold",
        reason: "trial-unsettled",
      });
      expect(
        await state.inspect([
          ...prefix,
          { ...started("child-one"), runKind: "child", parentRunId: "run-one" },
          finished(),
        ]),
      ).toMatchObject({ action: "hold", reason: "trial-unsettled" });
      expect(await state.inspect([...prefix, finished()])).toMatchObject({
        action: "resume-child",
        campaignId,
        ordinal: 0,
        assessment: {
          reason: "no-conclusion",
          progress: { trialsStarted: 1, trialsFinished: 1 },
        },
      });
      state.setClaims([
        { campaignId, snapshotDigest: snapshot, status: "recovery-needed" },
      ]);
      expect(await state.inspect([...prefix, finished()])).toMatchObject({
        action: "hold",
        reason: "resource-recovery-needed",
      });
    } finally {
      state.journal.close();
    }
  });

  it("resumes only the same reserved child before any Trial starts", async () => {
    const state = await setup();
    try {
      state.reserve();
      expect(await state.inspect([])).toMatchObject({
        action: "resume-child",
        campaignId,
        ordinal: 0,
      });
      state.bind();
      expect(
        await state.inspect([batchBound(), selected(), frozen()]),
      ).toMatchObject({
        action: "resume-child",
        campaignId,
        assessment: { progress: { trialsStarted: 0 } },
      });
    } finally {
      state.journal.close();
    }
  });

  it("holds live, recovery-needed, and orphan resource claims", async () => {
    const state = await setup();
    try {
      state.reserve();
      state.bind();
      state.setClaims([
        { campaignId, snapshotDigest: snapshot, status: "active" },
      ]);
      expect(await state.inspect(completed)).toMatchObject({
        action: "hold",
        reason: "resource-active",
      });
      state.setClaims([
        { campaignId, snapshotDigest: snapshot, status: "recovery-needed" },
      ]);
      expect(await state.inspect(completed)).toMatchObject({
        action: "hold",
        reason: "resource-recovery-needed",
      });
      state.setClaims([
        { campaignId, snapshotDigest: otherSnapshot, status: "active" },
      ]);
      expect(await state.inspect(completed)).toMatchObject({
        action: "hold",
        reason: "journal-mismatch",
      });
      state.setClaims([
        {
          campaignId: continuousChildCampaignId(parentRunId, 1),
          snapshotDigest: snapshot,
          status: "active",
        },
      ]);
      expect(await state.inspect(completed)).toMatchObject({
        action: "hold",
        reason: "orphan-resource-claim",
      });
    } finally {
      state.journal.close();
    }
  });

  it("holds a missing next-child journal record or a settled child whose ledger vanished", async () => {
    const state = await setup();
    try {
      const nextId = continuousChildCampaignId(parentRunId, 0);
      expect(
        await state.inspect([{ ...selected(), campaignId: nextId }]),
      ).toMatchObject({ action: "hold", reason: "orphan-child-ledger" });
      state.reserve();
      state.bind();
      state.settle(0);
      expect(await state.inspect([])).toMatchObject({
        action: "hold",
        reason: "settled-child-incomplete",
      });
    } finally {
      state.journal.close();
    }
  });

  it("holds corrupt journal bindings, missing binding events, and wrong selection batches", async () => {
    const state = await setup();
    try {
      state.reserve();
      state.bind();
      expect(await state.inspect(completed.slice(1))).toMatchObject({
        action: "hold",
        reason: "ledger-mismatch",
      });
      expect(
        await state.inspect([
          batchBound("another-batch"),
          ...completed.slice(1),
        ]),
      ).toMatchObject({
        action: "hold",
        reason: "ledger-mismatch",
      });
      const db = new DatabaseSync(state.path);
      try {
        db.prepare(
          "UPDATE continuous_children SET snapshot_digests_json = ? WHERE parent_id = ?",
        ).run("not-json", parentRunId);
      } finally {
        db.close();
      }
      expect(await state.inspect(completed)).toMatchObject({
        action: "hold",
        reason: "journal-unavailable",
      });
    } finally {
      state.journal.close();
    }
  });

  it("rejects repeated or comparison Trials even when every root has a finish", async () => {
    const state = await setup();
    try {
      state.reserve();
      state.bind();
      expect(
        await state.inspect([
          ...completed.slice(0, -1),
          started("run-two"),
          finished({ runId: "run-two" }),
          concluded(),
        ]),
      ).toMatchObject({ action: "hold", reason: "ledger-mismatch" });
      expect(
        await state.inspect([
          ...completed.slice(0, -1),
          { ...started("run-two", 1), runKind: "continue" },
          finished({ runId: "run-two" }),
          concluded(),
        ]),
      ).toMatchObject({ action: "hold", reason: "ledger-mismatch" });
      expect(
        await state.inspect([
          batchBound(),
          selected(),
          frozen(),
          { ...started(), stage: "screening" },
          finished(),
          concluded(),
        ]),
      ).toMatchObject({ action: "hold", reason: "ledger-mismatch" });
    } finally {
      state.journal.close();
    }
  });

  it("requires an active owner and honors a stop request", async () => {
    const state = await setup();
    try {
      state.setOwnerReady(false);
      expect(await state.inspect([])).toMatchObject({
        action: "hold",
        reason: "owner-not-ready",
      });
      state.journal.requestStop(parentRunId);
      expect(await state.inspect([])).toMatchObject({
        action: "hold",
        reason: "stop-requested",
      });
    } finally {
      state.journal.close();
    }
  });
});
