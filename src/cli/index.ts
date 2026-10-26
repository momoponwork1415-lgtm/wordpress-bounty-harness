import { z } from "zod";

import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { summarizeRecordedRuntimes } from "../discovery/index.js";
import { canonicalJson } from "../infrastructure/canonical-json.js";
import {
  type CampaignFunnel,
  type ResumeRow,
  type StopRow,
  type FunnelCounts,
  type LedgerEventV1,
} from "../ledger/index.js";
import {
  exportReviewBundle,
  exportReviewBundleV2,
  MANUAL_LAB_RECEIPT_FILE,
  manualObservationEvidenceStatus,
  recordManualObservation,
  recordManualObservationLabReady,
  type DuplicateCheck,
  type DuplicateResult,
  type HttpEvidenceReader,
  type Review,
  type ReviewItem,
  type ReviewQueue,
  type ReviewRef,
  type StateDiffReader,
  type VerifierRecordReader,
} from "../review/index.js";
import {
  MAXIMUM_CAMPAIGN_ID_LENGTH,
  type CampaignSummary,
  type ReverificationSummary,
  type TargetLimit,
  type VerifyNextSummary,
} from "./pipeline.js";
import { holdDiscoverySweep } from "./continuous.js";
import {
  continuousCommand,
  type ContinuousHostStatus,
} from "./continuous-cli.js";
import {
  BOOL,
  GLOBAL_OPTIONS,
  STR,
  STRS,
  commandIndex,
  parserOptions,
  usageText,
  type CommandShape,
  type FlagSet,
  type FlagValues,
} from "./command-table.js";
import { openState, type CliState } from "./state.js";

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
  /** Interactive hosts ask only after a successful human-facing command. */
  askMinutes?(
    action: "read" | "reproduce" | "submit" | "outcome",
  ): Promise<number>;
}

export type { CliState } from "./state.js";

export type LabDownSummary = {
  readonly labId: string | null;
  readonly removed: {
    readonly containers: readonly string[];
    readonly networks: readonly string[];
    readonly volumes: readonly string[];
  };
  readonly remaining: {
    readonly containers: readonly string[];
    readonly networks: readonly string[];
    readonly volumes: readonly string[];
  };
};

export interface CliSelectionReport {
  readonly batchId: string | null;
  /** available, stale or unavailable public listings; manual for named slugs. */
  readonly sourceStatus?: string;
  /** Whether the earlier generations' history took part in exclusion. */
  readonly legacyHistory?:
    | { readonly status: "unavailable" }
    | {
        readonly status: "available";
        readonly digest: string;
        readonly started: number;
        readonly ambiguous: number;
        readonly reconsider: number;
      };
  /** The public advisory mirror behind the history score: timestamp and digest, no record content (ADR 0037). */
  readonly advisoryHistory?:
    | { readonly status: "not-used" }
    | {
        readonly status: "used";
        readonly asOf: string;
        readonly digest: string;
        readonly recordCount: number;
        readonly lastRefreshFailed: boolean;
        readonly windowDays: number;
        readonly countCap: number;
        readonly maximumAgeDays: number;
      };
  /** The policy's fallback band that produced this selection; absent for the primary band (ADR 0037 addendum). */
  readonly cascadeStep?: number;
  /** Eligible counts of the bands tried, step 0 being the primary band. */
  readonly cascade?: readonly {
    readonly step: number;
    readonly eligible: number;
  }[];
  readonly selected: readonly {
    readonly targetId: string;
    readonly version: string;
    readonly score: number;
    readonly scoreBreakdown: Readonly<Record<string, number | undefined>>;
    readonly advisoryHistory?: {
      readonly count: number;
      readonly payingClassCount: number;
      readonly latestPublished?: string | undefined;
    };
    readonly cascadeStep?: number;
    readonly observedAt: string;
    readonly sourceUrl?: string;
  }[];
  readonly excluded: readonly {
    readonly targetId: string;
    readonly reasons: readonly string[];
    readonly observedAt?: string;
    readonly sourceUrl?: string;
  }[];
}

/** What `campaign resume --run` did: a reasoned refusal without events, or the new segment's outcome. */
export type ResumeCampaignRunSummary =
  | {
      readonly status: "refused";
      readonly reason: string;
      readonly detail?: string;
    }
  | {
      readonly status: "resumed";
      readonly runId: string;
      readonly resumesRun: string;
      readonly trialId: string;
      readonly segment: number;
      readonly remainingWallMs: number;
      readonly outcome: string;
      readonly failure?: {
        readonly reason: string;
        readonly reasonDetail?: string;
      };
      readonly wallTimeMs: number;
      readonly findingsRecorded: number;
    };

/** A profile composition: everything target-specific the commands need. */
export interface CliProfile {
  review(state: CliState): Review;
  /** A profile may provide a fresh, foreground Lab for human reproduction. */
  reviewLab?(
    state: CliState,
    input: { readonly packageDigest: string },
  ): Promise<{
    readonly endpoint: string;
    readonly networkName: string;
    readonly recorderIp: string;
    readonly receiverIp: string;
    readonly attackerAccounts: unknown;
    readonly administrator: unknown;
    readonly browserImage: string;
    close(): Promise<void>;
  }>;
  /** Profile-owned admission of an incomplete observation to a manual Lab. */
  reviewLabPackage?(
    state: CliState,
    ref: ReviewRef,
  ): Promise<{
    readonly packageDigest: string;
    readonly recipeDigest: string;
    readonly evidenceDigest: string;
  } | null>;
  /** Lines describing the public history mirror, and whether it is fresh; null when none is configured. */
  historyStatus(
    state: CliState,
  ): { readonly fresh: boolean; readonly line: string } | null;
  select(
    state: CliState,
    input: {
      readonly configPath: string;
      /** Fewest frozen targets that make a batch; fewer selects nothing. */
      readonly minimum?: number;
      /** The runner's stop request; true before recording selects nothing (#302). */
      readonly stop?: () => boolean;
    },
  ): Promise<CliSelectionReport>;
  /**
   * The runner only, before it continues a campaign after a restart: when the
   * campaign's selection batch was frozen under another policy, record that it
   * is discarded and return its id; null when the batch can run (#302).
   */
  discardStaleSelection?(
    state: CliState,
    input: {
      readonly campaignId: string;
      readonly configPath: string;
      /** Replaces the campaign config's selection policy path in process. */
      readonly selectionPolicyPath?: string;
    },
  ): Promise<string | null>;
  runCampaign(
    state: CliState,
    input: {
      readonly campaignId: string;
      readonly configPath: string;
      /** A profile target name, or null for every selected target. */
      readonly target: string | null;
      /** Explicit independent Trials on the same Snapshot. */
      readonly repeat?: number;
      /** Checked before each next target; true drains the campaign as `operator`. */
      readonly stop?: () => boolean;
      /** Aborts exploration currently running when continuous mode receives SIGTERM. */
      readonly signal?: AbortSignal;
      /** Replaces the campaign config's selection policy path in process. */
      readonly selectionPolicyPath?: string;
      /**
       * The runner only (ADR 0036, 2026-10-19 addendum 3): a run of this campaign
       * whose host died is resumed in its target's slot; a refusal is logged and
       * the target runs again as a new Trial.
       */
      readonly resumeInterrupted?: { log(line: string): void };
      /** The runner only, after provider backoff: resume a stopped Codex Trial. */
      readonly resumeProviderLimited?: { log(line: string): void };
      /** The runner only: the operator's live limit under maxConcurrentTargets. */
      readonly targetLimit?: TargetLimit;
    },
  ): Promise<CampaignSummary>;
  /** The campaign config's maxConcurrentTargets, the ceiling of `continuous concurrency`. */
  targetCeiling?(configPath: string): Promise<number>;
  /** The campaign config's per-runtime caps, the ceilings of `continuous concurrency --runtime`. */
  runtimeCeilings?(
    configPath: string,
  ): Promise<Readonly<Record<string, number>>>;
  /**
   * Operator-triggered resume of one stopped Root thread in a new sandbox
   * (ADR 0036). Refusals are printed with their reason; only sealing a run whose
   * host died writes its finish before a later rule may still refuse.
   */
  resumeCampaignRun?(
    state: CliState,
    input: {
      readonly campaignId: string;
      readonly runId: string;
      readonly configPath: string;
    },
  ): Promise<ResumeCampaignRunSummary>;
  /**
   * Hand the next Finding of the handoff queue (every campaign unless one is
   * named) to the verification skill in a fresh Lab (#423).
   */
  verifyNext?(
    state: CliState,
    input: {
      readonly campaignId?: string;
      readonly configPath: string;
      /** Where the skill and the Harness exchange files. */
      readonly handoff: {
        readonly directory: string;
        readonly httpPort: number;
        readonly databasePort: number;
      };
      /** The one Finding the operator named, outside the queue's retry rules. */
      readonly findingId?: string;
    },
  ): Promise<VerifyNextSummary | null>;
  /** The target's newest public version, observed once; absent without a host. */
  latestVersion?(
    state: CliState,
    targetId: string,
  ): Promise<{ version: string; observedAt: string } | null>;
  /** Host facts `continuous run` checks before each batch; absent without a host. */
  hostStatus?(
    state: CliState,
    input: { readonly configPath: string; readonly selectionPath: string },
  ): Promise<ContinuousHostStatus>;
  /**
   * Docker resources a crashed run left behind; removed only when asked.
   * `labs: false` names only discovery resources and never a Lab (#526).
   */
  cleanupLeftovers(
    state: CliState,
    input: {
      readonly configPath: string;
      readonly remove: boolean;
      readonly labs: boolean;
    },
  ): Promise<{
    readonly containers: readonly string[];
    readonly networks: readonly string[];
    readonly volumes: readonly string[];
  }>;
  /** Runtime items the profile pins next to what the provider image reports. */
  checkRuntime(
    state: CliState,
    input: { readonly configPath: string },
  ): Promise<
    readonly {
      readonly item: string;
      readonly profile: string;
      readonly image: string;
    }[]
  >;
  /** Re-verifies one Finding on its latest or explicitly pinned version in a fresh Lab. */
  reverify(
    state: CliState,
    input: {
      readonly campaignId: string;
      readonly findingId: string;
      readonly configPath: string;
      readonly version?: string;
      /** Hand the versioned Lab to the verification skill. */
      readonly handoff?: {
        readonly directory: string;
        readonly httpPort: number;
        readonly databasePort: number;
      };
      /** Read a confirmed route from a separate campaign without writing to it. */
      readonly referenceCampaignId?: string;
      /** Use a separately recorded, immutable Snapshot for this version. */
      readonly snapshotCampaignId?: string;
    },
  ): Promise<ReverificationSummary>;
  /**
   * #529: returns a Finding parked by a retired admission rule to the queues;
   * the profile refuses Programme Boundary and verification parks.
   */
  restoreParked?(
    state: CliState,
    input: {
      readonly campaignId: string;
      readonly findingId: string;
      readonly restoredBy: string;
      readonly reason: string;
    },
  ): Promise<{ readonly status: "restored" | "already-restored" }>;
  /** Summarizes the profile's Lab state diff artifact for `review export` (#186). */
  stateDiffReader(state: CliState): StateDiffReader;
  /** Reads the profile's HTTP evidence record for `review export`; names of its files stay in the profile. */
  httpEvidenceReader(state: CliState): HttpEvidenceReader;
  /** Reads the Verifier's steps and the victim-side observer record for `review export` (#437). */
  verifierRecordReader(state: CliState): VerifierRecordReader;
  /** Removes the Lab an earlier `lab up` recorded; containers, networks and volumes. */
  labDown(
    state: CliState,
    input: { readonly configPath: string | null },
  ): Promise<LabDownSummary>;
}

