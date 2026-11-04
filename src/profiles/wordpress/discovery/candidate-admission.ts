/**
 * One admission path for every WordPress candidate report: the campaign
 * recorder, the archive reinterpretation and the child-report recovery all
 * call `recordWordPressReport`, so a report yields the same ledger events
 * whichever way it arrives (ADR 0018, #185).
 */
import { z } from "zod";

import type {
  CandidateReport,
  RecordedCandidate,
  RecordedReport,
  ReportRecorderContext,
} from "../../../discovery/record-discovery-report.js";
import {
  canonicalDigest,
  canonicalJson,
} from "../../../infrastructure/canonical-json.js";
import { admitFindingGroup } from "../../../ledger/finding-groups.js";
import type { Ledger, LedgerEventV1 } from "../../../ledger/index.js";
import { classifyWordPressPrecondition } from "../verification/precondition-class.js";
import { wordPressAuditCheckSchema } from "./audit-check.js";
import {
  admitWordPressFinding,
  wordpressFindingClaimSchema,
  wordPressDeclaredPreconditionPark,
  wordPressFindingGroupKeys,
} from "./finding.js";
import {
  admitWordPressLead,
  wordpressLeadClaimSchema,
  wordPressLeadSignature,
} from "./lead.js";
import {
  classifyWordPressCandidate,
  normalizeWordPressCandidate,
} from "./normalize-candidate.js";
import { isWordPressProgrammeImpact } from "./programme-impacts.js";

type Kind = RecordedCandidate["kind"];
type Status = RecordedCandidate["status"];
type LedgerEvent = Parameters<Ledger["append"]>[0];
type AuditCheckRef = NonNullable<
  Extract<LedgerEventV1, { type: "finding-recorded" }>["auditCheck"]
>;

export type WordPressReportRecordingOptions = ReportRecorderContext & {
  /** Reinterpretation under a named parser; identities carry it so prior interpretations stay. */
  readonly parserVersion?: string;
  /** Identities already in the ledger: matching events count as existing instead of being appended. */
  readonly existingIdentities?: ReadonlySet<string>;
  /** Restrict to some candidates of the report (archived rejected or held output). */
  readonly select?: (kind: Kind, index: number) => boolean;
  /** Restrict archived AI checks to ones the recorded child report lacked. */
  readonly selectCheck?: (index: number) => boolean;
};

const IDENTITY_MISMATCH = "Candidate identity mismatch";

async function appendEvent(
  options: WordPressReportRecordingOptions,
  conflict: string,
  event: LedgerEvent,
): Promise<Status> {
  if (options.existingIdentities?.has(event.identity)) return "existing";
  const appended = await options.ledger.append(event);
  if (appended.status === "conflict") throw new Error(conflict);
  return appended.status;
}

function findingContext(options: WordPressReportRecordingOptions) {
  return {
    runId: options.runId,
    snapshotDigest: options.snapshotDigest,
    reportArtifactDigest: options.reportArtifactDigest,
  };
}

async function recordFinding(
  options: WordPressReportRecordingOptions,
  index: number,
  value: unknown,
  hold: (error: unknown) => Promise<RecordedCandidate>,
  auditCheck?: AuditCheckRef,
): Promise<RecordedCandidate> {
  let finding;
  try {
    finding = admitWordPressFinding(value, findingContext(options));
  } catch (error) {
    return await hold(error);
  }
  if (
    finding.discoveryRunId !== options.runId ||
    finding.snapshotDigest !== options.snapshotDigest
  )
    return await hold(new Error(IDENTITY_MISMATCH));
  const findingDigest = await options.evidence.putFiles({
    "finding.json": canonicalJson(finding),
  });
  const { preconditionClass } = classifyWordPressPrecondition({
    configurationPrecondition: finding.configurationPrecondition,
  });
  const common = {
    ...options.base,
    artifacts: [{ kind: "finding", digest: findingDigest }],
    findingId: finding.findingId,
    runId: options.runId,
    category: finding.impact,
    preconditionClass,
  };
  // Programme Boundary の外にある効果を先に止める。次に、agent が申告欄で
  // 管理者の脆弱な設定か、ベンダーだけが書けるデータを選んだ Finding を止める
  // （#613、ADR 0038 追記 13）。文言からは判定しない（追記 8）。
  const declared = wordPressDeclaredPreconditionPark(finding);
  const park = !isWordPressProgrammeImpact(finding.impact)
    ? { reason: "outside-programme-boundary" as const }
    : declared !== undefined
      ? {
          reason: "declared-precondition" as const,
          declaredPrecondition: declared,
        }
      : undefined;
  if (park !== undefined) {
    const status = await appendEvent(
      options,
      "Parked finding identity conflict",
      {
        ...common,
        identity: `discovery-finding-parked-${finding.findingId}`,
        type: "finding-parked",
        ...park,
      },
    );
    return { kind: "finding", index, outcome: "parked", status };
  }
  const status = await appendEvent(options, "Finding identity conflict", {
    ...common,
    identity: `discovery-finding-${finding.findingId}`,
    type: "finding-recorded",
    trialId: options.trialId,
    ...(auditCheck === undefined ? {} : { auditCheck }),
    ...(finding.historyRecordId === undefined
      ? {}
      : { historyRecordId: finding.historyRecordId }),
    // #424: 同じ Snapshot で plugin 側の file:function が重なる Finding の群。表示と順序だけに使う。
    group: admitFindingGroup(options.ledger, {
      campaignId: options.base.campaignId,
      snapshotDigest: options.snapshotDigest,
      findingId: finding.findingId,
      keys: wordPressFindingGroupKeys(finding),
    }),
  });
  return {
    kind: "finding",
    index,
    outcome: "recorded",
    status,
    signature: canonicalDigest({
      claim: finding.claim,
      impact: finding.impact,
      sourceTrace: finding.sourceTrace,
    }),
  };
}

