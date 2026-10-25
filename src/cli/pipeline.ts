import type { CampaignInputV1, PlannedTrial } from "../discovery/index.js";
import { runDiscoveryCampaign } from "../discovery/index.js";
import {
  canonicalDigest,
  canonicalJson,
} from "../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import type { LabHandle, LabProvisioner, TrialLab } from "../lab/index.js";
import { readFindingGroups } from "../ledger/finding-groups.js";
import type { Ledger, LedgerEventV1, LedgerRecord } from "../ledger/index.js";
import { targetSelectionId, type TargetSelection } from "../selection/index.js";
import type { Snapshot } from "../snapshot/index.js";
import { storeTargetSkipDiagnostic } from "./skip-diagnostic.js";
import {
  countAttemptsForReason,
  shouldAutomaticallyRetryVerification,
  type VerifiableFinding,
  type Verification,
  type VerificationResultV1,
} from "../verification/index.js";

type DiscoveryOptions = Parameters<typeof runDiscoveryCampaign>[0];

/** Everything a campaign needs, built by a profile composition from public interfaces. */
export interface CampaignPipeline<
  Target extends TargetSelection,
  Setup extends { readonly scenario?: { readonly id: string } | undefined },
  Handle extends LabHandle,
  Finding extends VerifiableFinding,
  Reconstruction,
> {
  readonly select: () => Promise<readonly Target[]>;
  readonly freeze: (target: Target) => Promise<Snapshot>;
  readonly lab: LabProvisioner<Setup, Handle>;
  /** `discovery.lab: attached`: drives one Trial's exploration Lab (ADR 0003, 2026-10-25 addendum). */
  readonly explorationLab?: (handle: Handle) => TrialLab;
  readonly setupFor: (snapshot: Snapshot) => Setup;
  readonly discovery: (input: {
    readonly target: Target;
    readonly snapshot: Snapshot;
    readonly lab?: Handle;
  }) => Promise<{
    readonly input: CampaignInputV1;
    readonly plannedTrials: readonly PlannedTrial[];
    readonly concurrency?: number;
    readonly runWallTimeMs?: number;
    readonly executor: DiscoveryOptions["executor"];
    readonly attachments: DiscoveryOptions["attachments"];
    readonly recordReport: DiscoveryOptions["recordReport"];
    readonly resumeInterrupted?: NonNullable<
      DiscoveryOptions["resumeInterrupted"]
    >;
    readonly resumeProviderLimited?: NonNullable<
      DiscoveryOptions["resumeProviderLimited"]
    >;
  }>;
  readonly verification: Verification<Finding, Setup, Handle, Reconstruction>;
  readonly reconstructionFor: (snapshot: Snapshot) => Reconstruction;
}

type SkipStage = "freeze" | "discovery" | "verification";
type FinishedVerification = Extract<
  LedgerEventV1,
  { type: "verification-finished" }
>;
type VerificationRecord = { sequence: number; event: FinishedVerification };

function scenarioForVerification(
  previous: VerificationRecord,
  labs: readonly LedgerRecord[],
  snapshotDigest: string,
): string | null | undefined {
  const verificationLab = labs.find(
    ({ event }) =>
      event.identity === `verification-lab-${previous.event.verificationId}`,
  );
  if (verificationLab?.event.type === "lab-provisioned")
    return verificationLab.event.scenario?.id ?? null;
  // A precondition can fail before a verification Lab exists. Its discovery
  // Lab records the selected scenario before that attempt.
  const discoveryLab = labs
    .filter(
      ({ sequence, event }) =>
        sequence < previous.sequence &&
        event.type === "lab-provisioned" &&
        event.snapshotDigest === snapshotDigest &&
        event.purpose === "discovery",
    )
    .at(-1);
  return discoveryLab?.event.type === "lab-provisioned"
    ? (discoveryLab.event.scenario?.id ?? null)
    : undefined;
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
  /**
   * With `stopped: "provider-limit"`, the runtimes whose limit stopped their
   * targets while the other runtime's targets went on. Absent, the limit
   * stopped the whole campaign.
   */
  readonly limitedRuntimes?: readonly string[];
  readonly targets: readonly {
    readonly targetId: string;
    readonly version: string;
    readonly snapshotDigest: string;
    readonly lab: "ready" | "failed" | "none";
    readonly runCount: number;
    readonly stoppedBy: string;
    readonly verifications: readonly {
      readonly findingId: string;
      readonly status: VerificationResultV1["status"];
    }[];
  }[];
};