type ReviewLabSession = Awaited<
  ReturnType<NonNullable<CliProfile["reviewLab"]>>
>;

interface ReviewSignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
}

export type CliEnvironment = {
  readonly stateDirectory: string;
  readonly profile: CliProfile;
  readonly clock?: () => Date;
  readonly newId?: () => string;
};

class UsageError extends Error {}

function isNonHumanReviewer(name: string): boolean {
  return ["ai", "agent", "automation", "system"].includes(
    name.trim().toLowerCase(),
  );
}

/** `--since` takes an ISO 8601 instant with an offset, e.g. 2026-10-20T00:00:00Z. */
function since(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!z.iso.datetime({ offset: true }).safeParse(value).success)
    throw new UsageError("--since must be an ISO 8601 instant");
  return value;
}

/** At least one of --campaign and --since narrows a read. */
function campaignOrSince(values: {
  readonly campaign?: string | undefined;
  readonly since?: string | undefined;
}): { campaignId?: string; since?: string } {
  const instant = since(values.since);
  if (values.campaign === undefined && instant === undefined)
    throw new UsageError("--campaign or --since is required");
  return {
    ...(values.campaign === undefined ? {} : { campaignId: values.campaign }),
    ...(instant === undefined ? {} : { since: instant }),
  };
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0)
    throw new UsageError(`--${name} is required`);
  return value;
}

async function humanMinutes(
  value: number | undefined,
  io: CliIo,
  action: "read" | "reproduce" | "submit" | "outcome",
): Promise<number | null> {
  return value ?? io.askMinutes?.(action) ?? null;
}

function parseMinutes(value: string): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value))
    throw new UsageError(
      "--minutes must be a non-negative number with at most two decimals",
    );
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes > 1440)
    throw new UsageError("--minutes must be between 0 and 1440");
  return minutes;
}

function choice<const Choices extends readonly string[]>(
  value: string,
  name: string,
  choices: Choices,
): Choices[number] {
  if (!choices.includes(value))
    throw new UsageError(`--${name} must be ${choices.join(", ")}`);
  return value;
}

function stages(counts: FunnelCounts): string {
  return `最終JSON到達 ${counts.reached} → 受理 ${counts.accepted} / 保留 ${counts.held} / parked ${counts.parked} → raw ${counts.raw} → verifier通過 ${counts.verified} → confirmed ${counts.confirmed} / reproduced ${counts.reproduced} / contradicted ${counts.contradicted} / incomplete ${counts.incomplete} → reviewed ${counts.reviewed} → in-scope ${counts.inScope} → submitted ${counts.submitted} → outcome ${counts.outcome}`;
}

export function formatStopRow(row: StopRow): string {
  const fields = Object.entries(row.fields).map(
    ([name, value]) => `${name}=${value}`,
  );
  const extra =
    row.explore === undefined
      ? []
      : [`explore=${row.explore}`, `within60s=${row.within60s ?? 0}`];
  return [row.type, ...fields, `count=${row.count}`, ...extra].join("  ");
}

/** One resumed segment: the stop it continued, then how it ended and how long it ran. */
export function formatResumeRow(row: ResumeRow): string {
  const stop = (value: {
    readonly outcome?: string;
    readonly reason?: string;
    readonly reasonDetail?: string;
  }) =>
    value.outcome === undefined
      ? "unfinished"
      : [value.outcome, value.reason, value.reasonDetail]
          .filter((part) => part !== undefined)
          .join("/");
  return [
    row.campaignId,
    `segment ${row.segment}`,
    `run ${row.runId}`,
    `resumes ${row.resumesRun}`,
    `after ${stop(row.resumed)}`,
    ...(row.runtime === undefined ? [] : [`runtime ${row.runtime}`]),
    `ended ${stop(row)}`,
    ...(row.wallTimeMs === undefined
      ? []
      : [`active ${(row.wallTimeMs / 60_000).toFixed(1)} min`]),
  ].join("  ");
}

export function formatFunnel(funnel: CampaignFunnel): string[] {
  const rate = (value: number | null) =>
    value === null ? "unavailable" : value.toFixed(2);
  const cost =
    funnel.unpricedRuns === funnel.runCount
      ? "cost unavailable"
      : `cost $${funnel.knownCostUsd.toFixed(2)} known, ${funnel.unpricedRuns} run(s) unavailable`;
  const labFailures = `verification Lab failed ${funnel.verificationLabFailed}`;
  const hasAttachedHistory = Object.values(funnel.byLab.attached).some(
    (count) => count > 0,
  );
  const lines = [
    `campaign ${funnel.campaignId}`,
    `agent runs ${funnel.runCount} (discovery attempts ${funnel.discoveryAttempts})  ${cost}  summed agent time ${(funnel.wallTimeMs / 1000).toFixed(1)}s`,
    ...(funnel.incompleteDepth > 0
      ? [`incomplete(depth) ${funnel.incompleteDepth}`]
      : []),
    hasAttachedHistory
      ? `by Lab: attached runs ${funnel.byLab.attached.runs} findings ${funnel.byLab.attached.findings} confirmed ${funnel.byLab.attached.confirmed}; none runs ${funnel.byLab.none.runs} findings ${funnel.byLab.none.findings} confirmed ${funnel.byLab.none.confirmed}; ${labFailures}`
      : labFailures,
    stages(funnel),
    `noncache input ${funnel.noncachedInputTokens} token(s) (${funnel.unavailableInputRuns} run(s) unavailable)  confirmed / 1M tokens ${rate(funnel.confirmedPerMillionInputTokens)}  confirmed / agent wall hour ${rate(funnel.confirmedPerAgentWallHour)}`,
    `owner minutes / submission ${rate(funnel.ownerMinutesPerSubmission)}  opened findings / submission ${rate(funnel.openedFindingsPerSubmission)}  manual reproduction agreement ${funnel.manualReproductionAgreement === null ? "unavailable" : `${(funnel.manualReproductionAgreement * 100).toFixed(1)}%`}`,
  ];
  const programmes = Object.keys(funnel.inScopeByProgramme).sort();
  if (programmes.length > 0)
    lines.push(
      `in-scope by programme: ${programmes.map((programme) => `${programme} ${funnel.inScopeByProgramme[programme]}`).join(", ")}`,
    );
  const outcomes = Object.keys(funnel.outcomesByKind).sort();
  if (outcomes.length > 0)
    lines.push(
      `outcomes: ${outcomes.map((outcome) => `${outcome} ${funnel.outcomesByKind[outcome]}`).join(", ")}  reward $${funnel.rewardUsd.toFixed(2)}`,
    );
  const categories = Object.keys(funnel.byCategory).sort();
  if (categories.length > 0) lines.push("by category:");
  for (const category of categories) {
    const human = funnel.humanByCategory[category];
    lines.push(`  ${category}: ${stages(funnel.byCategory[category]!)}`);
    if (human !== undefined)
      lines.push(
        `    owner minutes / submission ${rate(human.ownerMinutesPerSubmission)}  opened findings / submission ${rate(human.openedFindingsPerSubmission)}  manual reproduction agreement ${human.manualReproductionAgreement === null ? "unavailable" : `${(human.manualReproductionAgreement * 100).toFixed(1)}%`}`,
      );
  }
  const objectives = Object.keys(funnel.byObjective).sort();
  if (objectives.length > 0) lines.push("by objective version:");
  for (const name of objectives) {
    const counts = funnel.byObjective[name]!;
    lines.push(
      `  ${name}: runs ${counts.runs}  ${stages(counts)}  noncache input ${counts.noncachedInputTokens} (${counts.unavailableInputRuns} run(s) unavailable)  confirmed / 1M tokens ${rate(counts.confirmedPerMillionInputTokens)}  confirmed / agent wall hour ${rate(counts.confirmedPerAgentWallHour)}`,
    );
  }
  const findings = Object.keys(funnel.verificationAttempts).sort();
  if (findings.length > 0) lines.push("verification attempts by finding:");
  for (const finding of findings)
    lines.push(`  ${finding}: ${funnel.verificationAttempts[finding]}`);
  const arms = Object.keys(funnel.byArm).sort();
  if (arms.length > 0) lines.push("by arm:");
  for (const arm of arms) {
    const counts = funnel.byArm[arm]!;
    lines.push(
      `  ${arm}: runs ${counts.runs}  findings ${counts.findings}  confirmed ${counts.confirmed}`,
    );
  }
  return lines;
}

