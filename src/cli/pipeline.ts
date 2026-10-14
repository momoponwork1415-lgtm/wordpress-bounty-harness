import type { CampaignInputV1, PlannedTrial } from "../discovery/index.js";
import { runDiscoveryCampaign } from "../discovery/index.js";
import {
  canonicalDigest,
  canonicalJson,
} from "../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import type {
  LabHandle,
  LabProvisioner,
  LabReachability,
} from "../lab/index.js";
import type {
  Ledger,
  LedgerEventV1,
  LedgerReadQuery,
  LedgerRecord,
} from "../ledger/index.js";
import type { TargetSelection } from "../selection/index.js";
import type { Snapshot } from "../snapshot/index.js";
import type {
  VerifiableFinding,
  Verification,
  VerificationResultV1,
} from "../verification/index.js";

type DiscoveryOptions = Parameters<typeof runDiscoveryCampaign>[0];

/** Everything a campaign needs, built by a profile composition from public interfaces. */
export interface CampaignPipeline<
  Target extends TargetSelection,
  Setup,
  Handle extends LabHandle,
  Finding extends VerifiableFinding,
  Reconstruction,
> {
  readonly select: () => Promise<readonly Target[]>;
  readonly freeze: (target: Target) => Promise<Snapshot>;
  readonly lab: LabProvisioner<Setup, Handle>;
  readonly setupFor: (snapshot: Snapshot) => Setup;
  readonly discovery: (input: {
    readonly target: Target;
    readonly snapshot: Snapshot;
    readonly lab: Handle;
  }) => Promise<{
    readonly input: CampaignInputV1;
    readonly plannedTrials: readonly PlannedTrial[];
    readonly beforeTrialStart?: DiscoveryOptions["beforeTrialStart"];
    readonly historyFraction: number;
    readonly ablation?: NonNullable<DiscoveryOptions["ablation"]>;
    readonly concurrency?: number;
    readonly runWallTimeMs?: number;
    readonly executor: DiscoveryOptions["executor"];
    readonly attachments: DiscoveryOptions["attachments"];
    readonly admitFinding: DiscoveryOptions["admitFinding"];
    readonly isProgrammeImpact?: NonNullable<
      DiscoveryOptions["isProgrammeImpact"]
    >;
    readonly normalizeCandidate?: NonNullable<
      DiscoveryOptions["normalizeCandidate"]
    >;
    readonly classifyCandidate?: NonNullable<
      DiscoveryOptions["classifyCandidate"]
    >;
    readonly admitLead?: NonNullable<DiscoveryOptions["admitLead"]>;
    readonly leadSignature?: NonNullable<DiscoveryOptions["leadSignature"]>;
  }>;
  readonly verification: Verification<Finding, Setup, Handle, Reconstruction>;
  readonly reconstructionFor: (snapshot: Snapshot) => Reconstruction;
}

type SkipStage = "freeze" | "discovery" | "verification";
type FinishedVerification = Extract<
  LedgerEventV1,
  { type: "verification-finished" }
>;
type IncompleteReason = Extract<
  VerificationResultV1,
  { status: "incomplete" }
>["reason"];

function readAll(
  ledger: Ledger,
  query: Omit<LedgerReadQuery, "limit" | "afterSequence">,
): LedgerRecord[] {
  const records: LedgerRecord[] = [];
  let afterSequence = 0;
  for (;;) {
    const page = ledger.read({ ...query, afterSequence, limit: 1000 });
    records.push(...page);
    if (page.length < 1000) return records;
    afterSequence = page[page.length - 1]!.sequence;
  }
}

/** ADR 0022: counts include the attempt that produced the current reason. */
export function shouldAutomaticallyRetryVerification(input: {
  readonly reason: IncompleteReason;
  readonly attemptsForReason: number;
  readonly sameLabSetup: boolean;
  /** null is a recorded default scenario; undefined means no scenario record. */
  readonly previousScenarioId?: string | null | undefined;
  readonly currentScenarioId?: string | null | undefined;
}): boolean {
  switch (input.reason) {
    case "recipe":
    case "observation":
      return input.sameLabSetup && input.attemptsForReason < 3;
    case "provision":
      return input.sameLabSetup && input.attemptsForReason < 2;
    case "precondition":
      return (
        input.previousScenarioId !== undefined &&
        input.currentScenarioId !== undefined &&
        input.previousScenarioId !== input.currentScenarioId
      );
    default:
      return false;
  }
}

export type CampaignSummary = {
  readonly campaignId: string;
  /** Targets left behind by an error; the next target still runs. */
  readonly skipped: readonly {
    readonly targetId: string;
    readonly version: string;
    readonly stage: SkipStage;
    readonly message: string;
  }[];
  /** Set when the campaign stopped early and can be resumed with the same id. */
  readonly stopped?: "provider-limit" | "incomplete" | "operator";
  readonly targets: readonly {
    readonly targetId: string;
    readonly version: string;
    readonly snapshotDigest: string;
    readonly lab: "ready" | "failed";
    readonly runCount: number;
    readonly stoppedBy: string;
    readonly verifications: readonly {
      readonly findingId: string;
      readonly status: VerificationResultV1["status"];
    }[];
  }[];
};

/** Wiring only: each step is a module's public interface; rules stay in the modules. */
export async function runCampaignPipeline<
  Target extends TargetSelection,
  Setup,
  Handle extends LabHandle,
  Finding extends VerifiableFinding,
  Reconstruction,