async function recordLead(
  options: WordPressReportRecordingOptions,
  index: number,
  value: unknown,
  hold: (error: unknown) => Promise<RecordedCandidate>,
  auditCheck?: AuditCheckRef,
): Promise<RecordedCandidate> {
  let lead;
  try {
    lead = admitWordPressLead(value, {
      ...findingContext(options),
      trialId: options.trialId,
    });
  } catch (error) {
    return await hold(error);
  }
  if (
    lead.discoveryRunId !== options.runId ||
    lead.trialId !== options.trialId ||
    lead.snapshotDigest !== options.snapshotDigest
  )
    return await hold(new Error(IDENTITY_MISMATCH));
  const leadDigest = await options.evidence.putFiles({
    "lead.json": canonicalJson(lead),
  });
  const status = await appendEvent(options, "Lead identity conflict", {
    ...options.base,
    artifacts: [{ kind: "lead", digest: leadDigest }],
    identity: `discovery-lead-${lead.leadId}`,
    type: "lead-recorded",
    leadId: lead.leadId,
    runId: options.runId,
    trialId: options.trialId,
    missingEdge: lead.missingEdge,
    primitive: lead.primitive,
    storageKind: lead.storage?.kind ?? "none",
    ...(auditCheck === undefined ? {} : { auditCheck }),
  });
  return {
    kind: "lead",
    index,
    outcome: "recorded",
    status,
    signature: wordPressLeadSignature(lead),
  };
}

function claimFor(kind: Kind, raw: unknown) {
  const value = normalizeWordPressCandidate(raw).value;
  return kind === "finding"
    ? wordpressFindingClaimSchema.parse(value)
    : wordpressLeadClaimSchema.parse(value);
}

/** Stable normalized claim key shared by admission and archived reconciliation. */
export function wordPressAuditClaimDigest(kind: Kind, raw: unknown): string {
  const value = z.record(z.string(), z.unknown()).parse(raw);
  const fields = Object.keys(
    kind === "finding"
      ? wordpressFindingClaimSchema.shape
      : wordpressLeadClaimSchema.shape,
  );
  const claim = Object.fromEntries(
    fields
      .filter((field) => Object.hasOwn(value, field))
      .map((field) => [field, value[field]]),
  );
  return canonicalDigest(claimFor(kind, claim));
}