export function formatQueue(
  queue: ReviewQueue,
  /** The store's own location of an artifact's files, so the printed path opens. */
  contentPath: (digest: string) => string,
  /** #442: the stage-4 result each item's latest decision carries. */
  duplicates: ReadonlyMap<ReviewItem, DuplicateCheck | null> = new Map(),
  /** Each decision's reason code, so a Finding dropped before its Lab shows why (#436). */
  reasons: ReadonlyMap<ReviewItem, string> = new Map(),
  /** Resolved from Private Evidence before printing a human observation. */
  manualEvidence: ReadonlyMap<
    ReviewItem,
    "available" | "unavailable"
  > = new Map(),
): string[] {
  const lines: string[] = [];
  for (const item of queue.items) {
    const head = `${item.status}  ${item.ref.campaignId}  finding ${item.ref.findingId}  ${item.category}`;
    const reason = reasons.get(item);
    const decision = `  decision: ${item.decision ?? "none"}${reason === undefined ? "" : ` (${reason})`}`;
    const check = duplicates.get(item) ?? null;
    const duplicate = `  duplicate: ${
      check === null
        ? "none"
        : [
            check.status,
            check.status === "possible-match" ? check.reference : null,
            check.status === "unavailable" ? (check.reason ?? null) : null,
            `checked ${check.checkedAt ?? "never"}`,
          ]
            .filter((part) => part !== null)
            .join("  ")
    }`;
    const verification = `  verification ${item.ref.verificationId ?? "none"}  snapshot ${item.ref.snapshotDigest}`;
    // #424: the overlap group orders the queue; each Finding is still decided on its own.
    const group = `  group ${item.group.id}  ${item.group.size} finding(s)${item.group.representative ? "  representative" : ""}`;
    if (item.status === "contradicted")
      lines.push(
        head,
        verification,
        group,
        `  observer: ${item.judgeId}`,
        `  evidence: ${item.evidenceDigest} (${contentPath(item.evidenceDigest)})`,
        `  refutation: ${
          item.refutationDigest === null
            ? "none"
            : `${item.refutationDigest} (${contentPath(item.refutationDigest)})`
        }`,
        decision,
        duplicate,
      );
    else if (item.status === "not-verified")
      lines.push(head, verification, group, decision, duplicate);
    else if (item.status !== "incomplete")
      lines.push(
        head,
        verification,
        group,
        `  observer: ${item.judgeId}`,
        `  observed: ${
          Object.entries(item.conditions)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) => `${key}=${value}`)
            .join(" ") || "none"
        }`,
        `  evidence: ${item.evidenceDigest}`,
        `  reproduction package: ${item.reproductionPackageDigest} (${contentPath(item.reproductionPackageDigest)})`,
        decision,
        duplicate,
      );
    else
      lines.push(
        head,
        verification,
        group,
        `  reason: ${item.reason}`,
        `  next: ${item.nextStep}`,
        ...(item.manualObservation === undefined
          ? []
          : [
              `  manual observation: ${item.manualObservation.result} (evidence ${manualEvidence.get(item) ?? "unchecked"}; receipt ${item.manualObservation.sessionReceiptDigest}, evidence ${item.manualObservation.evidenceDigest})`,
            ]),
        decision,
        duplicate,
      );
  }
  const counts = (byReason: Readonly<Record<string, number>>) =>
    Object.entries(byReason)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([reason, count]) => `${reason} ${count}`)
      .join(", ") || "none";
  if (
    queue.items.length === 0 &&
    Object.keys(queue.incompleteByReason).length === 0
  )
    lines.push("review queue is empty");
  lines.push(`incomplete by reason: ${counts(queue.incompleteByReason)}`);
  lines.push(`precondition class: ${counts(queue.preconditionClassCounts)}`);
  lines.push(
    `retry candidates by reason: ${counts(queue.retryPendingByReason)}`,
  );
  lines.push(
    `contradicted: ${queue.contradicted}  unverified: ${queue.unverified}`,
  );
  return lines;
}

/** Absent, the decision keeps the result in force (#442). */
function parseDuplicate(
  value: string | undefined,
): DuplicateResult | undefined {
  if (value === undefined) return undefined;
  if (value === "unavailable") return { status: "unavailable" };
  if (value === "no-match") return { status: "no-match" };
  if (value.startsWith("unavailable:") && value.length > 12)
    return { status: "unavailable", reason: value.slice(12) };
  if (value.startsWith("possible-match:") && value.length > 15)
    return { status: "possible-match", reference: value.slice(15) };
  throw new UsageError(
    "--duplicate must be no-match, unavailable[:<reason>] or possible-match:<ref>",
  );
}

const OUTCOMES = [
  "triaged",
  "resolved",
  "duplicate",
  "informative",
  "not-applicable",
  "rejected",
] as const;

type Values = {
  readonly campaign?: string | undefined;
  readonly finding?: string | undefined;
  readonly candidate?: string | undefined;
  readonly draft?: string | undefined;
  readonly to?: string | undefined;
};

/** Every queued Finding is reviewable: evidence-backed, contradicted, or incomplete. */
function queued(review: Review, values: Values) {
  const campaignId = required(values.campaign, "campaign");
  const findingId = required(values.finding, "finding");
  const item = review
    .queue({ campaignId })
    .items.find((candidate) => candidate.ref.findingId === findingId);
  if (item === undefined)
    throw new UsageError("The finding is not in the review queue");
  return item;
}

/** #525 (ADR 0040): an old judge result, or a result a person observed in a review Lab. */
function hasSubmissionBasis(
  item: ReviewItem,
): item is Extract<
  ReviewItem,
  { readonly status: "runtime-confirmed" | "reproduced" | "incomplete" }
> {
  return (
    item.status === "runtime-confirmed" ||
    item.status === "reproduced" ||
    (item.status === "incomplete" &&
      item.reason === "awaiting-human-observation" &&
      item.manualObservation?.result === "match")
  );
}

function exactDraft(values: Values) {
  return {
    candidateId: required(values.candidate, "candidate"),
    draftDigest: required(values.draft, "draft"),
    destination: required(values.to, "to"),
  };
}

/**
 * The one owner of SIGINT/SIGTERM for `lab up --for-review`: a signal during
 * launch closes the session as soon as it exists; a signal afterwards ends the
 * foreground wait. The profile session only knows how to close itself.
 */
export async function runForegroundReviewLab(
  launch: () => Promise<ReviewLabSession>,
  io: CliIo,
  signals: ReviewSignalSource = process,
  onReady?: (session: ReviewLabSession) => Promise<void>,
): Promise<void> {
  let interrupted = false;
  let release: (() => void) | undefined;
  const interrupt = () => {
    interrupted = true;
    release?.();
  };
  const waitForInterrupt = () =>
    new Promise<void>((resolve) => {
      // Signal listeners alone do not keep Node's event loop alive.
      const keepAlive = setInterval(() => undefined, 60_000);
      release = () => {
        clearInterval(keepAlive);
        release = undefined;
        resolve();
      };
    });
  signals.on("SIGINT", interrupt);
  signals.on("SIGTERM", interrupt);
  try {
    const session = await launch();
    try {
      if (!interrupted) await onReady?.(session);
      if (!interrupted) {
        io.stdout(
          `review Lab ready on ${session.endpoint} (network ${session.networkName}, recorder ${session.recorderIp})`,
        );
        io.stdout(
          `attacker accounts: ${JSON.stringify(session.attackerAccounts)}`,
        );
        io.stdout(
          `review administrator: ${JSON.stringify(session.administrator)}`,
        );
        const shellQuote = (value: string) =>
          `'${value.replaceAll("'", "'\\''")}'`;
        io.stdout(
          `manual client: docker run --rm -it --runtime=runsc --network ${shellQuote(session.networkName)} --add-host ${shellQuote(`wordpress:${session.recorderIp}`)} --add-host ${shellQuote(`canary:${session.receiverIp}`)} --read-only --cap-drop=ALL --security-opt=no-new-privileges --tmpfs=/tmp:rw,nosuid,nodev,size=512m --entrypoint sh ${shellQuote(session.browserImage)}`,
        );
        io.stdout(
          "Run the private reproduction steps in that client; interrupt this command to remove the Lab.",
        );
        // Printing is synchronous, so an interrupt raised while printing is already recorded here.
        if (!interrupted) await waitForInterrupt();
      }
    } finally {
      await session.close();
    }
    io.stdout("review Lab removed");
  } finally {
    signals.off("SIGINT", interrupt);
    signals.off("SIGTERM", interrupt);
  }
}

