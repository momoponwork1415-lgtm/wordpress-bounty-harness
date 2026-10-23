import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  assessTrialResume,
  assignDiscoveryRuntime,
  DISCOVERY_LEFTOVER_PATTERNS,
  executeTrialResume,
  providerLimitedAutoResumeRefusal,
  recordInterruptedRun,
} from "../discovery/index.js";
import type { PlannedDiscoveryRun, ResumePlan } from "../discovery/index.js";
import { Review } from "../review/index.js";
import { targetSelectionId } from "../selection/index.js";
import { SourceAcquisitionError, type Snapshot } from "../snapshot/index.js";
import {
  canonicalDigest,
  canonicalJson,
} from "../infrastructure/canonical-json.js";
import { recordWordPressReport } from "../profiles/wordpress/discovery/candidate-admission.js";
import {
  admitWordPressFinding,
  readWordPressFinding,
  type WordPressFinding,
} from "../profiles/wordpress/discovery/finding.js";
import {
  wordPressDiscoveryOutputContract,
  wordPressDiscoveryOutputContractV2,
  wordPressDiscoveryOutputContractV4,
} from "../profiles/wordpress/discovery/output-contract.js";
import type {
  WordPressLabHandle,
  WordPressLabSetup,
} from "../profiles/wordpress/lab/index.js";
import {
  loadWordPressDiscoveryAsset,
  WORDPRESS_CURRENT_DISCOVERY_PROMPT_ID,
  wordPressDiscoveryPrompt,
  type WordPressDiscoveryAsset,
} from "../profiles/wordpress/prompts/index.js";
import { createWordpressScopeEvaluator } from "../profiles/wordpress/scope-policy.js";
import {
  openWordPressSelection,
  wordPressSelectionPolicySchema,
  wordPressTargetSelectionSchema,
  type WordPressSelectionPolicy,
  type WordPressTargetSelection,
} from "../profiles/wordpress/selection/index.js";
import { loadWordPressLegacyHistory } from "../profiles/wordpress/selection/legacy-history.js";
import { WORDPRESS_SANDBOX_LAYOUT } from "../profiles/wordpress/sandbox-layout.js";
import { createWordPressScopeFacts } from "../profiles/wordpress/scope-facts.js";
import { createWordfenceDuplicateLookup } from "../profiles/wordpress/wordfence-history/duplicate-lookup.js";
import { inspectHistoryMirror } from "../profiles/wordpress/wordfence-history/index.js";
import { createWordPressHttpEvidenceReader } from "../profiles/wordpress/verification/http-evidence.js";
import { createWordPressStateDiffReader } from "../profiles/wordpress/verification/lab-state-diff.js";
import type { WordPressReconstruction } from "../profiles/wordpress/verification/reproduction-package.js";
import { createWordPressVerifierRecordReader } from "../profiles/wordpress/verification/verifier-record.js";
import type { CliProfile, CliState } from "./index.js";
import {
  reverifyOnSelectedVersion,
  runCampaignPipeline,
  verifyNextFinding,
  type CampaignPipeline,
} from "./pipeline.js";
import {
  storeTargetSkipDiagnostic,
  type TargetSkipReason,
} from "./skip-diagnostic.js";
import {
  DISCOVERY_RUN_MEMORY_MIB,
  openWordPressCampaignSession,
  readWordPressCampaignConfig,
  readWordPressCampaignPolicy,
  wordPressRuntimeCaps,
  wordPressRuntimeCeilings,
  type WordPressCampaignBoundaries,
  type WordPressCampaignConfig,
  type WordPressCampaignSession,
  type WordPressCliProfileOptions,
} from "./wordpress-session.js";
import {
  parseWordPressOrgPluginIdentity,
  parseWordPressOrgSelectionId,
  wordPressOrgPluginIdentity,
} from "../profiles/wordpress/target-identity.js";

export {
  wordpressCampaignConfigSchema,
  type WordPressCampaignBoundaries,
  type WordPressCampaignConfig,
  type WordPressCliProfileOptions,
} from "./wordpress-session.js";

/** `select` reads either a bare selection policy or a campaign config naming one. */
async function loadSelectInput(configPath: string): Promise<{
  readonly policy: WordPressSelectionPolicy;
  readonly wordpressVersion: string;
  readonly config?: WordPressCampaignConfig;
}> {
  const value = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  const directPolicy = wordPressSelectionPolicySchema.safeParse(value);
  if (directPolicy.success) {
    if (directPolicy.data.wordpressVersion === undefined)
      throw new Error(
        "Direct selection policy requires wordpressVersion to freeze selections",
      );
    if (
      directPolicy.data.promptVariant !== undefined &&
      directPolicy.data.promptVariant !== WORDPRESS_CURRENT_DISCOVERY_PROMPT_ID
    )
      throw new Error("New selections use the current prompt variant only");
    return {
      policy: directPolicy.data,
      wordpressVersion: directPolicy.data.wordpressVersion,
    };
  }
  const config = await readWordPressCampaignConfig(configPath);
  return {
    config,
    policy: await readWordPressCampaignPolicy(config),
    wordpressVersion: config.wordpressVersion,
  };
}

type ReservedSelection = {
  readonly target: WordPressTargetSelection;
  readonly snapshotDigest: string;
};

type ReservedSelectionBatch = {
  readonly id: string;
  readonly reportDigest: string;
  readonly legacyHistoryDigest: string | null;
  readonly selections: readonly ReservedSelection[];
};

