import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runContinuousParent } from "../../src/cli/continuous-runner.js";
import type { CliProfile, CliState } from "../../src/cli/index.js";
import { SqliteContinuousRunJournal } from "../../src/infrastructure/continuous-run-journal.js";
import { SqliteContinuousRunOwner } from "../../src/infrastructure/continuous-run-owner.js";
import { SqliteHostResourceClaims } from "../../src/infrastructure/host-resource-claims.js";
import { canonicalDigest } from "../../src/infrastructure/canonical-json.js";
import {
  ledgerEventV1Schema,
  type Ledger,
  type LedgerEventInput,
  type LedgerReadQuery,
  type LedgerRecord,
} from "../../src/ledger/index.js";

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;

describe("continuous parent quota wait", () => {
  it("holds before the check time and requests review after it without replaying a Trial", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wbh-quota-wait-"));
    let instant = new Date("2026-10-14T00:00:00.000Z");
    const clock = () => instant;
    const journal = new SqliteContinuousRunJournal(
      join(directory, "runs.sqlite"),
      clock,
    );
    const owner = new SqliteContinuousRunOwner(
      join(directory, "owners.sqlite"),
      {
        clock,
      },
    );
    const claims = new SqliteHostResourceClaims(
      join(directory, "claims.sqlite"),
      { maxTargets: 1, providers: { codex: 1 } },
      clock,
    );
    try {
      const parentRunId = "quota-wait-test";
      const configDigest = canonicalDigest({ kind: "quota-config" });
      await writeFile(
        join(directory, "campaign.json"),
        JSON.stringify({ kind: "quota-config" }),
      );
      const policyDigest = digest("b");
      const created = journal.create({
        parentRunId,
        stateDirectory: directory,
        configDigest,
        policyDigest,
        inventoryDigest: digest("c"),
      });
      const reserved = journal.reserveChild(parentRunId, created.revision);
      const childCampaignId = reserved.children[0]!.campaignId;
      journal.transition(parentRunId, reserved.revision, {
        state: "WAIT_QUOTA",
        reason: "quota",
        nextCheckAt: "2026-10-14T00:05:00.000Z",
      });
      let campaignCalls = 0;
      const profile = {
        continuousPolicyDigest: async () => policyDigest,
        prepareContinuousBatch: async () => {
          throw new Error("Quota wait must not select another batch");
        },
        runCampaign: async () => {
          campaignCalls += 1;
          throw new Error("Quota wait must not replay the bound child");
        },
      } as unknown as CliProfile;
      const state = { clock, stateDirectory: directory } as CliState;
      const request = {
        parentRunId,
        configPath: join(directory, "campaign.json"),
        configDigest,
        state,
        profile,
        journal,
        owner,
        claims,
        io: { stdout: () => {} },
      };

      expect((await runContinuousParent(request)).state).toBe("WAIT_QUOTA");
      instant = new Date("2026-10-14T00:05:00.000Z");
      const due = await runContinuousParent(request);
      expect(due).toMatchObject({
        state: "WAIT_REVIEW",
        reason: "quota-readiness-unverified",
        nextCheckAt: null,
      });
      expect(due.children.map((child) => child.campaignId)).toEqual([
        childCampaignId,
      ]);
      expect(campaignCalls).toBe(0);
    } finally {
      claims.close();
      owner.close();
      journal.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { waitState: "WAIT_QUOTA", finish: "provider-limited", expected: "quota" },
    { waitState: "WAIT_REVIEW", finish: "failed", expected: "review-required" },
  ] as const)(
    "drains $waitState on stop and restores $expected on explicit resume",
    async ({ waitState, finish, expected }) => {
      const directory = await mkdtemp(join(tmpdir(), "wbh-stop-wait-"));
      const clock = () => new Date("2026-10-14T00:00:00.000Z");
      const journal = new SqliteContinuousRunJournal(
        join(directory, "runs.sqlite"),
        clock,
      );
      const owner = new SqliteContinuousRunOwner(
        join(directory, "owners.sqlite"),
        { clock },
      );
      const claims = new SqliteHostResourceClaims(
        join(directory, "claims.sqlite"),
        { maxTargets: 1, providers: { codex: 1 } },
        clock,
      );
      try {
        const parentRunId = `stop-${waitState.toLowerCase()}`;
        const configPath = join(directory, "campaign.json");
        const configDigest = canonicalDigest({ kind: "stop-wait-config" });
        await writeFile(
          configPath,
          JSON.stringify({ kind: "stop-wait-config" }),
        );
        const policyDigest = digest("b");
        const snapshotDigest = digest("a");
        const created = journal.create({
          parentRunId,
          stateDirectory: directory,
          configDigest,
          policyDigest,
          inventoryDigest: digest("c"),
        });
        const reserved = journal.reserveChild(parentRunId, created.revision);
        const childId = reserved.children[0]!.campaignId;
        const bound = journal.bindChild(parentRunId, reserved.revision, 0, {
          selectionBatchId: "selection-one",
          snapshotDigests: [snapshotDigest],
        });
        const base = {
          schemaVersion: 1 as const,
          campaignId: childId,
          snapshotDigest,
          occurredAt: clock().toISOString(),
          artifacts: [],
        };
        const events: LedgerEventInput[] = [
          {
            ...base,
            identity: "batch-bound",
            type: "selection-batch-bound",
            selectionBatchId: "selection-one",
            policyDigest,
            selectionIds: ["wporg:synthetic@1.0"],
          },
          {
            ...base,
            identity: "selected",
            type: "target-selected",
            selectionId: "wporg:synthetic@1.0",
          },
          {
            ...base,
            identity: "frozen",
            type: "snapshot-frozen",
            sourceDigest: digest("d"),
          },
          {
            ...base,
            identity: "started",
            type: "discovery-run-started",
            runId: "trial-one",
            labId: "lab-one",
            trialOrdinal: 0,
            history: { mode: "none" },
            configuration: {
              promptVariant: "synthetic",
              assignmentUnit: "target",
            },
          },
          {
            ...base,
            identity: "finished",
            type: "discovery-run-finished",
            runId: "trial-one",
            outcome: finish,
            reason: "provider",
            ...(finish === "provider-limited"
              ? { providerLimit: "quota" as const }
              : {}),
            costUsd: "unavailable",
            wallTimeMs: 1000,
          },
        ];
        const records: LedgerRecord[] = events.map((event, index) => ({
          sequence: index + 1,
          event: ledgerEventV1Schema.parse(event),
        }));
        const ledger = {
          read: (query: LedgerReadQuery = {}) =>
            records
              .filter(
                ({ sequence, event }) =>
                  sequence > (query.afterSequence ?? 0) &&
                  (query.campaignId === undefined ||
                    event.campaignId === query.campaignId) &&
                  (query.type === undefined || event.type === query.type),
              )
              .slice(0, query.limit ?? 100),
        } as unknown as Ledger;
        const waiting = journal.transition(parentRunId, bound.revision, {
          state: waitState,
          reason: expected,
          nextCheckAt:
            waitState === "WAIT_QUOTA" ? "2026-10-14T00:05:00.000Z" : null,
        });
        journal.requestStop(parentRunId);
        const state = { clock, stateDirectory: directory, ledger } as CliState;
        let campaignCalls = 0;
        const profile = {
          continuousPolicyDigest: async () => policyDigest,
          prepareContinuousBatch: async () => {
            throw new Error("A bound child must not be prepared again");
          },
          runCampaign: async () => {
            campaignCalls += 1;
            throw new Error("A spent Trial must not be replayed");
          },
        } as unknown as CliProfile;
        const request = {
          parentRunId,
          configPath,
          configDigest,
          state,
          profile,
          journal,
          owner,
          claims,
          io: { stdout: () => {} },
        };
        const stopped = await runContinuousParent(request);
        expect(stopped).toMatchObject({
          state: "STOPPED",
          stopRequested: true,
        });
        expect(stopped.children[0]?.campaignId).toBe(childId);
        expect(stopped.revision).toBeGreaterThan(waiting.revision);

        const resumed = await runContinuousParent(request);
        expect(resumed).toMatchObject({
          state: waitState,
          reason: expected,
          stopRequested: false,
        });
        expect(resumed.children.map((child) => child.campaignId)).toEqual([
          childId,
        ]);
        expect(campaignCalls).toBe(0);
      } finally {
        claims.close();
        owner.close();
        journal.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("retries a repaired operational review hold on its existing child", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wbh-review-retry-"));
    const clock = () => new Date("2026-10-14T00:00:00.000Z");
    const journal = new SqliteContinuousRunJournal(
      join(directory, "runs.sqlite"),
      clock,
    );
    const owner = new SqliteContinuousRunOwner(
      join(directory, "owners.sqlite"),
      { clock },
    );
    const claims = new SqliteHostResourceClaims(
      join(directory, "claims.sqlite"),
      { maxTargets: 1, providers: { codex: 1 } },
      clock,
    );
    try {
      const parentRunId = "repaired-review-hold";
      const configPath = join(directory, "campaign.json");
      const configDigest = canonicalDigest({ kind: "repaired-config" });
      await writeFile(configPath, JSON.stringify({ kind: "repaired-config" }));
      const policyDigest = digest("b");
      const created = journal.create({
        parentRunId,
        stateDirectory: directory,
        configDigest,
        policyDigest,
        inventoryDigest: digest("c"),
      });
      const reserved = journal.reserveChild(parentRunId, created.revision);
      journal.transition(parentRunId, reserved.revision, {
        state: "WAIT_REVIEW",
        reason: "config-or-policy-changed",
        nextCheckAt: null,
      });
      let prepareCalls = 0;
      const profile = {
        continuousPolicyDigest: async () => policyDigest,
        prepareContinuousBatch: async () => {
          prepareCalls += 1;
          return {
            status: "hold",
            reason: "insufficient-eligible-candidates",
            inspected: 0,
            frozen: 0,
          };
        },
        inspectInventory: async () => ({
          sourceCoverageVerified: true,
          traversal: { nextPageAvailable: false },
        }),
      } as unknown as CliProfile;
      const result = await runContinuousParent({
        parentRunId,
        configPath,
        configDigest,
        state: {
          clock,
          stateDirectory: directory,
          ledger: { read: () => [] },
        } as unknown as CliState,
        profile,
        journal,
        owner,
        claims,
        io: { stdout: () => {} },
      });
      expect(result).toMatchObject({
        state: "WAIT_REVIEW",
        reason: "candidate-exhausted",
      });
      expect(result.children).toHaveLength(1);
      expect(prepareCalls).toBe(1);
    } finally {
      claims.close();
      owner.close();
      journal.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records a non-drainable stop as recovery instead of leaving STOPPING", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wbh-stop-recovery-"));
    const clock = () => new Date("2026-10-14T00:00:00.000Z");
    const journal = new SqliteContinuousRunJournal(
      join(directory, "runs.sqlite"),
      clock,
    );
    const owner = new SqliteContinuousRunOwner(
      join(directory, "owners.sqlite"),
      { clock },
    );
    const claims = new SqliteHostResourceClaims(
      join(directory, "claims.sqlite"),
      { maxTargets: 1, providers: { codex: 1 } },
      clock,
    );
    try {
      const parentRunId = "stop-ledger-error";
      const configPath = join(directory, "campaign.json");
      const configDigest = canonicalDigest({ kind: "stop-recovery-config" });
      await writeFile(
        configPath,
        JSON.stringify({ kind: "stop-recovery-config" }),
      );
      const policyDigest = digest("b");
      journal.create({
        parentRunId,
        stateDirectory: directory,
        configDigest,
        policyDigest,
        inventoryDigest: digest("c"),
      });
      journal.requestStop(parentRunId);
      const request = {
        parentRunId,
        configPath,
        configDigest,
        state: {
          clock,
          stateDirectory: directory,
          ledger: {
            read: () => {
              throw new Error("Ledger unavailable");
            },
          },
        } as unknown as CliState,
        profile: {
          continuousPolicyDigest: async () => policyDigest,
          prepareContinuousBatch: async () => {
            throw new Error("No child may be prepared");
          },
        } as unknown as CliProfile,
        journal,
        owner,
        claims,
        io: { stdout: () => {} },
      };
      const held = await runContinuousParent(request);
      expect(held).toMatchObject({
        state: "RECOVERING",
        reason: "stop-ledger-unavailable",
        stopRequested: true,
      });
      const again = await runContinuousParent(request);
      expect(again).toMatchObject({
        state: "RECOVERING",
        reason: "stop-ledger-unavailable",
        revision: held.revision,
      });
    } finally {
      claims.close();
      owner.close();
      journal.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