function integerOption(
  value: string | undefined,
  name: string,
  fallback: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!/^\d{1,7}$/.test(value) || Number(value) > max)
    throw new UsageError(`--${name} must be an integer up to ${max}`);
  return Number(value);
}

export function formatLabDown(summary: LabDownSummary): string[] {
  const count = (kind: "containers" | "networks" | "volumes") =>
    `${kind} ${summary.removed[kind].length} removed, ${summary.remaining[kind].length} remaining${summary.remaining[kind].length === 0 ? "" : `: ${summary.remaining[kind].join(", ")}`}`;
  return [
    summary.labId === null
      ? "no lab recorded by lab up"
      : `lab ${summary.labId} down`,
    `  ${count("containers")}`,
    `  ${count("networks")}`,
    `  ${count("volumes")}`,
  ];
}

/** What a command handler receives; `values` holds only the flags its row declares. */
interface CommandContext<Flags extends FlagSet> {
  readonly values: FlagValues<Flags>;
  /** Positionals after the command name, e.g. the `<slug>` of `campaign run`. */
  readonly rest: readonly string[];
  readonly sub: string | undefined;
  readonly state: CliState;
  readonly environment: CliEnvironment;
  readonly io: CliIo;
  readonly print: (lines: readonly string[]) => void;
}

interface Command extends CommandShape {
  readonly readOnly: boolean;
  /** Parse and validate before opening any state. The closure retains the row's types. */
  prepare(
    argv: readonly string[],
    rest: readonly string[],
  ): (context: Omit<CommandContext<FlagSet>, "values">) => Promise<number>;
}

interface CommandRow<Flags extends FlagSet> {
  readonly name: string;
  readonly usage: string | readonly string[];
  readonly options: Flags;
  readonly readOnly?: boolean;
  readonly required?: readonly (keyof Flags & string)[];
  readonly maxPositionals?: number;
  readonly validate?: (
    values: FlagValues<Flags>,
    rest: readonly string[],
  ) => void;
}

/** Convert input once before opening state; keep the result typed in the handler. */
function command<const Flags extends FlagSet, Input>(
  row: CommandRow<Flags> & {
    readonly prepareInput: (values: FlagValues<Flags>) => Input;
    readonly handler: (
      context: CommandContext<Flags> & { readonly input: Input },
    ) => Promise<number>;
  },
): Command;
function command<const Flags extends FlagSet>(
  row: CommandRow<Flags> & {
    readonly handler: (context: CommandContext<Flags>) => Promise<number>;
  },
): Command;
function command<Flags extends FlagSet, Input>(
  row: CommandRow<Flags> &
    (
      | {
          readonly prepareInput: (values: FlagValues<Flags>) => Input;
          readonly handler: (
            context: CommandContext<Flags> & { readonly input: Input },
          ) => Promise<number>;
        }
      | {
          readonly prepareInput?: undefined;
          readonly handler: (context: CommandContext<Flags>) => Promise<number>;
        }
    ),
): Command {
  return {
    name: row.name,
    usage: typeof row.usage === "string" ? [row.usage] : row.usage,
    options: row.options,
    readOnly: row.readOnly ?? false,
    prepare(argv, rest) {
      // Node validates every name and value against this row, not the union of flags.
      const parsed = parseArgs({
        args: [...argv],
        options: { ...GLOBAL_OPTIONS, ...row.options },
        allowPositionals: true,
        strict: true,
      });
      const values = parsed.values as FlagValues<Flags>;
      for (const name of row.required ?? []) {
        const value = values[name];
        if (value === undefined || value === "")
          throw new UsageError(`--${name} is required`);
      }
      for (const [name, value] of Object.entries(parsed.values))
        if (value === "" || (Array.isArray(value) && value.includes("")))
          throw new UsageError(`--${name} must not be empty`);
      if (rest.length > (row.maxPositionals ?? 0))
        throw new UsageError(
          `${row.name} received unexpected positional arguments`,
        );
      row.validate?.(values, rest);
      if (row.prepareInput !== undefined) {
        const input = row.prepareInput(values);
        return (context) => row.handler({ ...context, values, input });
      }
      return (context) => row.handler({ ...context, values });
    },
  };
}

const continuousOptions = {
  "continuous run": {
    config: STR,
    selection: STR,
    "campaign-prefix": STR,
    notify: STR,
    resume: BOOL,
  },
  "continuous stop": {},
  "continuous resume": {},
  "continuous status": {},
  "continuous concurrency": { config: STR, runtime: STR },
} as const;
type ContinuousValues = FlagValues<
  (typeof continuousOptions)["continuous run"] &
    (typeof continuousOptions)["continuous concurrency"]
>;

/** The `continuous` subcommands share one handler; `sub` picks the action. */
function continuousRow(
  name: keyof typeof continuousOptions,
  usage: string,
): Command {
  return command({
    name,
    usage,
    options: continuousOptions[name],
    readOnly: name === "continuous status",
    maxPositionals: name === "continuous concurrency" ? 1 : 0,
    validate: (values, rest) => {
      const flags: ContinuousValues = values;
      if (name === "continuous run" || name === "continuous concurrency") {
        required(flags.config, "config");
        if (name === "continuous run") required(flags.selection, "selection");
      }
      if (name === "continuous run" && flags["campaign-prefix"] !== undefined) {
        const prefix = flags["campaign-prefix"];
        if (
          prefix.startsWith("selection-") ||
          !/^[a-z0-9][a-z0-9-]{0,40}$/.test(prefix)
        )
          throw new UsageError(
            "--campaign-prefix must be a short slug not starting with selection-",
          );
      }
      if (name === "continuous concurrency" && rest[0] !== undefined) {
        const minimum = flags.runtime === undefined ? 1 : 0;
        if (!/^\d{1,3}$/.test(rest[0]) || Number(rest[0]) < minimum)
          throw new UsageError(
            `concurrency must be an integer of at least ${minimum}`,
          );
      }
    },
    handler: async ({ values, sub, rest, state, environment, io }) => {
      const flags: ContinuousValues = values;
      return await continuousCommand(sub!, {
        rest,
        state,
        profile: environment.profile,
        io,
        configPath:
          flags.config === undefined ? undefined : resolve(flags.config),
        selectionPath:
          flags.selection === undefined ? undefined : resolve(flags.selection),
        campaignPrefix: flags["campaign-prefix"] ?? "prod",
        notify: flags.notify,
        resume: flags.resume ?? false,
        runtime: flags.runtime,
      });
    },
  });
}

