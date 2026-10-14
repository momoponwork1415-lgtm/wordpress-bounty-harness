import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runContinuousParent } from "../../src/cli/continuous-runner.js";
import type { CampaignSummary } from "../../src/cli/pipeline.js";
import type { CliProfile, CliState } from "../../src/cli/index.js";
import { SqliteContinuousRunJournal } from "../../src/infrastructure/continuous-run-journal.js";
import { SqliteContinuousRunOwner } from "../../src/infrastructure/continuous-run-owner.js";
import { SqliteHostResourceClaims } from "../../src/infrastructure/host-resource-claims.js";
import { canonicalDigest } from "../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import {
  ledgerEventV1Schema,
  type Ledger,
  type LedgerEventInput,
  type LedgerReadQuery,
  type LedgerRecord,
} from "../../src/ledger/index.js";

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const now = () => new Date("2026-10-14T00:00:00.000Z");
const parentRunId = "continuous-test-parent";
const configDigest = canonicalDigest({ kind: "synthetic-continuous-config" });
const policyDigest = digest("b");
const inventoryDigest = digest("c");
const sourceDigest = digest("d");
const candidates = ["1", "2", "3", "4", "5", "6"].map((suffix) => ({
  slug: `plugin-${suffix}`,
  snapshotDigest: digest(suffix),
  selectionId: `wporg:plugin-${suffix}@1.0.0`,
}));

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function setup(
  options: {
    readonly stopAfterFirstTrial?: boolean;
    readonly failAfterStop?: boolean;
    readonly expiredFirstInventory?: boolean;
    readonly changeConfigAfterPrepare?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "wbh-continuous-runner-"));
  directories.push(directory);
  await writeFile(
    join(directory, "synthetic-config.json"),
    JSON.stringify({ kind: "synthetic-continuous-config" }),
  );
  const journal = new SqliteContinuousRunJournal(
    join(directory, "runs.sqlite"),
    now,
  );
  const owner = new SqliteContinuousRunOwner(join(directory, "owner.sqlite"), {
    clock: now,
  });
  const claims = new SqliteHostResourceClaims(
    join(directory, "claims.sqlite"),
    { maxTargets: 2, providers: { codex: 2 } },
    now,
  );
  const store = new PrivateArtifactStore({
    rootDirectory: join(directory, "evidence"),
    maxEntries: 20,
    maxBytes: 1024 * 1024,
  });
  const records: LedgerRecord[] = [];
  const append = (candidate: LedgerEventInput) => {
    records.push({
      sequence: records.length + 1,
      event: ledgerEventV1Schema.parse(candidate),
    });
  };
  const read = (query: LedgerReadQuery = {}) =>
    records
      .filter(
        ({ sequence, event }) =>
          sequence > (query.afterSequence ?? 0) &&
          (query.campaignId === undefined ||
            event.campaignId === query.campaignId) &&
          (query.type === undefined || event.type === query.type) &&
          (query.findingId === undefined ||
            ("findingId" in event && event.findingId === query.findingId)),
      )
      .slice(0, query.limit ?? 100);
  const ledger = { read } as unknown as Ledger;
  const state: CliState = {
    ledger,
    store,
    evidenceDirectory: join(directory, "evidence"),
    stateDirectory: directory,
    clock: now,
    newId: () => "unused",
  };
  const preparedOrdinals: number[] = [];
  const campaignCalls: string[] = [];
  let stopIssued = false;
  let configChanged = false;
  const refreshedInventoryDigest = digest("f");
  const profile = {
    continuousPolicyDigest: async () => policyDigest,
    prepareContinuousBatch: async (
      _state: CliState,
      input: { readonly parent: ReturnType<typeof journal.get> },
    ) => {
      const child = input.parent?.children.at(-1);
      if (child === undefined) throw new Error("Missing reserved child");
      preparedOrdinals.push(child.ordinal);
      if (
        options.expiredFirstInventory &&
        child.inventoryDigest === inventoryDigest
      )
        return {
          status: "hold" as const,
          reason: "candidate-source-pool-expired" as const,
          selectionPrefixLength: 0,
        };
      const used = new Set(
        records
          .filter(({ event }) => event.type === "target-selected")
          .map(({ event }) =>
            event.type === "target-selected" ? event.selectionId : "",
          ),
      );
      const selected = candidates
        .filter((candidate) => !used.has(candidate.selectionId))
        .slice(0, 3);
      if (selected.length < 3)
        return {
          status: "hold" as const,
          reason: "insufficient-eligible-candidates" as const,
          inspected: candidates.length,
          frozen: 0,
        };
      const selectionBatchId = `selection-${child.ordinal}`;
      const base = (snapshotDigest: string) => ({
        schemaVersion: 1 as const,
        campaignId: child.campaignId,
        snapshotDigest,
        occurredAt: now().toISOString(),
        artifacts: [],
      });
      append({
        ...base(selected[0]!.snapshotDigest),
        identity: `batch-${child.ordinal}`,
        type: "selection-batch-bound",
        selectionBatchId,
        policyDigest,
        selectionIds: selected.map((candidate) => candidate.selectionId),
      });
      selected.forEach((candidate, index) => {
        append({
          ...base(candidate.snapshotDigest),
          identity: `selected-${child.ordinal}-${index}`,
          type: "target-selected",
          selectionId: candidate.selectionId,
        });
        append({
          ...base(candidate.snapshotDigest),
          identity: `frozen-${child.ordinal}-${index}`,
          type: "snapshot-frozen",
          sourceDigest,
        });
      });
      if (options.changeConfigAfterPrepare && !configChanged) {
        configChanged = true;
        await writeFile(
          join(directory, "synthetic-config.json"),
          JSON.stringify({ kind: "changed-config" }),
        );
      }
      return {
        status: "ready" as const,
        selectionBatchId,
        snapshotDigests: selected.map((candidate) => candidate.snapshotDigest),
        reportDigest: digest("e"),
      };
    },
    inspectInventory: async () => ({
      inventoryDigest,
      candidates: candidates.length,
      observedCandidates: candidates.length,
      sourceCoverageVerified: true,
      sourcePoolSealed: true,
      ineligibleByReason: {},
      source: {
        status: "available" as const,
        requestedListingCoverage: "all-observed" as const,
      },
      traversal: {
        offset: 0,
        observedUniqueCandidates: candidates.length,
        complete: true,
        nextPageAvailable: false,
      },
    }),
    collectInventory: async () => {
      if (options.expiredFirstInventory)
        return {
          inventoryDigest: refreshedInventoryDigest,
          candidates: candidates.length,
          observedCandidates: candidates.length,
          sourceCoverageVerified: true,
          sourcePoolSealed: true,
          ineligibleByReason: {},
          source: {
            status: "available" as const,
            requestedListingCoverage: "all-observed" as const,
          },
          traversal: {
            offset: 0,
            observedUniqueCandidates: candidates.length,
            complete: true,
            nextPageAvailable: false,
          },
        };
      throw new Error("A verified exhausted inventory has no next page");
    },
    runCampaign: async (
      _state: CliState,
      input: {
        readonly campaignId: string;
        readonly selectionBatchId?: string;
        readonly snapshotDigests?: readonly string[];
      },
    ): Promise<CampaignSummary> => {
      campaignCalls.push(input.campaignId);
      const child = journal
        .get(parentRunId)
        ?.children.find((entry) => entry.campaignId === input.campaignId);
      if (
        child === undefined ||
        child.binding === null ||
        child.binding.selectionBatchId !== input.selectionBatchId ||
        child.binding.snapshotDigests.join(",") !==
          input.snapshotDigests?.join(",")
      )
        throw new Error("Runner did not dispatch the reserved batch");
      const targets: CampaignSummary["targets"][number][] = [];
      for (const snapshotDigest of input.snapshotDigests ?? []) {
        const candidate = candidates.find(
          (entry) => entry.snapshotDigest === snapshotDigest,
        );
        if (candidate === undefined) throw new Error("Unknown Snapshot");
        const base = {
          schemaVersion: 1 as const,
          campaignId: input.campaignId,
          snapshotDigest,
          occurredAt: now().toISOString(),
          artifacts: [],
        };
        const started = read({
          campaignId: input.campaignId,
          type: "discovery-run-started",
        }).some(({ event }) => event.snapshotDigest === snapshotDigest);
        if (!started) {
          const runId = `trial-${candidate.slug}`;
          append({
            ...base,
            identity: `started-${candidate.slug}`,
            type: "discovery-run-started",
            runId,
            labId: `lab-${candidate.slug}`,
            trialOrdinal: 0,
            history: { mode: "none" },
            configuration: {
              promptVariant: "synthetic",
              assignmentUnit: "target",
            },
          });
          append({
            ...base,
            identity: `finished-${candidate.slug}`,
            type: "discovery-run-finished",
            runId,
            outcome: "completed",
            costUsd: "unavailable",
            wallTimeMs: 1000,
          });
          if (options.failAfterStop && !stopIssued) {
            stopIssued = true;
            journal.requestStop(parentRunId);
            throw new Error("simulated campaign failure after stop");
          }
          if (options.stopAfterFirstTrial && !stopIssued) {
            stopIssued = true;
            journal.requestStop(parentRunId);
            return {
              campaignId: input.campaignId,
              skipped: [],
              stopped: "operator",
              targets,
            };
          }
        }
        if (
          !read({
            campaignId: input.campaignId,
            type: "discovery-concluded",
          }).some(({ event }) => event.snapshotDigest === snapshotDigest)
        )
          append({
            ...base,
            identity: `concluded-${candidate.slug}`,
            type: "discovery-concluded",
            stoppedBy: "max-runs",
          });
        targets.push({
          targetId: `wporg:${candidate.slug}`,
          version: "1.0.0",
          snapshotDigest,
          lab: "ready",
          runCount: started ? 0 : 1,
          stoppedBy: "max-runs",
          verifications: [],
        });
      }
      return { campaignId: input.campaignId, skipped: [], targets };
    },
  } as unknown as CliProfile;
  journal.create({
    parentRunId,
    stateDirectory: directory,
    configDigest,
    policyDigest,
    inventoryDigest,
  });
  const run = () =>
    runContinuousParent({
      parentRunId,
      configPath: join(directory, "synthetic-config.json"),
      configDigest,
      state,
      profile,
      journal,
      owner,
      claims,
      io: { stdout: () => {} },
      stopPollMs: 10,
    });
  return {
    journal,
    owner,
    claims,
    read,
    run,
    preparedOrdinals,
    campaignCalls,
  };
}