/** How often a target held by the live limit looks at the limit again. */
export const TARGET_LIMIT_POLL_MS = 30_000;

/**
 * The operator's live target limit (`continuous concurrency`). It only holds
 * new starts; a running target is never stopped for it.
 */
export interface TargetLimit {
  /** The live limit, or null when unset or unreadable (the ceiling applies). */
  read(): Promise<number | null>;
  /** The effective limit, on the first read and each time it changes. */
  report?(limit: number): void;
  /**
   * The live limit of one runtime's targets (`continuous concurrency --runtime`),
   * or null when unset or unreadable (its configured cap applies). 0 holds them.
   */
  readRuntime?(runtime: string): Promise<number | null>;
  /** One runtime's effective limit, on the first read and each time it changes. */
  reportRuntime?(runtime: string, limit: number): void;
  /** Runtimes in provider backoff: none of their targets starts until they leave it. */
  heldRuntimes?(): ReadonlySet<string>;
  readonly pollMs?: number;
}

/**
 * Per-runtime caps under the total. The profile says which runtime a target
 * runs on; a runtime without a cap here is bound by the total only.
 */
export interface RuntimeTargetCaps<Target> {
  readonly runtimeOf: (target: Target) => string;
  readonly ceilings: Readonly<Record<string, number>>;
  /**
   * A provider limit in discovery stops only the targets of the runtime that
   * hit it; the other runtime's targets keep starting. Absent, it stops the
   * whole campaign. The in-campaign Verifier does not look at it, so the
   * profile sets it only for campaigns without a discovery Lab.
   */
  readonly providerLimitPerRuntime?: boolean;
}

type Claim =
  | { readonly kind: "claimed"; readonly index: number }
  | { readonly kind: "waited" }
  | { readonly kind: "empty" };

/**
 * Starts for new targets under min(live limit, ceiling) and, per runtime,
 * min(live runtime limit, its cap). The first pending target whose runtime has
 * room starts; otherwise selection order stays. A release or the poll wakes a waiter.
 */
function targetScheduler<Target>(options: {
  readonly ceiling: number;
  readonly selected: readonly Target[];
  readonly live: TargetLimit | undefined;
  readonly runtimeCaps: RuntimeTargetCaps<Target> | undefined;
}) {
  const { ceiling, selected, live, runtimeCaps } = options;
  const runtimes = selected.map((target) => runtimeCaps?.runtimeOf(target));
  let active = 0;
  const activeByRuntime = new Map<string, number>();
  let reported: number | undefined;
  const reportedByRuntime = new Map<string, number>();
  const waiters = new Set<() => void>();
  const limits = async () => {
    let total = ceiling;
    if (live !== undefined) {
      const read = await live.read().catch(() => null);
      total = read === null ? ceiling : Math.min(Math.max(read, 1), ceiling);
      if (total !== reported) live.report?.((reported = total));
    }
    const byRuntime = new Map<string, number>();
    for (const [runtime, cap] of Object.entries(runtimeCaps?.ceilings ?? {})) {
      let limit = cap;
      if (live?.readRuntime !== undefined) {
        const read = await live.readRuntime(runtime).catch(() => null);
        limit = read === null ? cap : Math.min(Math.max(read, 0), cap);
        if (reportedByRuntime.get(runtime) !== limit) {
          reportedByRuntime.set(runtime, limit);
          live.reportRuntime?.(runtime, limit);
        }
      }
      byRuntime.set(runtime, limit);
    }
    return { total, byRuntime, held: live?.heldRuntimes?.() ?? new Set() };
  };
  return {
    /** Takes the first startable index out of `pending`, or waits so the caller checks again. */
    async claim(pending: number[]): Promise<Claim> {
      const { total, byRuntime, held } = await limits();
      // Everything below runs without an await, so two workers never take the same target.
      if (pending.length === 0) return { kind: "empty" };
      if (active < total) {
        const position = pending.findIndex((index) => {
          const runtime = runtimes[index];
          if (runtime !== undefined && held.has(runtime)) return false;
          const limit =
            runtime === undefined ? undefined : byRuntime.get(runtime);
          return (
            limit === undefined || (activeByRuntime.get(runtime!) ?? 0) < limit
          );
        });
        if (position >= 0) {
          const index = pending.splice(position, 1)[0]!;
          active++;
          const runtime = runtimes[index];
          if (runtime !== undefined)
            activeByRuntime.set(
              runtime,
              (activeByRuntime.get(runtime) ?? 0) + 1,
            );
          return { kind: "claimed", index };
        }
      }
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, live?.pollMs ?? TARGET_LIMIT_POLL_MS);
        waiters.add(wake);
      });
      return { kind: "waited" };
    },
    release(index: number): void {
      active--;
      const runtime = runtimes[index];
      if (runtime !== undefined)
        activeByRuntime.set(runtime, (activeByRuntime.get(runtime) ?? 1) - 1);
      for (const wake of [...waiters]) wake();
    },
  };
}