/** One row per command, in the order the usage text lists them. */
const COMMANDS: readonly Command[] = [
  command({
    name: "select",
    required: ["config"],
    usage: ["select --config <path> [--minimum <n>]"],
    options: { config: STR, minimum: STR },
    validate: (values) => {
      const minimum =
        values.minimum === undefined ? undefined : Number(values.minimum);
      if (
        minimum !== undefined &&
        (!Number.isSafeInteger(minimum) || minimum < 1 || minimum > 5)
      )
        throw new UsageError("--minimum must be an integer from 1 to 5");
    },
    handler: async ({ values, state, environment, io }) => {
      const minimum =
        values.minimum === undefined ? undefined : Number(values.minimum);
      const report = await environment.profile.select(state, {
        configPath: resolve(required(values.config, "config")),
        ...(minimum === undefined ? {} : { minimum }),
      });
      const legacy = report.legacyHistory;
      if (legacy !== undefined)
        io.stdout(
          legacy.status === "unavailable"
            ? "legacy history unavailable"
            : `legacy history ${legacy.digest}  started ${legacy.started}  ambiguous ${legacy.ambiguous}  reconsider ${legacy.reconsider}`,
        );
      const advisory = report.advisoryHistory;
      if (advisory !== undefined)
        io.stdout(
          advisory.status === "not-used"
            ? "advisory history not used"
            : `advisory history ${advisory.digest}  as of ${advisory.asOf}${advisory.lastRefreshFailed ? " (last refresh failed)" : ""}  records ${advisory.recordCount}  window ${advisory.windowDays} d  cap ${advisory.countCap}`,
        );
      if (report.cascade !== undefined && report.cascade.length > 1)
        io.stdout(
          `cascade ${report.cascade
            .map(
              ({ step, eligible }) =>
                `step ${step} eligible ${eligible}${step === (report.cascadeStep ?? 0) ? " (selected)" : ""}`,
            )
            .join("; ")}`,
        );
      for (const target of report.selected)
        io.stdout(
          `${target.targetId} ${target.version} score ${target.score.toFixed(2)}  breakdown ${Object.entries(
            target.scoreBreakdown,
          )
            .map(([part, points]) => `${part}=${(points ?? 0).toFixed(2)}`)
            .join(" ")}${
            target.advisoryHistory === undefined
              ? ""
              : `  history records ${target.advisoryHistory.count} paying ${target.advisoryHistory.payingClassCount} latest ${target.advisoryHistory.latestPublished ?? "none"}`
          }${
            target.cascadeStep === undefined
              ? ""
              : `  cascade step ${target.cascadeStep}`
          }  observed ${target.observedAt}  source ${target.sourceUrl ?? "unavailable"}  excluded none`,
        );
      for (const target of report.excluded)
        io.stdout(
          `excluded ${target.targetId}  reasons ${target.reasons.join(",")}  observed ${target.observedAt ?? "unavailable"}  source ${target.sourceUrl ?? "unavailable"}`,
        );
      if (report.batchId !== null)
        io.stdout(`selection batch ${report.batchId}`);
      if (report.selected.length === 0) io.stdout("no targets selected");
      return 0;
    },
  }),
  command({
    name: "campaign run",
    required: ["campaign", "config"],
    maxPositionals: 1,
    usage: [
      "campaign run <slug>|--all --campaign <id> --config <path> [--selection <path>] [--repeat <n>]",
    ],
    options: {
      all: BOOL,
      campaign: STR,
      config: STR,
      repeat: STR,
      selection: STR,
    },
    validate: (values, rest) => {
      const target = rest[0] ?? null;
      const repeat = values.repeat === undefined ? 1 : Number(values.repeat);
      if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 40)
        throw new UsageError("--repeat must be an integer from 1 to 40");
      if ((target === null) === (values.all !== true) || rest.length > 1)
        throw new UsageError(
          "campaign run takes exactly one of <slug> or --all",
        );
      // A longer id cannot be written into the ledger's per-snapshot identities (#281).
      if ((values.campaign?.length ?? 0) > MAXIMUM_CAMPAIGN_ID_LENGTH)
        throw new UsageError(
          `--campaign must be at most ${MAXIMUM_CAMPAIGN_ID_LENGTH} characters`,
        );
    },
    handler: async ({ values, rest, state, environment, io, print }) => {
      const target = rest[0] ?? null;
      const repeat = values.repeat === undefined ? 1 : Number(values.repeat);
      // A manual campaign beside the runner keeps its containers (#399).
      const release = await holdDiscoverySweep(
        state.stateDirectory,
        process.pid,
      );
      const summary = await environment.profile
        .runCampaign(state, {
          campaignId: required(values.campaign, "campaign"),
          configPath: resolve(required(values.config, "config")),
          target,
          repeat,
          ...(values.selection === undefined
            ? {}
            : { selectionPolicyPath: resolve(values.selection) }),
        })
        .finally(release);
      for (const skipped of summary.skipped)
        io.stderr(
          `skipped ${skipped.targetId} ${skipped.version} at ${skipped.stage}: ${skipped.message}`,
        );
      if (summary.targets.length === 0 && summary.skipped.length === 0) {
        io.stdout(
          target === null
            ? "no targets selected"
            : `no selected target matched ${target}`,
        );
        return 0;
      }
      for (const target of summary.targets) {
        io.stdout(
          `${target.targetId} ${target.version}  snapshot ${target.snapshotDigest}  lab ${target.lab}  runs ${target.runCount}  stopped by ${target.stoppedBy}`,
        );
        for (const verification of target.verifications)
          io.stdout(
            `  finding ${verification.findingId}: ${verification.status}`,
          );
      }
      if (summary.stopped !== undefined)
        io.stdout(
          `campaign stopped by ${summary.stopped}; run the same command again to resume`,
        );
      print(formatFunnel(state.ledger.funnel(summary.campaignId)));
      // A distinct exit code lets an unattended schedule tell a resumable stop apart.
      if (summary.stopped !== undefined) return 3;
      // Every target skipped is a failure, not a quiet zero runs (#281).
      return summary.targets.length === 0 ? 1 : 0;
    },
  }),
  continuousRow(
    "continuous run",
    "continuous run --config <path> --selection <path> [--campaign-prefix <text>] [--notify <command>] [--resume]",
  ),
  continuousRow("continuous stop", "continuous stop"),
  continuousRow("continuous resume", "continuous resume"),
  continuousRow("continuous status", "continuous status"),
  command({
    name: "review",
    readOnly: true,
    usage: ["review [--campaign <id>]"],
    options: { campaign: STR },
    handler: async ({ values, state, environment, print }) => {
      const review = environment.profile.review(state);
      const queue = review.queue(
        values.campaign === undefined ? {} : { campaignId: values.campaign },
      );
      const duplicates = new Map<ReviewItem, DuplicateCheck | null>();
      const manualEvidence = new Map<ReviewItem, "available" | "unavailable">();
      for (const item of queue.items)
        duplicates.set(item, await review.duplicateOf(item.ref));
      for (const item of queue.items)
        if (
          item.status === "incomplete" &&
          item.manualObservation !== undefined
        )
          manualEvidence.set(
            item,
            await manualObservationEvidenceStatus(
              state.store,
              item.manualObservation,
            ),
          );
      print(
        formatQueue(
          queue,
          (digest) => state.store.contentPath(digest),
          duplicates,
          await review.decisionReasons(queue.items),
          manualEvidence,
        ),
      );
      return 0;
    },
  }),
  command({
    name: "review parked",
    readOnly: true,
    required: ["campaign"],
    usage: ["review parked --campaign <id>"],
    options: { campaign: STR },
    handler: async ({ values, state, print }) => {
      // Parked Findings remain inspectable by reason without joining the review queue.
      const parked = state.ledger.activeParked({
        campaignId: required(values.campaign, "campaign"),
      });
      if (parked.length === 0) print(["no parked findings"]);
      for (const event of parked) {
        const reference = event.artifacts.find(
          (artifact) => artifact.kind === "finding",
        );
        let property = "(finding.json unavailable)";
        if (reference !== undefined) {
          const stored = await state.store.readJson(
            reference.digest,
            "finding.json",
            z.object({ brokenProperty: z.string() }),
            1024 * 1024,
          );
          if (stored.status === "resolved")
            property = stored.value.brokenProperty;
        }
        print([
          `parked  ${event.category}  ${event.findingId}  ${property}  reason: ${event.reason}`,
        ]);
      }
      return 0;
    },
  }),
  command({
    name: "review restore",
    required: ["campaign", "finding", "reason"],
    usage: [
      "review restore --campaign <id> --finding <id> --reason <text> [--by <name>]",
    ],
    options: { campaign: STR, finding: STR, reason: STR, by: STR },
    handler: async ({ values, state, environment, print }) => {
      // #529 (ADR 0038 追記 8): append-only restore of a retired admission park.
      const restore = environment.profile.restoreParked;
      if (restore === undefined)
        throw new UsageError("This profile cannot restore parked Findings");
      const reason = required(values.reason, "reason").trim();
      if (reason === "") throw new UsageError("--reason must not be empty");
      const findingId = required(values.finding, "finding");
      const result = await restore(state, {
        campaignId: required(values.campaign, "campaign"),
        findingId,
        restoredBy: values.by ?? "operator",
        reason,
      });
      if (result.status === "already-restored")
        throw new Error(`Finding ${findingId} is already restored`);
      print([`restored finding ${findingId} to the review queue`]);
      return 0;
    },
  }),
  command({
    name: "review leads",
    readOnly: true,
    required: ["campaign"],
    usage: ["review leads --campaign <id>"],
    options: { campaign: STR },
    handler: async ({ values, state, print }) => {
      // Leads never join the review queue, but the human sees every one of them
      // (owner decision 2026-10-26: report widely, drop in review, never hide a route in a Lead).
      const seen = new Set<string>();
      const leads = state.ledger
        .readAll({ campaignId: required(values.campaign, "campaign") })
        .map(({ event }) => event)
        .flatMap((event) =>
          event.type === "lead-recorded" && !seen.has(event.leadId)
            ? (seen.add(event.leadId), [event])
            : [],
        );
      if (leads.length === 0) print(["no leads recorded"]);
      for (const event of leads) {
        const reference = event.artifacts.find(
          (artifact) => artifact.kind === "lead",
        );
        let position = "(position unknown)";
        let summary = "(lead.json unavailable)";
        if (reference !== undefined) {
          const stored = await state.store.readJson(
            reference.digest,
            "lead.json",
            z.object({
              summary: z.string(),
              attackerPosition: z.string().optional(),
            }),
            1024 * 1024,
          );
          if (stored.status === "resolved") {
            summary = stored.value.summary;
            position = stored.value.attackerPosition ?? position;
          }
        }
        print([
          `lead  ${event.primitive}/${event.missingEdge}  ${position}  ${event.leadId}  ${summary}`,
        ]);
      }
      return 0;
    },
  }),
  command({
    name: "review export",
    readOnly: true,
    required: ["campaign", "finding"],
    usage: ["review export --campaign <id> --finding <id> [--version 2]"],
    options: { campaign: STR, finding: STR, version: STR },
    handler: async ({ values, state, environment, io }) => {
      // The one read interface for the skills (ADR 0031). Bodies and payloads stay behind paths.
      const options = {
        ledger: state.ledger,
        store: state.store,
        campaignId: required(values.campaign, "campaign"),
        findingId: required(values.finding, "finding"),
        stateDiff: environment.profile.stateDiffReader(state),
        httpEvidence: environment.profile.httpEvidenceReader(state),
        verifierRecord: environment.profile.verifierRecordReader(state),
        clock: state.clock,
        ...(environment.profile.latestVersion === undefined
          ? {}
          : {
              observeLatestVersion: (targetId: string) =>
                environment.profile.latestVersion!(state, targetId),
            }),
      };
      const version = values.version ?? "1";
      if (version !== "1" && version !== "2")
        throw new UsageError("--version must be 1 or 2");
      const bundle =
        version === "2"
          ? await exportReviewBundleV2(options)
          : await exportReviewBundle(options);
      io.stdout(canonicalJson(bundle));
      return 0;
    },
  }),
  command({
    name: "review observe",
    required: ["campaign", "finding", "receipt", "result", "evidence", "by"],
    usage: [
      "review observe --campaign <id> --finding <id> --receipt <digest> --result match|mismatch|unavailable --evidence <path> --by <human>",
    ],
    options: {
      campaign: STR,
      finding: STR,
      receipt: STR,
      result: STR,
      evidence: STR,
      by: STR,
    },
    handler: async ({ values, state, environment, io }) => {
      const item = queued(environment.profile.review(state), values);
      if (
        item.status !== "incomplete" ||
        (item.reason !== "observation" &&
          item.reason !== "awaiting-human-observation")
      )
        throw new UsageError("A current incomplete observation is required");
      const manual = await environment.profile.reviewLabPackage?.(
        state,
        item.ref,
      );
      if (manual === null || manual === undefined)
        throw new UsageError("A captured observation package is required");
      const result = choice(required(values.result, "result"), "result", [
        "match",
        "mismatch",
        "unavailable",
      ] as const);
      const actor = required(values.by, "by");
      if (isNonHumanReviewer(actor))
        throw new UsageError("A named human actor is required");
      const evidencePath = resolve(required(values.evidence, "evidence"));
      const evidenceStat = await lstat(evidencePath);
      if (
        !evidenceStat.isFile() ||
        evidenceStat.size === 0 ||
        evidenceStat.size > 10_000_000
      )
        throw new UsageError("--evidence must be a 1-10000000 byte file");
      const recorded = await recordManualObservation({
        ledger: state.ledger,
        store: state.store,
        ref: item.ref,
        packageDigest: manual.packageDigest,
        sessionReceiptDigest: required(values.receipt, "receipt"),
        evidence: await readFile(evidencePath),
        result,
        recordedBy: actor,
        clock: state.clock,
      });
      io.stdout(
        `manual observation ${recorded.result} recorded for finding ${item.ref.findingId} (evidence ${recorded.evidenceDigest})`,
      );
      return 0;
    },
  }),
  command({
    name: "review decide",
    required: ["campaign", "finding", "decision", "reason"],
    usage: [
      "review decide --campaign <id> --finding <id> --decision accept|reject|defer --reason <code> [--opened <digest>]... [--duplicate no-match|unavailable[:<reason>]|possible-match:<ref> [--duplicate-note <path>]] [--reproduced match|mismatch|unavailable [--reproduce-minutes <n>]] [--by <name>] [--minutes <n>]",
    ],
    options: {
      by: STR,
      campaign: STR,
      decision: STR,
      duplicate: STR,
      "duplicate-note": STR,
      finding: STR,
      minutes: STR,
      opened: STRS,
      reason: STR,
      reproduced: STR,
      "reproduce-minutes": STR,
    },
    prepareInput: (values) => {
      const decidedBy = values.by ?? "operator";
      const nonHumanDecision = isNonHumanReviewer(decidedBy);
      if (nonHumanDecision) {
        if (values.minutes !== undefined)
          throw new UsageError("--minutes requires a human reviewer");
        if (values.reproduced !== undefined)
          throw new UsageError("--reproduced requires a human reviewer");
      }
      const decision = choice(
        required(values.decision, "decision"),
        "decision",
        ["accept", "reject", "defer"] as const,
      );
      const duplicate = parseDuplicate(values.duplicate);
      if (values["duplicate-note"] !== undefined && duplicate === undefined)
        throw new UsageError("--duplicate-note needs --duplicate");
      if (
        values.reproduced === undefined &&
        values["reproduce-minutes"] !== undefined
      )
        throw new UsageError("--reproduce-minutes needs --reproduced");
      const reproduced =
        values.reproduced === undefined
          ? undefined
          : choice(values.reproduced, "reproduced", [
              "match",
              "mismatch",
              "unavailable",
            ] as const);
      return {
        decision,
        decidedBy,
        nonHumanDecision,
        duplicate,
        reproduced,
        minutes:
          values.minutes === undefined
            ? undefined
            : parseMinutes(values.minutes),
        reproduceMinutes:
          values["reproduce-minutes"] === undefined
            ? undefined
            : parseMinutes(values["reproduce-minutes"]),
      };
    },
    handler: async ({ values, input, state, environment, io }) => {
      const review = environment.profile.review(state);
      const item = queued(review, values);
      const findingId = item.ref.findingId;
      const { decision, decidedBy, nonHumanDecision, duplicate, reproduced } =
        input;
      const reasonCode = required(values.reason, "reason");
      const notePath = values["duplicate-note"];
      const duplicateNote =
        notePath === undefined
          ? undefined
          : await readFile(resolve(notePath), "utf8");
      if (reproduced !== undefined) {
        if (!hasSubmissionBasis(item))
          throw new UsageError(
            "Only an evidence-backed package can be reproduced",
          );
      }
      const reproduceMinutes =
        reproduced === undefined
          ? null
          : await humanMinutes(input.reproduceMinutes, io, "reproduce");
      const minutes = nonHumanDecision
        ? null
        : await humanMinutes(input.minutes, io, "read");
      const recorded = await review.recordDecision({
        ref: item.ref,
        decision,
        reasonCode,
        openedEvidence: values.opened ?? [],
        ...(duplicate === undefined ? {} : { duplicate }),
        ...(duplicateNote === undefined ? {} : { duplicateNote }),
        decidedBy,
        ...(minutes === null ? {} : { minutes }),
        ...(reproduced === undefined
          ? {}
          : {
              reproduction: {
                result: reproduced,
                ...(reproduceMinutes === null
                  ? {}
                  : { minutes: reproduceMinutes }),
              },
            }),
      });
      if (reproduced !== undefined)
        io.stdout(
          `manual reproduction ${reproduced} recorded for finding ${findingId}`,
        );
      io.stdout(
        `recorded ${recorded.decision} (${recorded.reasonCode}) for finding ${findingId} at ${recorded.decidedAt}`,
      );
      return 0;
    },
  }),
  command({
    name: "review dedupe",
    readOnly: true,
    required: ["campaign", "finding"],
    usage: ["review dedupe --campaign <id> --finding <id>"],
    options: { campaign: STR, finding: STR },
    handler: async ({ values, state, environment, io }) => {
      const review = environment.profile.review(state);
      const item = queued(review, values);
      const result = await review.inspectDuplicate({
        campaignId: item.ref.campaignId,
        findingId: item.ref.findingId,
      });
      io.stdout(
        result.status === "possible-match"
          ? `duplicate: possible-match ${result.reference}`
          : `duplicate: ${result.status}`,
      );
      return 0;
    },
  }),
  command({
    name: "review scope",
    required: ["campaign", "finding"],
    usage: ["review scope --campaign <id> --finding <id>"],
    options: { campaign: STR, finding: STR },
    handler: async ({ values, state, environment, io }) => {
      const review = environment.profile.review(state);
      const item = queued(review, values);
      if (!hasSubmissionBasis(item))
        throw new UsageError(
          "Scope is assessed only for evidence-backed findings",
        );
      for (const assessment of await review.assessScope({ ref: item.ref }))
        io.stdout(
          `${assessment.programmeId} ${assessment.status} (${assessment.reason})  assessment ${assessment.id}`,
        );
      return 0;
    },
  }),
  command({
    name: "review reverify",
    required: ["campaign", "finding", "config"],
    usage: [
      "review reverify --campaign <id> --finding <id> --config <path> [--version <target-version>] [--handoff <dir> [--port <n>] [--db-port <n>]]",
    ],
    options: {
      campaign: STR,
      config: STR,
      "db-port": STR,
      finding: STR,
      handoff: STR,
      port: STR,
      version: STR,
    },
    validate: (values) => {
      const version = values.version;
      if (version !== undefined && !/^[0-9][A-Za-z0-9.+-]{0,31}$/.test(version))
        throw new UsageError("--version is invalid");
      if (
        values.handoff === undefined &&
        (values.port !== undefined || values["db-port"] !== undefined)
      )
        throw new UsageError("--port and --db-port require --handoff");
      integerOption(values.port, "port", 0, 65535);
      integerOption(values["db-port"], "db-port", 0, 65535);
    },
    handler: async ({ values, state, environment, io }) => {
      const version = values.version;
      const input = {
        campaignId: required(values.campaign, "campaign"),
        findingId: required(values.finding, "finding"),
        configPath: resolve(required(values.config, "config")),
        ...(version === undefined ? {} : { version }),
        ...(values.handoff === undefined
          ? {}
          : {
              handoff: {
                directory: resolve(values.handoff),
                httpPort: integerOption(values.port, "port", 0, 65535),
                databasePort: integerOption(
                  values["db-port"],
                  "db-port",
                  0,
                  65535,
                ),
              },
            }),
      };
      const summary = await environment.profile.reverify(state, input);
      io.stdout(
        `reverified finding ${values.finding} as ${summary.findingId} on ${summary.targetId} ${summary.version}  snapshot ${summary.snapshotDigest}  verification ${summary.verificationId}: ${summary.status}`,
      );
      return 0;
    },
  }),
  command({
    name: "verify next",
    required: ["config"],
    usage: [
      "verify next --config <path> --handoff <dir> [--campaign <id> [--finding <id>]] [--port <n>] [--db-port <n>]",
    ],
    options: {
      campaign: STR,
      config: STR,
      "db-port": STR,
      finding: STR,
      handoff: STR,
      port: STR,
    },
    validate: (values) => {
      // The automatic Verifier is retired; every Finding waits for the skill (#423).
      if (values.handoff === undefined)
        throw new UsageError(
          "verify next runs only through the verification skill; pass --handoff <dir>",
        );
      if (values.finding !== undefined && values.campaign === undefined)
        throw new UsageError("--finding needs --campaign");
      integerOption(values.port, "port", 0, 65535);
      integerOption(values["db-port"], "db-port", 0, 65535);
    },
    handler: async ({ values, state, environment, io }) => {
      if (environment.profile.verifyNext === undefined)
        throw new Error("verify next needs a verification profile");
      const summary = await environment.profile.verifyNext(state, {
        ...(values.campaign === undefined
          ? {}
          : { campaignId: values.campaign }),
        configPath: resolve(required(values.config, "config")),
        handoff: {
          directory: resolve(required(values.handoff, "handoff")),
          httpPort: integerOption(values.port, "port", 0, 65535),
          databasePort: integerOption(values["db-port"], "db-port", 0, 65535),
        },
        ...(values.finding === undefined ? {} : { findingId: values.finding }),
      });
      io.stdout(
        summary === null
          ? "no verification pending"
          : `verified finding ${summary.findingId} as ${summary.verificationId}: ${summary.status}`,
      );
      return 0;
    },
  }),
  command({
    name: "review draft",
    required: ["campaign", "finding", "programme", "file"],
    usage: [
      "review draft --campaign <id> --finding <id> --programme <id> --file <path> [--prepared-by human|ai]",
    ],
    options: {
      campaign: STR,
      file: STR,
      finding: STR,
      "prepared-by": STR,
      programme: STR,
    },
    prepareInput: (values) => ({
      preparedBy: choice(values["prepared-by"] ?? "ai", "prepared-by", [
        "human",
        "ai",
      ] as const),
    }),
    handler: async ({ values, input, state, environment, io }) => {
      const review = environment.profile.review(state);
      const item = queued(review, values);
      if (!hasSubmissionBasis(item))
        throw new UsageError(
          "A confirmed verification is required for a draft",
        );
      const programmeId = required(values.programme, "programme");
      const view = await review.inspect({
        campaignId: item.ref.campaignId,
        findingId: item.ref.findingId,
      });
      const assessment = view.scopeAssessments
        .filter(
          (candidate) =>
            candidate.programmeId === programmeId &&
            candidate.ref.verificationId === item.ref.verificationId &&
            candidate.ref.snapshotDigest === item.ref.snapshotDigest,
        )
        .at(-1);
      if (assessment?.status !== "in-scope")
        throw new UsageError(`No in-scope assessment for ${programmeId}`);
      const draft = await review.saveDraft({
        assessmentId: assessment.id,
        content: await readFile(resolve(required(values.file, "file")), "utf8"),
        preparedBy: input.preparedBy,
      });
      // The draft text stays in Private Evidence; only its identity is printed.
      io.stdout(
        `candidate ${draft.candidateId}  draft ${draft.digest}  revision ${draft.revision}  to ${draft.destination}`,
      );
      return 0;
    },
  }),
  command({
    name: "review authorize",
    required: ["candidate", "draft", "to", "by"],
    usage: [
      "review authorize --candidate <id> --draft <digest> --to <destination> --by <name>",
    ],
    options: { by: STR, candidate: STR, draft: STR, to: STR },
    handler: async ({ values, state, environment, io }) => {
      await environment.profile.review(state).authorizeExternalAction({
        ...exactDraft(values),
        authorizedBy: required(values.by, "by"),
      });
      io.stdout("authorization recorded; Harness sends nothing");
      return 0;
    },
  }),
  command({
    name: "review submitted",
    required: ["candidate", "draft", "to"],
    usage: [
      "review submitted --candidate <id> --draft <digest> --to <destination>",
    ],
    options: { candidate: STR, draft: STR, to: STR },
    handler: async ({ values, state, environment, io }) => {
      await environment.profile
        .review(state)
        .recordSubmission(exactDraft(values));
      {
        // Only an interactive host asks; there is no flag for it.
        const minutes = await humanMinutes(undefined, io, "submit");
        if (minutes !== null)
          await environment.profile.review(state).recordHumanEffort({
            candidateId: required(values.candidate, "candidate"),
            action: "submit",
            minutes,
          });
      }
      io.stdout("submission recorded");
      return 0;
    },
  }),
  command({
    name: "review outcome",
    required: ["candidate", "outcome"],
    usage: [
      "review outcome --candidate <id> --outcome triaged|resolved|duplicate|informative|not-applicable|rejected [--reward <usd>]",
    ],
    options: { candidate: STR, outcome: STR, reward: STR },
    prepareInput: (values) => {
      const outcome = OUTCOMES.find(
        (candidate) => candidate === values.outcome,
      );
      if (outcome === undefined)
        throw new UsageError(`--outcome must be one of ${OUTCOMES.join(", ")}`);
      const reward =
        values.reward === undefined ? undefined : Number(values.reward);
      if (
        reward !== undefined &&
        (!/^\d+(\.\d{1,2})?$/.test(values.reward ?? "") ||
          !Number.isFinite(reward))
      )
        throw new UsageError("--reward must be a non-negative USD amount");
      return { outcome, reward };
    },
    handler: async ({ values, input, state, environment, io }) => {
      const { outcome, reward } = input;
      await environment.profile.review(state).recordOutcome({
        candidateId: required(values.candidate, "candidate"),
        outcome,
        ...(reward === undefined ? {} : { rewardUsd: reward }),
      });
      // Only an interactive host asks; there is no flag for it.
      const minutes = await humanMinutes(undefined, io, "outcome");
      if (minutes !== null)
        await environment.profile.review(state).recordHumanEffort({
          candidateId: required(values.candidate, "candidate"),
          action: "outcome",
          minutes,
        });
      io.stdout(
        reward === undefined
          ? `outcome ${outcome} recorded`
          : `outcome ${outcome} recorded (reward $${reward.toFixed(2)})`,
      );
      return 0;
    },
  }),
  command({
    name: "ledger funnel",
    readOnly: true,
    usage: ["ledger funnel --campaign <id> | --since <ISO>"],
    options: { campaign: STR, since: STR },
    prepareInput: campaignOrSince,
    handler: async ({ input: scope, state, print }) => {
      print(
        formatFunnel(
          state.ledger.funnel(
            scope.campaignId,
            scope.since === undefined ? {} : { since: scope.since },
          ),
        ),
      );
      return 0;
    },
  }),
  command({
    name: "ledger stops",
    readOnly: true,
    usage: ["ledger stops [--campaign <id>] [--since <ISO>]"],
    options: { campaign: STR, since: STR },
    prepareInput: (values) => since(values.since),
    handler: async ({ values, input: instant, state, print }) => {
      const rows = state.ledger.stops({
        ...(values.campaign === undefined
          ? {}
          : { campaignId: values.campaign }),
        ...(instant === undefined ? {} : { since: instant }),
      });
      if (rows.length === 0) print(["no stops recorded"]);
      print(rows.map(formatStopRow));
      return 0;
    },
  }),
  command({
    name: "ledger resumes",
    readOnly: true,
    usage: ["ledger resumes [--campaign <id>] [--since <ISO>]"],
    options: { campaign: STR, since: STR },
    prepareInput: (values) => since(values.since),
    handler: async ({ values, input: instant, state, print }) => {
      const rows = state.ledger.resumes({
        ...(values.campaign === undefined
          ? {}
          : { campaignId: values.campaign }),
        ...(instant === undefined ? {} : { since: instant }),
      });
      if (rows.length === 0) print(["no resumed segments recorded"]);
      print(rows.map(formatResumeRow));
      return 0;
    },
  }),
  command({
    name: "ledger usage",
    readOnly: true,
    usage: ["ledger usage [--campaign <id>]"],
    options: { campaign: STR },
    handler: async ({ values, state, io }) => {
      const labels = {
        inputTokens: "input",
        cachedInputTokens: "cached",
        outputTokens: "output",
        reasoningOutputTokens: "reasoning",
      } as const;
      const rows = state.ledger.usage(
        values.campaign === undefined ? {} : { campaignId: values.campaign },
      );
      io.stdout("usage by target and UTC day");
      for (const row of rows) {
        const fields = Object.keys(labels) as (keyof typeof labels)[];
        const missing = fields
          .filter((field) => row.unavailable[field] > 0)
          .map((field) => `${labels[field]} ${row.unavailable[field]}`);
        io.stdout(
          `  ${row.day}  ${row.selectionId ?? "unselected"}  runs ${row.runs}  ${fields.map((field) => `${labels[field]} ${row.tokens[field]}`).join("  ")}${missing.length === 0 ? "" : `  unavailable: ${missing.join(", ")}`}`,
        );
      }
      return 0;
    },
  }),
  command({
    name: "ledger runtime",
    readOnly: true,
    usage: ["ledger runtime [--campaign <id>]"],
    options: { campaign: STR },
    handler: async ({ values, state, io }) => {
      const groups = await summarizeRecordedRuntimes({
        ledger: state.ledger,
        store: state.store,
        ...(values.campaign === undefined
          ? {}
          : { campaignId: values.campaign }),
      });
      io.stdout("recorded runtimes (oldest first)");
      for (const { runtime, runs, firstDay, lastDay } of groups)
        io.stdout(
          `  ${runtime.requestedModelId} effort ${runtime.requestedEffort}  child ${runtime.subagent.modelId} effort ${runtime.subagent.effort}  codex-cli ${runtime.codexCliVersion}  catalog ${runtime.bundledCatalogDigest}  tier ${runtime.serviceTier}  access ${runtime.cyberAccessProgram}  auth ${runtime.authenticationMethod}  runs ${runs}  ${firstDay}..${lastDay}`,
        );
      return 0;
    },
  }),
  command({
    name: "history status",
    readOnly: true,
    usage: ["history status"],
    options: {},
    handler: async ({ state, environment, io }) => {
      const status = environment.profile.historyStatus(state);
      io.stdout(status?.line ?? "history mirror not configured");
      return status?.fresh === true ? 0 : 1;
    },
  }),
  command({
    name: "runtime check",
    required: ["config"],
    usage: ["runtime check --config <path>"],
    options: { config: STR },
    handler: async ({ values, state, environment, io }) => {
      const items = await environment.profile.checkRuntime(state, {
        configPath: resolve(required(values.config, "config")),
      });
      for (const { item, profile, image } of items)
        io.stdout(
          `${item}  profile ${profile}  image ${image}  ${profile === image ? "ok" : "differs"}`,
        );
      if (items.every(({ profile, image }) => profile === image)) return 0;
      io.stdout(
        "The image differs from the runtime profile; runs would end incomplete(policy). Update the runtime profile, then confirm the new values with ledger runtime after the next campaign.",
      );
      return 1;
    },
  }),
  command({
    name: "lab cleanup",
    required: ["config"],
    usage: ["lab cleanup --config <path> [--remove]"],
    options: { config: STR, remove: BOOL },
    handler: async ({ values, state, environment, io }) => {
      const remove = values.remove === true;
      const leftovers = await environment.profile.cleanupLeftovers(state, {
        configPath: resolve(required(values.config, "config")),
        remove,
        labs: true,
      });
      for (const kind of ["containers", "networks", "volumes"] as const)
        io.stdout(
          `leftover ${kind} ${leftovers[kind].length}${leftovers[kind].length === 0 ? "" : `: ${leftovers[kind].join(", ")}`}`,
        );
      io.stdout(
        remove
          ? `removed ${leftovers.containers.length} containers, ${leftovers.networks.length} networks, ${leftovers.volumes.length} volumes`
          : "nothing removed; run again with --remove when no campaign is running",
      );
      return 0;
    },
  }),
  command({
    name: "lab up",
    required: ["campaign", "finding"],
    usage: ["lab up --for-review --campaign <id> --finding <id>"],
    options: {
      campaign: STR,
      finding: STR,
      "for-review": BOOL,
    },
    validate: (values) => {
      if (values["for-review"] !== true)
        throw new UsageError("lab up needs --for-review");
    },
    handler: async ({ values, state, environment, io }) => {
      const launch = environment.profile.reviewLab;
      if (launch === undefined)
        throw new UsageError("This profile has no review Lab provisioner");
      const item = queued(environment.profile.review(state), values);
      if (item.status === "not-verified")
        throw new UsageError(
          "An evidence-bound review Lab package is required",
        );
      const manual =
        item.status === "incomplete"
          ? await environment.profile.reviewLabPackage?.(state, item.ref)
          : null;
      const packageDigest =
        item.status === "runtime-confirmed" || item.status === "reproduced"
          ? item.reproductionPackageDigest
          : manual?.packageDigest;
      if (packageDigest === null || packageDigest === undefined)
        throw new UsageError(
          "An evidence-bound review Lab package is required",
        );
      if (manual !== null && manual !== undefined) {
        io.stdout(
          `private recipe steps: ${state.store.contentPath(manual.recipeDigest)}/steps.md`,
        );
        io.stdout(
          `private victim route: ${state.store.contentPath(manual.recipeDigest)}/route.json`,
        );
        io.stdout(
          `private Lab observation: ${state.store.contentPath(manual.evidenceDigest)}`,
        );
      }
      await runForegroundReviewLab(
        () => launch(state, { packageDigest }),
        io,
        process,
        manual === null || manual === undefined
          ? undefined
          : async (session) => {
              const receipt = await recordManualObservationLabReady({
                ledger: state.ledger,
                store: state.store,
                ref: item.ref,
                packageDigest: manual.packageDigest,
                sessionLabel: session.networkName,
                clock: state.clock,
              });
              io.stdout(
                `manual observation receipt: ${receipt} (${state.store.contentPath(receipt)}/${MANUAL_LAB_RECEIPT_FILE})`,
              );
            },
      );
      return 0;
    },
  }),
  command({
    name: "lab down",
    usage: ["lab down [--config <path>]"],
    options: { config: STR },
    handler: async ({ values, state, environment, print }) => {
      const summary = await environment.profile.labDown(state, {
        configPath: values.config === undefined ? null : resolve(values.config),
      });
      print(formatLabDown(summary));
      const remaining =
        summary.remaining.containers.length +
        summary.remaining.networks.length +
        summary.remaining.volumes.length;
      return remaining === 0 ? 0 : 1;
    },
  }),
  // ADR 0036: operator-triggered resume of a stopped Root thread.
  command({
    name: "campaign resume",
    required: ["campaign", "run", "config"],
    usage: ["campaign resume --campaign <id> --run <runId> --config <path>"],
    options: { campaign: STR, run: STR, config: STR },
    handler: async ({ values, state, environment, io, print }) => {
      if (environment.profile.resumeCampaignRun === undefined)
        throw new UsageError("This profile cannot resume a discovery run");
      const campaignId = required(values.campaign, "campaign");
      const release = await holdDiscoverySweep(
        state.stateDirectory,
        process.pid,
      );
      const summary = await environment.profile
        .resumeCampaignRun(state, {
          campaignId,
          runId: required(values.run, "run"),
          configPath: resolve(required(values.config, "config")),
        })
        .finally(release);
      if (summary.status === "refused") {
        io.stderr(
          `not resumable: ${summary.reason}${summary.detail === undefined ? "" : ` (${summary.detail})`}`,
        );
        return 3;
      }
      io.stdout(
        `resumed ${summary.resumesRun} as ${summary.runId}  trial ${summary.trialId}  segment ${summary.segment}  remaining wall ${Math.floor(summary.remainingWallMs / 60_000)} min`,
      );
      io.stdout(
        `  outcome ${summary.outcome}${summary.failure === undefined ? "" : ` (${summary.failure.reason}${summary.failure.reasonDetail === undefined ? "" : `: ${summary.failure.reasonDetail}`})`}  wall ${Math.round(summary.wallTimeMs / 60_000)} min  findings ${summary.findingsRecorded}`,
      );
      print(formatFunnel(state.ledger.funnel(campaignId)));
      return summary.outcome === "completed" ? 0 : 3;
    },
  }),
  // 2026-10-19: the live target limit; registered last so the lines above stay in place.
  continuousRow(
    "continuous concurrency",
    "continuous concurrency [<n>] [--runtime <name>] --config <path>",
  ),
  // 2026-10-20: held Finding candidates (ADR 0018) had no listing; registered last as above.
  command({
    name: "review held",
    readOnly: true,
    required: ["campaign"],
    usage: ["review held --campaign <id>"],
    options: { campaign: STR },
    handler: async ({ values, state, print }) => {
      const campaignId = required(values.campaign, "campaign");
      // As in the funnel, a later normalization of the same candidate clears its hold.
      const held = new Map<
        string,
        Extract<LedgerEventV1, { type: "candidate-held" }>
      >();
      const records = (["candidate-normalized", "candidate-held"] as const)
        .flatMap((type) => state.ledger.readAll({ campaignId, type }))
        .sort((a, b) => a.sequence - b.sequence);
      for (const { event } of records) {
        if (
          (event.type !== "candidate-normalized" &&
            event.type !== "candidate-held") ||
          event.candidateKind !== "finding"
        )
          continue;
        const key = `${event.runId}\0${event.candidateIndex}`;
        if (event.type === "candidate-held") held.set(key, event);
        else held.delete(key);
      }
      if (held.size === 0) print(["no held findings"]);
      for (const event of held.values()) {
        const candidate = event.artifacts.find(
          (artifact) => artifact.kind === "candidate",
        )?.digest;
        const issues = event.issuePaths
          .map((path, index) => {
            const code = event.issueCodes?.[index];
            return code === undefined ? path : `${path}(${code})`;
          })
          .join(", ");
        print([
          `held  ${event.impact ?? "unclassified"}  ${candidate ?? "(candidate unavailable)"}  ${event.runId}#${event.candidateIndex}  issues: ${issues}  ${candidate === undefined ? "" : state.store.contentPath(candidate)}`.trimEnd(),
        ]);
      }
      return 0;
    },
  }),
];

