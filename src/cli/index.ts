import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { summarizeRecordedRuntimes } from "../discovery/index.js";
import type {
  ArmComparison,
  LocationAnswerKey,
  ProspectiveAdvisory,
  ProspectiveScore,
  SourceLocation,
} from "../evaluation/index.js";
import { Evaluation } from "../evaluation/index.js";
import { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import {
  Ledger,
  type CampaignFunnel,
  type FunnelCounts,
} from "../ledger/index.js";
import type {
  DuplicateLookupResult,
  Review,
  ReviewQueue,
} from "../review/index.js";
import type { CampaignSummary, ReverificationSummary } from "./pipeline.js";

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export type CliState = {
  readonly ledger: Ledger;
  readonly store: PrivateArtifactStore;
  /** Where Private Evidence artifacts live on this host (outside Git). */
  readonly evidenceDirectory: string;
  readonly clock: () => Date;
  readonly newId: () => string;
};

/** A profile composition: everything target-specific the commands need. */
export interface CliProfile {
  review(state: CliState): Review;
  answerKeys(value: unknown): readonly LocationAnswerKey[];
  /** Lines describing the public history mirror, and whether it is fresh; null when none is configured. */
  historyStatus(
    state: CliState,
  ): { readonly fresh: boolean; readonly line: string } | null;
  /** Later public advisories in key form, matched to targets by the profile. */
  advisories(value: unknown): readonly ProspectiveAdvisory[];
  locationsOf(finding: unknown): readonly SourceLocation[];
  select(
    state: CliState,
    input: { readonly configPath: string },
  ): Promise<
    readonly {
      readonly targetId: string;
      readonly version: string;
      readonly score: number;
    }[]
  >;
  runCampaign(
    state: CliState,
    input: {
      readonly campaignId: string;
      readonly configPath: string;
      /** A profile target name, or null for every selected target. */
      readonly target: string | null;
    },
  ): Promise<CampaignSummary>;
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
  /** Re-verifies one Finding on its target's latest version in a fresh Lab. */
  reverify(
    state: CliState,
    input: {
      readonly campaignId: string;
      readonly findingId: string;
      readonly configPath: string;
    },
  ): Promise<ReverificationSummary>;
}

export type CliEnvironment = {
  readonly stateDirectory: string;
  readonly profile: CliProfile;
  readonly clock?: () => Date;
  readonly newId?: () => string;
};

const USAGE = [
  "usage: harness [--state <dir>] <command>",
  "  select --config <path>",
  "  campaign run <slug>|--all --campaign <id> --config <path>",
  "  review [--campaign <id>]",
  "  review decide --campaign <id> --finding <id> --decision accept|reject|defer --reason <code> [--opened <digest>]... [--duplicate unavailable|no-match|possible-match:<ref>] [--by <name>]",
  "  review dedupe --campaign <id> --finding <id>",
  "  review scope --campaign <id> --finding <id>",
  "  review reverify --campaign <id> --finding <id> --config <path>",
  "  review draft --campaign <id> --finding <id> --programme <id> --file <path> [--prepared-by human|ai]",
  "  review authorize --candidate <id> --draft <digest> --to <destination> [--by <name>]",
  "  review submitted --candidate <id> --draft <digest> --to <destination>",
  "  review outcome --candidate <id> --outcome triaged|resolved|duplicate|informative|not-applicable|rejected [--reward <usd>]",
  "  ledger funnel --campaign <id>",
  "  ledger usage [--campaign <id>]",
  "  ledger runtime [--campaign <id>]",
  "  history status",
  "  runtime check --config <path>",
  "  lab cleanup --config <path> [--remove]",
  "  eval score --campaign <id> --keys <path> --case <id>",
  "  eval compare [--axis history|prompt|continuation] [--campaign <id>]",
  "  eval prospective --advisories <path> [--campaign <id>]",
].join("\n");

const options = {
  state: { type: "string" },
  all: { type: "boolean" },
  campaign: { type: "string" },
  config: { type: "string" },
  finding: { type: "string" },
  decision: { type: "string" },
  reason: { type: "string" },
  opened: { type: "string", multiple: true },
  duplicate: { type: "string" },
  reward: { type: "string" },
  by: { type: "string" },
  keys: { type: "string" },
  programme: { type: "string" },
  file: { type: "string" },
  "prepared-by": { type: "string" },
  candidate: { type: "string" },
  draft: { type: "string" },
  to: { type: "string" },
  outcome: { type: "string" },
  case: { type: "string" },
  axis: { type: "string" },
  advisories: { type: "string" },
  remove: { type: "boolean" },
} as const;

class UsageError extends Error {}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0)
    throw new UsageError(`--${name} is required`);
  return value;
}

async function openState(
  directory: string,
  environment: CliEnvironment,
): Promise<CliState> {
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const evidenceDirectory = join(root, "private-evidence");
  const store = new PrivateArtifactStore({
    rootDirectory: evidenceDirectory,
    maxEntries: 64,
    maxBytes: 64 * 1024 * 1024,
  });
  return {
    store,
    evidenceDirectory,
    ledger: new Ledger({
      databasePath: join(root, "ledger.sqlite"),
      artifactStore: store,
    }),
    clock: environment.clock ?? (() => new Date()),
    newId: environment.newId ?? randomUUID,
  };
}