describe("continuous parent runner", () => {
  it("preserves a campaign error that races an operator stop", async () => {
    const fixture = await setup({ failAfterStop: true });
    try {
      await expect(fixture.run()).rejects.toThrow(
        "simulated campaign failure after stop",
      );
      expect(fixture.journal.get(parentRunId)).toMatchObject({
        state: "RECOVERING",
        reason: "runner-error",
        stopRequested: true,
      });
    } finally {
      fixture.claims.close();
      fixture.owner.close();
      fixture.journal.close();
    }
  });

  it("refreshes an expired pool on the same unbound child", async () => {
    const fixture = await setup({ expiredFirstInventory: true });
    try {
      const result = await fixture.run();
      expect(result).toMatchObject({
        state: "WAIT_REVIEW",
        reason: "candidate-exhausted",
        inventoryDigest: digest("f"),
      });
      expect(result.children[0]?.inventoryDigest).toBe(digest("f"));
      expect(fixture.read({ type: "discovery-run-started" })).toHaveLength(6);
    } finally {
      fixture.claims.close();
      fixture.owner.close();
      fixture.journal.close();
    }
  });

  it("holds a changed campaign config before binding or starting a Trial", async () => {
    const fixture = await setup({ changeConfigAfterPrepare: true });
    try {
      const result = await fixture.run();
      expect(result).toMatchObject({
        state: "WAIT_REVIEW",
        reason: "config-or-policy-changed",
      });
      expect(result.children).toHaveLength(1);
      expect(result.children[0]?.binding).toBeNull();
      expect(fixture.read({ type: "discovery-run-started" })).toHaveLength(0);
    } finally {
      fixture.claims.close();
      fixture.owner.close();
      fixture.journal.close();
    }
  });

  it("reconciles a recovery hold before dispatching its first child", async () => {
    const fixture = await setup();
    try {
      const created = fixture.journal.get(parentRunId)!;
      fixture.journal.transition(parentRunId, created.revision, {
        state: "RECOVERING",
        reason: "runner-error",
        nextCheckAt: null,
      });
      const result = await fixture.run();
      expect(result).toMatchObject({
        state: "WAIT_REVIEW",
        reason: "candidate-exhausted",
      });
      expect(fixture.read({ type: "discovery-run-started" })).toHaveLength(6);
    } finally {
      fixture.claims.close();
      fixture.owner.close();
      fixture.journal.close();
    }
  });

  it("settles two children then waits for review when the untried inventory is exhausted", async () => {
    const fixture = await setup();
    try {
      const result = await fixture.run();
      expect(result).toMatchObject({
        state: "WAIT_REVIEW",
        reason: "candidate-exhausted",
        stopRequested: false,
      });
      expect(result.children.map((child) => child.status)).toEqual([
        "settled",
        "settled",
        "reserved",
      ]);
      expect(fixture.preparedOrdinals).toEqual([0, 1, 2]);
      expect(fixture.campaignCalls).toEqual(
        result.children.slice(0, 2).map((child) => child.campaignId),
      );
      const selected = fixture.read({ type: "target-selected" });
      const slugs = selected.map(({ event }) =>
        event.type === "target-selected" ? event.selectionId : "",
      );
      expect(slugs).toHaveLength(6);
      expect(new Set(slugs).size).toBe(6);
      expect(fixture.read({ type: "discovery-run-started" })).toHaveLength(6);
    } finally {
      fixture.claims.close();
      fixture.owner.close();
      fixture.journal.close();
    }
  });

  it("resumes the same child after operator stop without starting its finished Trial again", async () => {
    const fixture = await setup({ stopAfterFirstTrial: true });
    try {
      const stopped = await fixture.run();
      expect(stopped).toMatchObject({
        state: "STOPPED",
        stopRequested: true,
      });
      expect(stopped.children).toHaveLength(1);
      expect(stopped.children[0]?.status).toBe("reserved");
      const childId = stopped.children[0]!.campaignId;
      expect(
        fixture.read({
          campaignId: childId,
          type: "discovery-run-started",
        }),
      ).toHaveLength(1);

      const resumed = await fixture.run();
      expect(resumed).toMatchObject({
        state: "WAIT_REVIEW",
        reason: "candidate-exhausted",
      });
      expect(resumed.children[0]).toMatchObject({
        campaignId: childId,
        status: "settled",
      });
      expect(fixture.campaignCalls.slice(0, 2)).toEqual([childId, childId]);
      expect(
        fixture.preparedOrdinals.filter((ordinal) => ordinal === 0),
      ).toEqual([0]);
      const starts = fixture.read({
        campaignId: childId,
        type: "discovery-run-started",
      });
      expect(starts).toHaveLength(3);
      expect(
        starts.filter(
          ({ event }) =>
            event.type === "discovery-run-started" &&
            event.runId === "trial-plugin-1",
        ),
      ).toHaveLength(1);
    } finally {
      fixture.claims.close();
      fixture.owner.close();
      fixture.journal.close();
    }
  });
});
