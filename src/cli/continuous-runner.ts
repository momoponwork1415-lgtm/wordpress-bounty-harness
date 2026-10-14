import { readFile, realpath } from "node:fs/promises";
import {
  canonicalDigest,
  canonicalJson,
} from "../infrastructure/canonical-json.js";
import {
  ContinuousRunRevisionConflictError,
  type ContinuousRunRecord,
  type SqliteContinuousRunJournal,
} from "../infrastructure/continuous-run-journal.js";
import type { SqliteContinuousRunOwner } from "../infrastructure/continuous-run-owner.js";
import type { SqliteHostResourceClaims } from "../infrastructure/host-resource-claims.js";
import { reconcileContinuousRestart } from "../discovery/continuous-restart-reconciliation.js";
import type { CliIo, CliProfile, CliState } from "./index.js";
import { ContinuousInputPinMismatchError } from "./continuous-input-pin.js";
import { continuousReviewExportCheck } from "./continuous-review-readiness.js";
import type { ReviewExportCheck } from "../discovery/continuous-child-assessment.js";
import {
  settleContinuousStop,
  settleIdleContinuousStop,
} from "./continuous-stop.js";

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
  /** The explicit resume command's pre-launch journal revision. */
  readonly expectedResumeRevision?: number;
  /** A scheduler may wake only the RUNNING revision it observed. */
  readonly supervisorExpectedRevision?: number;
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
  // The supervisor starts from an observed revision. Advance this fence only
  // after a journal write made by this worker, so an external review hold is
  // never mistaken for the result of our own asynchronous work.
  let supervisorRevision = input.supervisorExpectedRevision;
  const externalSupervisorChange = (): ContinuousRunRecord | null => {
    const run = current();
    return supervisorRevision !== undefined &&
      run.revision !== supervisorRevision &&
      !run.stopRequested
      ? run
      : null;
  };
  const supervisorStillEligible = () => {
    const run = current();
    return (
      input.supervisorExpectedRevision === undefined ||
      (run.revision === input.supervisorExpectedRevision &&
        run.state === "RUNNING" &&
        !run.stopRequested)
    );
  };
  if (!supervisorStillEligible()) return current();
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
  if (
    acquisition.status === "busy" &&
    input.supervisorExpectedRevision !== undefined
  )
    return current();
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
  ) => {
    if (supervisorRevision !== undefined && run.revision !== supervisorRevision)
      throw new ContinuousRunRevisionConflictError();
    const next = journal.transition(parentRunId, run.revision, value);
    if (supervisorRevision !== undefined) supervisorRevision = next.revision;
    return next;
  };
  const journalMutation = (
    expectedRevision: number,
    mutate: () => ContinuousRunRecord,
  ): ContinuousRunRecord => {
    if (
      supervisorRevision !== undefined &&
      expectedRevision !== supervisorRevision
    )
      throw new ContinuousRunRevisionConflictError();
    const next = mutate();
    if (supervisorRevision !== undefined) supervisorRevision = next.revision;
    return next;
  };
  const stopIfRequested = async (): Promise<ContinuousRunRecord | null> => {
    const run = current();
    if (!run.stopRequested) return null;
    return settleContinuousStop({
      parentRunId,
      journal,
      ledger: state.ledger,
      claims,
      owner,
      ownerHandle: handle,
      reviewExportReady,
    });
  };
  const holdChangedInputs = async (): Promise<ContinuousRunRecord | null> => {
    const externalBefore = externalSupervisorChange();
    if (externalBefore !== null) return externalBefore;
    if (current().stopRequested && current().state !== "STOPPED")
      return stopIfRequested();
    const inputsReady = await pinnedInputsReady();
    const externalAfter = externalSupervisorChange();
    if (externalAfter !== null) return externalAfter;
    if (inputsReady) return null;
    const run = current();
    if (run.stopRequested && run.state !== "STOPPED")
      return (await stopIfRequested()) ?? run;
    if (run.state !== "RUNNING" && run.state !== "WAIT_QUOTA") return run;
    return transition(run, {
      state: "WAIT_REVIEW",
      reason: "config-or-policy-changed",
      nextCheckAt: null,
    });
  };
  try {
    // The owner claim is the concurrency gate, but a stop/review transition
    // can race its acquisition. A supervised wake must never reopen a review
    // hold. A stop that races a dead-owner takeover must still pass through
    // the recovery and stop reconciliation below; returning here would leave
    // a recovery-required owner claim that idle stop cannot release.
    if (
      !supervisorStillEligible() &&
      !(acquisition.recoveryRequired && current().stopRequested)
    )
      return current();
    if (acquisition.recoveryRequired) {
      const firstDecision = await inspect(
        initial.stopRequested,
        initial.state === "RECOVERING" && !initial.stopRequested,
        initial.state === "WAIT_REVIEW" && !initial.stopRequested,
      );
      // A stop can be recorded after the supervised wake's revision check,
      // while the first recovery inspection is reading claims or the ledger.
      // Re-run the same read-only assessment with the durable stop intent;
      // otherwise the stale stop-requested hold strands a safe parent in
      // RECOVERING with a recovery-required owner claim.
      const decision =
        firstDecision.action === "hold" &&
        firstDecision.reason === "stop-requested" &&
        current().stopRequested
          ? await inspect(true)
          : firstDecision;
      const externalAfterInspect = externalSupervisorChange();
      if (externalAfterInspect !== null) return externalAfterInspect;
      const assessedWaitSafe =
        decision.action === "hold" &&
        decision.ownerReconciliationSafe &&
        (decision.reason === "quota" || decision.reason === "review-required");
      if (
        !assessedWaitSafe &&
        (decision.action !== "hold" || decision.reason !== "owner-not-ready")
      ) {
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
      const externalAfterEvidence = externalSupervisorChange();
      if (externalAfterEvidence !== null) return externalAfterEvidence;
      owner.markReconciled(handle, evidenceDigest);
      if (current().stopRequested && current().state !== "STOPPED")
        return (await stopIfRequested()) ?? current();
      if (
        assessedWaitSafe &&
        current().state === "RECOVERING" &&
        !current().stopRequested
      )
        transition(current(), {
          state: "RUNNING",
          reason: null,
          nextCheckAt: null,
        });
    }
    const changed = await holdChangedInputs();
    if (changed !== null) return changed;
    const externalAfterInputs = externalSupervisorChange();
    if (externalAfterInputs !== null) return externalAfterInputs;
    if (current().stopRequested && current().state !== "STOPPED")
      return (await stopIfRequested()) ?? current();
    if (current().state === "RECOVERING" && !current().stopRequested) {
      // Recovery is explicit. Reconcile ledger, resource claims, and the owner
      // before clearing the hold; a spent Trial remains the same child.
      const decision = await inspect(false, true);
      const externalAfterRecoveryInspect = externalSupervisorChange();
      if (externalAfterRecoveryInspect !== null)
        return externalAfterRecoveryInspect;
      if (decision.action === "hold") return current();
      transition(current(), {
        state: "RUNNING",
        reason: null,
        nextCheckAt: null,
      });
    }
    if (current().state === "STOPPED") {
      // An idle stop finalizer can settle a stop while a process is still
      // launching. Only a resume that observed this exact stopped revision may
      // clear it; an earlier start/resume intent cannot cancel the new stop.
      if (
        input.expectedResumeRevision !== initial.revision ||
        current().revision !== initial.revision
      )
        return current();
      const decision = await inspect(true);
      const externalAfterStoppedInspect = externalSupervisorChange();
      if (externalAfterStoppedInspect !== null)
        return externalAfterStoppedInspect;
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
      const expectedRevision = decision.expectedRevision;
      if (expectedRevision === null) return run;
      journalMutation(expectedRevision, () =>
        journal.resume(parentRunId, expectedRevision, {
          ...(run.children.at(-1)?.status === "reserved"
            ? { reservedChildReconciled: true as const }
            : {}),
        }),
      );
    }
    if (current().state === "WAIT_REVIEW") {
      const run = current();
      if (
        run.reason !== "config-or-policy-changed" &&
        run.reason !== "inventory-unavailable" &&
        run.reason !== "candidate-source-refresh-unavailable" &&
        run.reason !== "candidate-history-unverified" &&
        run.reason !== "candidate-observation-unverified"
      )
        return run;
      // The initial pinned-input check has passed. Preflight validates the
      // existing child, claims, and ledger before reopening this operational
      // hold. An assessed review hold, including cyber-policy, stays held.
      const decision = await inspect(false, false, true);
      const externalAfterReviewInspect = externalSupervisorChange();
      if (externalAfterReviewInspect !== null)
        return externalAfterReviewInspect;
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
      if (run.stopRequested) return (await stopIfRequested()) ?? run;
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
      const stopped = await stopIfRequested();
      if (stopped !== null) return stopped;
      const changed = await holdChangedInputs();
      if (changed !== null) return changed;
      const decision = await inspect();
      const externalAfterChildInspect = externalSupervisorChange();
      if (externalAfterChildInspect !== null) return externalAfterChildInspect;
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
        journalMutation(decision.expectedRevision, () =>
          journal.settleChild(
            parentRunId,
            decision.expectedRevision,
            decision.ordinal,
            decision.lastLedgerSequence,
          ),
        );
        continue;
      }
      if (decision.action === "reserve-next-child") {
        journalMutation(decision.expectedRevision, () =>
          journal.reserveChild(parentRunId, decision.expectedRevision),
        );
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
          journalMutation(latest.revision, () =>
            journal.bindChild(parentRunId, latest.revision, child.ordinal, {
              selectionBatchId: prepared.selectionBatchId,
              snapshotDigests: prepared.snapshotDigests,
            }),
          );
          continue;
        }
        if (
          prepared.reason === "candidate-history-unverified" ||
          prepared.reason === "candidate-observation-unverified"
        )
          return transition(current(), {
            state: "WAIT_REVIEW",
            reason: prepared.reason,
            nextCheckAt: null,
          });
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
          const expectedRevision = current().revision;
          journalMutation(expectedRevision, () =>
            journal.advanceUnboundChildInventory(
              parentRunId,
              expectedRevision,
              child.ordinal,
              fresh.inventoryDigest,
            ),
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
        const expectedRevision = current().revision;
        journalMutation(expectedRevision, () =>
          journal.advanceUnboundChildInventory(
            parentRunId,
            expectedRevision,
            child.ordinal,
            inventory.inventoryDigest,
          ),
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
          expectedConfigDigest: initial.configDigest,
          expectedPolicyDigest: initial.policyDigest,
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
          const stopped = await stopIfRequested();
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
    if (
      error instanceof ContinuousRunRevisionConflictError &&
      externalSupervisorChange() !== null
    )
      return current();
    if (error instanceof ContinuousInputPinMismatchError) {
      // WordPress checks the exact data it loaded before binding or starting
      // the child. A mismatch is an operational hold, not a spent Trial.
      const run = current();
      if (run.stopRequested) return (await stopIfRequested()) ?? current();
      return transition(run, {
        state: "WAIT_REVIEW",
        reason: "config-or-policy-changed",
        nextCheckAt: null,
      });
    }
    let failure = error;
    if (
      error instanceof ContinuousRunRevisionConflictError &&
      current().stopRequested
    ) {
      try {
        // A stop intentionally invalidates an in-flight journal CAS. Recheck
        // all child evidence and claims before deciding it was a clean stop.
        return (await stopIfRequested()) ?? current();
      } catch (reconciliationError) {
        failure = reconciliationError;
      }
    }
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
    throw failure;
  } finally {
    let released = false;
    try {
      owner.release(handle);
      released = true;
    } catch {
      // A recovery-required owner remains claimed for explicit reconciliation.
    }
    if (released) {
      try {
        // A stop command can observe this owner as busy after the runner has
        // decided to return a wait, but immediately before releasing it. Once
        // released, one of these two processes must take the owner and drain
        // the durable stop through the same ledger/claim preflight.
        const pending = current();
        if (pending.stopRequested && pending.state === "STOPPING")
          await settleIdleContinuousStop({
            parentRunId,
            journal,
            ledger: state.ledger,
            claims,
            owner,
            reviewExportReady,
          });
      } catch {
        // The stop intent stays durable for a later explicit reconciliation.
      }
    }
  }
}
