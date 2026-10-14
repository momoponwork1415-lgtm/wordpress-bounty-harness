import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assessContinuousChildCampaign,
  type ReviewExportCheck,
} from "../../src/discovery/continuous-child-assessment.js";
import {
  ledgerEventV1Schema,
  type Ledger,
  type LedgerEventInput,
  type LedgerRecord,
} from "../../src/ledger/index.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { exportReviewBundle } from "../../src/review/export.js";

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const snapshot = digest("a");
const otherSnapshot = digest("b");
const campaignId = "child-campaign";
const base = (snapshotDigest = snapshot) => ({
  schemaVersion: 1 as const,
  campaignId,
  snapshotDigest,
  occurredAt: "2026-10-14T00:00:00Z",
  artifacts: [],
});

function selected(snapshotDigest = snapshot): LedgerEventInput {
  return {
    ...base(snapshotDigest),
    type: "target-selected",
    identity: `selected-${snapshotDigest}`,
    selectionId: `target-${snapshotDigest}`,
  };
}

function frozen(snapshotDigest = snapshot): LedgerEventInput {
  return {
    ...base(snapshotDigest),
    type: "snapshot-frozen",
    identity: `frozen-${snapshotDigest}`,
    sourceDigest: digest("c"),
  };
}

function started(snapshotDigest = snapshot, runId = "run-1"): LedgerEventInput {
  return {
    ...base(snapshotDigest),
    type: "discovery-run-started",
    identity: `started-${runId}`,
    runId,
    labId: "lab-1",
    history: { mode: "none" },
    configuration: { promptVariant: "synthetic", assignmentUnit: "target" },
  };
}

function finished(
  input: {
    snapshotDigest?: string;
    runId?: string;
    outcome?: "completed" | "failed" | "provider-limited";
    reason?: "provider" | "schema" | "sandbox" | "policy" | "evidence";
    reasonDetail?: string;
    providerLimit?: "quota" | "rate-limit";
  } = {},
): LedgerEventInput {
  const runId = input.runId ?? "run-1";
  return {
    ...base(input.snapshotDigest),
    type: "discovery-run-finished",
    identity: `finished-${runId}`,
    runId,
    outcome: input.outcome ?? "completed",
    costUsd: "unavailable",
    wallTimeMs: 1000,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.reasonDetail === undefined
      ? {}
      : { reasonDetail: input.reasonDetail }),
    ...(input.providerLimit === undefined
      ? {}
      : { providerLimit: input.providerLimit }),
  };
}

function concluded(snapshotDigest = snapshot): LedgerEventInput {
  return {
    ...base(snapshotDigest),
    type: "discovery-concluded",
    identity: `concluded-${snapshotDigest}`,
    stoppedBy: "max-runs",
  };
}

function finding(
  findingId = "finding-1",
  snapshotDigest = snapshot,
): LedgerEventInput {
  return {
    ...base(snapshotDigest),
    type: "finding-recorded",
    identity: `finding-${findingId}`,
    findingId,
    runId: "run-1",
    category: "synthetic",
  };
}

function verification(
  result:
    | {
        readonly status: "incomplete";
        readonly reason: "observation";
        readonly nextStep: string;
      }
    | {
        readonly status: "contradicted";
        readonly judgeId: string;
        readonly evidenceDigest: string;
      },
  verificationId: string,
): LedgerEventInput {
  return {
    ...base(),
    type: "verification-finished",
    identity: `verification-${verificationId}`,
    verificationId,
    findingId: "finding-1",
    labSetupDigest: digest("d"),
    result,
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
            (query.type === undefined || event.type === query.type) &&
            (query.findingId === undefined ||
              ("findingId" in event && event.findingId === query.findingId)),
        )
        .slice(0, query.limit ?? 100);
    },
  };
}

const assess = (
  events: readonly LedgerEventInput[],
  extra: {
    readonly snapshotDigests?: readonly string[];
    readonly reviewExportReady?: ReviewExportCheck;
  } = {},
) =>
  assessContinuousChildCampaign({
    campaignId,
    snapshotDigests: extra.snapshotDigests ?? [snapshot],
    ledger: ledgerFor(events),
    ...(extra.reviewExportReady === undefined
      ? {}
      : { reviewExportReady: extra.reviewExportReady }),
  });

