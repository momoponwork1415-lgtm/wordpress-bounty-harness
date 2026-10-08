import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import type { LocationAnswerKey, SourceLocation } from "../evaluation/index.js";
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
import type { CampaignSummary } from "./pipeline.js";

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export type CliState = {
  readonly ledger: Ledger;
  readonly store: PrivateArtifactStore;
  readonly clock: () => Date;
  readonly newId: () => string;
};

/** A profile composition: everything target-specific the commands need. */
export interface CliProfile {
  review(state: CliState): Review;
  answerKeys(value: unknown): readonly LocationAnswerKey[];
  locationsOf(finding: unknown): readonly SourceLocation[];
  runCampaign(
    state: CliState,
    input: { readonly campaignId: string; readonly configPath: string },
  ): Promise<CampaignSummary>;
}

export type CliEnvironment = {
  readonly stateDirectory: string;
  readonly profile: CliProfile;
  readonly clock?: () => Date;
  readonly newId?: () => string;
};

const USAGE = [
  "usage: harness [--state <dir>] <command>",
  "  campaign run --campaign <id> --config <path>",
  "  review [--campaign <id>]",
  "  review decide --campaign <id> --finding <id> --decision accept|reject|defer --reason <code> [--opened <digest>]... [--duplicate unavailable|no-match|possible-match:<ref>] [--by <name>]",
  "  ledger funnel --campaign <id>",
  "  eval score --campaign <id> --keys <path> --case <id>",
].join("\n");

const options = {
  state: { type: "string" },
  campaign: { type: "string" },
  config: { type: "string" },
  finding: { type: "string" },
  decision: { type: "string" },
  reason: { type: "string" },
  opened: { type: "string", multiple: true },
  duplicate: { type: "string" },
  by: { type: "string" },
  keys: { type: "string" },
  case: { type: "string" },
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
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "private-evidence"),
    maxEntries: 64,
    maxBytes: 64 * 1024 * 1024,
  });
  return {
    store,
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
  const categories = Object.keys(funnel.byCategory).sort();
  if (categories.length > 0) lines.push("by category:");
  for (const category of categories)
    lines.push(`  ${category}: ${stages(funnel.byCategory[category]!)}`);
  return lines;
}

export function formatQueue(queue: ReviewQueue): string[] {
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
        `  evidence: ${item.evidenceDigest}`,
        `  reproduction package: ${item.reproductionPackageDigest}`,
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
    const command = positionals.join(" ");
    const print = (lines: readonly string[]) => lines.forEach(io.stdout);
    switch (command) {
      case "campaign run": {
        const summary = await environment.profile.runCampaign(state, {
          campaignId: required(values.campaign, "campaign"),
          configPath: resolve(required(values.config, "config")),
        });
        for (const target of summary.targets) {
          io.stdout(
            `${target.targetId} ${target.version}  snapshot ${target.snapshotDigest}  lab ${target.lab}  runs ${target.runCount}  stopped by ${target.stoppedBy}`,
          );
          for (const verification of target.verifications)
            io.stdout(
              `  finding ${verification.findingId}: ${verification.status}`,
            );
        }
        print(formatFunnel(state.ledger.funnel(summary.campaignId)));
        return 0;
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
          ),
        );
        return 0;
      case "review decide": {
        const campaignId = required(values.campaign, "campaign");
        const findingId = required(values.finding, "finding");
        const review = environment.profile.review(state);
        const item = review
          .queue({ campaignId })
          .items.find((candidate) => candidate.ref.findingId === findingId);
        if (item === undefined)
          throw new UsageError(
            "The finding is not in the review queue (only runtime-confirmed and incomplete are reviewed)",
          );
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
        // Only counts and Finding ids are printed; key locations stay in the key file.
        io.stdout(
          `${score.metric}  case ${score.caseId}  campaign ${score.campaignId}  findings ${score.findings}  overlapping ${score.overlapping.length}  unreadable ${score.unreadable.length}  hit ${score.hit ? "yes" : "no"}`,
        );
        for (const findingId of score.overlapping)
          io.stdout(`  overlapping finding ${findingId}`);
        for (const findingId of score.unreadable)
          io.stdout(`  unreadable finding ${findingId}`);
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
