import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runContinuousControl } from "../../src/cli/continuous-control.js";
import { settleIdleContinuousStop } from "../../src/cli/continuous-stop.js";
import { SqliteContinuousRunJournal } from "../../src/infrastructure/continuous-run-journal.js";
import { SqliteContinuousRunOwner } from "../../src/infrastructure/continuous-run-owner.js";
import { SqliteHostResourceClaims } from "../../src/infrastructure/host-resource-claims.js";
import {
  ledgerEventV1Schema,
  type Ledger,
  type LedgerEventInput,
  type LedgerRecord,
} from "../../src/ledger/index.js";

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;

describe("continuous control", () => {
  it("settles a RUNNING parent that crashed before taking ownership", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wbh-unowned-stop-"));
    const journal = new SqliteContinuousRunJournal(
      join(directory, "runs.sqlite"),
    );
    const owner = new SqliteContinuousRunOwner(
      join(directory, "owners.sqlite"),
    );
    const claims = new SqliteHostResourceClaims(
      join(directory, "claims.sqlite"),
      { maxTargets: 1, providers: { codex: 1 } },
    );
    const lines: string[] = [];
    try {
      journal.create({
        parentRunId: "unowned-parent",
        stateDirectory: directory,
        configDigest: digest("a"),
        policyDigest: digest("b"),
        inventoryDigest: digest("c"),
      });
      await runContinuousControl(
        ["continuous", "stop", "--run", "unowned-parent"],
        journal,
        { stdout: (line) => lines.push(line) },
        {
          settleStop: (requested) =>
            settleIdleContinuousStop({
              parentRunId: requested.parentRunId,
              journal,
              owner,
              claims,
              ledger: { read: () => [] } as unknown as Ledger,
              reviewExportReady: async () => false,
            }),
        },
      );
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({
        state: "STOPPED",
        reason: "operator-stop",
        stopRequested: true,
      });
      expect(owner.tryAcquire("unowned-parent").status).toBe("acquired");
    } finally {
      claims.close();
      owner.close();
      journal.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("settles an idle review wait after taking ownership and checking ledger and claims", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wbh-idle-stop-"));
    const journal = new SqliteContinuousRunJournal(
      join(directory, "runs.sqlite"),
    );
    const owner = new SqliteContinuousRunOwner(
      join(directory, "owners.sqlite"),
    );
    const claims = new SqliteHostResourceClaims(
      join(directory, "claims.sqlite"),
      { maxTargets: 1, providers: { codex: 1 } },
    );
    const lines: string[] = [];
    try {
      const created = journal.create({
        parentRunId: "idle-parent",
        stateDirectory: directory,
        configDigest: digest("a"),
        policyDigest: digest("b"),
        inventoryDigest: digest("c"),
      });
      journal.transition(created.parentRunId, created.revision, {
        state: "WAIT_REVIEW",
        reason: "candidate-exhausted",
        nextCheckAt: null,
      });
      const ledger = { read: () => [] } as unknown as Ledger;
      await runContinuousControl(
        ["continuous", "stop", "--run", "idle-parent"],
        journal,
        { stdout: (line) => lines.push(line) },
        {
          settleStop: (requested) =>
            settleIdleContinuousStop({
              parentRunId: requested.parentRunId,
              journal,
              owner,
              claims,
              ledger,
              reviewExportReady: async () => false,
            }),
        },
      );
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({
        state: "STOPPED",
        stopRequested: true,
      });
      const acquired = owner.tryAcquire("idle-parent");
      expect(acquired.status).toBe("acquired");
      if (acquired.status === "acquired") owner.release(acquired.handle);
    } finally {
      claims.close();
      owner.close();
      journal.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a stop request when idle reconciliation cannot open state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wbh-idle-stop-fail-"));
    const journal = new SqliteContinuousRunJournal(
      join(directory, "runs.sqlite"),
    );
    const lines: string[] = [];
    try {
      const created = journal.create({
        parentRunId: "idle-parent-fail",
        stateDirectory: directory,
        configDigest: digest("a"),
        policyDigest: digest("b"),
        inventoryDigest: digest("c"),
      });
      journal.transition(created.parentRunId, created.revision, {
        state: "WAIT_REVIEW",
        reason: "inventory-unavailable",
        nextCheckAt: null,
      });
      expect(
        await runContinuousControl(
          ["continuous", "stop", "--run", "idle-parent-fail"],
          journal,
          { stdout: (line) => lines.push(line) },
          {
            settleStop: async () => {
              throw new Error("state unavailable");
            },
          },
        ),
      ).toBe(0);
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({
        state: "STOPPING",
        stopRequested: true,
      });
    } finally {
      journal.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["WAIT_REVIEW", "RUNNING"] as const)(
    "leaves a %s stop pending while another process owns the parent",
    async (priorState) => {
      const directory = await mkdtemp(join(tmpdir(), "wbh-owned-stop-"));
      const journal = new SqliteContinuousRunJournal(
        join(directory, "runs.sqlite"),
      );
      const owner = new SqliteContinuousRunOwner(
        join(directory, "owners.sqlite"),
      );
      const claims = new SqliteHostResourceClaims(
        join(directory, "claims.sqlite"),
        { maxTargets: 1, providers: { codex: 1 } },
      );
      try {
        const created = journal.create({
          parentRunId: "owned-parent",
          stateDirectory: directory,
          configDigest: digest("a"),
          policyDigest: digest("b"),
          inventoryDigest: digest("c"),
        });
        if (priorState === "WAIT_REVIEW")
          journal.transition(created.parentRunId, created.revision, {
            state: "WAIT_REVIEW",
            reason: "candidate-exhausted",
            nextCheckAt: null,
          });
        const active = owner.tryAcquire("owned-parent");
        if (active.status !== "acquired") throw new Error("Owner setup failed");
        try {
          const lines: string[] = [];
          await runContinuousControl(
            ["continuous", "stop", "--run", "owned-parent"],
            journal,
            { stdout: (line) => lines.push(line) },
            {
              settleStop: (requested) =>
                settleIdleContinuousStop({
                  parentRunId: requested.parentRunId,
                  journal,
                  owner,
                  claims,
                  ledger: { read: () => [] } as unknown as Ledger,
                  reviewExportReady: async () => false,
                }),
            },
          );
          expect(JSON.parse(lines.at(-1)!)).toMatchObject({
            state: "STOPPING",
            stopRequested: true,
          });
        } finally {
          owner.release(active.handle);
        }
      } finally {
        claims.close();
        owner.close();
        journal.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("retains a real RECOVERING error when stop is requested", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wbh-error-stop-"));
    const journal = new SqliteContinuousRunJournal(
      join(directory, "runs.sqlite"),
    );
    try {
      const created = journal.create({
        parentRunId: "error-parent",
        stateDirectory: directory,
        configDigest: digest("a"),
        policyDigest: digest("b"),
        inventoryDigest: digest("c"),
      });
      journal.transition(created.parentRunId, created.revision, {
        state: "RECOVERING",
        reason: "runner-error",
        nextCheckAt: null,
      });
      const lines: string[] = [];
      await runContinuousControl(
        ["continuous", "stop", "--run", "error-parent"],
        journal,
        { stdout: (line) => lines.push(line) },
        {
          settleStop: async () => {
            throw new Error("A recovery hold must not be finalized");
          },
        },
      );
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({
        state: "RECOVERING",
        reason: "runner-error",
        stopRequested: true,
      });
    } finally {
      journal.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not claim a clean stop after a prior owner died", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wbh-dead-owner-stop-"));
    const journal = new SqliteContinuousRunJournal(
      join(directory, "runs.sqlite"),
    );
    const owner = new SqliteContinuousRunOwner(
      join(directory, "owners.sqlite"),
      { pidLiveness: (pid) => (pid === 999999 ? "dead" : "alive") },
    );
    const claims = new SqliteHostResourceClaims(
      join(directory, "claims.sqlite"),
      { maxTargets: 1, providers: { codex: 1 } },
    );
    try {
      const created = journal.create({
        parentRunId: "dead-owner-parent",
        stateDirectory: directory,
        configDigest: digest("a"),
        policyDigest: digest("b"),
        inventoryDigest: digest("c"),
      });
      journal.transition(created.parentRunId, created.revision, {
        state: "WAIT_QUOTA",
        reason: "quota",
        nextCheckAt: "2026-10-14T01:00:00.000Z",
      });
      expect(owner.tryAcquire("dead-owner-parent", 999999).status).toBe(
        "acquired",
      );
      const lines: string[] = [];
      await runContinuousControl(
        ["continuous", "stop", "--run", "dead-owner-parent"],
        journal,
        { stdout: (line) => lines.push(line) },
        {
          settleStop: (requested) =>
            settleIdleContinuousStop({
              parentRunId: requested.parentRunId,
              journal,
              owner,
              claims,
              ledger: { read: () => [] } as unknown as Ledger,
              reviewExportReady: async () => false,
            }),
        },
      );
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({
        state: "STOPPING",
        stopRequested: true,
      });
      expect(owner.tryAcquire("dead-owner-parent").status).toBe("busy");
    } finally {
      claims.close();
      owner.close();
      journal.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("shows durable progress and lets an operator stop new dispatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wbh-continuous-control-"));
    const journal = new SqliteContinuousRunJournal(
      join(directory, "runs.sqlite"),
    );
    const lines: string[] = [];
    const io = { stdout: (line: string) => lines.push(line) };
    try {
      let run = journal.create({
        parentRunId: "parent-one",
        stateDirectory: directory,
        configDigest: digest("a"),
        policyDigest: digest("b"),
        inventoryDigest: digest("c"),
      });
      run = journal.reserveChild(run.parentRunId, run.revision);
      run = journal.bindChild(run.parentRunId, run.revision, 0, {
        selectionBatchId: "selection-one",
        snapshotDigests: [digest("d"), digest("e")],
      });
      expect(
        await runContinuousControl(
          ["continuous", "status", "--run", "parent-one"],
          journal,
          io,
        ),
      ).toBe(0);
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({
        configDigest: digest("a"),
        policyDigest: digest("b"),
        inventoryDigest: digest("c"),
        state: "RUNNING",
        stopRequested: false,
        children: [{ status: "reserved", targetCount: 2 }],
      });
      expect(
        await runContinuousControl(
          ["continuous", "stop", "--run", "parent-one"],
          journal,
          io,
        ),
      ).toBe(0);
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({
        state: "STOPPING",
        stopRequested: true,
        reason: "operator-stop",
      });
      expect(() => journal.reserveChild("parent-one", run.revision)).toThrow(
        "revision conflict",
      );
      await expect(
        runContinuousControl(
          ["continuous", "status", "--run", "unknown"],
          journal,
          io,
        ),
      ).rejects.toThrow("not found");
    } finally {
      journal.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("shows bound child Trial, verification and review progress without evidence text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wbh-continuous-status-"));
    const journal = new SqliteContinuousRunJournal(
      join(directory, "runs.sqlite"),
    );
    const lines: string[] = [];
    const io = { stdout: (line: string) => lines.push(line) };
    try {
      let run = journal.create({
        parentRunId: "parent-progress",
        stateDirectory: directory,
        configDigest: digest("a"),
        policyDigest: digest("b"),
        inventoryDigest: digest("c"),
      });
      run = journal.reserveChild(run.parentRunId, run.revision);
      run = journal.bindChild(run.parentRunId, run.revision, 0, {
        selectionBatchId: "selection-progress",
        snapshotDigests: [digest("d")],
      });
      const campaignId = run.children[0]!.campaignId;
      const base = {
        schemaVersion: 1 as const,
        campaignId,
        snapshotDigest: digest("d"),
        occurredAt: "2026-10-14T00:00:00Z",
        artifacts: [],
      };
      const events: LedgerEventInput[] = [
        {
          ...base,
          type: "target-selected",
          identity: "selected-1",
          selectionId: "wporg:example@1.0.0",
        },
        {
          ...base,
          type: "snapshot-frozen",
          identity: "frozen-1",
          sourceDigest: digest("e"),
        },
        {
          ...base,
          type: "discovery-run-started",
          identity: "started-1",
          runId: "run-1",
          labId: "lab-1",
          history: { mode: "none" },
          configuration: {
            promptVariant: "synthetic",
            assignmentUnit: "target",
          },
        },
        {
          ...base,
          type: "discovery-run-finished",
          identity: "finished-1",
          runId: "run-1",
          outcome: "completed",
          costUsd: "unavailable",
          wallTimeMs: 1000,
        },
        {
          ...base,
          type: "discovery-concluded",
          identity: "concluded-1",
          stoppedBy: "max-runs",
        },
        {
          ...base,
          type: "finding-recorded",
          identity: "finding-1",
          findingId: "finding-1",
          runId: "run-1",
          category: "synthetic",
        },
        {
          ...base,
          type: "finding-recorded",
          identity: "finding-2",
          findingId: "finding-2",
          runId: "run-1",
          category: "synthetic",
        },
        {
          ...base,
          type: "verification-finished",
          identity: "verification-1",
          verificationId: "verification-1",
          findingId: "finding-1",
          labSetupDigest: digest("f"),
          result: {
            status: "incomplete",
            reason: "observation",
            nextStep: "private evidence must stay out of status",
          },
        },
        {
          ...base,
          type: "verification-finished",
          identity: "verification-2",
          verificationId: "verification-2",
          findingId: "finding-2",
          labSetupDigest: digest("f"),
          result: {
            status: "contradicted",
            judgeId: "judge-1",
            evidenceDigest: digest("1"),
          },
        },
      ];
      const records: LedgerRecord[] = events.map((event, index) => ({
        sequence: index + 1,
        event: ledgerEventV1Schema.parse(event),
      }));
      const ledger: Pick<Ledger, "read"> = {
        read(query = {}) {
          return records
            .filter(
              ({ sequence, event }) =>
                sequence > (query.afterSequence ?? 0) &&
                (query.campaignId === undefined ||
                  event.campaignId === query.campaignId),
            )
            .slice(0, query.limit ?? 100);
        },
      };
      await runContinuousControl(
        ["continuous", "status", "--run", run.parentRunId],
        journal,
        io,
        { ledger },
      );
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({
        children: [
          {
            state: null,
            reason: "review-export-unchecked",
            reviewExportChecked: false,
            reviewExportsReady: null,
          },
        ],
      });
      await runContinuousControl(
        ["continuous", "status", "--run", run.parentRunId],
        journal,
        io,
        { ledger, reviewExportReady: async () => true },
      );
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({
        children: [
          {
            state: "complete",
            reason: "complete",
            targetCount: 1,
            targetsComplete: 1,
            trialsStarted: 1,
            trialsFinished: 1,
            findings: 2,
            verificationComplete: 1,
            verificationIncomplete: 1,
            reviewExportsReady: 2,
            reviewExportChecked: true,
            lastLedgerSequence: 9,
          },
        ],
      });
      expect(lines.at(-1)).not.toContain("private evidence");
      expect(lines.at(-1)).not.toContain("finding-1");
    } finally {
      journal.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