const COMMAND_BY_NAME = commandIndex(COMMANDS);

const USAGE = usageText("usage: harness [--state <dir>] <command>", COMMANDS);

const PARSER_OPTIONS = parserOptions(COMMANDS);

/** Exposed so the tests can check the usage text against the rows it is derived from. */
export const CLI_COMMANDS: readonly CommandShape[] = COMMANDS;
export const CLI_USAGE = USAGE;

export async function runCli(
  argv: readonly string[],
  environment: CliEnvironment,
  io: CliIo,
): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: PARSER_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    const [group, sub, ...rest] = positionals;
    const command = [group, sub].filter((part) => part !== undefined).join(" ");
    const print = (lines: readonly string[]) => lines.forEach(io.stdout);
    const handler = COMMAND_BY_NAME.get(command);
    if (handler === undefined) {
      io.stderr(USAGE);
      return 2;
    }
    const invoke = handler.prepare(argv, rest);
    const state = await openState(
      typeof values.state === "string"
        ? values.state
        : environment.stateDirectory,
      environment,
      { readOnly: handler.readOnly },
    );
    return await invoke({
      rest,
      sub,
      state,
      environment,
      io,
      print,
    });
  } catch (error: unknown) {
    if (
      error instanceof UsageError ||
      (error instanceof TypeError && "code" in error)
    ) {
      io.stderr(`${error.message}\n${USAGE}`);
      return 2;
    }
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
