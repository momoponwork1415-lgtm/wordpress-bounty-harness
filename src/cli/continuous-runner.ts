import { readFile, realpath } from "node:fs/promises";
import {
  canonicalDigest,
  canonicalJson,
} from "../infrastructure/canonical-json.js";
import type {
  ContinuousRunRecord,
  SqliteContinuousRunJournal,
} from "../infrastructure/continuous-run-journal.js";
import type { SqliteContinuousRunOwner } from "../infrastructure/continuous-run-owner.js";
import type { SqliteHostResourceClaims } from "../infrastructure/host-resource-claims.js";
import { reconcileContinuousRestart } from "../discovery/continuous-restart-reconciliation.js";
import type { CliIo, CliProfile, CliState } from "./index.js";
import { continuousReviewExportCheck } from "./continuous-review-readiness.js";
import type { ReviewExportCheck } from "../discovery/continuous-child-assessment.js";

const QUOTA_RECHECK_MS = 5 * 60_000;

/**
 * The parent owns batch admission, not the individual Trial. Each child keeps
 * its own immutable selection batch and the normal profile campaign pipeline.
 */
export async function runContinuousParent(input: {
  readonly parentRunId: string;
  readonly configPath: string;
  readonly configDigest: string;
  readonly state: CliState;
  readonly profile: CliProfile;
  readonly journal: SqliteContinuousRunJournal;
  readonly owner: SqliteContinuousRunOwner;
  readonly claims: SqliteHostResourceClaims;
  readonly io: Pick<CliIo, "stdout">;
  readonly stopPollMs?: number;
  readonly findingRecordReady?: ReviewExportCheck;
}): Promise<ContinuousRunRecord> {
  const { parentRunId, journal, owner, claims, state, profile } = input;
  if (
    profile.prepareContinuousBatch === undefined ||
    profile.continuousPolicyDigest === undefined
  )
    throw new Error("Profile does not support continuous campaigns");
  const pollMs = input.stopPollMs ?? 1000;
  if (!Number.isSafeInteger(pollMs) || pollMs < 10 || pollMs > 60_000)
    throw new Error("Invalid continuous stop polling interval");
  const current = () => {
    const run = journal.get(parentRunId);
    if (run === null) throw new Error("Continuous parent is missing");
    return run;
  };
  const initial = current();
  if (
    initial.stateDirectory.length === 0 ||
    initial.stateDirectory !== (await realpath(state.stateDirectory))
  )
    throw new Error("Continuous parent state directory changed");
  const pinnedInputsReady = async () => {
    try {
      const configDigest = canonicalDigest(
        JSON.parse(await readFile(input.configPath, "utf8")) as unknown,
      );
      const policyDigest = await profile.continuousPolicyDigest!(state, {
        configPath: input.configPath,
      });
      return (
        input.configDigest === initial.configDigest &&
        configDigest === initial.configDigest &&
        policyDigest === initial.policyDigest
      );
    } catch {
      return false;
    }
  };
  const acquisition = owner.tryAcquire(parentRunId);
  if (acquisition.status === "busy")
    throw new Error(`Continuous parent has ${acquisition.reason}`);
  const handle = acquisition.handle;
  const reviewExportReady = continuousReviewExportCheck(
    state,
    profile,
    input.findingRecordReady,
  );
  let priorSettledAudited = false;
  const inspect = async (
    allowStoppedResume = false,
    allowRecoveringResume = false,
    allowReviewResume = false,
  ) => {
    const decision = await reconcileContinuousRestart({
      parentRunId,
      journal,
      ledger: state.ledger,
      claims,
      owner,
      ownerHandle: handle,
      reviewExportReady,
      ...(priorSettledAudited ? {} : { auditPriorSettled: true }),
      ...(allowStoppedResume ? { allowStoppedResume } : {}),
      ...(allowRecoveringResume ? { allowRecoveringResume } : {}),
      ...(allowReviewResume ? { allowReviewResume } : {}),
    });
    if (decision.action !== "hold") priorSettledAudited = true;
    return decision;
  };
  const transition = (
    run: ContinuousRunRecord,
    value: {
      readonly state:
        "RUNNING" | "WAIT_QUOTA" | "WAIT_REVIEW" | "STOPPED" | "RECOVERING";
      readonly reason: string | null;
      readonly nextCheckAt: string | null;
      readonly lastLedgerSequence?: number;
    },
  ) => journal.transition(parentRunId, run.revision, value);
  const stopIfRequested = (): ContinuousRunRecord | null => {
    const run = current();
    if (!run.stopRequested) return null;
    if (
      claims
        .status()
        .claims.some((claim) =>
          run.children.some((child) => child.campaignId === claim.campaignId),
        )
    )
      return transition(run, {
        state: "RECOVERING",
        reason: "resource-claim-after-stop",
        nextCheckAt: null,
      });
    return run.state === "STOPPED"
      ? run
      : transition(run, {
          state: "STOPPED",
          reason: "operator-stop",
          nextCheckAt: null,
        });
  };
  const holdChangedInputs = async (): Promise<ContinuousRunRecord | null> => {
    if (await pinnedInputsReady()) return null;
    const run = current();
    if (run.stopRequested) return stopIfRequested() ?? run;
    if (run.state !== "RUNNING" && run.state !== "WAIT_QUOTA") return run;
    return transition(run, {
      state: "WAIT_REVIEW",
      reason: "config-or-policy-changed",
      nextCheckAt: null,
    });
  };
  try {
    if (acquisition.recoveryRequired) {
      const decision = await inspect(
        initial.stopRequested,
        initial.state === "RECOVERING" && !initial.stopRequested,
      );
      if (decision.action !== "hold" || decision.reason !== "owner-not-ready") {
        const run = current();
        return transition(run, {
          state: "RECOVERING",
          reason: `crash-${decision.action === "hold" ? decision.reason : "unverified"}`,
          nextCheckAt: null,
        });
      }
      const evidenceDigest = await state.store.putFiles({
        "continuous-owner-reconciliation.json": canonicalJson({
          parentRunId,
          revision: decision.expectedRevision,
          campaignId: decision.campaignId,
          assessment: decision.assessment,
          claims: claims
            .status()
            .claims.filter((claim) =>
              current().children.some(
                (child) => child.campaignId === claim.campaignId,
              ),
            ),
          observedAt: state.clock().toISOString(),
        }),
      });
      owner.markReconciled(handle, evidenceDigest);
    }
    const changed = await holdChangedInputs();
    if (changed !== null) return changed;
    if (current().stopRequested && current().state !== "STOPPED") {
      const decision = await inspect(true);
      // A drained child may still need provider capacity or human review.
      // Neither wait keeps the operator's stop request in STOPPING.
      if (
        decision.action === "hold" &&
        decision.reason !== "quota" &&
        decision.reason !== "review-required"
      )
        return current().state === "RECOVERING"
          ? current()
          : transition(current(), {
              state: "RECOVERING",
              reason: `stop-${decision.reason}`,
              nextCheckAt: null,
            });
      return stopIfRequested() ?? current();
    }
    if (current().state === "RECOVERING" && !current().stopRequested) {
      // Recovery is explicit. Reconcile ledger, resource claims, and the owner
      // before clearing the hold; a spent Trial remains the same child.
      const decision = await inspect(false, true);
      if (decision.action === "hold") return current();
      transition(current(), {
        state: "RUNNING",
        reason: null,
        nextCheckAt: null,
      });
    }
    if (current().state === "STOPPED") {
      const decision = await inspect(true);
      // Explicit resume clears the stop request for an assessed wait. The
      // normal loop immediately restores WAIT_QUOTA or WAIT_REVIEW, without
      // replacing or replaying the bound child.
      if (
        decision.action === "hold" &&
        decision.reason !== "quota" &&
        decision.reason !== "review-required"
      )
        return current();
      if (decision.action === "hold") owner.assertReady(handle);
      const run = current();
      if (decision.expectedRevision === null) return run;
      journal.resume(parentRunId, decision.expectedRevision, {
        ...(run.children.at(-1)?.status === "reserved"
          ? { reservedChildReconciled: true as const }
          : {}),
      });
    }
    if (current().state === "WAIT_REVIEW") {
      const run = current();
      if (
        run.reason !== "config-or-policy-changed" &&
        run.reason !== "inventory-unavailable" &&
        run.reason !== "candidate-source-refresh-unavailable"
      )
        return run;
      // The initial pinned-input check has passed. Preflight validates the
      // existing child, claims, and ledger before reopening this operational
      // hold. An assessed review hold, including cyber-policy, stays held.
      const decision = await inspect(false, false, true);
      if (decision.action === "hold") return run;
      owner.assertReady(handle);
      transition(run, {
        state: "RUNNING",
        reason: null,
        nextCheckAt: null,
      });
    }
    if (current().state === "WAIT_QUOTA") {
      const run = current();
      if (run.stopRequested) return stopIfRequested() ?? run;
      if (
        run.nextCheckAt !== null &&
        Date.parse(run.nextCheckAt) > state.clock().getTime()
      )
        return run;
      // A clock deadline cannot prove provider capacity has returned. The
      // spent Trial is still in this bound child, so never dispatch it again.
      // A future non-Trial readiness check can replace this review hold.
      return transition(run, {
        state: "WAIT_REVIEW",
        reason: "quota-readiness-unverified",
        nextCheckAt: null,
      });
    }
    if (current().state !== "RUNNING") return current();

    for (;;) {
      const stopped = stopIfRequested();
      if (stopped !== null) return stopped;
      const changed = await holdChangedInputs();
      if (changed !== null) return changed;
      const decision = await inspect();
      if (decision.action === "hold") {
        const run = current();
        if (run.stopRequested) continue;
        const quota = decision.reason === "quota";
        return transition(run, {
          state: quota ? "WAIT_QUOTA" : "WAIT_REVIEW",
          reason: decision.reason,
          nextCheckAt: quota
            ? new Date(state.clock().getTime() + QUOTA_RECHECK_MS).toISOString()
            : null,
          ...(decision.assessment === null
            ? {}
            : { lastLedgerSequence: decision.assessment.lastLedgerSequence }),
        });
      }
      if (decision.action === "settle-child") {
        journal.settleChild(
          parentRunId,
          decision.expectedRevision,
          decision.ordinal,
          decision.lastLedgerSequence,
        );
        continue;
      }
      if (decision.action === "reserve-next-child") {
        journal.reserveChild(parentRunId, decision.expectedRevision);
        continue;
      }
      const run = current();
      const child = run.children[decision.ordinal];
      if (child === undefined || child.campaignId !== decision.campaignId)
        throw new Error("Continuous child changed during dispatch");
      if (child.binding === null) {
        const prepared = await profile.prepareContinuousBatch(state, {
          parent: run,
          owner,
          ownerHandle: handle,
          configPath: input.configPath,
        });
        const changed = await holdChangedInputs();
        if (changed !== null) return changed;
        if (prepared.status === "ready") {
          const latest = current();
          if (latest.stopRequested) continue;
          journal.bindChild(parentRunId, latest.revision, child.ordinal, {
            selectionBatchId: prepared.selectionBatchId,
            snapshotDigests: prepared.snapshotDigests,
          });
          continue;
        }
        if (prepared.reason === "candidate-source-pool-expired") {
          if (prepared.selectionPrefixLength > 0)
            return transition(current(), {
              state: "WAIT_REVIEW",
              reason: "expired-pool-with-selection-prefix",
              nextCheckAt: null,
            });
          // The old cursor belongs to the expired source pool. Recollect its
          // first page, then re-run the existing child with the new sealed pool.
          const fresh = await profile
            .collectInventory(state, { configPath: input.configPath })
            .catch(() => null);
          const afterRefresh = await holdChangedInputs();
          if (afterRefresh !== null) return afterRefresh;
          if (
            fresh === null ||
            fresh.source.status !== "available" ||
            fresh.source.requestedListingCoverage !== "all-observed" ||
            !fresh.sourcePoolSealed ||
            fresh.inventoryDigest === child.inventoryDigest
          )
            return transition(current(), {
              state: "WAIT_REVIEW",
              reason: "candidate-source-refresh-unavailable",
              nextCheckAt: null,
            });
          journal.advanceUnboundChildInventory(
            parentRunId,
            current().revision,
            child.ordinal,
            fresh.inventoryDigest,
          );
          continue;
        }
        const observed = await profile
          .inspectInventory?.(state, {
            configPath: input.configPath,
            digest: child.inventoryDigest,
          })
          .catch(() => null);
        if (observed?.traversal.nextPageAvailable !== true)
          return transition(current(), {
            state: "WAIT_REVIEW",
            reason:
              observed?.sourceCoverageVerified === true
                ? "candidate-exhausted"
                : "inventory-unverified",
            nextCheckAt: null,
          });
        // The unbound child has no selection events. The profile validates a
        // sealed next cursor before advancing; an exhausted page becomes a hold.
        const inventory = await profile
          .collectInventory(state, {
            configPath: input.configPath,
            afterDigest: child.inventoryDigest,
          })
          .catch(() => null);
        const afterPage = await holdChangedInputs();
        if (afterPage !== null) return afterPage;
        if (
          inventory === null ||
          inventory.source.status !== "available" ||
          inventory.source.requestedListingCoverage !== "all-observed" ||
          !inventory.sourcePoolSealed ||
          inventory.inventoryDigest === child.inventoryDigest
        )
          return transition(current(), {
            state: "WAIT_REVIEW",
            reason: "inventory-unavailable",
            nextCheckAt: null,
          });
        journal.advanceUnboundChildInventory(
          parentRunId,
          current().revision,
          child.ordinal,
          inventory.inventoryDigest,
        );
        continue;
      }
      const controller = new AbortController();
      if (current().stopRequested) controller.abort();
      let monitorError: unknown;
      const poll = setInterval(() => {
        try {
          if (current().stopRequested) controller.abort();
        } catch (error) {
          monitorError = error;
          controller.abort();
        }
      }, pollMs);
      try {
        if (current().stopRequested) controller.abort();
        const afterCampaign = await holdChangedInputs();
        if (afterCampaign !== null) return afterCampaign;
        const summary = await profile.runCampaign(state, {
          campaignId: child.campaignId,
          configPath: input.configPath,
          target: null,
          selectionBatchId: child.binding.selectionBatchId,
          snapshotDigests: child.binding.snapshotDigests,
          stopSignal: controller.signal,
          checkStop: () => {
            if (current().stopRequested) controller.abort();
          },
        });
        const changed = await holdChangedInputs();
        if (changed !== null) return changed;
        if (monitorError !== undefined) throw monitorError;
        if (summary.held !== undefined && summary.held.length > 0) {
          const stopped = stopIfRequested();
          if (stopped !== null) return stopped;
          return transition(current(), {
            state: "WAIT_REVIEW",
            reason: summary.held[0]!.reason,
            nextCheckAt: null,
          });
        }
        input.io.stdout(
          canonicalJson({
            parentRunId,
            campaignId: child.campaignId,
            targets: summary.targets.length,
            skipped: summary.skipped.length,
            stopped: summary.stopped ?? null,
          }),
        );
      } finally {
        clearInterval(poll);
      }
    }
  } catch (error) {
    const run = current();
    // An operator stop may race a real ledger, Lab, or verification failure.
    // Keep the error visible and require recovery instead of reporting a
    // successful STOPPED transition.
    if (run.state !== "RECOVERING")
      transition(run, {
        state: "RECOVERING",
        reason: "runner-error",
        nextCheckAt: null,
      });
    throw error;
  } finally {
    try {
      owner.release(handle);
    } catch {
      // A recovery-required owner remains claimed for explicit reconciliation.
    }
  }
}