/** The most recent complete batch with this exact policy feeds campaign run. */
async function reservedSelectionBatch(
  state: CliState,
  policy: WordPressSelectionPolicy,
  selectionBatchId?: string,
): Promise<ReservedSelectionBatch> {
  const all = state.ledger.readAll({ type: "target-selected" });
  const batches = new Map<string, (typeof all)[number][]>();
  for (const record of all) {
    const event = record.event;
    if (
      event.type !== "target-selected" ||
      !event.campaignId.startsWith("selection-") ||
      !event.artifacts.some((artifact) => artifact.kind === "selection-report")
    )
      continue;
    const batch = batches.get(event.campaignId) ?? [];
    batch.push(record);
    batches.set(event.campaignId, batch);
  }
  const sortedBatches = [...batches.values()].sort(
    (left, right) =>
      (right.at(-1)?.sequence ?? 0) - (left.at(-1)?.sequence ?? 0),
  );
  const digest = canonicalDigest(policy);
  const batchSchema = z.object({
    schemaVersion: z.literal(1),
    policyDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    legacyHistory: z
      .union([
        z.object({
          status: z.literal("available"),
          digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        }),
        z.object({ status: z.literal("unavailable") }),
      ])
      .optional(),
    selectedSnapshotDigests: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)),
  });
  for (const batch of sortedBatches) {
    if (
      selectionBatchId !== undefined &&
      batch[0]?.event.campaignId !== selectionBatchId
    )
      continue;
    const reportRef = batch[0]?.event.artifacts.find(
      (artifact) => artifact.kind === "selection-report",
    );
    if (reportRef === undefined) continue;
    const file = await state.store.readFile(
      reportRef.digest,
      "selection-report.json",
      2 * 1024 * 1024,
    );
    if (file.status !== "resolved")
      throw new Error("Reserved selection report is unavailable");
    const report = batchSchema.parse(JSON.parse(file.bytes.toString("utf8")));
    if (report.policyDigest !== digest) continue;
    if (
      batch.length !== report.selectedSnapshotDigests.length ||
      batch.some(
        ({ event }, index) =>
          event.snapshotDigest !== report.selectedSnapshotDigests[index],
      )
    )
      throw new Error("Reserved selection batch is incomplete");
    const result: ReservedSelection[] = [];
    for (const { event } of batch) {
      if (event.type !== "target-selected")
        throw new Error("Invalid reserved selection event");
      const targetRef = event.artifacts.find(
        (artifact) => artifact.kind === "target-selection",
      );
      if (targetRef === undefined)
        throw new Error("Reserved target selection is unavailable");
      const targetFile = await state.store.readFile(
        targetRef.digest,
        "target-selection.json",
        1024 * 1024,
      );
      if (targetFile.status !== "resolved")
        throw new Error("Reserved target selection is unavailable");
      const target = wordPressTargetSelectionSchema.parse(
        JSON.parse(targetFile.bytes.toString("utf8")),
      );
      if (
        target.policy.digest !== digest ||
        targetSelectionId(target) !== event.selectionId
      )
        throw new Error("Reserved target selection does not match the ledger");
      result.push({ target, snapshotDigest: event.snapshotDigest });
    }
    return {
      id: batch[0]!.event.campaignId,
      reportDigest: reportRef.digest,
      legacyHistoryDigest:
        report.legacyHistory?.status === "available"
          ? report.legacyHistory.digest
          : null,
      selections: result,
    };
  }
  throw new Error(
    selectionBatchId === undefined
      ? "No reserved selection batch matches this policy; run select first"
      : "The campaign's reserved selection batch is unavailable or does not match this policy",
  );
}

/** A resumed campaign may use only the batch and target set bound on first run. */
async function bindCampaignSelectionBatch(
  state: CliState,
  policy: WordPressSelectionPolicy,
  campaignId: string,
  targetSlug: string | null,
  legacyHistoryDigest: string,
): Promise<readonly ReservedSelection[]> {
  const bound = state.ledger.read({
    campaignId,
    type: "selection-batch-bound",
    limit: 2,
  });
  if (bound.length > 1)
    throw new Error("Campaign has conflicting selection batch bindings");
  const binding = bound[0]?.event;
  if (binding !== undefined && binding.type !== "selection-batch-bound")
    throw new Error("Invalid selection batch binding");
  if (binding === undefined) {
    const priorSelection = state.ledger.read({
      campaignId,
      type: "target-selected",
      limit: 1,
    });
    if (priorSelection.length > 0)
      throw new Error(
        "Campaign already has targets but no selection batch binding",
      );
  }
  const batch = await reservedSelectionBatch(
    state,
    policy,
    binding?.selectionBatchId,
  );
  if (batch.legacyHistoryDigest !== legacyHistoryDigest)
    throw new Error(
      "legacy-history-changed: reserved selection used different old Trial history; run select again",
    );
  if (binding !== undefined) {
    if (
      binding.policyDigest !== canonicalDigest(policy) ||
      binding.artifacts.find((artifact) => artifact.kind === "selection-report")
        ?.digest !== batch.reportDigest ||
      binding.snapshotDigest !== batch.selections[0]?.snapshotDigest
    )
      throw new Error(
        "Campaign selection batch binding does not match its report",
      );
  }
  const selected = batch.selections.filter(
    ({ target }) => targetSlug === null || target.slug === targetSlug,
  );
  const selectionIds = selected.map(({ target }) => targetSelectionId(target));
  if (binding !== undefined) {
    if (canonicalJson(binding.selectionIds) !== canonicalJson(selectionIds))
      throw new Error("Campaign target set differs from its bound selection");
    return selected;
  }
  if (selected.length === 0) return selected;
  const appended = await state.ledger.append({
    schemaVersion: 1,
    identity: `selection-batch-${canonicalDigest(campaignId).slice(7, 39)}`,
    campaignId,
    snapshotDigest: batch.selections[0]!.snapshotDigest,
    occurredAt: state.clock().toISOString(),
    type: "selection-batch-bound",
    selectionBatchId: batch.id,
    policyDigest: canonicalDigest(policy),
    selectionIds,
    artifacts: [{ kind: "selection-report", digest: batch.reportDigest }],
  });
  if (appended.status !== "appended")
    throw new Error("Campaign selection batch binding conflicted");
  return selected;
}

/** The one Lab an earlier `lab up` kept between invocations; `lab down` reads and removes it. */
const labUpRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  labId: z.string().regex(/^[0-9a-f-]{36}$/),
  campaignId: z.string().min(1).max(128),
  findingId: z.string().min(1).max(128),
  configPath: z.string().min(1),
  startedAt: z.iso.datetime(),
});
const labUpRecordPath = (state: CliState) =>
  join(state.stateDirectory, "lab-up.json");

async function readLabUpRecord(
  state: CliState,
): Promise<z.infer<typeof labUpRecordSchema> | null> {
  try {
    return labUpRecordSchema.parse(
      JSON.parse(await readFile(labUpRecordPath(state), "utf8")) as unknown,
    );
  } catch {
    return null;
  }
}

async function wordPressLabDown(
  state: CliState,
  input: Parameters<CliProfile["labDown"]>[1],
  options: WordPressCliProfileOptions,
): ReturnType<CliProfile["labDown"]> {
  const record = await readLabUpRecord(state);
  // Nothing recorded by lab up: nothing to remove here (`lab cleanup` handles orphans).
  if (record === null)
    return {
      labId: null,
      removed: { containers: [], networks: [], volumes: [] },
      remaining: { containers: [], networks: [], volumes: [] },
    };
  const { boundaries } = await openWordPressCampaignSession(options, state, {
    configPath: input.configPath ?? record.configPath,
  });
  // Only this Lab's resources; a concurrent campaign's Labs are never named.
  const removed = await boundaries.lab.cleanupLeftovers({
    remove: true,
    labId: record.labId,
  });
  const remaining = await boundaries.lab.cleanupLeftovers({
    remove: false,
    labId: record.labId,
  });
  if (
    remaining.containers.length === 0 &&
    remaining.networks.length === 0 &&
    remaining.volumes.length === 0
  )
    await rm(labUpRecordPath(state), { force: true });
  return { labId: record.labId, removed, remaining };
}

type WordPressDiscoveryPipeline = CampaignPipeline<
  WordPressTargetSelection,
  WordPressLabSetup,
  WordPressLabHandle,
  WordPressFinding,
  WordPressReconstruction
>;
type WordPressDiscoveryInput = Parameters<
  WordPressDiscoveryPipeline["discovery"]
