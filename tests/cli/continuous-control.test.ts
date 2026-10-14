import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runContinuousControl } from "../../src/cli/continuous-control.js";
import { SqliteContinuousRunJournal } from "../../src/infrastructure/continuous-run-journal.js";

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
        runContinuousControl(
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
        runContinuousControl(
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
      expect(() =>
        runContinuousControl(
          ["continuous", "status", "--run", "unknown"],
          journal,
          io,
        ),
      ).toThrow("not found");
    } finally {
      journal.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