/** Only actual completed child runs can provide a checked/v1 promotion receipt. */
export async function verifiedAuditChecks(
  options: Pick<
    WordPressReportRecordingOptions,
    "ledger" | "evidence" | "base" | "runId" | "trialId" | "snapshotDigest"
  >,
  sourceEvents?: readonly LedgerEventV1[],
): Promise<ReadonlyMap<string, AuditCheckRef>> {
  const events =
    sourceEvents ??
    options.ledger
      .readAll({ campaignId: options.base.campaignId })
      .map(({ event }) => event);
  const starts = new Map(
    events.flatMap((event) =>
      event.type === "discovery-run-started"
        ? [[event.runId, event] as const]
        : [],
    ),
  );
  const finishes = new Map(
    events.flatMap((event) =>
      event.type === "discovery-run-finished"
        ? [[event.runId, event] as const]
        : [],
    ),
  );
  const currentRoot = starts.get(options.runId);
  if (
    currentRoot?.runKind !== "explore" ||
    currentRoot.trialId !== options.trialId ||
    currentRoot.snapshotDigest !== options.snapshotDigest ||
    currentRoot.configuration.admissionContract !== "checked/v1"
  )
    return new Map();
  const childClaimOrigins = new Map<string, Set<string>>();
  for (const event of events) {
    if (
      event.type !== "audit-candidate-pending" ||
      event.reason !== "child-output" ||
      event.trialId !== options.trialId ||
      event.snapshotDigest !== options.snapshotDigest
    )
      continue;
    const key = `${event.candidateKind}\0${event.claimDigest}`;
    const origins = childClaimOrigins.get(key) ?? new Set<string>();
    origins.add(event.runId);
    childClaimOrigins.set(key, origins);
  }
  const latestByChildAndClaim = new Map<
    string,
    Extract<LedgerEventV1, { type: "audit-check-recorded" }>
  >();
  const availableChecks = new Set<string>();
  for (const check of events) {
    if (
      check.type !== "audit-check-recorded" ||
      check.trialId !== options.trialId ||
      check.snapshotDigest !== options.snapshotDigest ||
      check.runId === options.runId
    )
      continue;
    if (
      childClaimOrigins
        .get(`${check.candidateKind}\0${check.claimDigest}`)
        ?.has(check.runId)
    )
      continue;
    const child = starts.get(check.runId);
    const parent = starts.get(child?.parentRunId ?? "");
    const finished = finishes.get(check.runId);
    if (
      child?.runKind !== "child" ||
      child.trialId !== options.trialId ||
      child.snapshotDigest !== options.snapshotDigest ||
      child.configuration.admissionContract !== "checked/v1" ||
      parent?.runKind !== "explore" ||
      parent.trialId !== options.trialId ||
      parent.snapshotDigest !== options.snapshotDigest ||
      parent.configuration.admissionContract !== "checked/v1" ||
      finished?.outcome !== "completed" ||
      finished.snapshotDigest !== options.snapshotDigest
    )
      continue;
    const artifact = check.artifacts.find(
      (entry) => entry.kind === "audit-check",
    );
    if (
      artifact !== undefined &&
      (await options.evidence.resolve(artifact.digest)).status === "resolved"
    )
      availableChecks.add(check.identity);
    const key = `${check.runId}\0${check.candidateKind}\0${check.claimDigest}`;
    // A recovered full-turn transcript is appended after the original capture.
    // Its final check supersedes the capture even if its local index is lower.
    latestByChildAndClaim.set(key, check);
  }
  const grouped = new Map<
    string,
    Extract<LedgerEventV1, { type: "audit-check-recorded" }>[]
  >();
  for (const check of latestByChildAndClaim.values()) {
    const key = `${check.candidateKind}\0${check.claimDigest}`;
    const group = grouped.get(key) ?? [];
    group.push(check);
    grouped.set(key, group);
  }
  const result = new Map<string, AuditCheckRef>();
  for (const [key, group] of grouped) {
    // Conflicting independent checks keep the claim pending for another pass.
    if (
      group.some(
        (check) =>
          check.verdict !== "verified" || !availableChecks.has(check.identity),
      )
    )
      continue;
    const check = group[0]!;
    const digest = check.artifacts.find(
      (entry) => entry.kind === "audit-check",
    )!.digest;
    result.set(key, {
      runId: check.runId,
      checkIndex: check.checkIndex,
      digest,
    });
  }
  return result;
}

/** Seal every AI check; malformed checks are visible but never promote a claim. */
async function recordAuditChecks(
  report: CandidateReport,
  options: WordPressReportRecordingOptions,
): Promise<void> {
  for (const [index, raw] of (report.checks ?? []).entries()) {
    if (options.selectCheck?.(index) === false) continue;
    const key = `${options.runId}-${index}${
      options.parserVersion === undefined ? "" : `-${options.parserVersion}`
    }`;
    const digest = await options.evidence.putFiles({
      "audit-check.json": canonicalJson(raw),
    });
    const common = {
      ...options.base,
      runId: options.runId,
      trialId: options.trialId,
      checkIndex: index,
      artifacts: [{ kind: "audit-check", digest }],
    };
    let parsed:
      | {
          readonly kind: Kind;
          readonly verdict: "verified" | "replace" | "refuted" | "blocked";
          readonly claimDigest: string;
        }
      | undefined;
    let issuePaths: string[] | undefined;
    try {
      if (options.runKind !== "child") throw new Error("runKind");
      const check = wordPressAuditCheckSchema.parse(raw);
      parsed = {
        kind: check.kind,
        verdict: check.verdict,
        claimDigest: canonicalDigest(claimFor(check.kind, check.candidate)),
      };
    } catch (error) {
      issuePaths =
        error instanceof z.ZodError
          ? error.issues.map((issue) => issue.path.join("."))
          : ["runKind"];
    }
    if (parsed === undefined) {
      await appendEvent(options, "Held audit check identity conflict", {
        ...common,
        identity: `audit-check-held-${key}`,
        type: "audit-check-held",
        issuePaths: issuePaths ?? ["admission"],
      });
      continue;
    }
    await appendEvent(options, "Audit check identity conflict", {
      ...common,
      identity: `audit-check-${key}`,
      type: "audit-check-recorded",
      candidateKind: parsed.kind,
      claimDigest: parsed.claimDigest,
      verdict: parsed.verdict,
    });
  }
}