function stages(counts: FunnelCounts): string {
  return `raw ${counts.raw} → verifier通過 ${counts.verified} → confirmed ${counts.confirmed} / contradicted ${counts.contradicted} / incomplete ${counts.incomplete} → reviewed ${counts.reviewed} → in-scope ${counts.inScope} → submitted ${counts.submitted} → outcome ${counts.outcome}`;
}

export function formatFunnel(funnel: CampaignFunnel): string[] {
  const lines = [
    `campaign ${funnel.campaignId}`,
    `runs ${funnel.runCount} (discovery attempts ${funnel.discoveryAttempts})  cost $${funnel.knownCostUsd.toFixed(2)} known, ${funnel.unpricedRuns} run(s) unavailable  wall time ${(funnel.wallTimeMs / 1000).toFixed(1)}s`,
    stages(funnel),
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
  for (const category of categories)
    lines.push(`  ${category}: ${stages(funnel.byCategory[category]!)}`);
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

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

export function formatComparison(comparison: ArmComparison): string[] {
  const paired = comparison.targets.filter((target) => target.paired);
  const arm = (name: "a" | "b") => {
    const tally = comparison.pooled[name];
    const rate = tally.runs === 0 ? 0 : tally.hits / tally.runs;
    return `  arm ${name}: hits ${tally.hits}/${tally.runs} (${percent(rate)}, 95% CI ${(tally.interval.lower * 100).toFixed(1)}–${percent(tally.interval.upper)})  findings ${tally.findings}  cost $${tally.knownCostUsd.toFixed(2)} known, ${tally.unpricedRuns} run(s) unavailable`;
  };
  const verdict = {
    inconclusive:
      paired.length === 0 ? "判定不能（対なし）" : "判定不能（区間が重なる）",
    "a-higher": "arm a が高い",
    "b-higher": "arm b が高い",
  }[comparison.verdict];
  return [
    `compare ${comparison.axis}  paired targets ${paired.length}  unpaired ${comparison.targets.length - paired.length}`,
    arm("a"),
    arm("b"),
    `  verdict: ${verdict}`,
    ...comparison.targets.map(
      (target) =>
        `  target ${target.selectionId ?? target.snapshotDigest}  a ${target.arms.a.hits}/${target.arms.a.runs}  b ${target.arms.b.hits}/${target.arms.b.runs}${target.paired ? "" : "  (unpaired, excluded)"}`,
    ),
  ];
}

export function formatProspective(score: ProspectiveScore): string[] {
  const { counts } = score;
  return [
    `prospective ${score.metric}  advisories ${score.advisories.length}  found ${counts.found}  missed ${counts.missed}  unscorable ${counts.unscorable}  predates-run ${counts["predates-run"]}  not-searched ${counts["not-searched"]}`,
    ...score.advisories.map(
      (advisory) =>
        `  ${advisory.status} ${advisory.caseId}  overlapping ${advisory.overlapping.length}  unreadable ${advisory.unreadable.length}`,
    ),
    ...(score.rubric.length === 0 ? [] : ["blind rubric pairs:"]),
    ...score.rubric.map(
      (pair) => `  ${pair.caseId}  finding ${pair.findingId}`,
    ),
  ];
}

export function formatQueue(
  queue: ReviewQueue,
  evidenceDirectory: string,
): string[] {
  const lines: string[] = [];
  for (const item of queue.items) {
    const head = `${item.status}  ${item.ref.campaignId}  finding ${item.ref.findingId}  ${item.category}`;
    const decision = `  decision: ${item.decision ?? "none"}`;
    const verification = `  verification ${item.ref.verificationId}  snapshot ${item.ref.snapshotDigest}`;
    if (item.status === "runtime-confirmed")
      lines.push(
        head,
        verification,
        `  judge: ${item.judgeId}`,
        `  observed: ${
          Object.entries(item.conditions)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) => `${key}=${value}`)
            .join(" ") || "none"
        }`,
        `  evidence: ${item.evidenceDigest}`,
        `  reproduction package: ${item.reproductionPackageDigest} (${join(evidenceDirectory, item.reproductionPackageDigest)})`,
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
  if (queue.items.length === 0) lines.push("review queue is empty");
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

/** Only runtime-confirmed and incomplete findings are reviewable. */
function queued(review: Review, values: Values) {
  const campaignId = required(values.campaign, "campaign");
  const findingId = required(values.finding, "finding");
  const item = review
    .queue({ campaignId })
    .items.find((candidate) => candidate.ref.findingId === findingId);
  if (item === undefined)
    throw new UsageError(
      "The finding is not in the review queue (only runtime-confirmed and incomplete are reviewed)",
    );
  return item;
}

function exactDraft(values: Values) {
  return {
    candidateId: required(values.candidate, "candidate"),
    draftDigest: required(values.draft, "draft"),
    destination: required(values.to, "to"),
  };
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
      case "select": {
        const selected = await environment.profile.select(state, {
          configPath: resolve(required(values.config, "config")),
        });
        for (const target of selected)
          io.stdout(
            `${target.targetId} ${target.version} score ${target.score.toFixed(2)}`,
          );
        if (selected.length === 0) io.stdout("no targets selected");
        return 0;
      }
      case "campaign run": {
        const target = rest[0] ?? null;
        if ((target === null) === (values.all !== true) || rest.length > 1)
          throw new UsageError(
            "campaign run takes exactly one of <slug> or --all",
          );
        const summary = await environment.profile.runCampaign(state, {
          campaignId: required(values.campaign, "campaign"),
          configPath: resolve(required(values.config, "config")),
          target,
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
            state.evidenceDirectory,
          ),
        );
        return 0;
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
        const recorded = await review.decide({
          ref: item.ref,
          decision,
          reasonCode: required(values.reason, "reason"),
          openedEvidence: values.opened ?? [],
          duplicate: parseDuplicate(values.duplicate),
          decidedBy: values.by ?? "operator",
        });
        io.stdout(
          `recorded ${recorded.decision} (${recorded.reasonCode}) for finding ${findingId} at ${recorded.decidedAt}`,
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
        const summary = await environment.profile.reverify(state, {
          campaignId: required(values.campaign, "campaign"),
          findingId: required(values.finding, "finding"),
          configPath: resolve(required(values.config, "config")),
        });
        io.stdout(
          `reverified finding ${values.finding} on ${summary.targetId} ${summary.version}  snapshot ${summary.snapshotDigest}  verification ${summary.verificationId}: ${summary.status}`,
        );
        return 0;
      }
      case "review scope": {
        const review = environment.profile.review(state);
        const item = queued(review, values);
        if (item.status !== "runtime-confirmed")
          throw new UsageError(
            "Scope is assessed only for runtime-confirmed findings",
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
      case "ledger funnel":
        print(
          formatFunnel(
            state.ledger.funnel(required(values.campaign, "campaign")),
          ),
        );
        return 0;
      case "eval score": {
        const caseId = required(values.case, "case");
        const keys = environment.profile.answerKeys(
          JSON.parse(
            await readFile(resolve(required(values.keys, "keys")), "utf8"),
          ) as unknown,
        );
        const answerKey = keys.find((key) => key.caseId === caseId);
        if (answerKey === undefined)
          throw new UsageError("The key file has no such case");
        const score = await new Evaluation({
          ledger: state.ledger,
          store: state.store,
          locationsOf: (finding) => environment.profile.locationsOf(finding),
        }).score({
          campaignId: required(values.campaign, "campaign"),
          answerKey,
        });
        // Only counts and record ids are printed; key locations stay in the key file.
        io.stdout(
          `${score.metric}  case ${score.caseId}  campaign ${score.campaignId}  findings ${score.findings}  overlapping ${score.overlapping.length}  unreadable ${score.unreadable.length}  hit ${score.hit ? "yes" : "no"}`,
        );
        for (const findingId of score.overlapping)
          io.stdout(`  overlapping finding ${findingId}`);
        for (const findingId of score.unreadable)
          io.stdout(`  unreadable finding ${findingId}`);
        if (score.leadCandidates !== undefined) {
          io.stdout(
            `  source candidates ${score.leadCandidates.total}  overlapping ${score.leadCandidates.overlapping.length}  unreadable ${score.leadCandidates.unreadable.length}  hit ${score.leadCandidates.hit ? "yes" : "no"}`,
          );
          for (const leadId of score.leadCandidates.overlapping)
            io.stdout(`  overlapping lead ${leadId}`);
          for (const leadId of score.leadCandidates.unreadable)
            io.stdout(`  unreadable lead ${leadId}`);
        }
        return 0;
      }
      case "eval prospective": {
        const advisories = environment.profile.advisories(
          JSON.parse(
            await readFile(
              resolve(required(values.advisories, "advisories")),
              "utf8",
            ),
          ) as unknown,
        );
        print(
          formatProspective(
            await new Evaluation({
              ledger: state.ledger,
              store: state.store,
              locationsOf: (finding) =>
                environment.profile.locationsOf(finding),
            }).prospective({
              advisories,
              ...(values.campaign === undefined
                ? {}
                : { campaignId: values.campaign }),
            }),
          ),
        );
        return 0;
      }
      case "eval compare": {
        const axis = values.axis ?? "history";
        if (axis !== "history" && axis !== "prompt" && axis !== "continuation")
          throw new UsageError(
            "--axis supports history, prompt or continuation",
          );
        print(
          formatComparison(
            new Evaluation({
              ledger: state.ledger,
              store: state.store,
              locationsOf: (finding) =>
                environment.profile.locationsOf(finding),
            }).compare({
              axis,
              ...(values.campaign === undefined
                ? {}
                : { campaignId: values.campaign }),
            }),
          ),
        );
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
