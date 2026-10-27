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
import type { Ledger } from "../../../ledger/index.js";
import { classifyWordPressPrecondition } from "../verification/precondition-class.js";
import {
  admitWordPressFinding,
  wordPressDeclaredPreconditionPark,
  wordPressFindingGroupKeys,
} from "./finding.js";
import { admitWordPressLead, wordPressLeadSignature } from "./lead.js";
import {
  classifyWordPressCandidate,
  normalizeWordPressCandidate,
} from "./normalize-candidate.js";
import { isWordPressProgrammeImpact } from "./programme-impacts.js";

type Kind = RecordedCandidate["kind"];
type Status = RecordedCandidate["status"];
type LedgerEvent = Parameters<Ledger["append"]>[0];

export type WordPressReportRecordingOptions = ReportRecorderContext & {
  /** Reinterpretation under a named parser; identities carry it so prior interpretations stay. */
  readonly parserVersion?: string;
  /** Identities already in the ledger: matching events count as existing instead of being appended. */
  readonly existingIdentities?: ReadonlySet<string>;
  /** Restrict to some candidates of the report (archived rejected or held output). */
  readonly select?: (kind: Kind, index: number) => boolean;
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
    ...(finding.historyRecordId === undefined
      ? {}
      : { historyRecordId: finding.historyRecordId }),
    ...(options.partition === undefined
      ? {}
      : { partition: options.partition }),
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
    ...(options.partition === undefined
      ? {}
      : { partition: options.partition }),
  });
  return {
    kind: "lead",
    index,
    outcome: "recorded",
    status,
    signature: wordPressLeadSignature(lead),
  };
}

async function recordCandidate(
  options: WordPressReportRecordingOptions,
  kind: Kind,
  index: number,
  raw: unknown,
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
  return kind === "finding"
    ? await recordFinding(options, index, normalized.value, hold)
    : await recordLead(options, index, normalized.value, hold);
}

/** Normalize every candidate of one report, then record, park or hold each of them. */
export async function recordWordPressReport(
  report: CandidateReport,
  options: WordPressReportRecordingOptions,
): Promise<RecordedReport> {
  const candidates: RecordedCandidate[] = [];
  for (const kind of ["finding", "lead"] as const) {
    const raws = kind === "finding" ? report.findings : report.leads;
    for (const [index, raw] of raws.entries()) {
      if (options.select?.(kind, index) === false) continue;
      candidates.push(await recordCandidate(options, kind, index, raw));
    }
  }
  return { candidates };
}