>(options: {
  readonly campaignId: string;
  readonly ledger: Ledger;
  readonly store: PrivateArtifactStore;
  readonly pipeline: CampaignPipeline<
    Target,
    Setup,
    Handle,
    Finding,
    Reconstruction
  >;
  readonly clock: () => Date;
  readonly newId: () => string;
  /** Keep profile resource observations isolated for each concurrent target. */
  readonly withTargetScope?: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Optional profile-owned admission and claim before an expensive Lab starts. */
  readonly beforeLab?: (input: {
    readonly target: Target;
    readonly snapshot: Snapshot;
    /** Cancel targets still waiting for a host slot after campaign stop. */
    readonly signal: AbortSignal;
  }) =>
    | void
    | {
        readonly finish: (
          state: "clean" | "recovery-needed",
        ) => "clean" | "recovery-needed" | Promise<"clean" | "recovery-needed">;
      }
    | Promise<void | {
        readonly finish: (
          state: "clean" | "recovery-needed",
        ) => "clean" | "recovery-needed" | Promise<"clean" | "recovery-needed">;
      }>;
  /** Targets in flight at once; discovery run concurrency remains per target. */
  readonly maxConcurrentTargets?: number;
  /** An explicit operator retry after repairing the Verifier protocol. */
  readonly retryIncompleteVerifications?: boolean;
  /** Disable ADR 0022 automatic retries to restore the prior single-attempt behavior. */
  readonly automaticVerificationRetries?: boolean;
  /** Stop new targets while allowing a Trial already past Lab admission to drain. */
  readonly stopSignal?: AbortSignal;
}): Promise<CampaignSummary> {
  const { campaignId, ledger, pipeline, clock } = options;
  const at = () => clock().toISOString();
  const append = async (event: Parameters<Ledger["append"]>[0]) => {
    if ((await ledger.append(event)).status === "conflict")
      throw new Error(`Ledger conflict: ${event.identity}`);
  };
  // Selection and freeze records are keyed by campaign and snapshot; a resumed run keeps the first.
  const appendOnce = async (event: Parameters<Ledger["append"]>[0]) => {
    await ledger.append(event);
  };
  const maxConcurrentTargets = options.maxConcurrentTargets ?? 1;
  if (!Number.isSafeInteger(maxConcurrentTargets) || maxConcurrentTargets < 1)
    throw new Error("Invalid target concurrency");
  type TargetSummary = CampaignSummary["targets"][number];
  type SkippedSummary = CampaignSummary["skipped"][number];
  type TargetResult = {
    target?: TargetSummary;
    skipped?: SkippedSummary;
  };
  let stopped: CampaignSummary["stopped"];
  const stopController = new AbortController();
  const requestStop = (reason: NonNullable<CampaignSummary["stopped"]>) => {
    if (reason === "provider-limit" || stopped === undefined) stopped = reason;
    if (!stopController.signal.aborted)
      stopController.abort(new Error(`Campaign stopped: ${reason}`));
  };

  const selectedSnapshots = new Map<string, string>();
  for (const { event } of readAll(ledger, {
    campaignId,
    type: "target-selected",
  }))
    if (event.type === "target-selected")
      selectedSnapshots.set(event.selectionId, event.snapshotDigest);
  const concludedSnapshots = new Set(
    readAll(ledger, { campaignId, type: "discovery-concluded" }).map(
      ({ event }) => event.snapshotDigest,
    ),
  );
  const findingsBySnapshot = new Map<string, string[]>();
  for (const { event } of readAll(ledger, {
    campaignId,
    type: "finding-recorded",
  })) {
    if (event.type !== "finding-recorded") continue;
    const findings = findingsBySnapshot.get(event.snapshotDigest) ?? [];
    findings.push(event.findingId);
    findingsBySnapshot.set(event.snapshotDigest, findings);
  }
  const latestVerification = new Map<string, VerificationResultV1["status"]>();
  for (const { event } of readAll(ledger, {
    campaignId,
    type: "verification-finished",
  }))
    if (event.type === "verification-finished" && event.basis === undefined)
      latestVerification.set(
        `${event.snapshotDigest}\0${event.findingId}`,
        event.result.status,
      );
  const isCompleted = (target: Target): boolean => {
    const snapshotDigest = selectedSnapshots.get(
      `${target.targetId}@${target.version}`,
    );
    if (snapshotDigest === undefined || !concludedSnapshots.has(snapshotDigest))
      return false;
    return (findingsBySnapshot.get(snapshotDigest) ?? []).every((findingId) => {
      const status = latestVerification.get(`${snapshotDigest}\0${findingId}`);
      return status !== undefined && status !== "incomplete";
    });
  };

  const isSnapshotCompleteNow = (digest: string): boolean => {
    const concluded = readAll(ledger, {
      campaignId,
      type: "discovery-concluded",
    }).some(({ event }) => event.snapshotDigest === digest);
    if (!concluded) return false;
    const findingIds = readAll(ledger, {
      campaignId,
      type: "finding-recorded",
    }).flatMap(({ event }) =>
      event.type === "finding-recorded" && event.snapshotDigest === digest
        ? [event.findingId]
        : [],
    );
    const latest = new Map<string, VerificationResultV1["status"]>();
    for (const { event } of readAll(ledger, {
      campaignId,
      type: "verification-finished",
    }))
      if (
        event.type === "verification-finished" &&
        event.basis === undefined &&
        event.snapshotDigest === digest
      )
        latest.set(event.findingId, event.result.status);
    return findingIds.every((findingId) => {
      const status = latest.get(findingId);
      return status !== undefined && status !== "incomplete";
    });
  };

  const processTarget = async (target: Target): Promise<TargetResult> => {
    const selectionId = `${target.targetId}@${target.version}`;
    let stage: SkipStage = "freeze";
    // Before a snapshot exists, the selection record stands in for its digest.
    let snapshotDigest = canonicalDigest(target);
    let handle: Handle | undefined;
    let permit:
      | {
          readonly finish: (
            state: "clean" | "recovery-needed",
          ) =>
            "clean" | "recovery-needed" | Promise<"clean" | "recovery-needed">;
        }
      | undefined;
    let labAttempted = false;
    let labProvisionSettled = false;
    let result: TargetResult = {};
    const skip = async (error: unknown): Promise<void> => {
      // The failure text may hold paths; it goes to the operator, not the ledger.
      await append({
        schemaVersion: 1,
        campaignId,
        snapshotDigest,
        identity: `target-skipped-${options.newId()}`,
        occurredAt: at(),
        type: "target-skipped",
        selectionId,
        stage,
      });
      delete result.target;
      result.skipped = {
        targetId: target.targetId,
        version: target.version,
        stage,
        message: error instanceof Error ? error.message : String(error),
      };
    };
    const run = async (): Promise<void> => {
      const snapshot = await pipeline.freeze(target);
      snapshotDigest = snapshot.digest;
      stage = "discovery";
      stopController.signal.throwIfAborted();
      permit =
        (await options.beforeLab?.({
          target,
          snapshot,
          signal: stopController.signal,
        })) ?? undefined;
      if (stopController.signal.aborted) return;
      if (isSnapshotCompleteNow(snapshot.digest)) return;
      const base = {
        schemaVersion: 1 as const,
        campaignId,
        snapshotDigest: snapshot.digest,
      };
      await appendOnce({
        ...base,
        identity: `target-selected-${campaignId}-${snapshot.digest}`,
        occurredAt: target.selectedAt,
        type: "target-selected",
        selectionId,
        // The full selection record (install counts, score) stays in Private Evidence.
        artifacts: [
          {
            kind: "target-selection",
            digest: await options.store.putFiles({
              "target-selection.json": canonicalJson(target),
            }),
          },
        ],
      });
      await appendOnce({
        ...base,
        identity: `snapshot-frozen-${campaignId}-${snapshot.digest}`,
        occurredAt: at(),
        type: "snapshot-frozen",
        sourceDigest: snapshot.target.sourceDigest,
        dependencyDigests: snapshot.dependencies.map(
          (dependency) => dependency.sourceDigest,
        ),
      });

      stage = "discovery";
      const setup = pipeline.setupFor(snapshot);
      labAttempted = true;
      const provisioned = await pipeline.lab.provision(snapshot, setup);
      labProvisionSettled = true;
      if (provisioned.status === "ready") handle = provisioned.handle;
      const seeded =
        provisioned.status === "ready"
          ? await pipeline.lab.seedCanaries(provisioned.handle)
          : null;
      const labId =
        provisioned.status === "ready"
          ? provisioned.handle.id
          : options.newId();
      const reachability =
        provisioned.status === "ready" &&
        seeded?.status === "seeded" &&
        pipeline.lab.probe !== undefined
          ? await pipeline.lab
              .probe(provisioned.handle)
              .catch((): LabReachability => ({
                http: "failed",
                database: "failed",
              }))
          : undefined;
      const ready =
        provisioned.status === "ready" &&
        seeded?.status === "seeded" &&
        reachability?.http !== "failed";
      const failure =
        provisioned.status === "incomplete"
          ? { failureStage: "provision" as const, reason: provisioned.reason }
          : seeded?.status === "incomplete"
            ? { failureStage: "seed" as const, reason: seeded.reason }
            : reachability?.http === "failed"
              ? {
                  failureStage: "probe" as const,
                  reason: "reachability" as const,
                }
              : undefined;
      const diagnostic =
        provisioned.status === "incomplete"
          ? provisioned.diagnostic
          : seeded?.status === "incomplete"
            ? seeded.diagnostic
            : undefined;
      await append({
        ...base,
        identity: `lab-provisioned-${labId}`,
        occurredAt: at(),
        type: "lab-provisioned",
        labId,
        status: ready ? "ready" : "failed",
        purpose: "discovery",
        ...(provisioned.status !== "ready" ||
        provisioned.handle.scenario === undefined
          ? {}
          : { scenario: provisioned.handle.scenario }),
        ...(reachability === undefined ? {} : { reachability }),
        ...(failure === undefined ? {} : failure),
        ...(diagnostic === undefined
          ? {}
          : {
              artifacts: [
                {
                  kind: "lab-diagnostic",
                  digest: await options.store.putFiles({
                    "stderr.txt": diagnostic,
                  }),
                },
              ],
            }),
      });
      if (!ready || provisioned.status !== "ready") {
        result.target = {
          targetId: target.targetId,
          version: target.version,
          snapshotDigest: snapshot.digest,
          lab: "failed",
          runCount: 0,
          stoppedBy:
            provisioned.status === "incomplete" &&
            provisioned.reason === "precondition"
              ? "incomplete(precondition)"
              : "setup-failed",
          verifications: [],
        };
        return;
      }

      // Admission ended before a Trial start: drain this Lab and leave the
      // selected target pending for the same child campaign on resume.
      if (stopController.signal.aborted) return;
      const prepared = await pipeline.discovery({
        target,
        snapshot,
        lab: provisioned.handle,
      });
      if (stopController.signal.aborted) return;
      const campaignInput = prepared.input;
      const discovered = await runDiscoveryCampaign({
        campaignId,
        labId,
        ledger,
        evidence: options.store,
        clock,
        ...prepared,
      });
      const summary = {
        targetId: target.targetId,
        version: target.version,
        snapshotDigest: snapshot.digest,
        lab: "ready" as const,
        runCount: discovered.runCount,
        stoppedBy: discovered.stoppedBy,
      };
      // The Verifier draws on the same subscription, so this target does not
      // start verification after a new provider stop. Other in-flight targets finish.
      if (
        discovered.stoppedBy === "provider-limit" &&
        discovered.runCount > 0
      ) {
        requestStop(discovered.stoppedBy);
        await append({
          ...base,
          identity: `campaign-stopped-${options.newId()}`,
          occurredAt: at(),
          type: "campaign-stopped",
          reason: discovered.stoppedBy,
        });
        result.target = { ...summary, verifications: [] };
        return;
      }
      stage = "verification";
      const earlier = readAll(ledger, {
        campaignId,
        type: "verification-finished",
      });
      const labs = readAll(ledger, { campaignId, type: "lab-provisioned" });
      const scenarioFor = (previous: {
        sequence: number;
        event: FinishedVerification;
      }): string | null | undefined => {
        const verificationLab = labs.find(
          ({ event }) =>
            event.identity ===
            `verification-lab-${previous.event.verificationId}`,
        );
        if (verificationLab?.event.type === "lab-provisioned")
          return verificationLab.event.scenario?.id ?? null;
        // A precondition can fail before a verification Lab exists. Its
        // discovery Lab records the selected scenario before that attempt.
        const discoveryLab = labs
          .filter(
            ({ sequence, event }) =>
              sequence < previous.sequence &&
              event.type === "lab-provisioned" &&
              event.snapshotDigest === snapshot.digest &&
              event.purpose === "discovery",
          )
          .at(-1);
        return discoveryLab?.event.type === "lab-provisioned"
          ? (discoveryLab.event.scenario?.id ?? null)
          : undefined;
      };
      const verifications: {
        findingId: string;
        status: VerificationResultV1["status"];
      }[] = [];
      const findings = readAll(ledger, {
        campaignId,
        type: "finding-recorded",
      }).filter(({ event }) => event.snapshotDigest === snapshot.digest);
      for (const { event } of findings) {
        if (event.type !== "finding-recorded") continue;
        const history = earlier.filter(
          (
            record,
          ): record is { sequence: number; event: FinishedVerification } =>
            record.event.type === "verification-finished" &&
            record.event.basis === undefined &&
            record.event.snapshotDigest === snapshot.digest &&
            record.event.findingId === event.findingId,
        );
        const shouldRetry = (allowManualOverride: boolean): boolean => {
          const previous = history.at(-1);
          if (previous === undefined) return true;
          if (previous.event.result.status !== "incomplete") return false;
          if (options.automaticVerificationRetries === false)
            return (
              previous.event.labSetupDigest !== campaignInput.lab.setupDigest ||
              options.retryIncompleteVerifications === true
            );
          if (
            allowManualOverride &&
            options.retryIncompleteVerifications === true
          )
            return true;
          if (
            previous.event.promptVersion === undefined ||
            previous.event.promptVersion !== pipeline.verification.promptVersion
          )
            return false;
          const reason = previous.event.result.reason;
          const attemptsForReason = history.filter(({ event: prior }) => {
            if (
              prior.labSetupDigest !== campaignInput.lab.setupDigest ||
              prior.promptVersion !== previous.event.promptVersion ||
              prior.result.status !== "incomplete"
            )
              return false;
            return prior.result.reason === reason;
          }).length;
          return shouldAutomaticallyRetryVerification({
            reason,
            attemptsForReason,
            sameLabSetup:
              previous.event.labSetupDigest === campaignInput.lab.setupDigest,
            previousScenarioId: scenarioFor(previous),
            currentScenarioId: handle?.scenario?.id ?? null,
          });
        };
        if (!shouldRetry(true)) continue;
        do {
          const previous = history.at(-1)?.event;
          const verificationId = options.newId();
          const result = await pipeline.verification.verify({
            campaignId,
            findingId: event.findingId,
            verificationId,
            attempt: Math.max(history.length + 1, (previous?.attempt ?? 0) + 1),
            ...(previous === undefined
              ? {}
              : { retryOf: previous.verificationId }),
            snapshot,
            setup,
            campaignLabSetupDigest: campaignInput.lab.setupDigest,
            reconstruction: pipeline.reconstructionFor(snapshot),
          });
          const recorded = readAll(ledger, {
            campaignId,
            findingId: event.findingId,
            type: "verification-finished",
          }).at(-1);
          if (
            recorded?.event.type !== "verification-finished" ||
            recorded.event.verificationId !== verificationId
          )
            throw new Error("Verification result was not recorded");
          history.push({ sequence: recorded.sequence, event: recorded.event });
          verifications.push({
            findingId: event.findingId,
            status: result.status,
          });
          if (options.automaticVerificationRetries === false) break;
          // The operator override applies to the first attempt only.
          if (
            result.status !== "incomplete" ||
            result.reason === "precondition" ||
            !shouldRetry(false)
          )
            break;
        } while (true);
      }
      result.target = { ...summary, verifications };
      if (
        discovered.stoppedBy === "incomplete" ||
        discovered.stoppedBy === "provider-limit"
      ) {
        // A resumed target has already spent its one Trial. Keep its typed
        // failure and verify any captured child findings, then move on.
        if (discovered.runCount === 0) return;
        requestStop(discovered.stoppedBy);
        await append({
          ...base,
          identity: `campaign-stopped-${options.newId()}`,
          occurredAt: at(),
          type: "campaign-stopped",
          reason: discovered.stoppedBy,
        });
      }
    };
    try {
      await run();
    } catch (error: unknown) {
      if (
        error !== stopController.signal.reason ||
        stopped !== "operator" ||
        labAttempted
      )
        await skip(error);
    } finally {
      // An incomplete provision result means the adapter finished its own
      // cleanup. A thrown provision has no such guarantee.
      let clean =
        !labAttempted || (labProvisionSettled && handle === undefined);
      try {
        if (handle !== undefined) {
          const removed = await pipeline.lab.teardown(handle).catch(() => null);
          clean = removed?.status === "removed";
          if (!clean && result.skipped === undefined)
            await skip(
              new Error(
                removed?.status === "incomplete"
                  ? removed.nextStep
                  : "Inspect and remove remaining Lab resources before retry",
              ),
            );
        }
      } finally {
        const outcome =
          (await permit?.finish(clean ? "clean" : "recovery-needed")) ??
          (clean ? "clean" : "recovery-needed");
        if (outcome === "recovery-needed") requestStop("incomplete");
      }
    }
    return result;
  };

  const onOperatorStop = () => requestStop("operator");
  if (options.stopSignal?.aborted) onOperatorStop();
  else
    options.stopSignal?.addEventListener("abort", onOperatorStop, {
      once: true,
    });
  try {
    const selected = (await pipeline.select()).filter(
      (target) => !isCompleted(target),
    );
    const results: (TargetResult | undefined)[] = Array(selected.length);
    let next = 0;
    const worker = async () => {
      while (stopped === undefined) {
        const index = next++;
        const target = selected[index];
        if (target === undefined) return;
        results[index] =
          options.withTargetScope === undefined
            ? await processTarget(target)
            : await options.withTargetScope(() => processTarget(target));
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(maxConcurrentTargets, selected.length) },
        worker,
      ),
    );
    const targets = results.flatMap((result) =>
      result?.target === undefined ? [] : [result.target],
    );
    const skipped = results.flatMap((result) =>
      result?.skipped === undefined ? [] : [result.skipped],
    );
    return {
      campaignId,
      targets,
      skipped,
      ...(stopped === undefined ? {} : { stopped }),
    };
  } finally {
    options.stopSignal?.removeEventListener("abort", onOperatorStop);
  }
}

