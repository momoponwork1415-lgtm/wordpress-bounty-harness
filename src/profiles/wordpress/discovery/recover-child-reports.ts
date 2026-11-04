import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import { z } from "zod";
import {
  canonicalDigest,
  canonicalJson,
} from "../../../infrastructure/canonical-json.js";
import type { Ledger, LedgerEventV1 } from "../../../ledger/index.js";
import {
  recoverChildReportFromRollout,
  recoverChildTurnReportsFromRollout,
  rootThreadIdFromRollout,
} from "../../../discovery/codex-native-agent-runtime.js";
import { readNativeRunReceipt } from "../../../discovery/native-run-receipts.js";
import type { ProviderAttachmentStore } from "../../../discovery/provider-research-report.js";
import {
  recordWordPressReport,
  verifiedAuditChecks,
  wordPressAuditClaimDigest,
} from "./candidate-admission.js";

const parserVersion = "child-coverage-array-v1";
/** #539: completed Codex children whose earlier turns' reports the capture dropped. */
const turnsParserVersion = "child-turns-merge-v1";

type Started = Extract<LedgerEventV1, { type: "discovery-run-started" }>;
type Finished = Extract<LedgerEventV1, { type: "discovery-run-finished" }>;
type Recovery = Extract<LedgerEventV1, { type: "child-report-recovered" }>;
type Pending = Extract<LedgerEventV1, { type: "audit-candidate-pending" }>;
type AuditCause = Extract<
  LedgerEventV1,
  { type: "audit-check-recorded" | "audit-candidate-pending" }
>;
type Options = {
  readonly campaignId: string;
  readonly ledger: Ledger;
  readonly evidence: PrivateArtifactStore;
  readonly attachments: Pick<ProviderAttachmentStore, "put" | "readByDigest">;
  readonly clock?: () => Date;
};
type Counts = {
  readonly recovered: number;
  readonly findings: number;
  readonly leads: number;
};

const archivedRootReportSchema = z.object({
  findings: z.array(z.unknown()),
  leads: z.array(z.unknown()),
});

