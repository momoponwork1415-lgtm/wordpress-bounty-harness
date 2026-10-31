import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { onTestFinished } from "vitest";

import { runCli, type CliIo, type CliProfile } from "../../src/cli/index.js";
import { openState } from "../../src/cli/state.js";
import {
  createWordPressCliProfile,
  type WordPressCliProfileOptions,
} from "../../src/cli/wordpress.js";
import {
  canonicalDigest,
  canonicalJson,
} from "../../src/infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import type { Ledger } from "../../src/ledger/index.js";
import { admitWordPressFinding } from "../../src/profiles/wordpress/discovery/finding.js";
import {
  diffWordPressLabState,
  wordpressLabStateSchema,
} from "../../src/profiles/wordpress/lab/index.js";
import { loadWordpressScopePolicy } from "../../src/profiles/wordpress/scope-policy.js";
import { wordPressTargetSelectionSchema } from "../../src/profiles/wordpress/selection/contracts.js";

const sha = (character: string) => `sha256:${character.repeat(64)}`;

/** The clock of every recorded event and of every command the fixture runs. */
export const RECORDED_AT = "2026-10-08T00:00:00.000Z";
/** The discovery prompt the recorded run names. */
export const RECORDED_PROMPT_VARIANT = "wp2shell-bounty-v11";
const SNAPSHOT_DIGEST = sha("5");
const RUN_ID = "recorded-run-1";
const SELECTION_ID = "wporg:synthetic-plugin@3.3.1";

/**
 * Profile methods that select, freeze, explore, verify or touch Docker. The
 * fixture replaces each with one that records its name and throws, so an
 * admin command that reaches execution fails its test.
 */
const EXECUTION_METHODS = [
  "select",
  "discardStaleSelection",
  "runCampaign",
  "targetCeiling",
  "runtimeCeilings",
  "resumeCampaignRun",
  "verifyNext",
  "latestVersion",
  "hostStatus",
  "cleanupLeftovers",
  "checkRuntime",
  "reverify",
  "reviewLab",
  "reviewLabPackage",
  "labDown",
] as const satisfies readonly (keyof CliProfile)[];

export interface RecordedFinding {
  readonly findingId: string;
  readonly category: "account-takeover" | "sqli";
  /** Absent with `verified: false`. */
  readonly verificationId?: string;
  /** The judge evidence of the runtime-confirmed account takeover only. */
  readonly evidenceDigest?: string;
  readonly reproductionPackageDigest?: string;
}