export type ReverificationSummary = {
  readonly targetId: string;
  readonly version: string;
  readonly snapshotDigest: string;
  readonly findingId: string;
  readonly verificationId: string;
  readonly status: VerificationResultV1["status"];
};

/**
 * Freezes the selected version. A new Snapshot gets a derived Finding; an
 * unconfirmed Finding can be retried only on its original Snapshot.
 */
export async function reverifyOnSelectedVersion<
  Target extends TargetSelection,
  Setup extends {
    readonly scenario?:
      { readonly id: string; readonly digest: string } | undefined;
  },
  Handle extends LabHandle,
  Finding extends VerifiableFinding,
  Reconstruction,
>(options: {
  readonly campaignId: string;
  readonly findingId: string;
  /** A separate read-only campaign may supply an already confirmed route. */
  readonly referenceCampaignId?: string;
  /** Reuse a separately recorded, immutable Snapshot for a real Lab smoke. */
  readonly snapshotCampaignId?: string;
  readonly version?: string;
  readonly ledger: Ledger;
  readonly store: PrivateArtifactStore;
  readonly pipeline: Pick<
    CampaignPipeline<Target, Setup, Handle, Finding, Reconstruction>,
    "freeze" | "setupFor" | "verification" | "reconstructionFor"
  > & {
    /** The current or explicitly pinned version of the same target. */
    readonly selectVersion: (input: {
      readonly selectionId: string;
      readonly version?: string;
    }) => Promise<Target | null>;
    readonly loadSnapshot?: (digest: string) => Promise<Snapshot>;
    readonly deriveFinding: (input: {
      readonly original: unknown;
      readonly snapshotDigest: string;
      readonly runId: string;
    }) => { readonly finding: Finding; readonly category: string };
  };
  readonly clock: () => Date;
  readonly newId: () => string;
}): Promise<ReverificationSummary> {
  const { campaignId, findingId, ledger, pipeline } = options;
  const finding = ledger
    .read({ campaignId, findingId, type: "finding-recorded", limit: 1 })
    .at(0)?.event;
  if (finding?.type !== "finding-recorded")
    throw new Error("The finding is not recorded in this campaign");
  const selected = ledger
    .read({ campaignId, type: "target-selected", limit: 1000 })
    .map(({ event }) => event)
    .find(
      (event) =>
        event.type === "target-selected" &&
        event.snapshotDigest === finding.snapshotDigest,
    );
  if (selected?.type !== "target-selected")
    throw new Error("The finding's target selection is not recorded");
  const referenceCampaignId = options.referenceCampaignId ?? campaignId;
  if (referenceCampaignId !== campaignId) {
    const referenceFinding = ledger
      .read({
        campaignId: referenceCampaignId,
        findingId,
        type: "finding-recorded",
        limit: 1,
      })
      .at(0)?.event;
    if (
      referenceFinding?.type !== "finding-recorded" ||
      referenceFinding.snapshotDigest !== finding.snapshotDigest ||
      referenceFinding.artifacts.find((artifact) => artifact.kind === "finding")
        ?.digest !==
        finding.artifacts.find((artifact) => artifact.kind === "finding")
          ?.digest
    )
      throw new Error("The reference route belongs to a different Finding");
  }
  const observed = ledger
    .read({
      campaignId: referenceCampaignId,
      findingId,
      type: "verification-finished",
      limit: 1000,
    })
    .map(({ event }) => event)
    .filter(
      (event) =>
        event.type === "verification-finished" &&
        event.snapshotDigest === finding.snapshotDigest &&
        (event.result.status === "runtime-confirmed" ||
          event.result.status === "reproduced"),
    )
    .at(-1);
  if (observed === undefined && options.snapshotCampaignId !== undefined)
    throw new Error("A confirmed route is required for pinned smoke replay");
  let referenceRoute: unknown;
  let hasCapturedRouteBinding = false;
  if (
    observed?.type === "verification-finished" &&
    (observed.result.status === "runtime-confirmed" ||
      observed.result.status === "reproduced")
  ) {
    const routeFile = await options.store.readFile(
      observed.result.evidenceDigest,
      observed.result.status === "runtime-confirmed"
        ? "confirmed-route.json"
        : "reproduced-route.json",
      64 * 1024,
    );
    if (routeFile.status !== "resolved")
      throw new Error("The observed route is unavailable in Private Evidence");
    const route = JSON.parse(routeFile.bytes.toString("utf8")) as unknown;
    if (observed.result.status === "runtime-confirmed") {
      const observationFile = await options.store.readFile(
        observed.result.evidenceDigest,
        "canary-observation.json",
        64 * 1024,
      );
      if (observationFile.status === "resolved") {
        try {
          const observation = JSON.parse(
            observationFile.bytes.toString("utf8"),
          ) as unknown;
          if (
            route !== null &&
            typeof route === "object" &&
            !Array.isArray(route) &&
            observation !== null &&
            typeof observation === "object" &&
            !Array.isArray(observation) &&
            "capturedRoute" in route &&
            route.capturedRoute !== null &&
            "capturedRouteDigest" in observation &&
            typeof observation.capturedRouteDigest === "string"
          )
            hasCapturedRouteBinding =
              canonicalDigest(route.capturedRoute) ===
              observation.capturedRouteDigest;
        } catch {
          // Older evidence has no Harness-bound route; only a fresh confirmation
          // can supply a reliable baseline for a fixed-version comparison.
        }
      }
    }
    // A bound route whose binding cannot be verified is demoted to an unbound
    // one. Routes that never carried a binding (reproduced, smoke) are kept as is.
    referenceRoute =
      !hasCapturedRouteBinding &&
      route !== null &&
      typeof route === "object" &&
      !Array.isArray(route) &&
      "capturedRoute" in route
        ? { ...route, capturedRoute: null }
        : route;
  }
  let originalVersion: string | undefined;
  if (
    options.snapshotCampaignId !== undefined &&
    options.version === undefined
  ) {
    const frozen = ledger
      .read({
        campaignId: options.snapshotCampaignId,
        type: "snapshot-frozen",
        limit: 1000,
      })
      .some(
        ({ event }) =>
          event.type === "snapshot-frozen" &&
          event.snapshotDigest === finding.snapshotDigest,
      );
    if (!frozen || pipeline.loadSnapshot === undefined)
      throw new Error("The original pinned Snapshot is unavailable");
    originalVersion = (await pipeline.loadSnapshot(finding.snapshotDigest))
      .target.version;
  }
  const requestedVersion = options.version ?? originalVersion;
  const target = await pipeline.selectVersion({
    selectionId: selected.selectionId,
    ...(requestedVersion === undefined ? {} : { version: requestedVersion }),
  });
  if (target === null)
    throw new Error("The selected target version is not available now");
  let snapshot: Snapshot;
  if (options.snapshotCampaignId === undefined) {
    snapshot = await pipeline.freeze(target);
  } else {
    const recordedSelection = ledger
      .read({
        campaignId: options.snapshotCampaignId,
        type: "target-selected",
        limit: 1000,
      })
      .map(({ event }) => event)
      .find(
        (event) =>
          event.type === "target-selected" &&
          event.selectionId === `${target.targetId}@${target.version}`,
      );
    if (recordedSelection?.type !== "target-selected")
      throw new Error("The pinned reference Snapshot is not recorded");
    const frozen = ledger
      .read({
        campaignId: options.snapshotCampaignId,
        type: "snapshot-frozen",
        limit: 1000,
      })
      .some(
        ({ event }) =>
          event.type === "snapshot-frozen" &&
          event.snapshotDigest === recordedSelection.snapshotDigest,
      );
    if (!frozen || pipeline.loadSnapshot === undefined)
      throw new Error("The pinned reference Snapshot is unavailable");
    snapshot = await pipeline.loadSnapshot(recordedSelection.snapshotDigest);
    if (
      snapshot.digest !== recordedSelection.snapshotDigest ||
      snapshot.target.identity !== target.targetId ||
      snapshot.target.version !== target.version
    )
      throw new Error(
        "The pinned reference Snapshot does not match the target",
      );
  }
  const originalSnapshot = snapshot.digest === finding.snapshotDigest;
  // An unconfirmed Finding may be rechecked on its own Snapshot (also when the
  // version is spelled out); any other Snapshot needs an evidence-backed route.
  if (observed === undefined && !originalSnapshot)
    throw new Error(
      options.version === undefined
        ? "An unconfirmed Finding can only be retried on its original Snapshot"
        : "An evidence-backed route is required for fixed-version comparison",
    );
  const setup = pipeline.setupFor(snapshot);
  if (observed === undefined) {
    const previous = ledger
      .read({
        campaignId,
        findingId,
        type: "verification-finished",
        limit: 1000,
      })
      .map(({ event }) => event)
      .filter(
        (event) =>
          event.type === "verification-finished" &&
          event.snapshotDigest === finding.snapshotDigest,
      )
      .at(-1);
    if (
      previous?.type !== "verification-finished" ||
      previous.result.status !== "incomplete" ||
      previous.result.reason !== "precondition"
    )
      throw new Error(
        "A prior incomplete(precondition) verification is required for scenario retry",
      );
    const previousLab = ledger
      .read({ campaignId, type: "lab-provisioned", limit: 1000 })
      .map(({ event }) => event)
      .find(
        (event) =>
          event.type === "lab-provisioned" &&
          event.identity === `verification-lab-${previous.verificationId}`,
      );
    if (previousLab?.type !== "lab-provisioned")
      throw new Error(
        "A prior verification Lab is required for scenario retry",
      );
    if (
      setup.scenario === undefined ||
      setup.scenario.id === previousLab.scenario?.id
    )
      throw new Error(
        "An unconfirmed Finding requires a different Lab scenario for retry",
      );
  }
  if (
    observed?.type === "verification-finished" &&
    options.version !== undefined
  ) {
    const observedLab = ledger
      .read({
        campaignId: referenceCampaignId,
        type: "lab-provisioned",
        limit: 1000,
      })
      .map(({ event }) => event)
      .find(
        (event) =>
          event.type === "lab-provisioned" &&
          event.identity === `verification-lab-${observed.verificationId}`,
      );
    const sameScenario =
      observedLab?.type === "lab-provisioned" &&
      (setup.scenario === undefined
        ? observedLab.scenario === undefined
        : setup.scenario.id === observedLab.scenario?.id &&
          setup.scenario.digest === observedLab.scenario.digest);
    if (
      originalSnapshot &&
      (observedLab?.type !== "lab-provisioned" ||
        (setup.scenario === undefined && hasCapturedRouteBinding) ||
        (sameScenario && hasCapturedRouteBinding))
    )
      throw new Error(
        "A fixed-version control requires a different Snapshot from the original Finding, or a changed Lab scenario for same-Snapshot recheck",
      );
    if (!originalSnapshot && !sameScenario)
      throw new Error(
        "A fixed-version control requires the confirmed Finding's Lab scenario",
      );
  }
  const verificationId = options.newId();
  const base = {
    schemaVersion: 1 as const,
    campaignId,
    snapshotDigest: snapshot.digest,
  };
  for (const event of [
    {
      ...base,
      identity: `target-selected-${verificationId}`,
      occurredAt: target.selectedAt,
      type: "target-selected" as const,
      selectionId: `${target.targetId}@${target.version}`,
      artifacts: [
        {
          kind: "target-selection",
          digest: await options.store.putFiles({
            "target-selection.json": canonicalJson(target),
          }),
        },
      ],
    },
    {
      ...base,
      identity: `snapshot-frozen-${verificationId}`,
      occurredAt: options.clock().toISOString(),
      type: "snapshot-frozen" as const,
      sourceDigest: snapshot.target.sourceDigest,
      dependencyDigests: snapshot.dependencies.map(
        (dependency) => dependency.sourceDigest,
      ),
    },
  ])
    if ((await ledger.append(event)).status === "conflict")
      throw new Error(`Ledger conflict: ${event.identity}`);
  let verificationFindingId = findingId;
  if (!originalSnapshot) {
    const reference = finding.artifacts.find(
      (artifact) => artifact.kind === "finding",
    );
    if (reference === undefined)
      throw new Error("The original Finding has no private record");
    const original = await options.store.readFile(
      reference.digest,
      "finding.json",
      1024 * 1024,
    );
    if (original.status !== "resolved")
      throw new Error("The original Finding private record is unavailable");
    const derivedRunId = `reverify-${verificationId}`;
    const derived = pipeline.deriveFinding({
      original: JSON.parse(original.bytes.toString("utf8")) as unknown,
      snapshotDigest: snapshot.digest,
      runId: derivedRunId,
    });
    if (
      derived.finding.snapshotDigest !== snapshot.digest ||
      derived.finding.findingId === findingId
    )
      throw new Error("The derived Finding is not bound to the new snapshot");
    const derivedArtifact = await options.store.putFiles({
      "finding.json": canonicalJson(derived.finding),
    });
    const recorded = await ledger.append({
      ...base,
      identity: `finding-derived-${verificationId}`,
      occurredAt: options.clock().toISOString(),
      type: "finding-recorded",
      findingId: derived.finding.findingId,
      runId: derivedRunId,
      category: derived.category,
      derivedFromFindingId: findingId,
      derivationKind:
        options.version === undefined
          ? "latest-version"
          : "fixed-version-control",
      artifacts: [{ kind: "finding", digest: derivedArtifact }],
    });
    if (recorded.status !== "appended")
      throw new Error("The derived Finding could not be recorded");
    verificationFindingId = derived.finding.findingId;
  }
  // A same-Snapshot recheck after a scenario change has no version basis; a
  // pinned smoke replay on the original Snapshot has none either.
  const basisKind =
    options.version === undefined
      ? "latest-version"
      : originalSnapshot
        ? undefined
        : "fixed-version";
  const pinnedReplay =
    options.snapshotCampaignId !== undefined && originalSnapshot;
  const result = await pipeline.verification.verify({
    campaignId,
    findingId: verificationFindingId,
    verificationId,
    snapshot,
    ...(basisKind === undefined || pinnedReplay
      ? {}
      : { basis: { kind: basisKind, findingSnapshotDigest: snapshot.digest } }),
    setup,
    campaignLabSetupDigest: canonicalDigest(setup),
    reconstruction: pipeline.reconstructionFor(snapshot),
    // The smoke replay compares the route digest, so it is passed untouched.
    referenceRoute: pinnedReplay
      ? referenceRoute
      : originalSnapshot ||
          referenceRoute === null ||
          typeof referenceRoute !== "object" ||
          Array.isArray(referenceRoute)
        ? undefined
        : { ...referenceRoute, comparisonKind: basisKind },
  });
  return {
    targetId: target.targetId,
    version: target.version,
    snapshotDigest: snapshot.digest,
    findingId: verificationFindingId,
    verificationId,
    status: result.status,
  };
}

