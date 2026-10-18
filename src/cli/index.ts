import { z } from "zod";

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { summarizeRecordedRuntimes } from "../discovery/index.js";
import { canonicalJson } from "../infrastructure/canonical-json.js";
import {
  type CampaignFunnel,
  type StopRow,
  type FunnelCounts,
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
  VerifyNextSummary,
} from "./pipeline.js";
import { holdLabSweep } from "./continuous.js";
import {
  continuousCommand,
  type ContinuousHostStatus,
} from "./continuous-cli.js";
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

/** What `lab up --finding` started; Lab-only credentials are printed on purpose (#186). */
export type LabUpSummary = {
  readonly labId: string;
  readonly campaignId: string;
  readonly findingId: string;
  readonly snapshotDigest: string;
  readonly scenario: { readonly id: string; readonly digest: string } | null;
  readonly setupDigest: string;
  /** Null when the Finding has no verification to compare with. */
  readonly matchesVerification: {
    readonly verificationId: string;
    readonly same: boolean;
  } | null;
  readonly http: { readonly port: number; readonly hostHeader: string };
  readonly database: {
    readonly port: number;
    readonly name: string;
    readonly username: string;
    readonly password: string;
  } | null;
  readonly attackerAccounts: readonly {
    readonly role: string;
    readonly username: string;
    readonly password: string;
  }[];
};

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
  readonly selected: readonly {
    readonly targetId: string;
    readonly version: string;
    readonly score: number;
    readonly scoreBreakdown: Readonly<Record<string, number>>;
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
      /** Keep the discovery Lab, but leave Findings for a later `verify next`. */
      readonly deferVerification?: boolean;
      /** Checked before each next target; true drains the campaign as `operator`. */
      readonly stop?: () => boolean;
      /** Aborts exploration currently running when continuous mode receives SIGTERM. */
      readonly signal?: AbortSignal;
      /** Replaces the campaign config's selection policy path in process. */
      readonly selectionPolicyPath?: string;
    },
  ): Promise<CampaignSummary>;
  /** Verify one unverified or retry-eligible Finding in a fresh Lab. */
  verifyNext?(
    state: CliState,
    input: {
      readonly campaignId?: string;
      readonly campaignPrefix?: string;
      readonly configPath: string;
      /** Hand the Lab to a skill through this directory instead of the agent transport. */
      readonly handoff?: {
        readonly directory: string;
        readonly httpPort: number;
        readonly databasePort: number;
      };
      /** With `handoff`: the one Finding the operator named, outside the automatic retry rules. */
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
  /** Whether the policies an `exhausted` runner is restarted with sit next to `selectionPath`. */
  floorPoliciesAvailable(
    state: CliState,
    input: { readonly selectionPath: string },
  ): Promise<boolean>;
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
  /** Starts the verification Lab of one Finding and publishes it on host loopback ports. */
  labUp(
    state: CliState,
    input: {
      readonly campaignId: string;
      readonly findingId: string;
      readonly configPath: string;
      readonly httpPort: number;
      readonly databasePort: number;
    },
  ): Promise<LabUpSummary>;
  /** Removes the Lab `lab up` started; containers, networks and volumes. */
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

const USAGE = [
  "usage: harness [--state <dir>] <command>",
  "  select --config <path> [--minimum <n>]",
  "  campaign run <slug>|--all --campaign <id> --config <path> [--selection <path>] [--repeat <n>] [--retry-incomplete] [--defer-verification]",
  "  continuous run --config <path> --selection <path> [--campaign-prefix <text>] [--verify-concurrency <n>] [--notify <command>] [--resume]",
  "  continuous stop",
  "  continuous resume",
  "  continuous status",
  "  review [--campaign <id>]",
  "  review parked --campaign <id> | --since <ISO>",
  "  review export --campaign <id> --finding <id>",
  "  review decide --campaign <id> --finding <id> --decision accept|reject|defer --reason <code> [--opened <digest>]... [--duplicate unavailable|no-match|possible-match:<ref>] [--by <name>] [--minutes <n>]",
  "  review reproduced --campaign <id> --finding <id> --result match|mismatch|unavailable [--minutes <n>]",
  "  review dedupe --campaign <id> --finding <id>",
  "  review scope --campaign <id> --finding <id>",
  "  review reverify --campaign <id> --finding <id> --config <path> [--version <target-version>]",
  "  verify next --campaign <id> --config <path> [--handoff <dir> [--finding <id>] [--port <n>] [--db-port <n>]]",
  "  review draft --campaign <id> --finding <id> --programme <id> --file <path> [--prepared-by human|ai]",
  "  review authorize --candidate <id> --draft <digest> --to <destination> [--by <name>]",
  "  review submitted --candidate <id> --draft <digest> --to <destination>",
  "  review outcome --candidate <id> --outcome triaged|resolved|duplicate|informative|not-applicable|rejected [--reward <usd>]",
  "  ledger funnel --campaign <id> | --since <ISO>",
  "  ledger stops [--campaign <id>] [--since <ISO>]",
  "  ledger usage [--campaign <id>]",
  "  ledger runtime [--campaign <id>]",
  "  history status",
  "  runtime check --config <path>",
  "  lab cleanup --config <path> [--remove]",
  "  lab up --for-review --campaign <id> --finding <id>",
  "  lab up --campaign <id> --finding <id> --config <path> [--port <n>] [--db-port <n>]",
  "  lab down [--config <path>]",
].join("\n");

const options = {
  state: { type: "string" },
  all: { type: "boolean" },
  campaign: { type: "string" },
  config: { type: "string" },
  finding: { type: "string" },
  version: { type: "string" },
  decision: { type: "string" },
  reason: { type: "string" },
  opened: { type: "string", multiple: true },
  duplicate: { type: "string" },
  reward: { type: "string" },
  minutes: { type: "string" },
  result: { type: "string" },
  by: { type: "string" },
  keys: { type: "string" },
  manifest: { type: "string" },
  programme: { type: "string" },
  file: { type: "string" },
  "prepared-by": { type: "string" },
  candidate: { type: "string" },
  draft: { type: "string" },
  to: { type: "string" },
  outcome: { type: "string" },
  remove: { type: "boolean" },
  "for-review": { type: "boolean" },
  handoff: { type: "string" },
  "retry-incomplete": { type: "boolean" },
  "defer-verification": { type: "boolean" },
  repeat: { type: "string" },
  "verify-concurrency": { type: "string" },
  port: { type: "string" },
  "db-port": { type: "string" },
  since: { type: "string" },
  selection: { type: "string" },
  "campaign-prefix": { type: "string" },
  notify: { type: "string" },
  resume: { type: "boolean" },
  minimum: { type: "string" },
} as const;

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
    if (item.status !== "incomplete")
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
    `contradicted: ${queue.contradicted} (count only)  unverified: ${queue.unverified}`,
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

/** Evidence-backed and exhausted incomplete findings are reviewable. */
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

export function formatLabUp(summary: LabUpSummary): string[] {
  const lines = [
    `lab ${summary.labId} up for finding ${summary.findingId} (campaign ${summary.campaignId})`,
    `  snapshot ${summary.snapshotDigest}`,
    `  scenario ${summary.scenario === null ? "none" : `${summary.scenario.id} ${summary.scenario.digest}`}`,
    `  setup ${summary.setupDigest}  ${
      summary.matchesVerification === null
        ? "no verification to compare"
        : summary.matchesVerification.same
          ? `same as verification ${summary.matchesVerification.verificationId}`
          : `DIFFERS from verification ${summary.matchesVerification.verificationId}`
    }`,
    `  http: http://127.0.0.1:${summary.http.port}/  (send Host: ${summary.http.hostHeader}; e.g. curl --resolve ${summary.http.hostHeader}:${summary.http.port}:127.0.0.1 http://${summary.http.hostHeader}:${summary.http.port}/)`,
    `  browser: map ${summary.http.hostHeader} to 127.0.0.1 in /etc/hosts and start with --port 80, because the site URL is http://${summary.http.hostHeader}`,
  ];
  for (const account of summary.attackerAccounts)
    lines.push(
      `  attacker ${account.role}: ${account.username} / ${account.password} (Lab only)`,
    );
  lines.push(
    summary.database === null
      ? "  database: not exposed by this Lab setup"
      : `  database (read-only): mysql -h 127.0.0.1 -P ${summary.database.port} -u ${summary.database.username} -p'${summary.database.password}' ${summary.database.name}`,
    "  finish with: lab down",
  );
  return lines;
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

export async function runCli(
  argv: readonly string[],
  environment: CliEnvironment,
  io: CliIo,
): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options,
      allowPositionals: true,
      strict: true,
    });
    const state = await openState(
      values.state ?? environment.stateDirectory,
      environment,
    );
    const [group, sub, ...rest] = positionals;
    const command = [group, sub].filter((part) => part !== undefined).join(" ");
    const print = (lines: readonly string[]) => lines.forEach(io.stdout);
    switch (command) {
      case "continuous run":
      case "continuous stop":
      case "continuous resume":
      case "continuous status":
        return await continuousCommand(sub!, {
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
          verifyConcurrency:
            values["verify-concurrency"] === undefined
              ? 1
              : Number(values["verify-concurrency"]),
        });
      case "select": {
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
        for (const target of report.selected)
          io.stdout(
            `${target.targetId} ${target.version} score ${target.score.toFixed(2)}  breakdown ${Object.entries(
              target.scoreBreakdown,
            )
              .map(([part, points]) => `${part}=${points.toFixed(2)}`)
              .join(
                " ",
              )}  observed ${target.observedAt}  source ${target.sourceUrl ?? "unavailable"}  excluded none`,
          );
        for (const target of report.excluded)
          io.stdout(
            `excluded ${target.targetId}  reasons ${target.reasons.join(",")}  observed ${target.observedAt ?? "unavailable"}  source ${target.sourceUrl ?? "unavailable"}`,
          );
        if (report.batchId !== null)
          io.stdout(`selection batch ${report.batchId}`);
        if (report.selected.length === 0) io.stdout("no targets selected");
        return 0;
      }
      case "campaign run": {
        const target = rest[0] ?? null;
        const repeat = values.repeat === undefined ? 1 : Number(values.repeat);
        if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 40)
          throw new UsageError("--repeat must be an integer from 1 to 40");
        if ((target === null) === (values.all !== true) || rest.length > 1)
          throw new UsageError(
            "campaign run takes exactly one of <slug> or --all",
          );
        const summary = await environment.profile.runCampaign(state, {
          campaignId: required(values.campaign, "campaign"),
          configPath: resolve(required(values.config, "config")),
          target,
          repeat,
          retryIncompleteVerifications: values["retry-incomplete"] === true,
          deferVerification: values["defer-verification"] === true,
          ...(values.selection === undefined
            ? {}
            : { selectionPolicyPath: resolve(values.selection) }),
        });
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
      }
      case "review":
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
      case "review parked": {
        // Parked Findings remain inspectable by reason without joining the review queue.
        const parked = state.ledger.read({
          ...campaignOrSince(values),
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
      }
      case "review export": {
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
      }
      case "review decide": {
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
        // One caller input: the minutes land on the decision (ADR 0032 Q22) and on the effort record.
        const minutes = await humanMinutes(values.minutes, io, "read");
        const recorded = await review.decide({
          ref: item.ref,
          decision,
          reasonCode: required(values.reason, "reason"),
          openedEvidence: values.opened ?? [],
          duplicate: parseDuplicate(values.duplicate),
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
      }
      case "review reproduced": {
        const review = environment.profile.review(state);
        const item = queued(review, values);
        if (item.status === "incomplete")
          throw new UsageError(
            "Only an evidence-backed package can be reproduced",
          );
        const result = required(values.result, "result");
        if (
          result !== "match" &&
          result !== "mismatch" &&
          result !== "unavailable"
        )
          throw new UsageError(
            "--result must be match, mismatch or unavailable",
          );
        await review.recordHumanReproduction({ ref: item.ref, result });
        const minutes = await humanMinutes(values.minutes, io, "reproduce");
        if (minutes !== null)
          await review.recordHumanEffort({
            campaignId: item.ref.campaignId,
            findingId: item.ref.findingId,
            action: "reproduce",
            minutes,
          });
        io.stdout(
          `manual reproduction ${result} recorded for finding ${item.ref.findingId}`,
        );
        return 0;
      }
      case "review dedupe": {
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
      }
      case "review reverify": {
        const version = values.version;
        if (
          version !== undefined &&
          !/^[0-9][A-Za-z0-9.+-]{0,31}$/.test(version)
        )
          throw new UsageError("--version is invalid");
        const summary = await environment.profile.reverify(state, {
          campaignId: required(values.campaign, "campaign"),
          findingId: required(values.finding, "finding"),
          configPath: resolve(required(values.config, "config")),
          ...(version === undefined ? {} : { version }),
        });
        io.stdout(
          `reverified finding ${values.finding} as ${summary.findingId} on ${summary.targetId} ${summary.version}  snapshot ${summary.snapshotDigest}  verification ${summary.verificationId}: ${summary.status}`,
        );
        return 0;
      }
      case "verify next": {
        if (environment.profile.verifyNext === undefined)
          throw new Error("verify next needs a verification profile");
        if (values.finding !== undefined && values.handoff === undefined)
          throw new UsageError("--finding names a Finding for --handoff only");
        const summary = await environment.profile.verifyNext(state, {
          campaignId: required(values.campaign, "campaign"),
          configPath: resolve(required(values.config, "config")),
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
          ...(values.finding === undefined
            ? {}
            : { findingId: values.finding }),
        });
        io.stdout(
          summary === null
            ? "no verification pending"
            : `verified finding ${summary.findingId} as ${summary.verificationId}: ${summary.status}`,
        );
        return 0;
      }
      case "review scope": {
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
      }
      case "review draft": {
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
          content: await readFile(
            resolve(required(values.file, "file")),
            "utf8",
          ),
          preparedBy,
        });
        // The draft text stays in Private Evidence; only its identity is printed.
        io.stdout(
          `candidate ${draft.candidateId}  draft ${draft.digest}  revision ${draft.revision}  to ${draft.destination}`,
        );
        return 0;
      }
      case "review authorize":
        await environment.profile.review(state).authorizeExternalAction({
          ...exactDraft(values),
          authorizedBy: values.by ?? "operator",
        });
        io.stdout("authorization recorded; Harness sends nothing");
        return 0;
      case "review submitted":
        await environment.profile
          .review(state)
          .recordSubmission(exactDraft(values));
        {
          const minutes = await humanMinutes(values.minutes, io, "submit");
          if (minutes !== null)
            await environment.profile.review(state).recordHumanEffort({
              candidateId: required(values.candidate, "candidate"),
              action: "submit",
              minutes,
            });
        }
        io.stdout("submission recorded");
        return 0;
      case "review outcome": {
        const outcome = required(values.outcome, "outcome");
        if (!OUTCOMES.includes(outcome as (typeof OUTCOMES)[number]))
          throw new UsageError(
            `--outcome must be one of ${OUTCOMES.join(", ")}`,
          );
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
        const minutes = await humanMinutes(values.minutes, io, "outcome");
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
      }
      case "ledger runtime": {
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
            `  ${runtime.requestedModelId} effort ${runtime.requestedEffort}  codex-cli ${runtime.codexCliVersion}  catalog ${runtime.bundledCatalogDigest}  tier ${runtime.serviceTier}  access ${runtime.cyberAccessProgram}  auth ${runtime.authenticationMethod}  runs ${runs}  ${firstDay}..${lastDay}`,
          );
        return 0;
      }
      case "lab cleanup": {
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
      }
      case "lab up": {
        if (values["for-review"] === true) {
          const launch = environment.profile.reviewLab;
          if (launch === undefined)
            throw new UsageError("This profile has no review Lab provisioner");
          const item = queued(environment.profile.review(state), values);
          if (item.status === "incomplete")
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
        }
        const summary = await environment.profile.labUp(state, {
          campaignId: required(values.campaign, "campaign"),
          findingId: required(values.finding, "finding"),
          configPath: resolve(required(values.config, "config")),
          httpPort: integerOption(values.port, "port", 8080, 65535),
          databasePort: integerOption(
            values["db-port"],
            "db-port",
            3307,
            65535,
          ),
        });
        print(formatLabUp(summary));
        return 0;
      }
      case "lab down": {
        const summary = await environment.profile.labDown(state, {
          configPath:
            values.config === undefined ? null : resolve(values.config),
        });
        print(formatLabDown(summary));
        const remaining =
          summary.remaining.containers.length +
          summary.remaining.networks.length +
          summary.remaining.volumes.length;
        return remaining === 0 ? 0 : 1;
      }
      case "runtime check": {
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
      }
      case "history status": {
        const status = environment.profile.historyStatus(state);
        io.stdout(status?.line ?? "history mirror not configured");
        return status?.fresh === true ? 0 : 1;
      }
      case "ledger usage": {
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
      }
      case "ledger funnel": {
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
      }
      case "ledger stops": {
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
      }
      default:
        io.stderr(USAGE);
        return 2;
    }
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
