import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
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
import { recordWordPressReport } from "./candidate-admission.js";

const parserVersion = "child-coverage-array-v1";
/** #539: completed Codex children whose earlier turns' reports the capture dropped. */
const turnsParserVersion = "child-turns-merge-v1";

type Started = Extract<LedgerEventV1, { type: "discovery-run-started" }>;
type Finished = Extract<LedgerEventV1, { type: "discovery-run-finished" }>;
type Recovery = Extract<LedgerEventV1, { type: "child-report-recovered" }>;
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
      existingIdentities,
      ...(input.versionedAdmission
        ? { parserVersion: input.parserVersion }
        : {}),
      ...(input.select === undefined ? {} : { select: input.select }),
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

  return { started, finished, receiptOf, bound, record };
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
  const { started, finished, receiptOf, bound, record } = archive(options);
  let counts: Counts = { recovered: 0, findings: 0, leads: 0 };
  let skipped = 0;
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
    };
    if (added.finding.length + added.lead.length === 0) continue;
    if (options.dryRun === true) {
      counts = add(counts, {
        recovered: 1,
        findings: added.finding.length,
        leads: added.lead.length,
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
        versionedAdmission: true,
      }),
    );
  }
  return { ...counts, skipped };
}