>[0];
type WordPressDiscoveryPlan = Awaited<
  ReturnType<WordPressDiscoveryPipeline["discovery"]>
>;
type WordPressDiscoveryContext = {
  readonly campaignId: string;
  readonly resumeInterrupted?: { log(line: string): void };
  readonly resumeProviderLimited?: { log(line: string): void };
  readonly config: WordPressCampaignConfig;
  readonly repeat: number;
  readonly boundaries: WordPressCampaignBoundaries;
  readonly state: CliState;
  readonly objective: WordPressDiscoveryAsset;
  readonly trustBoundary: WordPressDiscoveryAsset;
};

/**
 * Which Harness-generated output contract a prompt version receives, read
 * from the prompt table. Objective-only bodies get a generated contract
 * (ADR 0019). The entry-index coverage contract (v3) was deleted with the
 * index (ADR 0034); old Trials keep their recorded `contractDigest`.
 */
export function wordPressDiscoveryContractPlan(id: string): {
  readonly objectiveOnly: boolean;
  readonly contract: "v1" | "v2" | "v4" | null;
} {
  const record = wordPressDiscoveryPrompt(id);
  return {
    objectiveOnly: record.outputContract !== null,
    contract: record.outputContract,
  };
}

type WordPressDiscoverySource = Awaited<
  ReturnType<WordPressCampaignBoundaries["sourceFor"]>
>;

/** ADR 0033: the Root explores at least this long; a resumed segment inherits what is left of it. */
const WORDPRESS_DISCOVERY_MINIMUM_ACTIVE_MS = 60 * 60_000;

function wordPressOutputContractFor(id: string) {
  const { contract } = wordPressDiscoveryContractPlan(id);
  if (contract === null)
    throw new Error("Prompt carries its own output contract");
  return {
    v1: wordPressDiscoveryOutputContract,
    v2: wordPressDiscoveryOutputContractV2,
    v4: wordPressDiscoveryOutputContractV4,
  }[contract]();
}

/**
 * The whole text one Root receives: the versioned objective, the generated
 * contract (ADR 0019), the human-written boundaries and the mounted sources.
 * A resumed segment rebuilds it the same way so the pinned resume paragraph is
 * verifiably part of it (ADR 0036).
 */
function wordPressDiscoveryPromptText(options: {
  readonly objective: WordPressDiscoveryAsset;
  readonly trustBoundary: WordPressDiscoveryAsset;
  readonly config: WordPressCampaignConfig;
  readonly lab: WordPressDiscoveryInput["lab"];
  readonly source: WordPressDiscoverySource;
}): string {
  const { objective, trustBoundary, config, lab, source } = options;
  const objectiveOnly = wordPressDiscoveryContractPlan(
    objective.id,
  ).objectiveOnly;
  // Only low-privilege Lab accounts exist on the handle; nothing else is offered.
  const accounts = Object.entries(lab?.attackerAccounts ?? {}).map(
    ([role, account]) =>
      `- ${role}: ${account.username} / ${account.password} (Lab only)`,
  );
  return [
    objective.text.trim(),
    ...(objectiveOnly ? [wordPressOutputContractFor(objective.id).text] : []),
    "## Trust boundary",
    trustBoundary.text.trim(),
    `## Programme Boundary (${config.programmeBoundary.version})`,
    config.programmeBoundary.text.trim(),
    ...(lab === undefined
      ? [
          "This Trial has no Lab. Runtime confirmation happens during verification.",
        ]
      : [
          "## Lab",
          `Endpoint: ${lab.endpoint}`,
          ...accounts,
          ...(lab.database === undefined
            ? ["Database: not exposed to this run."]
            : [
                `Database (read-only, Lab only): host ${lab.database.host} port ${lab.database.port} database ${lab.database.name} user ${lab.database.readOnlyAccount.username} / ${lab.database.readOnlyAccount.password}`,
              ]),
        ]),
    ...(source.dependency === undefined
      ? []
      : [
          lab === undefined
            ? `WordPress core source (read-only): ${source.dependency.path}.`
            : `WordPress core source (read-only): ${source.dependency.path}, the same version the Lab runs.`,
        ]),
    ...(source.dependencySources ?? []).map(
      (dependency) => `Dependency source (read-only): ${dependency.path}.`,
    ),
    ...(objectiveOnly
      ? [`Writable notes directory: ${WORDPRESS_SANDBOX_LAYOUT.research}.`]
      : []),
    "## Assigned files",
    `All files under ${WORDPRESS_SANDBOX_LAYOUT.target}.`,
  ].join("\n\n");
}

/** The last paragraph of the objective is the pinned directive early Root resumes receive. */
function wordPressResumeParagraph(objective: WordPressDiscoveryAsset): string {
  const resumePrompt = objective.text
    .trim()
    .split(/\n\s*\n/)
    .at(-1);
  if (
    resumePrompt === undefined ||
    !resumePrompt.startsWith("Before giving up,")
  )
    throw new Error("Versioned minimum exploration directive is missing");
  return resumePrompt;
}

/** The source mounts of one Snapshot as the transport run names them. */
function wordPressSourceMounts(source: WordPressDiscoverySource) {
  return {
    sourceDirectory: source.directory,
    sourceTree: source.tree,
    ...(source.dependency === undefined
      ? {}
      : { dependencySource: source.dependency }),
    ...(source.dependencySources === undefined
      ? {}
      : { dependencySources: source.dependencySources }),
  };
}