async function recordCandidate(
  options: WordPressReportRecordingOptions,
  kind: Kind,
  index: number,
  raw: unknown,
  verified: ReadonlyMap<string, AuditCheckRef>,
): Promise<RecordedCandidate> {
  const key = `${options.runId}-${kind}-${index}${
    options.parserVersion === undefined ? "" : `-${options.parserVersion}`
  }`;
  const version =
    options.parserVersion === undefined
      ? {}
      : { parserVersion: options.parserVersion };
  const rawDigest = await options.evidence.putFiles({
    "candidate.json": canonicalJson(raw),
  });
  const normalized = normalizeWordPressCandidate(raw);
  const candidate = {
    runId: options.runId,
    candidateKind: kind,
    candidateIndex: index,
    ...version,
    artifacts: [{ kind: "candidate", digest: rawDigest }],
  };
  await appendEvent(options, "Candidate normalization identity conflict", {
    ...options.base,
    ...candidate,
    identity: `candidate-normalized-${key}`,
    type: "candidate-normalized",
    changes: normalized.changes,
  });
  const hold = async (error: unknown): Promise<RecordedCandidate> => {
    const issuePaths =
      error instanceof z.ZodError
        ? error.issues.map((issue) => issue.path.join("."))
        : [
            error instanceof Error && error.message === IDENTITY_MISMATCH
              ? "identity"
              : "admission",
          ];
    const status = await appendEvent(
      options,
      "Candidate hold identity conflict",
      {
        ...options.base,
        ...candidate,
        identity: `candidate-held-${key}`,
        type: "candidate-held",
        issuePaths,
        ...(error instanceof z.ZodError
          ? { issueCodes: error.issues.map((issue) => issue.code) }
          : {}),
        ...classifyWordPressCandidate(normalized.value, kind),
      },
    );
    return { kind, index, outcome: "held", status };
  };
  if (options.admissionContract === "checked/v1") {
    let claim;
    try {
      claim = claimFor(kind, normalized.value);
    } catch (error) {
      return await hold(error);
    }
    const claimDigest = canonicalDigest(claim);
    const check =
      options.runKind === "root"
        ? verified.get(`${kind}\0${claimDigest}`)
        : undefined;
    if (check === undefined) {
      const status = await appendEvent(
        options,
        "Pending audit candidate identity conflict",
        {
          ...options.base,
          identity: `audit-candidate-pending-${key}`,
          type: "audit-candidate-pending",
          runId: options.runId,
          trialId: options.trialId,
          candidateKind: kind,
          candidateIndex: index,
          claimDigest,
          reason:
            options.runKind === "child"
              ? "child-output"
              : "missing-matching-check",
          artifacts: [{ kind: "candidate", digest: rawDigest }],
        },
      );
      return { kind, index, outcome: "pending", status };
    }
    const promoted =
      kind === "finding"
        ? await recordFinding(options, index, normalized.value, hold, check)
        : await recordLead(options, index, normalized.value, hold, check);
    if (promoted.outcome !== "held")
      await appendEvent(options, "Audit promotion identity conflict", {
        ...options.base,
        identity: `audit-candidate-promoted-${key}`,
        type: "audit-candidate-promoted",
        runId: options.runId,
        trialId: options.trialId,
        candidateKind: kind,
        candidateIndex: index,
        claimDigest,
        checkRunId: check.runId,
        checkIndex: check.checkIndex,
      });
    return promoted;
  }
  return kind === "finding"
    ? await recordFinding(options, index, normalized.value, hold)
    : await recordLead(options, index, normalized.value, hold);
}

/** Normalize every candidate of one report, then record, park or hold each of them. */
export async function recordWordPressReport(
  report: CandidateReport,
  options: WordPressReportRecordingOptions,
): Promise<RecordedReport> {
  if (
    options.admissionContract === "checked/v1" &&
    options.runKind === undefined
  )
    throw new Error("A checked report must name its actual run kind");
  if (options.admissionContract === "checked/v1")
    await recordAuditChecks(report, options);
  const verified =
    options.admissionContract === "checked/v1" && options.runKind === "root"
      ? await verifiedAuditChecks(options)
      : new Map<string, AuditCheckRef>();
  const candidates: RecordedCandidate[] = [];
  for (const kind of ["finding", "lead"] as const) {
    const raws = kind === "finding" ? report.findings : report.leads;
    for (const [index, raw] of raws.entries()) {
      if (options.select?.(kind, index) === false) continue;
      candidates.push(
        await recordCandidate(options, kind, index, raw, verified),
      );
    }
  }
  return { candidates };
}