/** The campaign's archived runs, receipts and diagnostics, read once per call. */
function archive(options: Options) {
  const { campaignId, ledger, evidence, attachments } = options;
  const events = ledger.readAll({ campaignId }).map(({ event }) => event);
  const started = new Map<string, Started>();
  const finished = new Map<string, Finished>();
  const recoveries = new Map<string, Recovery>();
  for (const event of events) {
    if (event.type === "discovery-run-started") started.set(event.runId, event);
    else if (event.type === "discovery-run-finished")
      finished.set(event.runId, event);
    else if (event.type === "child-report-recovered")
      recoveries.set(event.identity, event);
  }
  const existingIdentities = new Set(events.map((event) => event.identity));

  const receiptOf = async (event: Finished) => {
    const digest = event.artifacts.find(
      (artifact) => artifact.kind === "native-run-receipt",
    )?.digest;
    if (digest === undefined)
      throw new Error("A finished run has no private receipt");
    const receipt = await readNativeRunReceipt(evidence, digest);
    if (receipt === undefined)
      throw new Error("Private run receipt is unavailable");
    return receipt;
  };
  const diagnosticOf = async (digest: string) => {
    const result = await attachments.readByDigest("diagnostic", digest);
    if (result.status !== "resolved")
      throw new Error("Archived child diagnostic is unavailable");
    return result.bytes.toString("utf8");
  };

  /** A child run bound to its Root, Trial and Snapshot, with both receipts and rollouts. */
  const bound = async (childFinish: Finished) => {
    const childStart = started.get(childFinish.runId);
    if (
      childStart === undefined ||
      childStart.runKind !== "child" ||
      childStart.parentRunId === undefined ||
      typeof childStart.configuration.agentPath !== "string" ||
      childStart.snapshotDigest !== childFinish.snapshotDigest
    )
      throw new Error(
        "Archived child run is not bound to one Trial and snapshot",
      );
    const rootFinish = finished.get(childStart.parentRunId);
    const rootStart = started.get(childStart.parentRunId);
    if (
      rootFinish === undefined ||
      rootStart === undefined ||
      rootStart.snapshotDigest !== childStart.snapshotDigest ||
      rootStart.trialId !== childStart.trialId
    )
      throw new Error("Archived Root and child Trial do not match");
    const [childReceipt, rootReceipt] = await Promise.all([
      receiptOf(childFinish),
      receiptOf(rootFinish),
    ]);
    if (
      childReceipt.runId !== childStart.runId ||
      childReceipt.targetSnapshotDigest !== childStart.snapshotDigest ||
      rootReceipt.targetSnapshotDigest !== childStart.snapshotDigest ||
      childReceipt.runtimeProfileDigest !== rootReceipt.runtimeProfileDigest ||
      childReceipt.diagnosticArtifactDigest === undefined ||
      rootReceipt.diagnosticArtifactDigest === undefined
    )
      throw new Error("Archived receipts do not match the ledger");
    const [rootRaw, childRaw] = await Promise.all([
      diagnosticOf(rootReceipt.diagnosticArtifactDigest),
      diagnosticOf(childReceipt.diagnosticArtifactDigest),
    ]);
    return {
      childStart: { ...childStart, parentRunId: childStart.parentRunId },
      childReceipt,
      sourceDiagnosticDigest: childReceipt.diagnosticArtifactDigest,
      childRaw,
      expected: {
        parentThreadId: rootThreadIdFromRollout(rootRaw),
        childThreadId: childStart.runId,
        agentPath: childStart.configuration.agentPath,
        modelId: childReceipt.requestedModelId,
        effort: childReceipt.requestedEffort,
        cyberAccessProgram: childReceipt.cyberAccessProgram,
      },
    };
  };

  /**
   * Seal the reinterpretation, append `child-report-recovered`, then admit the
   * report through the one WordPress admission path. A rerun appends nothing.
   */
  const record = async (input: {
    readonly identity: string;
    readonly parserVersion: string;
    readonly childStart: Started & { readonly parentRunId: string };
    readonly sourceDiagnosticDigest: string;
    readonly report: Parameters<typeof recordWordPressReport>[0];
    readonly select?: (kind: "finding" | "lead", index: number) => boolean;
    readonly selectCheck?: (index: number) => boolean;
    /** Older recoveries kept the parser version out of their admission identities. */
    readonly versionedAdmission: boolean;
  }) => {
    const { childStart } = input;
    const reportRef = await attachments.put(
      "findings",
      Buffer.from(canonicalJson(input.report)),
    );
    const recoveryDigest = await evidence.putFiles({
      "recovery.json": canonicalJson({
        schemaVersion: 1,
        runId: childStart.runId,
        parentRunId: childStart.parentRunId,
        snapshotDigest: childStart.snapshotDigest,
        sourceDiagnosticDigest: input.sourceDiagnosticDigest,
        reportArtifactDigest: reportRef.digest,
        parserVersion: input.parserVersion,
      }),
    });
    const previous = recoveries.get(input.identity);
    if (
      previous !== undefined &&
      (previous.sourceDiagnosticDigest !== input.sourceDiagnosticDigest ||
        previous.reportArtifactDigest !== reportRef.digest ||
        previous.parserVersion !== input.parserVersion)
    )
      throw new Error("Archived recovery provenance changed");
    const base = {
      schemaVersion: 1 as const,
      campaignId,
      snapshotDigest: childStart.snapshotDigest,
      occurredAt:
        previous?.occurredAt ??
        (options.clock ?? (() => new Date()))().toISOString(),
    };
    const appended = await ledger.append({
      ...base,
      identity: input.identity,
      type: "child-report-recovered",
      runId: childStart.runId,
      sourceDiagnosticDigest: input.sourceDiagnosticDigest,
      reportArtifactDigest: reportRef.digest,
      parserVersion: input.parserVersion,
      artifacts: [{ kind: "child-report-recovery", digest: recoveryDigest }],
    });
    if (appended.status === "conflict")
      throw new Error(`Ledger conflict: ${input.identity}`);
    const recorded = await recordWordPressReport(input.report, {
      ledger,
      evidence,
      base,
      runId: childStart.runId,
      trialId: childStart.trialId ?? childStart.runId,
      snapshotDigest: childStart.snapshotDigest,
      reportArtifactDigest: reportRef.digest,
      runKind: "child",
      admissionContract:
        childStart.configuration.admissionContract ?? "direct/v1",
      existingIdentities,
      ...(input.versionedAdmission
        ? { parserVersion: input.parserVersion }
        : {}),
      ...(input.select === undefined ? {} : { select: input.select }),
      ...(input.selectCheck === undefined
        ? {}
        : { selectCheck: input.selectCheck }),
    });
    let findings = 0;
    let leads = 0;
    for (const candidate of recorded.candidates) {
      if (candidate.outcome !== "recorded" || candidate.status !== "appended")
        continue;
      if (candidate.kind === "finding") findings++;
      else leads++;
    }
    return { recovered: previous === undefined ? 1 : 0, findings, leads };
  };

  /** Recheck only Root candidates left pending before a completed child's check was recovered. */
  const reconcilePendingRoots = async (
    recoveredCheckIds: ReadonlySet<string>,
  ): Promise<Pick<Counts, "findings" | "leads">> => {
    if (recoveredCheckIds.size === 0) return { findings: 0, leads: 0 };
    const current = ledger.readAll({ campaignId }).map(({ event }) => event);
    const checkedClaims = new Set(
      current.flatMap((event) =>
        event.type === "audit-check-recorded" &&
        event.verdict === "verified" &&
        recoveredCheckIds.has(event.identity)
          ? [
              `${event.trialId}\0${event.snapshotDigest}\0${event.candidateKind}\0${event.claimDigest}`,
            ]
          : [],
      ),
    );
    const promoted = new Set(
      current.flatMap((event) =>
        event.type === "audit-candidate-promoted"
          ? [
              `${event.runId}\0${event.candidateKind}\0${event.candidateIndex}\0${event.claimDigest}`,
            ]
          : [],
      ),
    );
    const normalized = new Map(
      current.flatMap((event) =>
        event.type === "candidate-normalized"
          ? [[event.identity, event] as const]
          : [],
      ),
    );
    const pendingByRoot = new Map<string, Map<string, Pending>>();
    for (const event of current) {
      if (event.type !== "audit-candidate-pending") continue;
      const key = `${event.runId}-${event.candidateKind}-${event.candidateIndex}`;
      if (
        // A parser-specific reinterpretation may not match the original Root report.
        event.identity !== `audit-candidate-pending-${key}` ||
        event.reason !== "missing-matching-check" ||
        !checkedClaims.has(
          `${event.trialId}\0${event.snapshotDigest}\0${event.candidateKind}\0${event.claimDigest}`,
        ) ||
        promoted.has(
          `${event.runId}\0${event.candidateKind}\0${event.candidateIndex}\0${event.claimDigest}`,
        )
      )
        continue;
      const rootStart = started.get(event.runId);
      if (
        rootStart?.runKind !== "explore" ||
        rootStart.configuration.admissionContract !== "checked/v1" ||
        rootStart.trialId !== event.trialId ||
        rootStart.snapshotDigest !== event.snapshotDigest ||
        !finished.has(event.runId)
      )
        continue;
      const selected =
        pendingByRoot.get(event.runId) ?? new Map<string, Pending>();
      selected.set(`${event.candidateKind}\0${event.candidateIndex}`, event);
      pendingByRoot.set(event.runId, selected);
    }
    let findings = 0;
    let leads = 0;
    for (const [runId, selected] of pendingByRoot) {
      const rootStart = started.get(runId)!;
      const rootFinish = finished.get(runId)!;
      const receipt = await receiptOf(rootFinish);
      if (
        receipt.runId !== runId ||
        receipt.targetSnapshotDigest !== rootStart.snapshotDigest ||
        receipt.reportArtifactDigest === "unavailable"
      )
        throw new Error(
          "Archived Root receipt does not match its pending candidates",
        );
      const stored = await attachments.readByDigest(
        "findings",
        receipt.reportArtifactDigest,
      );
      if (stored.status !== "resolved")
        throw new Error("Archived Root report is unavailable");
      const report = archivedRootReportSchema.parse(
        JSON.parse(stored.bytes.toString("utf8")) as unknown,
      );
      const existingIdentities = new Set<string>();
      for (const pending of selected.values()) {
        const key = `${runId}-${pending.candidateKind}-${pending.candidateIndex}`;
        const normalizedIdentity = `candidate-normalized-${key}`;
        const normalizedEvent = normalized.get(normalizedIdentity);
        const pendingArtifact = pending.artifacts.find(
          (artifact) => artifact.kind === "candidate",
        );
        const normalizedArtifact = normalizedEvent?.artifacts.find(
          (artifact) => artifact.kind === "candidate",
        );
        if (
          normalizedEvent?.parserVersion !== undefined ||
          pendingArtifact === undefined ||
          normalizedArtifact?.digest !== pendingArtifact.digest
        )
          throw new Error("Archived Root pending candidate provenance differs");
        const raw = await evidence.readJson(
          pendingArtifact.digest,
          "candidate.json",
          z.unknown(),
          8 * 1024 * 1024,
        );
        const fromReport = (
          pending.candidateKind === "finding" ? report.findings : report.leads
        )[pending.candidateIndex];
        if (
          raw.status !== "resolved" ||
          fromReport === undefined ||
          canonicalJson(raw.value) !== canonicalJson(fromReport)
        )
          throw new Error(
            "Archived Root report differs from its pending candidate",
          );
        existingIdentities.add(normalizedIdentity);
        existingIdentities.add(pending.identity);
      }
      const recorded = await recordWordPressReport(report, {
        ledger,
        evidence,
        base: {
          schemaVersion: 1,
          campaignId,
          snapshotDigest: rootStart.snapshotDigest,
          occurredAt: (options.clock ?? (() => new Date()))().toISOString(),
        },
        runId,
        runKind: "root",
        admissionContract: "checked/v1",
        trialId: rootStart.trialId!,
        snapshotDigest: rootStart.snapshotDigest,
        reportArtifactDigest: receipt.reportArtifactDigest,
        existingIdentities,
        select: (kind, index) => selected.has(`${kind}\0${index}`),
      });
      for (const candidate of recorded.candidates) {
        if (candidate.outcome !== "recorded" || candidate.status !== "appended")
          continue;
        if (candidate.kind === "finding") findings++;
        else leads++;
      }
    }
    return { findings, leads };
  };

  /** Keep a later invalidated admission visible without deleting earlier evidence. */
  const reconcilePromotedRoots = async (
    recoveredEventIds: ReadonlySet<string>,
  ): Promise<void> => {
    if (recoveredEventIds.size === 0) return;
    const current = ledger.readAll({ campaignId }).map(({ event }) => event);
    const recovered = current.filter(
      (event): event is AuditCause =>
        recoveredEventIds.has(event.identity) &&
        (event.type === "audit-check-recorded" ||
          (event.type === "audit-candidate-pending" &&
            event.reason === "child-output")),
    );
    const eventIndex = new Map(
      current.map((event, index) => [event.identity, index] as const),
    );
    const disputed = new Set(
      current.flatMap((event) =>
        event.type === "audit-candidate-disputed"
          ? [event.promotedIdentity]
          : [],
      ),
    );
    const verifiedByRoot = new Map<
      string,
      Awaited<ReturnType<typeof verifiedAuditChecks>>
    >();
    for (const promotion of current) {
      if (
        promotion.type !== "audit-candidate-promoted" ||
        disputed.has(promotion.identity)
      )
        continue;
      const causes = recovered.filter(
        (event) =>
          (eventIndex.get(event.identity) ?? -1) >
            (eventIndex.get(promotion.identity) ?? -1) &&
          event.trialId === promotion.trialId &&
          event.snapshotDigest === promotion.snapshotDigest &&
          event.candidateKind === promotion.candidateKind &&
          event.claimDigest === promotion.claimDigest,
      );
      if (causes.length === 0) continue;
      const checkOptions = {
        ledger,
        evidence,
        base: {
          schemaVersion: 1 as const,
          campaignId,
          snapshotDigest: promotion.snapshotDigest,
          occurredAt: promotion.occurredAt,
        },
        runId: promotion.runId,
        trialId: promotion.trialId,
        snapshotDigest: promotion.snapshotDigest,
      };
      const claimKey = `${promotion.candidateKind}\0${promotion.claimDigest}`;
      let verified = verifiedByRoot.get(promotion.runId);
      if (verified === undefined) {
        verified = await verifiedAuditChecks(checkOptions, current);
        verifiedByRoot.set(promotion.runId, verified);
      }
      if (verified.has(claimKey)) continue;
      // Replay only the recovered facts after this promotion. The check which
      // originally enabled the promotion may itself have come from recovery.
      // A dispute needs a recovered fact that changes this gate from valid to
      // invalid, rather than merely sharing the claim digest.
      const causeIds = new Set(causes.map((event) => event.identity));
      const withoutCauses = current.filter(
        (event) => !causeIds.has(event.identity),
      );
      let wasVerified = (
        await verifiedAuditChecks(checkOptions, withoutCauses)
      ).has(claimKey);
      if (!wasVerified) continue;
      let cause: AuditCause | undefined;
      const included = new Set<string>();
      for (const event of causes) {
        included.add(event.identity);
        const withPrefix = current.filter(
          (candidate) =>
            !causeIds.has(candidate.identity) ||
            included.has(candidate.identity),
        );
        const nowVerified = (
          await verifiedAuditChecks(checkOptions, withPrefix)
        ).has(claimKey);
        if (wasVerified && !nowVerified) cause = event;
        wasVerified = nowVerified;
      }
      if (cause === undefined) continue;
      const recordIds: string[] = [];
      for (const event of current) {
        if (event.type !== "finding-recorded" && event.type !== "lead-recorded")
          continue;
        if (
          (promotion.candidateKind === "finding" &&
            event.type !== "finding-recorded") ||
          (promotion.candidateKind === "lead" &&
            event.type !== "lead-recorded") ||
          event.runId !== promotion.runId ||
          event.snapshotDigest !== promotion.snapshotDigest
        )
          continue;
        const artifact = event.artifacts.find(
          (entry) => entry.kind === promotion.candidateKind,
        );
        if (artifact === undefined) continue;
        const raw = await evidence.readJson(
          artifact.digest,
          `${promotion.candidateKind}.json`,
          z.unknown(),
          8 * 1024 * 1024,
        );
        if (
          raw.status !== "resolved" ||
          wordPressAuditClaimDigest(promotion.candidateKind, raw.value) !==
            promotion.claimDigest
        )
          continue;
        recordIds.push(
          event.type === "finding-recorded" ? event.findingId : event.leadId,
        );
      }
      const result = await ledger.append({
        schemaVersion: 1,
        campaignId,
        snapshotDigest: promotion.snapshotDigest,
        occurredAt: (options.clock ?? (() => new Date()))().toISOString(),
        identity: `audit-candidate-disputed-${canonicalDigest(promotion.identity).slice(7)}`,
        type: "audit-candidate-disputed",
        runId: promotion.runId,
        trialId: promotion.trialId,
        candidateKind: promotion.candidateKind,
        candidateIndex: promotion.candidateIndex,
        claimDigest: promotion.claimDigest,
        promotedIdentity: promotion.identity,
        causingEventIdentity: cause.identity,
        recordIds: [...new Set(recordIds)],
        artifacts: cause.artifacts,
      });
      if (result.status === "conflict")
        throw new Error(`Ledger conflict: ${promotion.identity}`);
    }
  };

  return {
    started,
    finished,
    receiptOf,
    bound,
    record,
    reconcilePendingRoots,
    reconcilePromotedRoots,
  };
}