async function planWordPressDiscovery(
  { snapshot, lab }: WordPressDiscoveryInput,
  context: WordPressDiscoveryContext,
): Promise<WordPressDiscoveryPlan> {
  const { config, repeat, boundaries, state, objective, trustBoundary } =
    context;
  if ((lab === undefined) !== (config.discovery.lab === "none"))
    throw new Error(
      "Discovery Lab mode differs from the campaign configuration",
    );
  const wallMinutes = config.runWallTimeMinutes;
  const objectiveOnly = (id: string) =>
    wordPressDiscoveryContractPlan(id).objectiveOnly;
  const outputContractFor = wordPressOutputContractFor;
  const source = await boundaries.sourceFor(snapshot);
  // The campaign's share alone picks the runtime for this target (Harness control).
  const share = config.discovery.runtimeShare;
  const assigned = assignDiscoveryRuntime(snapshot.target.identity, share);
  if (assigned === "claude" && boundaries.claude === undefined)
    throw new Error(
      "The campaign assigns this target to Claude, but the host has none",
    );
  const runtime =
    assigned === "claude"
      ? boundaries.claude!
      : {
          runtimeProfile: boundaries.runtimeProfile,
          executor: boundaries.executor,
        };
  // One Trial per target; only an explicit `--repeat` plans more (ADR 0029).
  const maxRuns = repeat;
  const stopRules = { maxRuns, noFindingRuns: 1 };
  const promptFor = (selectedObjective: typeof objective) =>
    wordPressDiscoveryPromptText({
      objective: selectedObjective,
      trustBoundary,
      config,
      lab,
      source,
    });
  const now = state.clock().getTime();
  return {
    input: {
      schemaVersion: 1,
      snapshotDigest: snapshot.digest,
      trustBoundary: {
        version: trustBoundary.id,
        text: trustBoundary.text,
      },
      programmeBoundary: config.programmeBoundary,
      modelProfileDigest: runtime.runtimeProfile.digest,
      promptDigest: objective.digest,
      stopRules,
      lab:
        lab === undefined ? { mode: "none" } : { setupDigest: lab.setupDigest },
      history: { mode: "none" },
    },
    runWallTimeMs: wallMinutes * 60_000,
    concurrency: Math.min(
      config.resources.maxConcurrentRuns,
      Math.floor(config.resources.memoryBudgetMiB / DISCOVERY_RUN_MEMORY_MIB),
    ),
    plannedTrials: Array.from({ length: maxRuns }, (_, trialOrdinal) => {
      const trialId = state.newId();
      const selectedObjective = objective;
      const resumePrompt = wordPressResumeParagraph(selectedObjective);
      const explore: PlannedDiscoveryRun = {
        configuration: {
          promptVariant: selectedObjective.id,
          promptDigest: selectedObjective.digest,
          ...(objectiveOnly(selectedObjective.id)
            ? {
                objectiveDigest: selectedObjective.digest,
                contractDigest: outputContractFor(selectedObjective.id).digest,
              }
            : {}),
          trustBoundaryVersion: trustBoundary.id,
          sourcePack: {
            dependency:
              source.dependency === undefined
                ? ("none" as const)
                : ("mounted" as const),
          },
          labAccess: {
            database: lab?.database === undefined ? "none" : "read-only",
          },
          ...(share === undefined
            ? {}
            : { runtime: runtime.runtimeProfile.transportKind }),
        },
        run: {
          runId: trialId,
          targetSnapshotDigest: snapshot.digest,
          profile: runtime.runtimeProfile,
          coordination: "cooperative" as const,
          prompt: promptFor(selectedObjective),
          minimumActiveMs: WORDPRESS_DISCOVERY_MINIMUM_ACTIVE_MS,
          resumePrompt,
          ...(lab === undefined
            ? {}
            : {
                lab: {
                  endpoint: lab.endpoint,
                  networkName: lab.networkName,
                  internalIp: lab.internalIp,
                  ...(lab.database === undefined
                    ? {}
                    : {
                        database: {
                          host: lab.database.host,
                          ipv4: lab.database.ipv4,
                        },
                      }),
                },
              }),
          ...wordPressSourceMounts(source),
          expiresAt: new Date(now + wallMinutes * 60_000).toISOString(),
        },
      };
      return {
        trialId,
        trialOrdinal,
        explore,
      };
    }),
    executor: runtime.executor,
    attachments: boundaries.attachments,
    recordReport: recordWordPressReport,
    ...(context.resumeInterrupted === undefined || lab !== undefined
      ? {}
      : {
          resumeInterrupted: resumeInterruptedFor(
            context,
            context.resumeInterrupted.log,
          ),
        }),
    ...(context.resumeProviderLimited === undefined || lab !== undefined
      ? {}
      : {
          resumeProviderLimited: resumeProviderLimitedFor(
            context,
            context.resumeProviderLimited.log,
          ),
        }),
  };
}

/**
 * The runner's resume of a run whose host died (ADR 0036, 2026-10-19 addendum
 * 3): the same rules as `campaign resume`; a refusal is logged and the target
 * runs again as a new Trial, as it did before.
 */
function resumeInterruptedFor(
  context: WordPressDiscoveryContext,
  log: (line: string) => void,
): NonNullable<WordPressDiscoveryPlan["resumeInterrupted"]> {
  return async (started, signal) => {
    const resumed = await resumeWordPressRun(
      context.state,
      context,
      { campaignId: context.campaignId, runId: started.runId },
      signal,
    );
    if (resumed.status === "refused") {
      log(
        `interrupted run=${started.runId} not resumed reason=${resumed.reason}${resumed.detail === undefined ? "" : ` detail=${resumed.detail}`}; the target runs again as a new Trial`,
      );
      return undefined;
    }
    log(
      `interrupted run=${started.runId} resumed as ${resumed.outcome.runId} segment=${resumed.plan.segment} outcome=${resumed.outcome.outcome}`,
    );
    return resumed.outcome;
  };
}

/** Continue a Codex Trial after the runner's provider backoff, using the manual resume path. */
function resumeProviderLimitedFor(
  context: WordPressDiscoveryContext,
  log: (line: string) => void,
): NonNullable<WordPressDiscoveryPlan["resumeProviderLimited"]> {
  return async (started, signal) => {
    const incomplete = (reason: string, detail?: string) => {
      log(
        `provider-limited run=${started.runId} not resumed reason=${reason}${detail === undefined ? "" : ` detail=${detail}`}; target incomplete`,
      );
      return {
        status: "incomplete" as const,
        runId: started.runId,
        reason,
        ...(detail === undefined ? {} : { detail }),
      };
    };
    // Only Codex runs reach here (autoResumesProviderLimit); the pinned
    // receipt is checked by resumeWordPressRun before any sandbox starts.
    const policyRefusal = providerLimitedAutoResumeRefusal(started);
    if (policyRefusal !== undefined) return incomplete(policyRefusal);
    const resumed = await resumeWordPressRun(
      context.state,
      context,
      { campaignId: context.campaignId, runId: started.runId },
      signal,
    );
    if (resumed.status === "refused")
      return incomplete(resumed.reason, resumed.detail);
    log(
      `provider-limited run=${started.runId} resumed as ${resumed.outcome.runId} segment=${resumed.plan.segment} outcome=${resumed.outcome.outcome}`,
    );
    return { status: "resumed", outcome: resumed.outcome };
  };
}

/**
 * `campaign resume --run`: continue one stopped Root thread in a new sandbox on
 * the same Snapshot (ADR 0036). A run whose host died is sealed from its
 * sandbox's leftovers first. The rules live in the discovery module; this body
 * only rebuilds the WordPress inputs the original run had (prompt text, source
 * mounts, runtime profile) and reports.
 */
async function resumeWordPressCampaignRun(
  state: CliState,
  input: Parameters<NonNullable<CliProfile["resumeCampaignRun"]>>[1],
  session: WordPressCampaignSession,
): ReturnType<NonNullable<CliProfile["resumeCampaignRun"]>> {
  const resumed = await resumeWordPressRun(state, session, input);
  if (resumed.status === "refused") return resumed;
  const { plan, outcome } = resumed;
  return {
    status: "resumed",
    runId: outcome.runId,
    resumesRun: plan.resumesRun,
    trialId: plan.trialId,
    segment: plan.segment,
    remainingWallMs: plan.remainingWallMs,
    outcome: outcome.outcome,
    ...(outcome.failure === undefined
      ? {}
      : {
          failure: {
            reason: outcome.failure.reason,
            ...(outcome.failure.reasonDetail === undefined
              ? {}
              : { reasonDetail: outcome.failure.reasonDetail }),
          },
        }),
    wallTimeMs: outcome.wallTimeMs,
    findingsRecorded: outcome.findingsRecorded,
  };
}

