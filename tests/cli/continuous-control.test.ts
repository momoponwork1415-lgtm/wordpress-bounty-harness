import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runContinuousControl } from "../../src/cli/continuous-control.js";
import { SqliteContinuousRunJournal } from "../../src/infrastructure/continuous-run-journal.js";
import {
  ledgerEventV1Schema,
  type Ledger,
  type LedgerEventInput,
  type LedgerRecord,
} from "../../src/ledger/index.js";

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;

describe("continuous control", () => {
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