export interface RecordedReviewState {
  readonly root: string;
  readonly stateDirectory: string;
  readonly campaignId: string;
  readonly snapshotDigest: string;
  readonly runId: string;
  /** The same ledger and Private Evidence the CLI opens; append to it for extra history. */
  readonly ledger: Ledger;
  readonly store: PrivateArtifactStore;
  readonly findings: {
    readonly accountTakeover: RecordedFinding;
    readonly sqli: RecordedFinding;
  };
  /** Runs one CLI command on the recorded state; output lines are joined by `\n`. */
  run(
    ...argv: string[]
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Execution methods any command reached; `run` already fails when this is non-empty. */
  readonly executions: readonly string[];
}

/**
 * A state directory that starts from a recorded ledger, for the admin commands
 * (`review …`, `ledger funnel`). Selection, Snapshot freezing, discovery and
 * Labs never run: the real WordPress CLI profile is composed with boundaries
 * and execution methods that throw, and `run` fails if any was reached. Call
 * it inside a test; the state directory is removed when the test finishes.
 *
 * Recorded in campaign `campaignId` (default `campaign-1`) on one synthetic
 * Snapshot, each event through `Ledger.append` with its Private Evidence:
 *
 * - `target-selected` `wporg:synthetic-plugin@3.3.1`, with a valid
 *   `target-selection.json` (5,000 active installations).
 * - `snapshot-frozen`.
 * - `discovery-run-started` (prompt `wp2shell-bounty-v11` and its digest),
 *   `discovery-run-finished` (completed, 2 s, 1,000 input / 100 cached / 20
 *   output tokens, cost unavailable) and `discovery-concluded` (max-runs).
 * - Two `finding-recorded` from that run, each with its admitted
 *   `finding.json`: an account takeover by a subscriber
 *   (`includes/synthetic.php`) and an SQL injection (`synthetic-plugin.php`).
 * - Unless `verified: false`, for each Finding a verification
 *   `lab-provisioned` and a `verification-finished` (attempt 1, verifier-v8,
 *   agent-authored evidence, captured Lab state before / after / diff with
 *   option `synthetic_plugin_shared` changed, and a recipe). The account
 *   takeover is `runtime-confirmed` by a nonce canary (subscriber reached an
 *   administrator session with default settings) with its confirmed route and
 *   reproduction package; the SQL injection is `incomplete (evidence)`.
 */
export async function recordedReviewState(
  options: {
    readonly campaignId?: string;
    /** False records discovery only; both Findings wait for verification. */
    readonly verified?: boolean;
    /** Replaces the facts `review scope` reads from the records. */
    readonly scopeFacts?: WordPressCliProfileOptions["scopeFacts"];
    readonly askMinutes?: CliIo["askMinutes"];
    /** Stands in for the host's one WordPress.org observation (#698). */
    readonly latestVersion?: CliProfile["latestVersion"];
  } = {},
): Promise<RecordedReviewState> {
  const campaignId = options.campaignId ?? "campaign-1";
  const root = await mkdtemp(join(tmpdir(), "wbh-recorded-review-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  const clock = () => new Date(RECORDED_AT);
  const { ledger, store } = await openState(stateDirectory, { clock });
  const base = {
    schemaVersion: 1 as const,
    campaignId,
    snapshotDigest: SNAPSHOT_DIGEST,
    occurredAt: RECORDED_AT,
  };
  const append = async (event: Parameters<Ledger["append"]>[0]) => {
    const result = await ledger.append(event);
    if (result.status !== "appended")
      throw new Error(`Recorded ${event.type} was ${result.status}`);
  };

  const selection = wordPressTargetSelectionSchema.parse({
    targetId: "wporg:synthetic-plugin",
    slug: "synthetic-plugin",
    version: "3.3.1",
    score: 4.5,
    selectedAt: RECORDED_AT,
    policy: { id: "synthetic-pin", digest: sha("6") },
    activeInstallations: 5000,
    dependencyVersionPolicy: "pinned-only",
    scoreBreakdown: { installations: 3.7, recency: 0.8, history: 0 },
    observationRef: {
      kind: "wordpress-org-target-observation-ref",
      schemaVersion: 1,
      id: "observation-synthetic-plugin",
      digest: sha("c"),
    },
    programmeRef: {
      kind: "programme-eligibility-snapshot-ref",
      schemaVersion: 1,
      id: "wordfence-policy",
      digest: sha("a"),
    },
  });
  await append({
    ...base,
    identity: `target-selected-${campaignId}`,
    type: "target-selected",
    selectionId: SELECTION_ID,
    artifacts: [
      {
        kind: "target-selection",
        digest: await store.putFiles({
          "target-selection.json": canonicalJson(selection),
        }),
      },
    ],
  });
  await append({
    ...base,
    identity: `snapshot-frozen-${campaignId}`,
    type: "snapshot-frozen",
    sourceDigest: sha("7"),
    dependencyDigests: [],
  });
  await append({
    ...base,
    identity: `discovery-start-${RUN_ID}`,
    type: "discovery-run-started",
    runId: RUN_ID,
    trialId: RUN_ID,
    trialOrdinal: 0,
    runKind: "explore",
    labAttached: false,
    history: { mode: "none" },
    configuration: {
      promptVariant: RECORDED_PROMPT_VARIANT,
      promptDigest: sha("8"),
    },
  });

  const claim = (impact: RecordedFinding["category"], file: string) => ({
    claim: `Synthetic ${impact} claim`,
    attackerPosition: "subscriber",
    impact,
    configurationPrecondition: "default",
    brokenProperty: "Synthetic property",
    sourceTrace: [{ file, function: "synthetic_handler", line: 3 }],
    existingControls: "Synthetic control",
    labObservations: "Synthetic observation",
  });
  const reportDigest = await store.putFiles({
    "report.json": "Synthetic provider report",
  });
  const recordFinding = async (
    category: RecordedFinding["category"],
    file: string,
  ) => {
    const finding = admitWordPressFinding(claim(category, file), {
      runId: RUN_ID,
      snapshotDigest: SNAPSHOT_DIGEST,
      reportArtifactDigest: reportDigest,
    });
    await append({
      ...base,
      identity: `discovery-finding-${finding.findingId}`,
      type: "finding-recorded",
      findingId: finding.findingId,
      runId: RUN_ID,
      trialId: RUN_ID,
      category,
      preconditionClass: "default",
      artifacts: [
        {
          kind: "finding",
          digest: await store.putFiles({
            "finding.json": canonicalJson(finding),
          }),
        },
      ],
    });
    return finding.findingId;
  };
  const accountTakeoverId = await recordFinding(
    "account-takeover",
    "includes/synthetic.php",
  );
  const sqliId = await recordFinding("sqli", "synthetic-plugin.php");
  await append({
    ...base,
    identity: `discovery-finish-${RUN_ID}`,
    type: "discovery-run-finished",
    runId: RUN_ID,
    outcome: "completed",
    costUsd: "unavailable",
    wallTimeMs: 2000,
    usage: {
      inputTokens: 1000,
      cachedInputTokens: 100,
      outputTokens: 20,
      reasoningOutputTokens: "unavailable",
    },
  });
  await append({
    ...base,
    identity: `discovery-concluded-${campaignId}`,
    type: "discovery-concluded",
    stoppedBy: "max-runs",
  });

  const recordVerification = async (
    findingId: string,
    category: RecordedFinding["category"],
  ): Promise<RecordedFinding> => {
    const verificationId = `recorded-verification-${category}`;
    const setup = {
      schemaVersion: 1,
      snapshotDigest: SNAPSHOT_DIGEST,
      wordpressVersion: "6.8",
      siteTitle: "Synthetic",
      initialPosts: ["Welcome"],
      customerRole: false,
    };
    const labSetupDigest = canonicalDigest(setup);
    const route = {
      snapshotDigest: SNAPSHOT_DIGEST,
      labSetupDigest,
      role: "subscriber",
      defaultSettings: true,
      configurationChanges: [],
      steps: [],
    };
    const evidenceDigest = await store.putFiles({
      "confirmed-route.json": JSON.stringify(route),
    });
    const recipeDigest = await store.putFiles({
      "route.json": JSON.stringify(route),
      "http.json": JSON.stringify([{ status: 200 }]),
    });
    const reproductionPackageDigest = await store.putFiles({
      "manual.md": "Synthetic recorded review package",
      "lab.json": JSON.stringify(setup),
      "evidence.json": JSON.stringify({ judgeEvidenceDigest: evidenceDigest }),
    });
    const before = wordpressLabStateSchema.parse({
      schema: "wordpress-lab-state/v1",
      capturedAt: RECORDED_AT,
      tablePrefix: "wp_",
      options: [
        { name: "synthetic_plugin_shared", value: "untouched", autoload: "no" },
      ],
      users: [],
      tables: [],
    });
    const after = {
      ...before,
      options: [{ ...before.options[0]!, value: "written-synthetic" }],
    };
    const beforeDigest = await store.putFiles({
      "lab-state.json": JSON.stringify(before),
    });
    const afterDigest = await store.putFiles({
      "lab-state.json": JSON.stringify(after),
    });
    const diffDigest = await store.putFiles({
      "lab-state-diff.json": JSON.stringify(
        diffWordPressLabState(before, after, {
          before: beforeDigest,
          after: afterDigest,
        }),
      ),
    });
    await append({
      ...base,
      identity: `verification-lab-${verificationId}`,
      type: "lab-provisioned",
      labId: verificationId,
      status: "ready",
      purpose: "verification",
    });
    const confirmed = category === "account-takeover";
    await append({
      ...base,
      identity: verificationId,
      type: "verification-finished",
      verificationId,
      findingId,
      attempt: 1,
      promptVersion: "verifier-v8",
      labSetupDigest,
      evidenceCapture: "agent-authored",
      labStateDiff: { status: "captured" },
      artifacts: [
        { kind: "recipe", digest: recipeDigest },
        { kind: "lab-state-before", digest: beforeDigest },
        { kind: "lab-state-after", digest: afterDigest },
        { kind: "lab-state-diff", digest: diffDigest },
      ],
      result: confirmed
        ? {
            status: "runtime-confirmed",
            judgeId: "synthetic-recorded-judge",
            proofKind: "nonce-canary",
            conditions: {
              attackerRole: "subscriber",
              defaultSettings: "true",
              observedVia: "session",
              reachedRole: "administrator",
            },
            evidenceDigest,
            reproductionPackageDigest,
          }
        : {
            status: "incomplete",
            reason: "evidence",
            nextStep: "Review the recorded synthetic evidence",
          },
    });
    return {
      findingId,
      category,
      verificationId,
      ...(confirmed ? { evidenceDigest, reproductionPackageDigest } : {}),
    };
  };
  const verified = options.verified !== false;
  const accountTakeover: RecordedFinding = verified
    ? await recordVerification(accountTakeoverId, "account-takeover")
    : { findingId: accountTakeoverId, category: "account-takeover" };
  const sqli: RecordedFinding = verified
    ? await recordVerification(sqliId, "sqli")
    : { findingId: sqliId, category: "sqli" };

  const executions: string[] = [];
  const refuse = (name: string) => () => {
    executions.push(name);
    throw new Error(`Recorded review state does not run ${name}`);
  };
  const wordpress = createWordPressCliProfile({
    scopePolicy: await loadWordpressScopePolicy(),
    ...(options.scopeFacts === undefined
      ? {}
      : { scopeFacts: options.scopeFacts }),
    boundaries: refuse("campaign boundaries"),
    selectionBoundaries: refuse("selection boundaries"),
  });
  const profile: CliProfile = { ...wordpress };
  // Only methods the profile has: an absent optional method keeps its absence.
  for (const name of EXECUTION_METHODS)
    if (wordpress[name] !== undefined)
      Object.assign(profile, { [name]: refuse(name) });
  if (options.latestVersion !== undefined)
    profile.latestVersion = options.latestVersion;

  let ids = 0;
  const environment = {
    stateDirectory,
    profile,
    clock,
    newId: () => `recorded-id-${++ids}`,
  };
  return {
    root,
    stateDirectory,
    campaignId,
    snapshotDigest: SNAPSHOT_DIGEST,
    runId: RUN_ID,
    ledger,
    store,
    findings: { accountTakeover, sqli },
    executions,
    async run(...argv) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runCli(argv, environment, {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
        ...(options.askMinutes === undefined
          ? {}
          : { askMinutes: options.askMinutes }),
      });
      if (executions.length > 0)
        throw new Error(
          `An admin command reached execution: ${executions.join(", ")}`,
        );
      return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
    },
  };
}