/** One resume, by the operator or by the runner for a run whose host died. */
async function resumeWordPressRun(
  state: CliState,
  {
    config,
    boundaries,
  }: Pick<WordPressCampaignSession, "config" | "boundaries">,
  input: { readonly campaignId: string; readonly runId: string },
  signal?: AbortSignal,
): Promise<
  | {
      readonly status: "refused";
      readonly reason: string;
      readonly detail?: string;
    }
  | {
      readonly status: "resumed";
      readonly plan: ResumePlan;
      readonly outcome: Awaited<ReturnType<typeof executeTrialResume>>;
    }
> {
  if (config.discovery.lab !== "none")
    return {
      status: "refused",
      reason: "lab-attached",
      detail: "resume supports discovery.lab = none only",
    };
  const started = state.ledger
    .readAll({ campaignId: input.campaignId, type: "discovery-run-started" })
    .map(({ event }) => event)
    .find(
      (event) =>
        event.type === "discovery-run-started" && event.runId === input.runId,
    );
  if (started?.type !== "discovery-run-started")
    return { status: "refused", reason: "run-unknown" };
  // The segment runs on the runtime the original run recorded; its profile digest is checked against the receipt.
  if (
    started.configuration.runtime === "claude-code/v1" &&
    boundaries.claude === undefined
  )
    return {
      status: "refused",
      reason: "runtime-profile-differs",
      detail: "the campaign configuration assigns no targets to Claude",
    };
  const runtime =
    started.configuration.runtime === "claude-code/v1"
      ? boundaries.claude!
      : {
          runtimeProfile: boundaries.runtimeProfile,
          executor: boundaries.executor,
        };
  const [objective, trustBoundary] = await Promise.all([
    loadWordPressDiscoveryAsset(config.promptId),
    loadWordPressDiscoveryAsset("trust-boundary-v1"),
  ]);
  const resumePrompt = wordPressResumeParagraph(objective);
  // The Snapshot the run was frozen on; the sandbox re-verifies every tree digest at mount.
  const snapshot = await boundaries.loadSnapshot(started.snapshotDigest);
  if (snapshot.digest !== started.snapshotDigest)
    return {
      status: "refused",
      reason: "snapshot-digest-differs",
      detail: snapshot.digest,
    };
  const source = await boundaries.sourceFor(snapshot);
  const prompt = wordPressDiscoveryPromptText({
    objective,
    trustBoundary,
    config,
    lab: undefined,
    source,
  });
  const context = {
    campaignId: input.campaignId,
    input: {
      schemaVersion: 1 as const,
      snapshotDigest: snapshot.digest,
      trustBoundary: { version: trustBoundary.id, text: trustBoundary.text },
      programmeBoundary: config.programmeBoundary,
      modelProfileDigest: runtime.runtimeProfile.digest,
      promptDigest: objective.digest,
      stopRules: { maxRuns: 1, noFindingRuns: 1 },
      lab: { mode: "none" as const },
      history: { mode: "none" as const },
    },
    attachments: boundaries.attachments,
    evidence: state.store,
    ledger: state.ledger,
    recordReport: recordWordPressReport,
    clock: state.clock,
  };
  const run = {
    targetSnapshotDigest: snapshot.digest,
    profile: runtime.runtimeProfile,
    coordination: "cooperative" as const,
    prompt,
    resumePrompt,
    ...wordPressSourceMounts(source),
  };
  const { recoverInterrupted } = runtime.executor;
  const assessment = await assessTrialResume({
    ledger: state.ledger,
    evidence: state.store,
    attachments: boundaries.attachments,
    campaignId: input.campaignId,
    runId: input.runId,
    snapshotDigest: snapshot.digest,
    promptDigest: objective.digest,
    prompt,
    resumePrompt,
    profileDigest: runtime.runtimeProfile.digest,
    wallTimeMs: config.runWallTimeMinutes * 60_000,
    minimumActiveMs: WORDPRESS_DISCOVERY_MINIMUM_ACTIVE_MS,
    // A run whose host died is sealed first, then resumed like any other (ADR 0036).
    ...(recoverInterrupted === undefined
      ? {}
      : {
          recoverInterrupted: (interrupted) =>
            recordInterruptedRun(
              context,
              {
                recoverInterrupted: (transportRun, startedAt) =>
                  recoverInterrupted.call(
                    runtime.executor,
                    transportRun,
                    startedAt,
                  ),
              },
              interrupted,
              {
                ...run,
                minimumActiveMs: WORDPRESS_DISCOVERY_MINIMUM_ACTIVE_MS,
              },
            ),
        }),
  });
  if (assessment.status === "refused") return assessment;
  const { plan } = assessment;
  const outcome = await executeTrialResume(
    {
      ...context,
      executor: runtime.executor,
      ...(signal === undefined ? {} : { signal }),
    },
    plan,
    { runId: state.newId(), ...run },
  );
  return { status: "resumed" as const, plan, outcome };
}