const add = (left: Counts, right: Counts): Counts => ({
  recovered: left.recovered + right.recovered,
  findings: left.findings + right.findings,
  leads: left.leads + right.leads,
});

/**
 * Reinterpret child runs that failed with `child-final-message-not-report` from
 * their immutable private rollouts. The failed events stay; `child-report-recovered`
 * and the admitted Findings / Leads are appended (docs/OPERATIONS.md).
 */
export async function recoverWordPressChildReports(
  options: Options,
): Promise<Counts> {
  const { finished, bound, record } = archive(options);
  let counts: Counts = { recovered: 0, findings: 0, leads: 0 };
  for (const childFinish of finished.values()) {
    if (
      childFinish.outcome !== "failed" ||
      childFinish.reason !== "schema" ||
      childFinish.reasonDetail !== "child-final-message-not-report"
    )
      continue;
    const child = await bound(childFinish);
    if (
      child.childReceipt.terminal !== "incomplete" ||
      child.childReceipt.reason !== "schema" ||
      child.childReceipt.reasonDetail !== "child-final-message-not-report"
    )
      throw new Error("Archived receipts do not match the ledger");
    counts = add(
      counts,
      await record({
        identity: `child-report-recovered-${child.childStart.runId}-v1`,
        parserVersion,
        childStart: child.childStart,
        sourceDiagnosticDigest: child.sourceDiagnosticDigest,
        report: recoverChildReportFromRollout(child.childRaw, child.expected),
        versionedAdmission: false,
      }),
    );
  }
  return counts;
}

