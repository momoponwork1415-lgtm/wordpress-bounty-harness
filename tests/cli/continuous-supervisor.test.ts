import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runContinuousParent } from "../../src/cli/continuous-runner.js";
import { assessContinuousSupervisorWake } from "../../src/cli/continuous-supervisor.js";
import type { CliProfile, CliState } from "../../src/cli/index.js";
import { canonicalDigest } from "../../src/infrastructure/canonical-json.js";
import { SqliteContinuousRunJournal } from "../../src/infrastructure/continuous-run-journal.js";
import {
  observeContinuousRunOwner,
  SqliteContinuousRunOwner,
} from "../../src/infrastructure/continuous-run-owner.js";
import { SqliteHostResourceClaims } from "../../src/infrastructure/host-resource-claims.js";
import {
  ledgerEventV1Schema,
  type Ledger,
  type LedgerEventInput,
  type LedgerReadQuery,
  type LedgerRecord,
} from "../../src/ledger/index.js";

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "wbh-supervisor-"));
  const journal = new SqliteContinuousRunJournal(
    join(directory, "runs.sqlite"),
  );
  const ownerPath = join(directory, "owners.sqlite");
  const owner = new SqliteContinuousRunOwner(ownerPath, {
    pidLiveness: (pid) => (pid === process.pid ? "alive" : "dead"),
  });
  const claims = new SqliteHostResourceClaims(
    join(directory, "claims.sqlite"),
    { maxTargets: 2, providers: { codex: 2 } },
  );
  const configPath = join(directory, "campaign.json");
  const config = { kind: "supervisor-test" };
  await writeFile(configPath, JSON.stringify(config));
  const configDigest = canonicalDigest(config);
  const policyDigest = digest("b");
  const parentRunId = "supervisor-parent";
  journal.create({
    parentRunId,
    stateDirectory: directory,
    configDigest,
    policyDigest,
    inventoryDigest: digest("c"),
  });
  let campaigns = 0;
  const profile = {
    continuousPolicyDigest: async () => policyDigest,
    prepareContinuousBatch: async () => {
      throw new Error("Supervisor test must not prepare a batch");
    },
    runCampaign: async () => {
      campaigns++;
      throw new Error("Supervisor test must not start a Trial");
    },
  } as unknown as CliProfile;
  const state = { stateDirectory: directory } as CliState;
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
  return {
    directory,
    journal,
    owner,
    ownerPath,
    claims,
    parentRunId,
    request,
    campaigns: () => campaigns,
    close: async () => {
      claims.close();
      owner.close();
      journal.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("continuous supervisor wake", () => {
  it("wakes only a RUNNING parent with a definitely absent or dead owner", async () => {
    const test = await fixture();
    try {
      const run = test.journal.get(test.parentRunId)!;
      const gate = (pidLiveness: "no-claim" | "alive" | "dead" | "unknown") =>
        assessContinuousSupervisorWake({
          run,
          owner:
            pidLiveness === "no-claim"
              ? { pidLiveness, claimStatus: null, ownerPid: null }
              : pidLiveness === "unknown"
                ? {
                    pidLiveness,
                    claimStatus: null,
                    ownerPid: null,
                    reason: "owner-store-unavailable",
                  }
                : { pidLiveness, claimStatus: "active", ownerPid: 100 },
          claims: test.claims,
        });
      expect(gate("no-claim")).toEqual({
        action: "wake",
        expectedRevision: run.revision,
      });
      expect(gate("dead").action).toBe("wake");
      expect(gate("alive")).toEqual({ action: "hold", reason: "owner-live" });
      expect(gate("unknown")).toEqual({
        action: "hold",
        reason: "owner-uncertain",
      });
      const reviewHold = test.journal.transition(
        test.parentRunId,
        run.revision,
        { state: "WAIT_REVIEW", reason: "manual-review", nextCheckAt: null },
      );
      expect(
        assessContinuousSupervisorWake({
          run: reviewHold,
          owner: { pidLiveness: "no-claim", claimStatus: null, ownerPid: null },
          claims: test.claims,
        }),
      ).toEqual({ action: "hold", reason: "parent-not-running" });
      const stopped = test.journal.requestStop(test.parentRunId);
      expect(
        assessContinuousSupervisorWake({
          run: stopped,
          owner: { pidLiveness: "no-claim", claimStatus: null, ownerPid: null },
          claims: test.claims,
        }),
      ).toEqual({ action: "hold", reason: "stop-requested" });
    } finally {
      await test.close();
    }
  });

  it("holds when child claims or the claim store are uncertain", async () => {
    const test = await fixture();
    try {
      const run = test.journal.get(test.parentRunId)!;
      const owner = {
        pidLiveness: "dead" as const,
        claimStatus: "active" as const,
        ownerPid: 100,
      };
      expect(
        assessContinuousSupervisorWake({
          run,
          owner,
          claims: {
            status: () => {
              throw new Error("unavailable");
            },
          },
        }),
      ).toEqual({ action: "hold", reason: "claims-unavailable" });
      test.claims.tryAcquire({
        targetKey: "wporg:synthetic",
        ownerKey: "run:orphan",
        ownerPid: 100,
        stateDirectory: test.directory,
        campaignId: `continuous-${canonicalDigest({ parentRunId: test.parentRunId, ordinal: 0 }).slice(7, 39)}`,
        snapshotDigest: digest("a"),
        providerKeys: ["codex"],
        leaseDurationMs: 60_000,
      });
      expect(
        assessContinuousSupervisorWake({ run, owner, claims: test.claims }),
      ).toEqual({ action: "hold", reason: "resource-claim-present" });
    } finally {
      await test.close();
    }
  });

  it("keeps a stop race stopped without acquiring an owner or starting a Trial", async () => {
    const test = await fixture();
    try {
      const run = test.journal.get(test.parentRunId)!;
      test.journal.requestStop(test.parentRunId);
      const result = await runContinuousParent({
        ...test.request,
        supervisorExpectedRevision: run.revision,
      });
      expect(result).toMatchObject({ state: "STOPPING", stopRequested: true });
      expect(test.campaigns()).toBe(0);
      expect(
        observeContinuousRunOwner(test.ownerPath, test.parentRunId),
      ).toMatchObject({
        pidLiveness: "no-claim",
      });
    } finally {
      await test.close();
    }
  });

  it("holds a second supervisor after the first acquires the parent", async () => {
    const test = await fixture();
    try {
      const run = test.journal.get(test.parentRunId)!;
      const first = test.owner.tryAcquire(test.parentRunId);
      expect(first.status).toBe("acquired");
      if (first.status !== "acquired") return;
      const result = await runContinuousParent({
        ...test.request,
        supervisorExpectedRevision: run.revision,
      });
      expect(result).toMatchObject({
        state: "RUNNING",
        revision: run.revision,
      });
      expect(test.campaigns()).toBe(0);
      expect(
        observeContinuousRunOwner(test.ownerPath, test.parentRunId),
      ).toMatchObject({
        pidLiveness: "alive",
      });
      test.owner.release(first.handle);
    } finally {
      await test.close();
    }
  });

  it.each(["review", "stop"] as const)(
    "does not clear a %s transition that races owner acquisition",
    async (transition) => {
      const test = await fixture();
      try {
        const run = test.journal.get(test.parentRunId)!;
        const racingOwner = {
          tryAcquire: () => {
            const acquired = test.owner.tryAcquire(test.parentRunId);
            if (transition === "stop")
              test.journal.requestStop(test.parentRunId);
            else
              test.journal.transition(test.parentRunId, run.revision, {
                state: "WAIT_REVIEW",
                reason: "manual-review",
                nextCheckAt: null,
              });
            return acquired;
          },
          release: (handle: Parameters<typeof test.owner.release>[0]) =>
            test.owner.release(handle),
        } as unknown as SqliteContinuousRunOwner;
        const result = await runContinuousParent({
          ...test.request,
          owner: racingOwner,
          supervisorExpectedRevision: run.revision,
        });
        expect(result).toMatchObject({
          state: transition === "stop" ? "STOPPING" : "WAIT_REVIEW",
          reason: transition === "stop" ? "operator-stop" : "manual-review",
        });
        expect(test.campaigns()).toBe(0);
      } finally {
        await test.close();
      }
    },
  );

  it.each(["stop", "review"] as const)(
    "keeps a dead-owner %s race safe after the recovery claim is acquired",
    async (transition) => {
      const test = await fixture();
      try {
        const parentRunId = test.parentRunId;
        const oldClaim = test.owner.tryAcquire(parentRunId, 100);
        expect(oldClaim.status).toBe("acquired");
        const run = test.journal.get(parentRunId)!;
        const racingOwner = {
          tryAcquire: () => {
            const acquired = test.owner.tryAcquire(parentRunId);
            expect(acquired).toMatchObject({
              status: "acquired",
              recoveryRequired: true,
            });
            if (transition === "stop") test.journal.requestStop(parentRunId);
            else
              test.journal.transition(parentRunId, run.revision, {
                state: "WAIT_REVIEW",
                reason: "manual-review",
                nextCheckAt: null,
              });
            return acquired;
          },
          assertReady: (handle: Parameters<typeof test.owner.assertReady>[0]) =>
            test.owner.assertReady(handle),
          markReconciled: (
            handle: Parameters<typeof test.owner.markReconciled>[0],
            digest: string,
          ) => test.owner.markReconciled(handle, digest),
          release: (handle: Parameters<typeof test.owner.release>[0]) =>
            test.owner.release(handle),
        } as unknown as SqliteContinuousRunOwner;
        const state = {
          stateDirectory: test.directory,
          clock: () => new Date(),
          store: { putFiles: async () => digest("e") },
          ledger: { read: () => [] },
        } as unknown as CliState;
        const result = await runContinuousParent({
          ...test.request,
          state,
          owner: racingOwner,
          supervisorExpectedRevision: run.revision,
        });
        expect(result).toMatchObject({
          state: transition === "stop" ? "STOPPED" : "WAIT_REVIEW",
          reason: transition === "stop" ? "operator-stop" : "manual-review",
          stopRequested: transition === "stop",
        });
        expect(result.children).toHaveLength(0);
        expect(test.campaigns()).toBe(0);
        if (transition === "stop")
          expect(
            observeContinuousRunOwner(test.ownerPath, parentRunId),
          ).toMatchObject({
            pidLiveness: "no-claim",
          });
      } finally {
        await test.close();
      }
    },
  );

  it("reconciles a dead parent into a new worker without starting an unapproved Trial", async () => {
    const test = await fixture();
    try {
      const oldClaim = test.owner.tryAcquire(test.parentRunId, 100);
      expect(oldClaim.status).toBe("acquired");
      const run = test.journal.get(test.parentRunId)!;
      const wake = assessContinuousSupervisorWake({
        run,
        owner: observeContinuousRunOwner(test.ownerPath, test.parentRunId, {
          pidLiveness: () => "dead",
        }),
        claims: test.claims,
      });
      expect(wake).toEqual({ action: "wake", expectedRevision: run.revision });
      if (wake.action !== "wake") return;
      const state = {
        stateDirectory: test.directory,
        clock: () => new Date(),
        store: { putFiles: async () => digest("e") },
        ledger: { read: () => [] },
      } as unknown as CliState;
      const profile = {
        continuousPolicyDigest: async () => run.policyDigest,
        prepareContinuousBatch: async () => ({
          status: "hold" as const,
          reason: "insufficient-eligible-candidates" as const,
          inspected: 0,
          frozen: 0,
        }),
        inspectInventory: async () => ({
          sourceCoverageVerified: true,
          traversal: { nextPageAvailable: false },
        }),
        runCampaign: async () => {
          throw new Error("A dead owner wake must not invent a Trial");
        },
      } as unknown as CliProfile;
      const result = await runContinuousParent({
        ...test.request,
        state,
        profile,
        supervisorExpectedRevision: wake.expectedRevision,
      });
      expect(result).toMatchObject({
        state: "WAIT_REVIEW",
        reason: "candidate-exhausted",
      });
      expect(result.children).toHaveLength(1);
      expect(test.campaigns()).toBe(0);
      expect(
        observeContinuousRunOwner(test.ownerPath, test.parentRunId),
      ).toMatchObject({
        pidLiveness: "no-claim",
      });
    } finally {
      await test.close();
    }
  });

  it.each([
    { stopAtClaimRead: 1, label: "during first recovery inspection" },
    { stopAtClaimRead: 2, label: "during reconciliation evidence capture" },
  ])(
    "settles a late stop $label without replaying a Trial",
    async ({ stopAtClaimRead }) => {
      const test = await fixture();
      try {
        const parentRunId = test.parentRunId;
        const oldClaim = test.owner.tryAcquire(parentRunId, 100);
        expect(oldClaim.status).toBe("acquired");
        const run = test.journal.get(parentRunId)!;
        let claimReads = 0;
        const racingClaims = {
          status: () => {
            claimReads++;
            if (
              claimReads === stopAtClaimRead ||
              (stopAtClaimRead === 1 && claimReads === 2)
            )
              test.journal.requestStop(parentRunId);
            return test.claims.status();
          },
        } as SqliteHostResourceClaims;
        const state = {
          stateDirectory: test.directory,
          clock: () => new Date(),
          store: { putFiles: async () => digest("e") },
          ledger: { read: () => [] },
        } as unknown as CliState;
        const result = await runContinuousParent({
          ...test.request,
          state,
          claims: racingClaims,
          supervisorExpectedRevision: run.revision,
        });
        expect(result).toMatchObject({
          state: "STOPPED",
          stopRequested: true,
          reason: "operator-stop",
          revision: run.revision + 2,
        });
        expect(result.children).toHaveLength(0);
        expect(test.campaigns()).toBe(0);
        expect(
          observeContinuousRunOwner(test.ownerPath, parentRunId),
        ).toMatchObject({ pidLiveness: "no-claim" });
      } finally {
        await test.close();
      }
    },
  );

  it("holds a started but unfinished Trial after a dead owner instead of replaying it", async () => {
    const test = await fixture();
    try {
      const parentRunId = test.parentRunId;
      const first = test.journal.get(parentRunId)!;
      const reserved = test.journal.reserveChild(parentRunId, first.revision);
      const snapshotDigest = digest("a");
      const child = reserved.children[0]!;
      const bound = test.journal.bindChild(parentRunId, reserved.revision, 0, {
        selectionBatchId: "selection-one",
        snapshotDigests: [snapshotDigest],
      });
      const base = {
        schemaVersion: 1 as const,
        campaignId: child.campaignId,
        snapshotDigest,
        occurredAt: new Date().toISOString(),
        artifacts: [],
      };
      const events: LedgerEventInput[] = [
        {
          ...base,
          identity: "batch-bound",
          type: "selection-batch-bound",
          selectionBatchId: "selection-one",
          policyDigest: bound.policyDigest,
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
            .slice(0, query.limit),
      } as Pick<Ledger, "read">;
      const oldClaim = test.owner.tryAcquire(parentRunId, 100);
      expect(oldClaim.status).toBe("acquired");
      const state = {
        stateDirectory: test.directory,
        clock: () => new Date(),
        ledger,
      } as CliState;
      const result = await runContinuousParent({
        ...test.request,
        state,
        supervisorExpectedRevision: bound.revision,
      });
      expect(result).toMatchObject({
        state: "RECOVERING",
        reason: "crash-trial-unsettled",
      });
      expect(result.children).toHaveLength(1);
      expect(result.children[0]?.campaignId).toBe(child.campaignId);
      expect(test.campaigns()).toBe(0);
    } finally {
      await test.close();
    }
  });
});