/** Wiring only: each step is a module's public interface; rules stay in the modules. */
export async function runCampaignPipeline<
  Target extends TargetSelection,
  Setup extends { readonly scenario?: { readonly id: string } | undefined },
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
  /** Targets in flight at once; discovery run concurrency remains per target. */
  readonly maxConcurrentTargets?: number;
  /** The runner's live limit under maxConcurrentTargets; absent, the ceiling applies. */
  readonly targetLimit?: TargetLimit;
  /** Per-runtime caps under maxConcurrentTargets; absent, only the total applies. */
  readonly runtimeCaps?: RuntimeTargetCaps<Target>;
  readonly discoveryLab?: "attached" | "none";
  readonly repeat?: number;
  /** Checked before each next target. True drains in-flight targets and stops as `operator`. */
  readonly stop?: () => boolean;
  readonly signal?: AbortSignal;
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
  let fatalError: Error | undefined;
  let selected: readonly Target[] = [];
  // Selection order; a target leaves when it starts.
  const pending: number[] = [];
  const limitedRuntimes = new Set<string>();
  const runtimeOf = (target: Target): string | undefined =>
    options.runtimeCaps?.providerLimitPerRuntime === true
      ? options.runtimeCaps.runtimeOf(target)
      : undefined;
  /** With a runtime, a provider limit stops only that runtime's pending targets. */
  const requestStop = (
    reason: NonNullable<CampaignSummary["stopped"]>,
    runtime?: string,
  ) => {
    if (reason === "provider-limit" && runtime !== undefined) {
      limitedRuntimes.add(runtime);
      // They stay unstarted for the resume; synchronous, so no claim takes one.
      for (let at = pending.length - 1; at >= 0; at--)
        if (runtimeOf(selected[pending[at]!]!) === runtime)
          pending.splice(at, 1);
      return;
    }
    if (reason === "provider-limit" || stopped === undefined) stopped = reason;
  };

  const selectedSnapshots = new Map<string, string>();
  for (const { event } of ledger.readAll({
    campaignId,
    type: "target-selected",
  }))
    if (event.type === "target-selected")
      selectedSnapshots.set(event.selectionId, event.snapshotDigest);
  const concludedSnapshots = new Set(
    ledger
      .readAll({ campaignId, type: "discovery-concluded" })
      .map(({ event }) => event.snapshotDigest),
  );
  // A refused or failed Trial is skipped for this campaign; it is not resumed.
  for (const { event } of ledger.readAll({
    campaignId,
    type: "target-skipped",
  }))
    if (
      event.type === "target-skipped" &&
      event.stage === "discovery" &&
      (event.reason === "provider-refused" || event.reason === "run-failed")
    )
      concludedSnapshots.add(event.snapshotDigest);
  // Verification is its own step (`verify next`, ADR 0035), so a concluded
  // discovery completes the target with or without a Lab.
  const isCompleted = (target: Target): boolean => {
    const snapshotDigest = selectedSnapshots.get(targetSelectionId(target));
    return (
      snapshotDigest !== undefined && concludedSnapshots.has(snapshotDigest)
    );
  };

  /** A refusal is a provider failure without a usage limit (e.g. cyber_policy). */
  const refusedTrial = (snapshotDigest: string): boolean => {
    const finished = ledger
      .readAll({
        campaignId,
        type: "discovery-run-finished",
      })
      .map(({ event }) => event)
      .filter(
        (event) =>
          event.type === "discovery-run-finished" &&
          event.snapshotDigest === snapshotDigest &&
          event.outcome === "failed",
      )
      .at(-1);
    return (
      finished?.type === "discovery-run-finished" &&
      finished.reason === "provider" &&
      finished.providerLimit === undefined
    );
  };

  const processTarget = async (target: Target): Promise<TargetResult> => {
    const selectionId = targetSelectionId(target);
    let stage: SkipStage = "freeze";
    // Before a snapshot exists, the selection record stands in for its digest.
    let snapshotDigest = canonicalDigest(target);
    let handle: Handle | undefined;
    let result: TargetResult = {};
    const skip = async (error: unknown): Promise<void> => {
      // The ledger gets only a fixed reason and a digest. Raw diagnostics stay private.
      const { reason, digest: diagnosticDigest } =
        await storeTargetSkipDiagnostic(options.store, error);
      await append({
        schemaVersion: 1,
        campaignId,
        snapshotDigest,
        identity: `target-skipped-${options.newId()}`,
        occurredAt: at(),
        type: "target-skipped",
        selectionId,
        stage,
        reason,
        artifacts: [
          { kind: "target-skip-diagnostic", digest: diagnosticDigest },
        ],
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
      const setup = pipeline.setupFor(snapshot);
      if (
        selectedSnapshots.get(selectionId) === snapshot.digest &&
        isCompleted(target)
      )
        return;
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
      // An attached Lab serves exactly one Trial (ADR 0003, 2026-10-25 addendum).
      if (options.discoveryLab !== "none") {
        if ((options.repeat ?? 1) > 1)
          throw new Error(
            "An exploration Lab serves one Trial; --repeat needs discovery.lab none",
          );
        if (pipeline.explorationLab === undefined)
          throw new Error("This profile has no exploration Lab");
        const provisioned = await pipeline.lab.provision(snapshot, setup, {
          purpose: "discovery",
        });
        if (provisioned.status === "ready") handle = provisioned.handle;
        const labId =
          provisioned.status === "ready"
            ? provisioned.handle.id
            : options.newId();
        await append({
          ...base,
          identity: `lab-provisioned-${labId}`,
          occurredAt: at(),
          type: "lab-provisioned",
          labId,
          status: provisioned.status === "ready" ? "ready" : "failed",
          purpose: "discovery",
          ...(provisioned.status !== "ready" ||
          provisioned.handle.scenario === undefined
            ? {}
            : { scenario: provisioned.handle.scenario }),
          ...(provisioned.status === "ready"
            ? {}
            : {
                failureStage: "provision" as const,
                reason: provisioned.reason,
              }),
          ...(provisioned.status === "ready" ||
          provisioned.diagnostic === undefined
            ? {}
            : {
                artifacts: [
                  {
                    kind: "lab-diagnostic",
                    digest: await options.store.putFiles({
                      "stderr.txt": provisioned.diagnostic,
                    }),
                  },
                ],
              }),
        });
        if (provisioned.status !== "ready") {
          result.target = {
            targetId: target.targetId,
            version: target.version,
            snapshotDigest: snapshot.digest,
            lab: "failed",
            runCount: 0,
            stoppedBy:
              provisioned.reason === "precondition"
                ? "incomplete(precondition)"
                : "setup-failed",
            verifications: [],
          };
          return;
        }
      }
      const prepared = await pipeline.discovery({
        target,
        snapshot,
        ...(handle === undefined ? {} : { lab: handle }),
      });
      const discovered = await runDiscoveryCampaign({
        campaignId,
        ledger,
        evidence: options.store,
        clock,
        ...(handle === undefined
          ? {}
          : {
              lab: pipeline.explorationLab!(handle),
              ...(options.signal === undefined
                ? {}
                : { signal: options.signal }),
            }),
        ...prepared,
        repeatAll: (options.repeat ?? 1) > 1,
      });
      result.target = {
        targetId: target.targetId,
        version: target.version,
        snapshotDigest: snapshot.digest,
        lab: handle === undefined ? "none" : "ready",
        runCount: discovered.runCount,
        stoppedBy: discovered.stoppedBy,
        verifications: [],
      };
      if (
        discovered.stoppedBy === "provider-limit" &&
        discovered.runCount > 0
      ) {
        const runtime = runtimeOf(target);
        requestStop("provider-limit", runtime);
        await append({
          ...base,
          identity: `campaign-stopped-${options.newId()}`,
          occurredAt: at(),
          type: "campaign-stopped",
          reason: "provider-limit",
          ...(runtime === undefined ? {} : { runtime }),
        });
      } else if (
        discovered.stoppedBy === "incomplete" &&
        (discovered.runCount > 0 || discovered.resumeRefusal !== undefined)
      ) {
        const diagnosticDigest =
          discovered.resumeRefusal === undefined
            ? undefined
            : await options.store.putFiles({
                "target-skip-diagnostic.json": canonicalJson({
                  kind: "resume-refused",
                  runId: discovered.resumeRefusal.runId,
                  reason: discovered.resumeRefusal.reason,
                  ...(discovered.resumeRefusal.detail === undefined
                    ? {}
                    : { detail: discovered.resumeRefusal.detail }),
                }),
              });
        await append({
          ...base,
          identity: `target-skipped-${options.newId()}`,
          occurredAt: at(),
          type: "target-skipped",
          selectionId,
          stage: "discovery",
          reason:
            discovered.resumeRefusal === undefined &&
            refusedTrial(snapshot.digest)
              ? "provider-refused"
              : "run-failed",
          ...(diagnosticDigest === undefined
            ? {}
            : {
                artifacts: [
                  {
                    kind: "target-skip-diagnostic" as const,
                    digest: diagnosticDigest,
                  },
                ],
              }),
        });
      }
    };
    try {
      await run();
    } catch (error: unknown) {
      await skip(error);
    } finally {
      if (handle !== undefined) {
        const removed = await pipeline.lab.teardown(handle).catch(() => null);
        if (removed?.status !== "removed") {
          const cleanupFailure = new Error(
            removed?.nextStep ??
              "Inspect and remove remaining Lab resources before retry",
          );
          fatalError ??= cleanupFailure;
          requestStop("incomplete");
          await append({
            schemaVersion: 1,
            campaignId,
            snapshotDigest,
            identity: `campaign-stopped-${options.newId()}`,
            occurredAt: at(),
            type: "campaign-stopped",
            reason: "incomplete",
            cleanupLabIds: [handle.id],
          });
          if (result.skipped === undefined) await skip(cleanupFailure);
        }
      }
    }
    return result;
  };

  selected = (await pipeline.select()).filter((target) => !isCompleted(target));
  const results: (TargetResult | undefined)[] = Array(selected.length);
  pending.push(...selected.map((_, index) => index));
  const scheduler = targetScheduler({
    ceiling: maxConcurrentTargets,
    selected,
    live: options.targetLimit,
    runtimeCaps: options.runtimeCaps,
  });
  const worker = async () => {
    while (stopped === undefined) {
      if (pending.length === 0) return;
      // Above the live limit, or with every pending target's runtime full, no
      // new target starts; the running ones go on.
      const claim = await scheduler.claim(pending);
      if (claim.kind === "empty") return;
      // The operator stop point: in-flight targets finish, no new target starts.
      const stopping = options.stop?.() === true;
      if (claim.kind === "waited" && !stopping) continue;
      const index = claim.kind === "claimed" ? claim.index : pending[0];
      const target = index === undefined ? undefined : selected[index];
      if (claim.kind === "claimed" && stopping) scheduler.release(claim.index);
      if (target === undefined || index === undefined) return;
      if (stopping) {
        if (stopped === undefined) {
          stopped = "operator";
          await append({
            schemaVersion: 1,
            campaignId,
            snapshotDigest: canonicalDigest(target),
            identity: `campaign-stopped-${options.newId()}`,
            occurredAt: at(),
            type: "campaign-stopped",
            reason: "operator",
          });
        }
        return;
      }
      try {
        results[index] = await processTarget(target);
      } catch (error) {
        fatalError ??=
          error instanceof Error ? error : new Error(String(error));
        requestStop("incomplete");
        return;
      } finally {
        scheduler.release(index);
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(maxConcurrentTargets, selected.length) },
      worker,
    ),
  );
  if (fatalError !== undefined) throw fatalError;
  const targets = results.flatMap((result) =>
    result?.target === undefined ? [] : [result.target],
  );
  const skipped = results.flatMap((result) =>
    result?.skipped === undefined ? [] : [result.skipped],
  );
  // A whole-campaign stop keeps its old summary; a runtime stop names its runtimes.
  const runtimeStopped =
    stopped !== "provider-limit" && limitedRuntimes.size > 0;
  if (runtimeStopped) stopped = "provider-limit";
  return {
    campaignId,
    targets,
    skipped,
    ...(stopped === undefined ? {} : { stopped }),
    ...(runtimeStopped ? { limitedRuntimes: [...limitedRuntimes].sort() } : {}),
  };
}

export type ReverificationSummary = {
  readonly targetId: string;
  readonly version: string;
  readonly snapshotDigest: string;
  readonly findingId: string;
  readonly verificationId: string;
  readonly status: VerificationResultV1["status"];
};

export type VerifyNextSummary = {
  readonly campaignId: string;
  readonly findingId: string;
  readonly verificationId: string;
  readonly status: VerificationResultV1["status"];
};

/**
 * The handoff queue (#423): every recorded, unparked Finding without a verdict
 * whose latest review decision is not `reject` (#436, ADR 0038 段 1),
 * in ledger order with each overlap group's first Finding ahead of the rest of
 * its group (#424), one per call, without a discovery Lab. Retry budgets count
 * the current skill version's attempts only, so an incomplete left by another
 * Verifier version (the retired automatic `verifier-v8`) keeps a Finding queued.
 */
export async function verifyNextFinding<
  Setup extends { readonly scenario?: { readonly id: string } | undefined },
  Handle extends LabHandle,
  Finding extends VerifiableFinding,
  Reconstruction,
>(options: {
  readonly campaignId?: string;
  /**
   * The one Finding an operator or skill named. They supply what the queue
   * rules could not, so parking, a `reject` and the retry budget do not apply.
   */
  readonly only?: { readonly findingId: string };
  readonly ledger: Ledger;
  readonly newId: () => string;
  readonly loadSnapshot: (digest: string) => Promise<Snapshot>;
  readonly setupFor: (snapshot: Snapshot) => Setup;
  readonly reconstructionFor: (snapshot: Snapshot) => Reconstruction;
  readonly verification: Verification<Finding, Setup, Handle, Reconstruction>;
}): Promise<VerifyNextSummary | null> {
  const scope =
    options.campaignId === undefined ? {} : { campaignId: options.campaignId };
  // #424: each overlap group's first Finding comes before the rest of its group; none is dropped.
  const findings = readFindingGroups(options.ledger, scope).order(
    options.ledger.readAll({ ...scope, type: "finding-recorded" }),
    ({ event }) => event,
  );
  const histories = options.ledger.readAll({
    ...scope,
    type: "verification-finished",
  });
  const labs = options.ledger.readAll({ ...scope, type: "lab-provisioned" });
  const parked = new Set(
    options.ledger
      .activeParked(scope)
      .map((event) => `${event.campaignId}\0${event.findingId}`),
  );
  // The latest decision per Finding; a `reject` keeps it out of the Lab.
  const decisions = new Map<string, string>();
  for (const { event } of options.ledger.readAll({
    ...scope,
    type: "review-decided",
  }))
    if (event.type === "review-decided")
      decisions.set(`${event.campaignId}\0${event.findingId}`, event.decision);
  for (const { event } of findings) {
    if (
      event.type !== "finding-recorded" ||
      event.derivationKind === "fixed-version-control"
    )
      continue;
    if (
      options.only !== undefined &&
      event.findingId !== options.only.findingId
    )
      continue;
    if (
      options.only === undefined &&
      (parked.has(`${event.campaignId}\0${event.findingId}`) ||
        decisions.get(`${event.campaignId}\0${event.findingId}`) === "reject")
    )
      continue;
    const history = histories.filter(
      (record): record is VerificationRecord =>
        record.event.type === "verification-finished" &&
        record.event.campaignId === event.campaignId &&
        record.event.findingId === event.findingId &&
        record.event.basis === undefined,
    );
    const latest = history.at(-1);
    // This version's latest attempt; its budget decides a retry.
    const previous = history
      .filter(
        ({ event: prior }) =>
          prior.promptVersion === options.verification.promptVersion,
      )
      .at(-1);
    if (
      options.only === undefined &&
      latest !== undefined &&
      latest.event.result.status !== "incomplete"
    )
      continue;
    if (previous !== undefined && options.only === undefined) {
      if (previous.event.result.status !== "incomplete") continue;
      const reason = previous.event.result.reason;
      const attemptsForReason = countAttemptsForReason(
        history.map(({ event: prior }) => prior),
        {
          labSetupDigest: previous.event.labSetupDigest,
          promptVersion: previous.event.promptVersion,
          reason,
        },
      );
      const previousScenarioId = scenarioForVerification(
        previous,
        labs,
        event.snapshotDigest,
      );
      // Scenario-dependent retries are decided after loading the same pinned Snapshot.
      if (
        !shouldAutomaticallyRetryVerification({
          reason,
          attemptsForReason,
          sameLabSetup: true,
          previousScenarioId,
          currentScenarioId: previousScenarioId,
        }) &&
        reason !== "precondition"
      )
        continue;
    }
    const snapshot = await options.loadSnapshot(event.snapshotDigest);
    const setup = options.setupFor(snapshot);
    if (
      options.only === undefined &&
      previous?.event.result.status === "incomplete" &&
      previous.event.result.reason === "precondition" &&
      !shouldAutomaticallyRetryVerification({
        reason: "precondition",
        attemptsForReason: 1,
        sameLabSetup: true,
        previousScenarioId: scenarioForVerification(
          previous,
          labs,
          event.snapshotDigest,
        ),
        currentScenarioId: setup.scenario?.id ?? null,
      })
    )
      continue;
    const verificationId = options.newId();
    const result = await options.verification.verify({
      campaignId: event.campaignId,
      findingId: event.findingId,
      verificationId,
      attempt: Math.max(history.length + 1, (latest?.event.attempt ?? 0) + 1),
      ...(latest === undefined ? {} : { retryOf: latest.event.verificationId }),
      snapshot,
      setup,
      campaignLabSetupDigest: canonicalDigest(setup),
      reconstruction: options.reconstructionFor(snapshot),
    });
    return {
      campaignId: event.campaignId,
      findingId: event.findingId,
      verificationId,
      status: result.status,
    };
  }
  return null;
}

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
      readonly originalSnapshotDigest: string;
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
    .readAll({ campaignId, type: "target-selected" })
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
    .readAll({
      campaignId: referenceCampaignId,
      findingId,
      type: "verification-finished",
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
      .readAll({
        campaignId: options.snapshotCampaignId,
        type: "snapshot-frozen",
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
    originalSnapshotDigest: finding.snapshotDigest,
    ...(requestedVersion === undefined ? {} : { version: requestedVersion }),
  });
  if (target === null)
    throw new Error("The selected target version is not available now");
  let snapshot: Snapshot;
  if (options.snapshotCampaignId === undefined) {
    snapshot = await pipeline.freeze(target);
  } else {
    const recordedSelection = ledger
      .readAll({
        campaignId: options.snapshotCampaignId,
        type: "target-selected",
      })
      .map(({ event }) => event)
      .find(
        (event) =>
          event.type === "target-selected" &&
          event.selectionId === targetSelectionId(target),
      );
    if (recordedSelection?.type !== "target-selected")
      throw new Error("The pinned reference Snapshot is not recorded");
    const frozen = ledger
      .readAll({
        campaignId: options.snapshotCampaignId,
        type: "snapshot-frozen",
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
      .readAll({
        campaignId,
        findingId,
        type: "verification-finished",
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
      .readAll({ campaignId, type: "lab-provisioned" })
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
      .readAll({
        campaignId: referenceCampaignId,
        type: "lab-provisioned",
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
      selectionId: targetSelectionId(target),
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
