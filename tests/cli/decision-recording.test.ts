import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CliIo } from "../../src/cli/index.js";
import {
  RECORDED_AT,
  recordedReviewState,
} from "../support/recorded-review-state.js";

/** The shared recorded history; no target or verification is run. */
async function fixture(askMinutes?: CliIo["askMinutes"]) {
  const state = await recordedReviewState(
    askMinutes === undefined ? {} : { askMinutes },
  );
  const { findingId, evidenceDigest } = state.findings.accountTakeover;
  const notePath = join(state.root, "review-note.md");
  await writeFile(notePath, "Synthetic human review note");
  return {
    ...state,
    findingId,
    decide: (
      reason: string,
      minutes: { read?: string; reproduce?: string } = {
        read: "2.5",
        reproduce: "7.25",
      },
    ) =>
      state.run(
        "review",
        "decide",
        "--campaign",
        "campaign-1",
        "--finding",
        findingId,
        "--decision",
        "accept",
        "--reason",
        reason,
        "--opened",
        evidenceDigest!,
        "--duplicate",
        "no-match",
        "--duplicate-note",
        notePath,
        "--reproduced",
        "match",
        ...(minutes.reproduce === undefined
          ? []
          : ["--reproduce-minutes", minutes.reproduce]),
        ...(minutes.read === undefined ? [] : ["--minutes", minutes.read]),
        "--by",
        "operator",
      ),
  };
}

describe("CLI human review operation", () => {
  it("keeps explicit zero minutes and prompts only for the omitted duration", async () => {
    const asked: string[] = [];
    const { ledger, decide } = await fixture(async (action) => {
      asked.push(action);
      return 3.25;
    });
    const result = await decide("accepted", { reproduce: "0" });
    expect(result.code).toBe(0);
    expect(asked).toEqual(["read"]);
    expect(
      ledger
        .readAll({ type: "human-effort-recorded" })
        .map(({ event }) => event),
    ).toMatchObject([
      { action: "reproduce", minutes: 0 },
      { action: "read", minutes: 3.25 },
    ]);
  });

  it("does not leave partial records or a filed note when the decision reason is invalid", async () => {
    const { ledger, store, decide } = await fixture();
    const eventsBefore = ledger.readAll();
    const artifactsBefore = await readdir(store.rootDirectory);
    const result = await decide("invalid reason");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("reasonCode");
    expect(result.stdout).toBe("");
    expect(ledger.readAll()).toEqual(eventsBefore);
    expect(await readdir(store.rootDirectory)).toEqual(artifactsBefore);
  });

  it("records related work and prints completion in the existing order", async () => {
    const { ledger, decide, findingId } = await fixture();
    const countBefore = ledger.readAll().length;
    const result = await decide("accepted");
    expect(result).toEqual({
      code: 0,
      stderr: "",
      stdout: [
        `manual reproduction match recorded for finding ${findingId}`,
        `recorded accept (accepted) for finding ${findingId} at ${RECORDED_AT}`,
      ].join("\n"),
    });
    const recorded = ledger
      .readAll()
      .slice(countBefore)
      .map(({ event }) => event);
    expect(recorded).toHaveLength(4);
    expect(recorded).toMatchObject([
      { type: "human-reproduction-recorded", result: "match" },
      { type: "human-effort-recorded", action: "reproduce", minutes: 7.25 },
      { type: "review-decided", decision: "accept", humanElapsedSeconds: 150 },
      { type: "human-effort-recorded", action: "read", minutes: 2.5 },
    ]);
  });
});
