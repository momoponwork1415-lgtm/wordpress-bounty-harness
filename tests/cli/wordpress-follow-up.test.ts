import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { FollowUpTarget } from "../../src/cli/continuous.js";
import { resolveWordPressFollowUp } from "../../src/cli/wordpress-prior-leads.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("resolveWordPressFollowUp (ADR 0049 C)", () => {
  it("records the schedule once, records an ADR 0044 refusal as follow-up-refused, logs it and runs nothing twice", async () => {
    const root = await mkdtemp(join(tmpdir(), "wbh-follow-up-"));
    roots.push(root);
    const store = new PrivateArtifactStore({
      rootDirectory: join(root, "evidence"),
      maxEntries: 4,
      maxBytes: 1024,
    });
    const ledger = new Ledger({
      databasePath: join(root, "ledger.sqlite"),
      artifactStore: store,
    });
    let ids = 0;
    const state = {
      ledger,
      store,
      clock: () => new Date("2026-11-02T00:00:00Z"),
      newId: () => `id-${++ids}`,
    };
    const snapshotDigest = `sha256:${"3".repeat(64)}`;
    // The runner names a Lead the ledger never recorded: the named-Trial check refuses it.
    const target: FollowUpTarget = {
      snapshotDigest,
      selectionId: "wporg:three@1.0.0",
      ofRunId: "run-first",
      ofCampaignId: "prod-20261102-1",
      leadCount: 3,
      leadIds: [`sha256:${"d".repeat(64)}`],
    };
    const log: string[] = [];
    const campaignId = "prod-20261102-2";
    const resolved = await resolveWordPressFollowUp(state, campaignId, {
      targets: [target],
      log: (line) => log.push(line),
    });
    expect(resolved).toEqual([]);
    expect(log).toEqual([
      `follow-up refused campaign=${campaignId} snapshot=${snapshotDigest} of=run-first reason=prior-lead-unknown`,
    ]);
    const events = () =>
      ledger.read({ campaignId }).map(({ event }) => {
        const { identity: _identity, occurredAt: _at, ...rest } = event;
        return rest;
      });
    const recorded = events();
    expect(recorded).toMatchObject([
      {
        type: "follow-up-scheduled",
        snapshotDigest,
        ofRunId: "run-first",
        ofCampaignId: "prod-20261102-1",
        leadCount: 3,
      },
      {
        type: "target-skipped",
        snapshotDigest,
        selectionId: "wporg:three@1.0.0",
        stage: "discovery",
        reason: "follow-up-refused",
        reasonDetail: "prior-lead-unknown",
      },
    ]);
    // A restarted runner hands the same campaign the same targets: nothing is written again.
    expect(
      await resolveWordPressFollowUp(state, campaignId, {
        targets: [target],
        log: (line) => log.push(line),
      }),
    ).toEqual([]);
    expect(events()).toEqual(recorded);
    expect(log).toHaveLength(1);
  });
});