describe("read-only child campaign assessment", () => {
  it("requires a bound Trial and conclusion before claiming a complete target", async () => {
    expect((await assess([])).nextState).toBe("pending");
    const bound = [selected(), frozen(), started(), finished()];
    expect((await assess(bound)).nextState).toBe("unsettled");
    const result = await assess([...bound, concluded()]);
    expect(result.nextState).toBe("complete");
    expect(result.lastLedgerSequence).toBe(5);
    expect(result.progress).toEqual({
      targetsTotal: 1,
      targetsComplete: 1,
      trialsStarted: 1,
      trialsFinished: 1,
      findings: 0,
      verificationCovered: 0,
      verificationComplete: 0,
      verificationIncomplete: 0,
      reviewExportsReady: 0,
    });
  });

  it("never authorizes a replacement Trial for a start without finish", async () => {
    const result = await assess([selected(), frozen(), started()]);
    expect(result.nextState).toBe("unsettled");
    expect(result.reason).toBe("trial-unsettled");
    expect(result.progress.trialsStarted).toBe(1);
    expect(result.progress.trialsFinished).toBe(0);
  });

  it("waits for exact snapshot verification and materializable review export", async () => {
    const trial = [
      selected(),
      frozen(),
      started(),
      finished(),
      concluded(),
      finding(),
    ];
    expect((await assess(trial)).reason).toBe("verification-missing");
    const incomplete = verification(
      { status: "incomplete", reason: "observation", nextStep: "Inspect Lab" },
      "verify-1",
    );
    expect((await assess([...trial, incomplete])).reason).toBe(
      "review-export-unchecked",
    );
    const incompleteReady = await assess([...trial, incomplete], {
      reviewExportReady: () => true,
    });
    expect(incompleteReady.nextState).toBe("complete");
    expect(incompleteReady.progress.verificationIncomplete).toBe(1);
    expect(incompleteReady.progress.verificationComplete).toBe(0);
    const complete = verification(
      {
        status: "contradicted",
        judgeId: "judge-1",
        evidenceDigest: digest("e"),
      },
      "verify-2",
    );
    expect((await assess([...trial, incomplete, complete])).reason).toBe(
      "review-export-unchecked",
    );
    const unavailable = await assess([...trial, incomplete, complete], {
      reviewExportReady: async () => false,
    });
    expect(unavailable.reason).toBe("review-export-unavailable");
    const ready = await assess([...trial, incomplete, complete], {
      reviewExportReady: ({ findingId, snapshotDigest }) =>
        findingId === "finding-1" && snapshotDigest === snapshot,
    });
    expect(ready.nextState).toBe("complete");
    expect(ready.progress.verificationCovered).toBe(1);
    expect(ready.progress.verificationComplete).toBe(1);
    expect(ready.progress.verificationIncomplete).toBe(0);
    expect(ready.progress.reviewExportsReady).toBe(1);
    expect(JSON.stringify(ready)).not.toContain("Inspect Lab");
  });

  it("materializes an incomplete review export and excludes parked Findings", async () => {
    const events: LedgerEventInput[] = [
      selected(),
      frozen(),
      started(),
      finished(),
      concluded(),
      finding(),
      {
        ...base(),
        type: "finding-parked",
        identity: "parked-1",
        findingId: "parked-1",
        runId: "run-1",
        category: "other",
        reason: "outside-programme-boundary",
      },
      verification(
        {
          status: "incomplete",
          reason: "observation",
          nextStep: "Inspect Lab",
        },
        "verify-1",
      ),
    ];
    const evidenceDirectory = join(tmpdir(), "wbh-child-review-export");
    const store = new PrivateArtifactStore({
      rootDirectory: evidenceDirectory,
      maxEntries: 1,
      maxBytes: 1,
    });
    const ledger = ledgerFor(events);
    const exported = await exportReviewBundle({
      ledger: ledger as Ledger,
      store,
      evidenceDirectory,
      campaignId,
      findingId: "finding-1",
      clock: () => new Date("2026-10-14T00:00:00Z"),
    });
    expect(exported.verification?.status).toBe("incomplete");
    expect(exported.verification?.reason).toBe("observation");
    let exportCalls = 0;
    const assessed = await assess(events, {
      reviewExportReady: async ({ findingId }) => {
        exportCalls++;
        return findingId === exported.findingId;
      },
    });
    expect(assessed.nextState).toBe("complete");
    expect(assessed.progress.findings).toBe(1);
    expect(assessed.progress.verificationIncomplete).toBe(1);
    expect(exportCalls).toBe(1);
  });

  it("distinguishes typed quota from explicit policy and ambiguous provider failure", async () => {
    const bound = [selected(), frozen(), started()];
    const quota = await assess([
      ...bound,
      finished({
        outcome: "provider-limited",
        reason: "provider",
        providerLimit: "quota",
      }),
    ]);
    expect(quota.nextState).toBe("wait-quota");
    const policy = await assess([
      ...bound,
      finished({
        outcome: "failed",
        reason: "provider",
        reasonDetail: "cyber_policy",
      }),
    ]);
    expect(policy.nextState).toBe("wait-review");
    expect(policy.reason).toBe("cyber-policy");
    const actualPolicyCode = await assess([
      ...bound,
      finished({
        outcome: "failed",
        reason: "provider",
        reasonDetail: "provider-cyber-policy",
      }),
    ]);
    expect(actualPolicyCode.reason).toBe("cyber-policy");
    const ambiguous = await assess([
      ...bound,
      finished({ outcome: "provider-limited", reason: "provider" }),
    ]);
    expect(ambiguous.nextState).toBe("wait-review");
    expect(ambiguous.reason).toBe("run-failed");
  });

  it("holds a fresh target when another target exhausted the provider", async () => {
    const result = await assess(
      [
        selected(),
        frozen(),
        started(),
        finished({
          outcome: "provider-limited",
          reason: "provider",
          providerLimit: "rate-limit",
        }),
      ],
      { snapshotDigests: [snapshot, otherSnapshot] },
    );
    expect(result.targets.map(({ nextState }) => nextState)).toEqual([
      "wait-quota",
      "pending",
    ]);
    expect(result.nextState).toBe("wait-quota");
  });

  it("holds unknown campaign snapshots and orphan finish records", async () => {
    const valid = [selected(), frozen(), started(), finished(), concluded()];
    expect((await assess([...valid, selected(otherSnapshot)])).reason).toBe(
      "ledger-mismatch",
    );
    expect((await assess([selected(), frozen(), finished()])).reason).toBe(
      "ledger-mismatch",
    );
  });

  it("reports bounded progress and leaves a selected but unstarted target pending", async () => {
    const result = await assess(
      [
        selected(),
        frozen(),
        started(),
        finished(),
        concluded(),
        selected(otherSnapshot),
        frozen(otherSnapshot),
      ],
      { snapshotDigests: [snapshot, otherSnapshot] },
    );
    expect(result.progress.targetsTotal).toBe(2);
    expect(result.progress.targetsComplete).toBe(1);
    expect(result.targets.map(({ nextState }) => nextState)).toEqual([
      "complete",
      "pending",
    ]);
    expect(result.nextState).toBe("pending");
    expect(result.lastLedgerSequence).toBe(7);
  });

  it("keeps failed discovery Lab and export errors as review holds", async () => {
    const lab = await assess([
      selected(),
      frozen(),
      {
        ...base(),
        type: "lab-provisioned",
        identity: "lab-failed",
        labId: "lab-1",
        status: "failed",
        purpose: "discovery",
      },
    ]);
    expect(lab.reason).toBe("lab-failed");
    const trial = [
      selected(),
      frozen(),
      started(),
      finished(),
      concluded(),
      finding(),
      verification(
        {
          status: "contradicted",
          judgeId: "judge-1",
          evidenceDigest: digest("e"),
        },
        "verify-1",
      ),
    ];
    const failedExport = await assess(trial, {
      reviewExportReady: () => {
        throw new Error("Private Evidence unavailable");
      },
    });
    expect(failedExport.reason).toBe("review-export-unavailable");
  });

  it("rejects duplicate or unbounded target bindings", async () => {
    await expect(
      assessContinuousChildCampaign({
        campaignId,
        snapshotDigests: [snapshot, snapshot],
        ledger: ledgerFor([]),
      }),
    ).rejects.toThrow("Invalid bound target snapshot digests");
    await expect(
      assessContinuousChildCampaign({
        campaignId,
        snapshotDigests: Array.from({ length: 6 }, (_, index) =>
          digest(String(index)),
        ),
        ledger: ledgerFor([]),
      }),
    ).rejects.toThrow("Invalid bound target snapshot digests");
  });
});