/**
 * #539: a completed Codex child answered each Root follow-up with a new report,
 * and the capture kept only the last one. Re-read every turn from the archived
 * rollout and admit only the claims the recorded report lacks, so the Findings
 * already in the ledger are not recorded twice. The rollout must reproduce the
 * recorded report exactly; otherwise nothing is appended.
 */
export async function recoverWordPressChildTurnReports(
  options: Options & { readonly dryRun?: boolean },
): Promise<Counts & { readonly skipped: number }> {
  const {
    started,
    finished,
    receiptOf,
    bound,
    record,
    reconcilePendingRoots,
    reconcilePromotedRoots,
  } = archive(options);
  let counts: Counts = { recovered: 0, findings: 0, leads: 0 };
  let skipped = 0;
  const recoveredCheckIds = new Set<string>();
  const recoveredEventIds = new Set<string>();
  for (const childFinish of finished.values()) {
    const childStart = started.get(childFinish.runId);
    if (childFinish.outcome !== "completed" || childStart?.runKind !== "child")
      continue;
    // A Root still running (or never finished) has no sealed rollout yet; a later run reads it.
    if (
      childStart.parentRunId === undefined ||
      !finished.has(childStart.parentRunId)
    ) {
      skipped++;
      continue;
    }
    // Claude Code children keep their own transcript form (no Codex turns).
    if ((await receiptOf(childFinish)).claudeCliVersion !== undefined) continue;
    const child = await bound(childFinish);
    if (
      child.childReceipt.terminal !== "completed" ||
      child.childReceipt.reportArtifactDigest === undefined
    )
      throw new Error("Archived receipts do not match the ledger");
    const { recorded, merged } = recoverChildTurnReportsFromRollout(
      child.childRaw,
      child.expected,
    );
    if (canonicalDigest(recorded) !== child.childReceipt.reportArtifactDigest)
      throw new Error("Archived child rollout does not reproduce its report");
    const known = {
      finding: new Set(recorded.findings.map((claim) => canonicalJson(claim))),
      lead: new Set(recorded.leads.map((claim) => canonicalJson(claim))),
    };
    const added = {
      finding: merged.findings.flatMap((claim, index) =>
        known.finding.has(canonicalJson(claim)) ? [] : [index],
      ),
      lead: merged.leads.flatMap((claim, index) =>
        known.lead.has(canonicalJson(claim)) ? [] : [index],
      ),
      // Replay the whole check sequence when it differs. Membership would drop
      // a final A in A -> B -> A when the original capture kept only A.
      check:
        canonicalJson(merged.checks ?? []) ===
        canonicalJson(recorded.checks ?? [])
          ? []
          : (merged.checks ?? []).map((_, index) => index),
    };
    if (added.finding.length + added.lead.length + added.check.length === 0)
      continue;
    if (options.dryRun === true) {
      counts = add(counts, {
        recovered: 1,
        findings:
          child.childStart.configuration.admissionContract === "checked/v1"
            ? 0
            : added.finding.length,
        leads:
          child.childStart.configuration.admissionContract === "checked/v1"
            ? 0
            : added.lead.length,
      });
      continue;
    }
    counts = add(
      counts,
      await record({
        identity: `child-report-recovered-${child.childStart.runId}-${turnsParserVersion}`,
        parserVersion: turnsParserVersion,
        childStart: child.childStart,
        sourceDiagnosticDigest: child.sourceDiagnosticDigest,
        report: merged,
        select: (kind, index) => added[kind].includes(index),
        selectCheck: (index) => added.check.includes(index),
        versionedAdmission: true,
      }),
    );
    // The recovery can stop after admission and before Root reconciliation.
    // Include the deterministic identities admitted by an earlier invocation
    // when replaying the same sealed rollout.
    const recoveredIdentities = new Set([
      ...added.check.map(
        (index) =>
          `audit-check-${child.childStart.runId}-${index}-${turnsParserVersion}`,
      ),
      ...(["finding", "lead"] as const).flatMap((kind) =>
        added[kind].map(
          (index) =>
            `audit-candidate-pending-${child.childStart.runId}-${kind}-${index}-${turnsParserVersion}`,
        ),
      ),
    ]);
    for (const { event } of options.ledger.readAll({
      campaignId: options.campaignId,
    }))
      if (
        recoveredIdentities.has(event.identity) &&
        (event.type === "audit-check-recorded" ||
          (event.type === "audit-candidate-pending" &&
            event.reason === "child-output"))
      )
        recoveredEventIds.add(event.identity);
    if (
      child.childStart.configuration.admissionContract === "checked/v1" &&
      added.check.length > 0
    )
      for (const index of added.check)
        recoveredCheckIds.add(
          `audit-check-${child.childStart.runId}-${index}-${turnsParserVersion}`,
        );
  }
  if (options.dryRun !== true) {
    const promoted = await reconcilePendingRoots(recoveredCheckIds);
    counts = add(counts, { recovered: 0, ...promoted });
    await reconcilePromotedRoots(recoveredEventIds);
  }
  return { ...counts, skipped };
}
