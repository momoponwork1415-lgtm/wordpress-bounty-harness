import { z } from "zod";

import { readFile } from "node:fs/promises";
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
  type DuplicateLookupResult,
  type HttpEvidenceReader,
  type Review,
  type ReviewQueue,
  type StateDiffReader,
} from "../review/index.js";
import type {
  CampaignSummary,
  ReverificationSummary,
  TargetLimit,
  VerifyNextSummary,
} from "./pipeline.js";
import { holdLabSweep } from "./continuous.js";
import {
  continuousCommand,
  type ContinuousHostStatus,
} from "./continuous-cli.js";
import {
  BOOL,
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
    input: { readonly packageDigest: string; readonly category: string },
  ): Promise<{
    readonly endpoint: string;
    readonly networkName: string;
    readonly recorderIp: string;
    readonly receiverIp: string;
    readonly attackerAccounts: unknown;
    readonly administrator: unknown;
    readonly canaries: unknown;
    readonly browserImage: string;
    close(): Promise<void>;
  }>;
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
    },
  ): Promise<CliSelectionReport>;
  runCampaign(
    state: CliState,
    input: {
      readonly campaignId: string;
      readonly configPath: string;
      /** A profile target name, or null for every selected target. */
      readonly target: string | null;
      /** Explicit independent Trials on the same Snapshot. */
      readonly repeat?: number;
      /** Retry an incomplete independent verification on the same Lab setup. */
      readonly retryIncompleteVerifications?: boolean;
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
  /** Whether `lab up` holds a Lab for an operator; `continuous run` skips its sweep meanwhile. */
  labHeld(state: CliState): Promise<boolean>;
  /** Docker resources a crashed run left behind; removed only when asked. */
  cleanupLeftovers(
    state: CliState,
    input: { readonly configPath: string; readonly remove: boolean },
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
  /** Summarizes the profile's Lab state diff artifact for `review export` (#186). */
  stateDiffReader(state: CliState): StateDiffReader;
  /** Reads the profile's HTTP evidence record for `review export`; names of its files stay in the profile. */
  httpEvidenceReader(state: CliState): HttpEvidenceReader;
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
  value: string | undefined,
  io: CliIo,
  action: "read" | "reproduce" | "submit" | "outcome",
): Promise<number | null> {
  if (value === undefined) return io.askMinutes?.(action) ?? null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(value))
    throw new UsageError(
      "--minutes must be a non-negative number with at most two decimals",
    );
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes > 1440)
    throw new UsageError("--minutes must be between 0 and 1440");
  return minutes;
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
  const lines = [
    `campaign ${funnel.campaignId}`,
    `agent runs ${funnel.runCount} (discovery attempts ${funnel.discoveryAttempts})  ${cost}  summed agent time ${(funnel.wallTimeMs / 1000).toFixed(1)}s`,
    `incomplete(depth) ${funnel.incompleteDepth}`,
    `by Lab: attached runs ${funnel.byLab.attached.runs} findings ${funnel.byLab.attached.findings} confirmed ${funnel.byLab.attached.confirmed}; none runs ${funnel.byLab.none.runs} findings ${funnel.byLab.none.findings} confirmed ${funnel.byLab.none.confirmed}; verification Lab failed ${funnel.verificationLabFailed}`,
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
): string[] {
  const lines: string[] = [];
  for (const item of queue.items) {
    const head = `${item.status}  ${item.ref.campaignId}  finding ${item.ref.findingId}  ${item.category}`;
    const decision = `  decision: ${item.decision ?? "none"}`;
    const verification = `  verification ${item.ref.verificationId}  snapshot ${item.ref.snapshotDigest}`;
    if (item.status === "contradicted")
      lines.push(
        head,
        verification,
        `  observer: ${item.judgeId}`,
        `  evidence: ${item.evidenceDigest} (${contentPath(item.evidenceDigest)})`,
        `  refutation: ${
          item.refutationDigest === null
            ? "none"
            : `${item.refutationDigest} (${contentPath(item.refutationDigest)})`
        }`,
        decision,
      );
    else if (item.status !== "incomplete")
      lines.push(
        head,
        verification,
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
      );
    else
      lines.push(
        head,
        verification,
        `  reason: ${item.reason}`,
        `  next: ${item.nextStep}`,
        decision,
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

function parseDuplicate(value: string | undefined): DuplicateLookupResult {
  if (value === undefined || value === "unavailable")
    return { status: "unavailable" };
  if (value === "no-match") return { status: "no-match" };
  if (value.startsWith("possible-match:") && value.length > 15)
    return { status: "possible-match", reference: value.slice(15) };
  throw new UsageError(
    "--duplicate must be unavailable, no-match or possible-match:<ref>",
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
        io.stdout(`fresh canaries: ${JSON.stringify(session.canaries)}`);
        const shellQuote = (value: string) =>
          `'${value.replaceAll("'", "'\\''")}'`;
        io.stdout(
          `manual client: docker run --rm -it --runtime=runsc --network ${shellQuote(session.networkName)} --add-host ${shellQuote(`wordpress:${session.recorderIp}`)} --add-host ${shellQuote(`canary:${session.receiverIp}`)} --read-only --cap-drop=ALL --security-opt=no-new-privileges --tmpfs=/tmp:rw,nosuid,nodev,size=512m --entrypoint sh ${shellQuote(session.browserImage)}`,
        );
        io.stdout(
          "Run the package's manual HTTP or browser steps in that client; interrupt this command to remove the Lab.",
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
  readonly handler: (context: CommandContext<FlagSet>) => Promise<number>;
}

/** Declares one row; the handler's `values` is typed from the row's own `options`. */
function command<const Flags extends FlagSet>(row: {
  readonly name: string;
  readonly usage: string | readonly string[];
  readonly options: Flags;
  readonly handler: (context: CommandContext<Flags>) => Promise<number>;
}): Command {
  return {
    name: row.name,
    usage: typeof row.usage === "string" ? [row.usage] : row.usage,
    options: row.options,
    handler: row.handler as Command["handler"],
  };
}

const continuousFlags = {
  config: STR,
  selection: STR,
  "campaign-prefix": STR,
  notify: STR,
  resume: BOOL,
  runtime: STR,
} as const;

/** The `continuous` subcommands share one handler; `sub` picks the action. */
function continuousRow(name: string, usage: string): Command {
  return command({
    name,
    usage,
    options: continuousFlags,
    handler: async ({ values, sub, rest, state, environment, io }) => {
      return await continuousCommand(sub!, {
        rest,
        state,
        profile: environment.profile,
        io,
        configPath:
          values.config === undefined ? undefined : resolve(values.config),
        selectionPath:
          values.selection === undefined
            ? undefined
            : resolve(values.selection),
        campaignPrefix: values["campaign-prefix"] ?? "prod",
        notify: values.notify,
        resume: values.resume ?? false,
        runtime: values.runtime,
      });
    },
  });
}

/** One row per command, in the order the usage text lists them. */
const COMMANDS: readonly Command[] = [
  command({
    name: "select",
    usage: ["select --config <path> [--minimum <n>]"],
    options: { config: STR, minimum: STR },
    handler: async ({ values, state, environment, io }) => {
      const minimum =
        values.minimum === undefined ? undefined : Number(values.minimum);
      if (
        minimum !== undefined &&
        (!Number.isSafeInteger(minimum) || minimum < 1 || minimum > 5)
      )
        throw new UsageError("--minimum must be an integer from 1 to 5");
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
    usage: [
      "campaign run <slug>|--all --campaign <id> --config <path> [--selection <path>] [--repeat <n>] [--retry-incomplete]",
    ],
    options: {
      all: BOOL,
      campaign: STR,
      config: STR,
      repeat: STR,
      "retry-incomplete": BOOL,
      selection: STR,
    },
    handler: async ({ values, rest, state, environment, io, print }) => {
      const target = rest[0] ?? null;
      const repeat = values.repeat === undefined ? 1 : Number(values.repeat);
      if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 40)
        throw new UsageError("--repeat must be an integer from 1 to 40");
      if ((target === null) === (values.all !== true) || rest.length > 1)
        throw new UsageError(
          "campaign run takes exactly one of <slug> or --all",
        );
      // A manual campaign beside the runner keeps its containers (#399).
      const release = await holdLabSweep(state.stateDirectory, process.pid);
      const summary = await environment.profile
        .runCampaign(state, {
          campaignId: required(values.campaign, "campaign"),
          configPath: resolve(required(values.config, "config")),
          target,
          repeat,
          retryIncompleteVerifications: values["retry-incomplete"] === true,
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
      return summary.stopped === undefined ? 0 : 3;
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
    usage: ["review [--campaign <id>]"],
    options: { campaign: STR },
    handler: async ({ values, state, environment, print }) => {
      print(
        formatQueue(
          environment.profile
            .review(state)
            .queue(
              values.campaign === undefined
                ? {}
                : { campaignId: values.campaign },
            ),
          (digest) => state.store.contentPath(digest),
        ),
      );
      return 0;
    },
  }),
  command({
    name: "review parked",
    usage: ["review parked --campaign <id>"],
    options: { campaign: STR },
    handler: async ({ values, state, print }) => {
      // Parked Findings remain inspectable by reason without joining the review queue.
      const parked = state.ledger.read({
        campaignId: required(values.campaign, "campaign"),
        type: "finding-parked",
        limit: 1000,
      });
      if (parked.length === 0) print(["no parked findings"]);
      for (const { event } of parked) {
        if (event.type !== "finding-parked") continue;
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
    name: "review export",
    usage: ["review export --campaign <id> --finding <id>"],
    options: { campaign: STR, finding: STR },
    handler: async ({ values, state, environment, io }) => {
      // The one read interface for the skills (ADR 0031). Bodies and payloads stay behind paths.
      const bundle = await exportReviewBundle({
        ledger: state.ledger,
        store: state.store,
        campaignId: required(values.campaign, "campaign"),
        findingId: required(values.finding, "finding"),
        stateDiff: environment.profile.stateDiffReader(state),
        httpEvidence: environment.profile.httpEvidenceReader(state),
        clock: state.clock,
        ...(environment.profile.latestVersion === undefined
          ? {}
          : {
              observeLatestVersion: (targetId: string) =>
                environment.profile.latestVersion!(state, targetId),
            }),
      });
      io.stdout(canonicalJson(bundle));
      return 0;
    },
  }),
  command({
    name: "review decide",
    usage: [
      "review decide --campaign <id> --finding <id> --decision accept|reject|defer --reason <code> [--opened <digest>]... [--duplicate unavailable|no-match|possible-match:<ref>] [--reproduced match|mismatch|unavailable [--reproduce-minutes <n>]] [--by <name>] [--minutes <n>]",
    ],
    options: {
      by: STR,
      campaign: STR,
      decision: STR,
      duplicate: STR,
      finding: STR,
      minutes: STR,
      opened: STRS,
      reason: STR,
      reproduced: STR,
      "reproduce-minutes": STR,
    },
    handler: async ({ values, state, environment, io }) => {
      const review = environment.profile.review(state);
      const item = queued(review, values);
      const findingId = item.ref.findingId;
      const decision = required(values.decision, "decision");
      if (
        decision !== "accept" &&
        decision !== "reject" &&
        decision !== "defer"
      )
        throw new UsageError("--decision must be accept, reject or defer");
      const reasonCode = required(values.reason, "reason");
      const duplicate = parseDuplicate(values.duplicate);
      const reproduced = values.reproduced;
      if (reproduced === undefined) {
        if (values["reproduce-minutes"] !== undefined)
          throw new UsageError("--reproduce-minutes needs --reproduced");
      } else {
        if (
          reproduced !== "match" &&
          reproduced !== "mismatch" &&
          reproduced !== "unavailable"
        )
          throw new UsageError(
            "--reproduced must be match, mismatch or unavailable",
          );
        if (item.status === "incomplete" || item.status === "contradicted")
          throw new UsageError(
            "Only an evidence-backed package can be reproduced",
          );
      }
      // Every input is read before the first ledger write, so a bad value writes nothing.
      const reproduceMinutes =
        reproduced === undefined
          ? null
          : await humanMinutes(values["reproduce-minutes"], io, "reproduce");
      // One caller input: the minutes land on the decision (ADR 0032 Q22) and on the effort record.
      const minutes = await humanMinutes(values.minutes, io, "read");
      if (reproduced !== undefined) {
        // The human reproduction precedes the decision it informs.
        await review.recordHumanReproduction({
          ref: item.ref,
          result: reproduced,
        });
        if (reproduceMinutes !== null)
          await review.recordHumanEffort({
            campaignId: item.ref.campaignId,
            findingId,
            action: "reproduce",
            minutes: reproduceMinutes,
          });
        io.stdout(
          `manual reproduction ${reproduced} recorded for finding ${findingId}`,
        );
      }
      const recorded = await review.decide({
        ref: item.ref,
        decision,
        reasonCode,
        openedEvidence: values.opened ?? [],
        duplicate,
        decidedBy: values.by ?? "operator",
        ...(minutes === null
          ? {}
          : { humanElapsedSeconds: Math.round(minutes * 60) }),
      });
      io.stdout(
        `recorded ${recorded.decision} (${recorded.reasonCode}) for finding ${findingId} at ${recorded.decidedAt}`,
      );
      if (minutes !== null)
        await review.recordHumanEffort({
          campaignId: item.ref.campaignId,
          findingId,
          action: "read",
          minutes,
        });
      return 0;
    },
  }),
  command({
    name: "review dedupe",
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
    usage: ["review scope --campaign <id> --finding <id>"],
    options: { campaign: STR, finding: STR },
    handler: async ({ values, state, environment, io }) => {
      const review = environment.profile.review(state);
      const item = queued(review, values);
      if (item.status !== "runtime-confirmed" && item.status !== "reproduced")
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
    handler: async ({ values, state, environment, io }) => {
      const version = values.version;
      if (version !== undefined && !/^[0-9][A-Za-z0-9.+-]{0,31}$/.test(version))
        throw new UsageError("--version is invalid");
      if (
        values.handoff === undefined &&
        (values.port !== undefined || values["db-port"] !== undefined)
      )
        throw new UsageError("--port and --db-port require --handoff");
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
                httpPort: integerOption(values.port, "port", 8080, 65535),
                databasePort: integerOption(
                  values["db-port"],
                  "db-port",
                  3307,
                  65535,
                ),
              },
            }),
      };
      const release = await holdLabSweep(state.stateDirectory, process.pid);
      const summary = await environment.profile
        .reverify(state, input)
        .finally(release);
      io.stdout(
        `reverified finding ${values.finding} as ${summary.findingId} on ${summary.targetId} ${summary.version}  snapshot ${summary.snapshotDigest}  verification ${summary.verificationId}: ${summary.status}`,
      );
      return 0;
    },
  }),
  command({
    name: "verify next",
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
    handler: async ({ values, state, environment, io }) => {
      if (environment.profile.verifyNext === undefined)
        throw new Error("verify next needs a verification profile");
      // The automatic Verifier is retired; every Finding waits for the skill (#423).
      if (values.handoff === undefined)
        throw new UsageError(
          "verify next runs only through the verification skill; pass --handoff <dir>",
        );
      if (values.finding !== undefined && values.campaign === undefined)
        throw new UsageError("--finding needs --campaign");
      const release = await holdLabSweep(state.stateDirectory, process.pid);
      const summary = await environment.profile
        .verifyNext(state, {
          ...(values.campaign === undefined
            ? {}
            : { campaignId: values.campaign }),
          configPath: resolve(required(values.config, "config")),
          handoff: {
            directory: resolve(values.handoff),
            httpPort: integerOption(values.port, "port", 8080, 65535),
            databasePort: integerOption(
              values["db-port"],
              "db-port",
              3307,
              65535,
            ),
          },
          ...(values.finding === undefined
            ? {}
            : { findingId: values.finding }),
        })
        .finally(release);
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
    handler: async ({ values, state, environment, io }) => {
      const review = environment.profile.review(state);
      const item = queued(review, values);
      const programmeId = required(values.programme, "programme");
      const view = await review.inspect({
        campaignId: item.ref.campaignId,
        findingId: item.ref.findingId,
      });
      const assessment = view.scopeAssessments
        .filter(
          (candidate) =>
            candidate.programmeId === programmeId &&
            candidate.status === "in-scope",
        )
        .at(-1);
      if (assessment === undefined)
        throw new UsageError(`No in-scope assessment for ${programmeId}`);
      const preparedBy = values["prepared-by"] ?? "human";
      if (preparedBy !== "human" && preparedBy !== "ai")
        throw new UsageError("--prepared-by must be human or ai");
      const draft = await review.saveDraft({
        assessmentId: assessment.id,
        content: await readFile(resolve(required(values.file, "file")), "utf8"),
        preparedBy,
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
    usage: [
      "review authorize --candidate <id> --draft <digest> --to <destination>",
    ],
    options: { candidate: STR, draft: STR, to: STR },
    handler: async ({ values, state, environment, io }) => {
      await environment.profile.review(state).authorizeExternalAction({
        ...exactDraft(values),
        authorizedBy: "operator",
      });
      io.stdout("authorization recorded; Harness sends nothing");
      return 0;
    },
  }),
  command({
    name: "review submitted",
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
    usage: [
      "review outcome --candidate <id> --outcome triaged|resolved|duplicate|informative|not-applicable|rejected [--reward <usd>]",
    ],
    options: { candidate: STR, outcome: STR, reward: STR },
    handler: async ({ values, state, environment, io }) => {
      const outcome = required(values.outcome, "outcome");
      if (!OUTCOMES.includes(outcome as (typeof OUTCOMES)[number]))
        throw new UsageError(`--outcome must be one of ${OUTCOMES.join(", ")}`);
      const reward =
        values.reward === undefined ? undefined : Number(values.reward);
      if (
        reward !== undefined &&
        (!/^\d+(\.\d{1,2})?$/.test(values.reward ?? "") ||
          !Number.isFinite(reward))
      )
        throw new UsageError("--reward must be a non-negative USD amount");
      await environment.profile.review(state).recordOutcome({
        candidateId: required(values.candidate, "candidate"),
        outcome: outcome as (typeof OUTCOMES)[number],
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
    usage: ["ledger funnel --campaign <id> | --since <ISO>"],
    options: { campaign: STR, since: STR },
    handler: async ({ values, state, print }) => {
      const scope = campaignOrSince(values);
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
    usage: ["ledger stops [--campaign <id>] [--since <ISO>]"],
    options: { campaign: STR, since: STR },
    handler: async ({ values, state, print }) => {
      const instant = since(values.since);
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
    usage: ["ledger resumes [--campaign <id>] [--since <ISO>]"],
    options: { campaign: STR, since: STR },
    handler: async ({ values, state, print }) => {
      const instant = since(values.since);
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
    usage: ["lab cleanup --config <path> [--remove]"],
    options: { config: STR, remove: BOOL },
    handler: async ({ values, state, environment, io }) => {
      const remove = values.remove === true;
      const leftovers = await environment.profile.cleanupLeftovers(state, {
        configPath: resolve(required(values.config, "config")),
        remove,
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
    usage: ["lab up --for-review --campaign <id> --finding <id>"],
    options: {
      campaign: STR,
      finding: STR,
      "for-review": BOOL,
    },
    handler: async ({ values, state, environment, io }) => {
      if (values["for-review"] !== true)
        throw new UsageError("lab up needs --for-review");
      const launch = environment.profile.reviewLab;
      if (launch === undefined)
        throw new UsageError("This profile has no review Lab provisioner");
      const item = queued(environment.profile.review(state), values);
      if (item.status === "incomplete" || item.status === "contradicted")
        throw new UsageError(
          "A reproduction package is required for review Lab setup",
        );
      const release = await holdLabSweep(state.stateDirectory, process.pid);
      try {
        await runForegroundReviewLab(
          () =>
            launch(state, {
              packageDigest: item.reproductionPackageDigest,
              category: item.category,
            }),
          io,
        );
      } finally {
        await release();
      }
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
    usage: ["campaign resume --campaign <id> --run <runId> --config <path>"],
    options: { campaign: STR, run: STR, config: STR },
    handler: async ({ values, state, environment, io, print }) => {
      if (environment.profile.resumeCampaignRun === undefined)
        throw new UsageError("This profile cannot resume a discovery run");
      const campaignId = required(values.campaign, "campaign");
      const release = await holdLabSweep(state.stateDirectory, process.pid);
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
    const state = await openState(
      (values.state as string | undefined) ?? environment.stateDirectory,
      environment,
    );
    const [group, sub, ...rest] = positionals;
    const command = [group, sub].filter((part) => part !== undefined).join(" ");
    const print = (lines: readonly string[]) => lines.forEach(io.stdout);
    const handler = COMMAND_BY_NAME.get(command);
    if (handler === undefined) {
      io.stderr(USAGE);
      return 2;
    }
    return await handler.handler({
      values: values as never,
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