export type FindingLab<Target, Handle extends LabHandle> = {
  readonly target: Target;
  readonly snapshot: Snapshot;
  readonly handle: Handle;
  /** The latest verification of this Finding, to compare Lab setups with. */
  readonly verification: {
    readonly verificationId: string;
    readonly labSetupDigest: string;
  } | null;
};

/**
 * `lab up --finding`: the same Lab supply verification used (frozen snapshot,
 * profile setup, verification purpose, seeded canaries), for a human's own
 * reproduction. Nothing is appended to the ledger; the Lab is not evidence.
 */
export async function provisionFindingLab<
  Target extends TargetSelection,
  Setup,
  Handle extends LabHandle,
>(options: {
  readonly campaignId: string;
  readonly findingId: string;
  readonly ledger: Ledger;
  readonly store: PrivateArtifactStore;
  readonly pipeline: {
    readonly freeze: (target: Target) => Promise<Snapshot>;
    readonly setupFor: (snapshot: Snapshot) => Setup;
    readonly lab: LabProvisioner<Setup, Handle>;
  };
  /** Profile parser for the private selection record. */
  readonly readTarget: (value: unknown) => Target;
}): Promise<FindingLab<Target, Handle>> {
  const { campaignId, findingId, ledger, pipeline } = options;
  const finding = ledger
    .read({ campaignId, findingId, type: "finding-recorded", limit: 1 })
    .at(0)?.event;
  if (finding?.type !== "finding-recorded")
    throw new Error("The finding is not recorded in this campaign");
  const selected = ledger
    .read({ campaignId, type: "target-selected", limit: 1000 })
    .map(({ event }) => event)
    .find(
      (event) =>
        event.type === "target-selected" &&
        event.snapshotDigest === finding.snapshotDigest,
    );
  const reference = selected?.artifacts.find(
    (artifact) => artifact.kind === "target-selection",
  );
  if (reference === undefined)
    throw new Error("The finding's target selection is not recorded");
  const file = await options.store.readFile(
    reference.digest,
    "target-selection.json",
    1024 * 1024,
  );
  if (file.status !== "resolved")
    throw new Error("The target selection record is unavailable");
  const target = options.readTarget(
    JSON.parse(file.bytes.toString("utf8")) as unknown,
  );
  const snapshot = await pipeline.freeze(target);
  if (snapshot.digest !== finding.snapshotDigest)
    throw new Error(
      "The frozen source differs from the finding snapshot; the Lab was not started",
    );
  const verification = ledger
    .read({ campaignId, findingId, type: "verification-finished", limit: 1000 })
    .map(({ event }) => event)
    .filter(
      (event) =>
        event.type === "verification-finished" &&
        event.snapshotDigest === finding.snapshotDigest,
    )
    .at(-1);
  const setup = pipeline.setupFor(snapshot);
  const provisioned = await pipeline.lab.provision(snapshot, setup, {
    purpose: "verification",
  });
  if (provisioned.status !== "ready")
    throw new Error(
      `Lab provision failed (${provisioned.reason}): ${provisioned.nextStep}`,
    );
  const seeded = await pipeline.lab.seedCanaries(provisioned.handle);
  if (seeded.status !== "seeded") {
    await pipeline.lab.teardown(provisioned.handle);
    throw new Error(`Canary seeding failed: ${seeded.nextStep}`);
  }
  return {
    target,
    snapshot,
    handle: provisioned.handle,
    verification:
      verification?.type === "verification-finished"
        ? {
            verificationId: verification.verificationId,
            labSetupDigest: verification.labSetupDigest,
          }
        : null,
  };
}