async function runWordPressCampaign(
  state: CliState,
  input: Parameters<CliProfile["runCampaign"]>[1],
  options: Pick<WordPressCliProfileOptions, "legacyHistoryFile">,
  session: WordPressCampaignSession,
): ReturnType<CliProfile["runCampaign"]> {
  const { config, boundaries } = session;
  const policy = await session.policy();
  // The policy's revisitPolicy is applied by `select`; a repeat Trial on a higher
  // version is a selection outcome, not a campaign-level approval (ADR 0037 addendum).
  let legacyHistoryDigest: string | undefined;
  if ("candidateSource" in policy) {
    const legacy = await loadWordPressLegacyHistory(options.legacyHistoryFile);
    if (legacy.report.status !== "available")
      throw new Error(
        "legacy-history-missing: automatic campaign cannot start",
      );
    legacyHistoryDigest = legacy.report.digest;
  }
  const reservedSelections =
    "candidateSource" in policy
      ? await bindCampaignSelectionBatch(
          state,
          policy,
          input.campaignId,
          input.target,
          legacyHistoryDigest!,
        )
      : undefined;
  const reservedDigests = new Map(
    reservedSelections?.map(({ target, snapshotDigest }) => [
      targetSelectionId(target),
      snapshotDigest,
    ]) ?? [],
  );
  // A previous teardown failure is a campaign stop, not a negative finding.
  // Inspect only the recorded Lab ids and never delete them implicitly.
  const cleanupLabIds = new Set<string>();
  for (const { event } of state.ledger.readAll({
    campaignId: input.campaignId,
    type: "campaign-stopped",
  }))
    if (event.type === "campaign-stopped")
      for (const labId of event.cleanupLabIds ?? []) cleanupLabIds.add(labId);
  for (const labId of cleanupLabIds) {
    const remaining = await boundaries.lab.cleanupLeftovers({
      remove: false,
      labId,
    });
    if (
      remaining.containers.length +
        remaining.networks.length +
        remaining.volumes.length >
      0
    )
      throw new Error(
        `Lab ${labId} cleanup is incomplete; inspect and remove its resources before resuming`,
      );
  }
  const [objective, trustBoundary] = await Promise.all([
    loadWordPressDiscoveryAsset(config.promptId),
    loadWordPressDiscoveryAsset("trust-boundary-v1"),
  ]);
  return runCampaignPipeline({
    campaignId: input.campaignId,
    discoveryLab: config.discovery.lab,
    repeat: input.repeat ?? 1,
    maxConcurrentTargets: config.resources.maxConcurrentTargets,
    ...(input.targetLimit === undefined
      ? {}
      : { targetLimit: input.targetLimit }),
    ...(wordPressRuntimeCaps(config) === undefined
      ? {}
      : { runtimeCaps: wordPressRuntimeCaps(config)! }),
    ...(input.stop === undefined ? {} : { stop: input.stop }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ledger: state.ledger,
    store: state.store,
    clock: state.clock,
    newId: state.newId,
    pipeline: {
      select: async () =>
        (reservedSelections === undefined
          ? await boundaries.selection.rank(policy)
          : reservedSelections.map(({ target }) => target)
        ).filter(
          (target) =>
            reservedSelections !== undefined ||
            input.target === null ||
            target.slug === input.target,
        ),
      freeze: async (target) => {
        const reservedDigest = reservedDigests.get(targetSelectionId(target));
        if (reservedSelections !== undefined && reservedDigest === undefined)
          throw new SourceAcquisitionError("source-mismatch", {
            reason: "reserved-snapshot-unavailable",
            selectionId: targetSelectionId(target),
          });
        // Selection already froze this source. Reuse the pinned Snapshot so a
        // second WordPress.org download cannot replace or block the campaign.
        const snapshot =
          reservedDigest === undefined
            ? await boundaries.freeze(target)
            : await boundaries.loadSnapshot(reservedDigest);
        if (
          reservedSelections !== undefined &&
          (snapshot.digest !== reservedDigest ||
            snapshot.target.identity !== target.targetId ||
            snapshot.target.version !== target.version)
        )
          throw new SourceAcquisitionError("source-mismatch", {
            reason: "reserved-snapshot-changed",
            expectedDigest: reservedDigest,
            actualDigest: snapshot.digest,
            expectedTarget: targetSelectionId(target),
            actualTarget: `${snapshot.target.identity}@${snapshot.target.version}`,
          });
        return snapshot;
      },
      lab: boundaries.lab,
      setupFor: session.setupFor,
      discovery: (discoveryInput) =>
        planWordPressDiscovery(discoveryInput, {
          campaignId: input.campaignId,
          ...(input.resumeInterrupted === undefined
            ? {}
            : { resumeInterrupted: input.resumeInterrupted }),
          ...(input.resumeProviderLimited === undefined
            ? {}
            : { resumeProviderLimited: input.resumeProviderLimited }),
          config,
          repeat: input.repeat ?? 1,
          boundaries,
          state,
          objective,
          trustBoundary,
        }),
      verification: session.verification,
      reconstructionFor: session.reconstructionFor,
    },
  });
}

export function createWordPressCliProfile(
  options: WordPressCliProfileOptions,
): CliProfile {
  return {
    review: (state) =>
      new Review({
        ledger: state.ledger,
        artifactStore: state.store,
        scopeEvaluator: createWordpressScopeEvaluator(options.scopePolicy),
        factsProvider:
          options.scopeFacts ??
          createWordPressScopeFacts({
            ledger: state.ledger,
            store: state.store,
          }),
        ...(options.wordfenceHistory === undefined
          ? {}
          : {
              duplicateLookup: createWordfenceDuplicateLookup({
                ledger: state.ledger,
                history: options.wordfenceHistory,
                clock: state.clock,
              }),
            }),
        clock: state.clock,
      }),
    historyStatus(state) {
      if (options.wordfenceHistory === undefined) return null;
      const mirror = inspectHistoryMirror({
        ...options.wordfenceHistory,
        now: state.clock(),
      });
      if (mirror.status === "unavailable")
        return {
          fresh: false,
          line: `history mirror unavailable  ${mirror.reason === "state-unreadable" ? "state is unreadable" : "database and state disagree"}`,
        };
      const hours = (ms: number) => (ms / 3_600_000).toFixed(1);
      return {
        fresh: mirror.status === "fresh",
        line: `history mirror ${mirror.status}${mirror.staleFallback ? " (last refresh failed)" : ""}  last success ${mirror.lastSuccessfulAt} (${hours(mirror.ageMs)} h ago, limit ${mirror.maxAgeMs / 3_600_000} h)  records ${mirror.recordCount}`,
      };
    },
    async select(state, input) {
      const { config, policy, wordpressVersion } = await loadSelectInput(
        input.configPath,
      );
      const boundaries =
        options.selectionBoundaries === undefined
          ? config === undefined
            ? undefined
            : await options.boundaries(config, state)
          : await options.selectionBoundaries(state, wordpressVersion);
      if (boundaries === undefined)
        throw new Error("Direct policy selection is unavailable on this host");
      const promptVariant =
        policy.promptVariant ??
        config?.promptId ??
        WORDPRESS_CURRENT_DISCOVERY_PROMPT_ID;
      // Automatic batches keep the historical floor of 3 unless the caller lowers it.
      const minimum = input.minimum ?? ("candidateSource" in policy ? 3 : 1);
      // Policy, Ledger and legacy history decide; this command freezes and records.
      // Below `minimum` eligible candidates the policy's cascade steps are tried in order.
      const decision = await openWordPressSelection({
        candidates: boundaries.selection,
        ledger: state.ledger,
        ...(options.legacyHistoryFile === undefined
          ? {}
          : { legacyHistoryFile: options.legacyHistoryFile }),
        promptVariant,
        clock: state.clock,
      }).decide(policy, { minimum });
      const inspected = decision.inspections;
      const inspectionBySlug = new Map(
        inspected.map((item) => [item.slug, item]),
      );
      // Freeze and batch outcomes are appended to the decision's reasons below.
      const reasons = new Map<string, string[]>(
        inspected.map((item) => [item.slug, [...item.reasons]]),
      );
      const chosen: { target: WordPressTargetSelection; snapshot: Snapshot }[] =
        [];
      const selectionAttemptId = `selection-${state.newId()}`;
      const freezeFailures: {
        selectionId: string;
        snapshotDigest: string;
        reason: TargetSkipReason;
        diagnosticDigest: string;
        selectionArtifactDigest: string;
      }[] = [];
      // Ranked beyond the cutoff fills in when a better-ranked source fails to freeze.
      for (const target of decision.ranked) {
        if (chosen.length >= policy.maximumTargets) {
          reasons.get(target.slug)?.push("below-rank-cutoff");
          continue;
        }
        try {
          chosen.push({ target, snapshot: await boundaries.freeze(target) });
        } catch (error) {
          reasons.get(target.slug)?.push("snapshot-unavailable");
          const { reason, digest } = await storeTargetSkipDiagnostic(
            state.store,
            error,
          );
          const selectionId = targetSelectionId(target);
          const selectionArtifactDigest = await state.store.putFiles({
            "target-selection.json": canonicalJson(target),
          });
          freezeFailures.push({
            selectionId,
            snapshotDigest: canonicalDigest(target),
            reason,
            diagnosticDigest: digest,
            selectionArtifactDigest,
          });
        }
      }
      // Too few: write no selection, and say why for each frozen target.
      if (chosen.length < minimum)
        for (const { target } of chosen.splice(0))
          reasons.get(target.slug)?.push("below-minimum");
      const report = {
        schemaVersion: 1,
        policyDigest: canonicalDigest(policy),
        inspectedAt: state.clock().toISOString(),
        sourceStatus: decision.sourceStatus,
        sourceListings: decision.sourceListings,
        inspections: inspected.map((item) => ({
          ...item,
          reasons: reasons.get(item.slug) ?? [],
        })),
        selectedSnapshotDigests: chosen.map(({ snapshot }) => snapshot.digest),
        freezeFailures,
        legacyHistory: decision.legacyHistory,
        advisoryHistory: decision.advisoryHistory,
        minimum,
        ...(decision.cascadeStep === undefined
          ? {}
          : { cascadeStep: decision.cascadeStep }),
        cascade: decision.cascade,
      };
      const reportDigest = await state.store.putFiles({
        "selection-report.json": canonicalJson(report),
      });
      for (const failure of freezeFailures) {
        const appended = await state.ledger.append({
          schemaVersion: 1,
          identity: `target-skipped-${state.newId()}`,
          campaignId: selectionAttemptId,
          snapshotDigest: failure.snapshotDigest,
          occurredAt: state.clock().toISOString(),
          type: "target-skipped",
          selectionId: failure.selectionId,
          stage: "freeze",
          reason: failure.reason,
          artifacts: [
            {
              kind: "target-selection",
              digest: failure.selectionArtifactDigest,
            },
            {
              kind: "target-skip-diagnostic",
              digest: failure.diagnosticDigest,
            },
            { kind: "selection-report", digest: reportDigest },
          ],
        });
        if (appended.status !== "appended")
          throw new Error("Selection skip ledger append conflicted");
      }
      const batchId = chosen.length === 0 ? null : selectionAttemptId;
      for (const { target, snapshot } of chosen) {
        const selectionDigest = await state.store.putFiles({
          "target-selection.json": canonicalJson(target),
        });
        const appended = await state.ledger.append({
          schemaVersion: 1,
          identity: `selected-${state.newId()}`,
          campaignId: batchId!,
          snapshotDigest: snapshot.digest,
          occurredAt: target.selectedAt,
          type: "target-selected",
          selectionId: targetSelectionId(target),
          promptVariant,
          // The band that admitted the target, so per-band yield can be read from the ledger.
          ...(target.cascadeStep === undefined
            ? {}
            : { cascadeStep: target.cascadeStep }),
          artifacts: [
            { kind: "target-selection", digest: selectionDigest },
            { kind: "selection-report", digest: reportDigest },
          ],
        });
        if (appended.status !== "appended")
          throw new Error("Selection ledger append conflicted");
      }
      const chosenSlugs = new Set(chosen.map(({ target }) => target.slug));
      return {
        batchId,
        sourceStatus: decision.sourceStatus,
        legacyHistory: decision.legacyHistory,
        advisoryHistory: decision.advisoryHistory,
        ...(decision.cascadeStep === undefined
          ? {}
          : { cascadeStep: decision.cascadeStep }),
        cascade: decision.cascade,
        selected: chosen.map(({ target }) => ({
          targetId: target.targetId,
          version: target.version,
          score: target.score,
          scoreBreakdown: target.scoreBreakdown,
          ...(target.advisoryHistory === undefined
            ? {}
            : { advisoryHistory: target.advisoryHistory }),
          ...(target.cascadeStep === undefined
            ? {}
            : { cascadeStep: target.cascadeStep }),
          observedAt:
            inspectionBySlug.get(target.slug)?.observedAt ?? target.selectedAt,
          ...(inspectionBySlug.get(target.slug)?.enumeration === undefined
            ? {}
            : {
                sourceUrl: inspectionBySlug.get(target.slug)!.enumeration!
                  .sourceUrl,
              }),
        })),
        excluded: inspected
          .filter((item) => !chosenSlugs.has(item.slug))
          .map((item) => ({
            targetId: wordPressOrgPluginIdentity(item.slug),
            reasons: reasons.get(item.slug) ?? [],
            ...(item.observedAt === undefined
              ? {}
              : { observedAt: item.observedAt }),
            ...(item.enumeration === undefined
              ? {}
              : { sourceUrl: item.enumeration.sourceUrl }),
          })),
      };
    },
    runCampaign: async (state, input) =>
      runWordPressCampaign(
        state,
        input,
        options,
        await openWordPressCampaignSession(options, state, input),
      ),
    resumeCampaignRun: async (state, input) =>
      resumeWordPressCampaignRun(
        state,
        input,
        await openWordPressCampaignSession(options, state, input),
      ),
    async verifyNext(state, input) {
      const session = await openWordPressCampaignSession(options, state, {
        configPath: input.configPath,
        handoff: input.handoff,
      });
      return verifyNextFinding({
        ...(input.campaignId === undefined
          ? {}
          : { campaignId: input.campaignId }),
        ...(input.findingId === undefined
          ? {}
          : { only: { findingId: input.findingId } }),
        ledger: state.ledger,
        newId: state.newId,
        loadSnapshot: session.boundaries.loadSnapshot,
        setupFor: session.setupFor,
        reconstructionFor: session.reconstructionFor,
        verification: session.verification,
      });
    },
    stateDiffReader: (state) =>
      createWordPressStateDiffReader({ store: state.store }),
    httpEvidenceReader: (state) =>
      createWordPressHttpEvidenceReader({ store: state.store }),
    verifierRecordReader: (state) =>
      createWordPressVerifierRecordReader({ store: state.store }),
    labDown: (state, input) => wordPressLabDown(state, input, options),
    // A record that exists holds the sweep even when unreadable; `lab down` decides.
    targetCeiling: async (configPath) =>
      (await readWordPressCampaignConfig(configPath)).resources
        .maxConcurrentTargets,
    runtimeCeilings: async (configPath) =>
      wordPressRuntimeCeilings(await readWordPressCampaignConfig(configPath)),
    labHeld: (state) =>
      stat(labUpRecordPath(state)).then(
        () => true,
        () => false,
      ),
    async cleanupLeftovers(state, input) {
      const { boundaries } = await openWordPressCampaignSession(
        options,
        state,
        input,
      );
      return boundaries.lab.cleanupLeftovers({
        remove: input.remove,
        patterns: DISCOVERY_LEFTOVER_PATTERNS,
      });
    },
    async checkRuntime(state, input) {
      const { boundaries } = await openWordPressCampaignSession(
        options,
        state,
        input,
      );
      const measured = await boundaries.probeRuntime();
      return [
        {
          item: "codex-cli",
          profile: boundaries.runtimeProfile.codexCliVersion,
          image: measured.cliVersion,
        },
        {
          item: "catalog",
          profile: boundaries.runtimeProfile.bundledCatalogDigest,
          image: measured.bundledCatalogDigest,
        },
      ];
    },
    async reverify(state, input) {
      const session = await openWordPressCampaignSession(options, state, input);
      const { boundaries } = session;
      const policy = await session.policy();
      return reverifyOnSelectedVersion({
        campaignId: input.campaignId,
        findingId: input.findingId,
        ...(input.referenceCampaignId === undefined
          ? {}
          : { referenceCampaignId: input.referenceCampaignId }),
        ...(input.snapshotCampaignId === undefined
          ? {}
          : { snapshotCampaignId: input.snapshotCampaignId }),
        ...(input.version === undefined ? {} : { version: input.version }),
        ledger: state.ledger,
        store: state.store,
        clock: state.clock,
        newId: state.newId,
        pipeline: {
          deriveFinding({ original, snapshotDigest, runId }) {
            const recorded = readWordPressFinding(original);
            const {
              findingId: _findingId,
              discoveryRunId: _discoveryRunId,
              snapshotDigest: _originalSnapshotDigest,
              recipeRef,
              historyRecordId: _historyRecordId,
              ...claim
            } = recorded;
            const finding = admitWordPressFinding(claim, {
              runId,
              snapshotDigest,
              reportArtifactDigest: recipeRef.digest,
            });
            return { finding, category: finding.impact };
          },
          async selectVersion({
            selectionId,
            originalSnapshotDigest,
            version,
          }) {
            const slug = parseWordPressOrgSelectionId(selectionId)?.slug;
            if (slug === undefined) return null;
            const originalSnapshot = await boundaries.loadSnapshot(
              originalSnapshotDigest,
            );
            if (
              originalSnapshot.target.identity !==
              wordPressOrgPluginIdentity(slug)
            )
              throw new Error(
                "The original Snapshot belongs to another target",
              );
            const originalPluginPins: Record<string, string> = {};
            for (const dependency of originalSnapshot.dependencies) {
              const dependencySlug = parseWordPressOrgPluginIdentity(
                dependency.identity,
              );
              if (dependencySlug === null) continue;
              if (
                originalPluginPins[dependencySlug] !== undefined &&
                originalPluginPins[dependencySlug] !== dependency.version
              )
                throw new Error(
                  `The original Snapshot has conflicting versions for ${dependencySlug}`,
                );
              originalPluginPins[dependencySlug] = dependency.version;
            }
            const explicitSlugs =
              "pluginDependencySlugs" in policy
                ? (policy.pluginDependencySlugs?.[slug] ?? [])
                : [];
            for (const dependencySlug of explicitSlugs)
              if (originalPluginPins[dependencySlug] === undefined)
                throw new Error(
                  `The original Snapshot has no pinned source for ${dependencySlug}`,
                );
            const configuredPluginPins =
              "pluginDependencyPins" in policy
                ? (policy.pluginDependencyPins?.[slug] ?? {})
                : {};
            const pluginDependencyPins = {
              ...configuredPluginPins,
              ...originalPluginPins,
            };
            // Rechecking a known Finding does not need the candidate batch's
            // history ranking, so the mirror is not opened here (ADR 0037).
            const unranked = {
              ...policy,
              scoreWeights: {
                ...policy.scoreWeights,
                history: 0,
                historyPayingClass: 0,
              },
            };
            const reverifyPolicy =
              "candidateSource" in unranked
                ? (({
                    candidateSource: _candidateSource,
                    pluginDependencySlugs: _pluginDependencySlugs,
                    ...rest
                  }) => rest)(unranked)
                : unranked;
            const {
              targetSourcePins: _targetSourcePins,
              ...policyWithoutCapturedSources
            } = reverifyPolicy as WordPressSelectionPolicy & {
              targetSourcePins?: Readonly<Record<string, unknown>>;
            };
            const sameOriginalVersion =
              version === originalSnapshot.target.version;
            let capturedSourcePin: WordPressTargetSelection["targetSourcePin"];
            if (sameOriginalVersion) {
              const originalSelectionEvent = state.ledger
                .read({
                  campaignId: input.campaignId,
                  type: "target-selected",
                  limit: 1000,
                })
                .map(({ event }) => event)
                .find(
                  (event) =>
                    event.type === "target-selected" &&
                    event.snapshotDigest === originalSnapshotDigest,
                );
              const selectionRef = originalSelectionEvent?.artifacts.find(
                (artifact) => artifact.kind === "target-selection",
              );
              const configuredPin =
                "targetSourcePins" in policy
                  ? policy.targetSourcePins?.[slug]
                  : undefined;
              if (selectionRef === undefined) {
                // Older ZIP selections need no captured-source record. A new
                // SVN pin cannot be substituted for an unknown original.
                if (configuredPin !== undefined)
                  throw new SourceAcquisitionError("source-mismatch", {
                    reason: "original-target-source-pin-unavailable",
                  });
              } else {
                const file = await state.store.readFile(
                  selectionRef.digest,
                  "target-selection.json",
                  1024 * 1024,
                );
                if (file.status !== "resolved")
                  throw new SourceAcquisitionError("source-mismatch", {
                    reason: "original-target-selection-unavailable",
                  });
                const originalSelection = wordPressTargetSelectionSchema.parse(
                  JSON.parse(file.bytes.toString("utf8")),
                );
                if (
                  originalSelection.targetId !==
                    originalSnapshot.target.identity ||
                  originalSelection.version !==
                    originalSnapshot.target.version ||
                  (configuredPin !== undefined &&
                    canonicalJson(configuredPin) !==
                      canonicalJson(originalSelection.targetSourcePin ?? null))
                )
                  throw new SourceAcquisitionError("source-mismatch", {
                    reason: "original-target-source-pin-mismatch",
                  });
                capturedSourcePin = originalSelection.targetSourcePin;
              }
            }
            // The Finding's own target carries a recorded Finding, so the
            // Ledger-aware select would exclude it; rank the pinned policy.
            const selected = await boundaries.selection.rank({
              ...policyWithoutCapturedSources,
              candidateSlugs: [slug],
              pluginDependencyPins: { [slug]: pluginDependencyPins },
              pinnedVersions: version === undefined ? {} : { [slug]: version },
              ...(capturedSourcePin === undefined
                ? {}
                : { targetSourcePins: { [slug]: capturedSourcePin } }),
              maximumTargets: 1,
            });
            const target = selected[0] ?? null;
            if (version !== undefined && target?.version !== version)
              throw new Error("Pinned verification version mismatch");
            return target;
          },
          freeze: boundaries.freeze,
          loadSnapshot: boundaries.loadSnapshot,
          setupFor: session.setupFor,
          verification: session.verification,
          reconstructionFor: session.reconstructionFor,
        },
      });
    },
  };
}
