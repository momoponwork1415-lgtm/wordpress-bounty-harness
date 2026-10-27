import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  assessTrialResume,
  assignDiscoveryRuntime,
  DEFAULT_MAX_CHILDREN,
  defineClaudeRuntimeProfile,
  DISCOVERY_LEFTOVER_PATTERNS,
  executeTrialResume,
  PARTITION_INPUT_FILES,
  PARTITIONED_TARGET_CEILING_MS,
  partitionLimitsSection,
  providerLimitedAutoResumeRefusal,
  recordInterruptedRun,
  runParametersSection,
  SANDBOX_INPUT_MOUNT_PATH,
} from "../discovery/index.js";
import type {
  AgentRuntimeProfile,
  OneShotToolFile,
  PartitionedRolePlan,
  PlannedDiscoveryRun,
  ResumePlan,
  RunParameters,
} from "../discovery/index.js";
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
  wordPressDiscoveryOutputContractV4Solo,
  wordPressDiscoveryOutputContractV5,
} from "../profiles/wordpress/discovery/output-contract.js";
import {
  loadWordPressEnumerationTool,
  wordPressEnumerationToolsDigest,
} from "../profiles/wordpress/discovery/tools.js";
import {
  loadWordPressRoleDefinition,
  WORDPRESS_CURRENT_ROLE_DEFINITION_IDS,
} from "../profiles/wordpress/prompts/roles.js";
import type {
  WordPressLabHandle,
  WordPressLabSetup,
} from "../profiles/wordpress/lab/index.js";
import {
  loadWordPressDiscoveryAsset,
  WORDPRESS_CURRENT_DISCOVERY_PROMPT_ID,
  WORDPRESS_DISCOVERY_PROMPT_IDS,
  WORDPRESS_LAUNCHABLE_DISCOVERY_PROMPT_IDS,
  wordPressDiscoveryModeOf,
  wordPressDiscoveryPrompt,
  WORDPRESS_TRUST_BOUNDARY,
  type WordPressDiscoveryAsset,
  type WordPressOutputContractVersion,
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
import { restoreParkedWordPressFinding } from "../profiles/wordpress/discovery/restore-parked-finding.js";
import { createWordPressHttpEvidenceReader } from "../profiles/wordpress/verification/http-evidence.js";
import { storeLabDiagnostic } from "../lab/index.js";
import { openWordPressExplorationLab } from "../profiles/wordpress/lab/exploration-lab.js";
import {
  holdWordPressVerificationLab,
  releaseHeldLabRecord,
} from "../profiles/wordpress/lab/review-lab.js";
import { HANDOFF_WALL_MS } from "../profiles/wordpress/verification/handoff-verifier.js";
import type { HeldVerificationLab } from "../verification/index.js";
import { createWordPressStateDiffReader } from "../profiles/wordpress/verification/lab-state-diff.js";
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
import { unboundBatch } from "./continuous.js";
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
      !WORDPRESS_LAUNCHABLE_DISCOVERY_PROMPT_IDS.some(
        (id) => id === directPolicy.data.promptVariant,
      )
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
  /** The runner's own batch; without it, the latest batch of this policy (#604). */
  requestedBatchId?: string,
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
    binding?.selectionBatchId ?? requestedBatchId,
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

/**
 * The runner's check before it continues a campaign after a restart (#302).
 * The campaign's batch is its bound one, or else the latest unbound automatic
 * batch. A batch frozen under another policy digest can never bind or resume
 * under this one, so the runner records why it drops it and selects afresh.
 * Its targets started no Trial, so selection admits them again.
 */
async function discardStaleSelectionBatch(
  state: CliState,
  policy: WordPressSelectionPolicy,
  campaignId: string,
): Promise<string | null> {
  if (!("candidateSource" in policy)) return null;
  const binding = state.ledger.read({
    campaignId,
    type: "selection-batch-bound",
    limit: 1,
  })[0]?.event;
  const batchId =
    binding?.type === "selection-batch-bound"
      ? binding.selectionBatchId
      : unboundBatch(state.ledger);
  if (batchId === undefined) return null;
  const selected = state.ledger.read({
    campaignId: batchId,
    type: "target-selected",
    limit: 1,
  })[0]?.event;
  const reportRef = selected?.artifacts.find(
    (artifact) => artifact.kind === "selection-report",
  );
  if (selected === undefined || reportRef === undefined) return null;
  let batchPolicyDigest =
    binding?.type === "selection-batch-bound" ? binding.policyDigest : null;
  if (batchPolicyDigest === null) {
    const file = await state.store.readFile(
      reportRef.digest,
      "selection-report.json",
      2 * 1024 * 1024,
    );
    // An unreadable report is left to the campaign's own error.
    if (file.status !== "resolved") return null;
    batchPolicyDigest = z
      .object({ policyDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/) })
      .parse(JSON.parse(file.bytes.toString("utf8"))).policyDigest;
  }
  const currentPolicyDigest = canonicalDigest(policy);
  if (batchPolicyDigest === currentPolicyDigest) return null;
  // A restart that died after the record but before its memo finds it here.
  if (
    state.ledger.read({
      campaignId: batchId,
      type: "selection-batch-discarded",
      limit: 1,
    }).length > 0
  )
    return batchId;
  const appended = await state.ledger.append({
    schemaVersion: 1,
    identity: `selection-batch-discarded-${canonicalDigest(batchId).slice(7, 39)}`,
    campaignId: batchId,
    snapshotDigest: selected.snapshotDigest,
    occurredAt: state.clock().toISOString(),
    type: "selection-batch-discarded",
    policyDigest: batchPolicyDigest,
    currentPolicyDigest,
    reason: "policy-changed",
    artifacts: [{ kind: "selection-report", digest: reportRef.digest }],
  });
  if (appended.status === "conflict")
    throw new Error("Selection batch discard conflicted");
  return batchId;
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
  WordPressFinding
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
  readonly setupFor: WordPressCampaignSession["setupFor"];
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
  readonly contract: WordPressOutputContractVersion | null;
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

/**
 * The campaign's active floor (60 minutes by default for `deep`, none for
 * `wide`, ADR 0033 / 0039); a resumed segment inherits what is left of it.
 */
function wordPressMinimumActiveMs(config: WordPressCampaignConfig): number {
  return config.discovery.minimumActiveMinutes * 60_000;
}

/** What the Harness enforces for one Trial on `profile`, as the Root is told and the ledger records. */
function wordPressRunParameters(
  config: WordPressCampaignConfig,
  profile: WordPressCampaignBoundaries["runtimeProfile"],
): RunParameters {
  return {
    wallMinutes: config.runWallTimeMinutes,
    minimumActiveMinutes: config.discovery.minimumActiveMinutes,
    maxChildren: config.discovery.maxChildren,
    // The observe budget is recorded for attached Labs only, so Lab-less
    // runs keep the configuration they had.
    lab:
      config.discovery.lab.mode === "none"
        ? {
            mode: config.discovery.lab.mode,
            maxResets: config.discovery.lab.maxResets,
          }
        : config.discovery.lab,
    runtime: {
      transportKind: profile.transportKind,
      model: profile.requestedModelId,
      effort: profile.requestedEffort,
    },
  };
}

function wordPressOutputContractFor(id: string) {
  const { contract } = wordPressDiscoveryContractPlan(id);
  if (contract === null)
    throw new Error("Prompt carries its own output contract");
  return {
    v1: wordPressDiscoveryOutputContract,
    v2: wordPressDiscoveryOutputContractV2,
    v4: wordPressDiscoveryOutputContractV4,
    v5: wordPressDiscoveryOutputContractV5,
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
  /** A resumed segment's fresh Lab: how many resets earlier segments used. */
  readonly resumedLab?: WordPressLabUsed;
  readonly source: WordPressDiscoverySource;
  readonly runParameters: RunParameters;
}): string {
  const { objective, trustBoundary, config, lab, source } = options;
  const objectiveOnly = wordPressDiscoveryContractPlan(
    objective.id,
  ).objectiveOnly;
  return [
    objective.text.trim(),
    ...(objectiveOnly ? [wordPressOutputContractFor(objective.id).text] : []),
    runParametersSection(options.runParameters),
    "## Trust boundary",
    trustBoundary.text.trim(),
    `## Programme Boundary (${config.programmeBoundary.version})`,
    config.programmeBoundary.text.trim(),
    ...(lab === undefined
      ? [
          "This Trial has no Lab. Runtime confirmation happens during verification.",
        ]
      : [wordPressLabSection(lab, config.discovery.lab, options.resumedLab)]),
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

/** What earlier segments of a resumed Trial used of its Lab budgets. */
type WordPressLabUsed = {
  readonly resetsUsed: number;
  readonly observationsUsed: number;
};
type WordPressLabBudget = {
  readonly maxResets: number;
  readonly maxObservations: number;
};

/**
 * The Harness-generated `## Lab` section of a Trial with an exploration Lab
 * (ADR 0003, 2026-10-25 addendum). It states the endpoint, the accounts,
 * the reset and observe commands with their budgets, and that the Lab
 * confirms nothing; it says nothing about what to try. Passwords are written
 * here: the sandbox has no other channel for Lab credentials. A resumed
 * segment's section states that its Lab is new and how much of the Trial's
 * budgets is used; it is that segment's first-turn notice. Agent-facing
 * text: changes need `owner-approved`.
 */
export function wordPressLabSection(
  lab: WordPressLabHandle,
  budget: WordPressLabBudget,
  resumed?: WordPressLabUsed,
): string {
  const { maxResets, maxObservations } = budget;
  const exploration = lab.exploration;
  if (exploration === undefined)
    throw new Error("The discovery Lab is not an exploration Lab");
  const { administrator, control } = exploration;
  const accounts = Object.entries(lab.attackerAccounts).flatMap(
    ([role, account]) =>
      account === undefined
        ? []
        : [`- ${role} account: ${account.username} / ${account.password}`],
  );
  const roles = [
    `"visitor" (not logged in)`,
    ...Object.entries(lab.attackerAccounts).flatMap(([role, account]) =>
      account === undefined ? [] : [`"${role}"`],
    ),
    `"administrator"`,
  ];
  const roleList = `${roles.slice(0, -1).join(", ")} or ${roles.at(-1)}`;
  return [
    "## Lab",
    [
      resumed === undefined
        ? "This Trial has one Lab of its own for its whole wall time. It runs the frozen target and its dependency plugins on WordPress in gVisor. This sandbox reaches it over HTTP only; the Lab has no internet access."
        : "This segment resumes the Trial in a new sandbox with a new Lab. The site was provisioned again from the same setup: nothing changed in the earlier Lab remains, and the accounts below replace the earlier ones. The Lab runs the frozen target and its dependency plugins on WordPress in gVisor. This sandbox reaches it over HTTP only; the Lab has no internet access.",
      `- Site: ${lab.endpoint}/`,
      `- Administrator account: ${administrator.username} / ${administrator.password}`,
      ...accounts,
      `- Reset: \`POST http://${control.host}/reset\` removes the site and provisions it again from the same setup; the accounts above stay the same. ${resumed === undefined ? `This Trial may reset at most ${maxResets} times` : `This Trial may reset at most ${maxResets} times in all and has used ${resumed.resetsUsed}`}, and the answer states how many are used. Other requests through \`${lab.endpoint}\` are counted, not limited.`,
    ].join("\n"),
    `Observe: \`POST http://${control.host}/observe\` with a JSON body opens one page of the site in the Harness's headless browser inside the Lab and answers with what the browser saw. The body is \`{"role": ..., "path": "/..."}\`, where role is ${roleList}, and the browser logs in with that account above. The path starts with a single \`/\`, has no whitespace or backslash, and is at most 2048 characters. It may add \`"actions"\`, 1 to 5 steps run in order after the page loads, each \`{"kind": "click", "selector": "..."}\`, \`{"kind": "click-text", "text": "...", "exact": true}\` or \`{"kind": "fill", "selector": "...", "value": "..."}\`. A selector is 1 to 200 characters of letters, digits, spaces and \`# . _ [ ] = " ' ( ) : > + ~ * , -\`; \`text\` and a fill \`value\` are 1 to 120 characters; \`exact\` is a boolean, true or false. It may also add \`"dialogMarker"\`, a string of 10 to 15 digits not starting with 0. No other field is accepted; a body that does not fit is refused as \`invalid-request\`, and the answer's \`field\` names the first field that failed. The control endpoint takes one command at a time: a request sent while another is waiting is answered 409 \`busy\`. The answer gives the HTTP status of the path, whether a dialog opened and, with a marker, whether an alert with exactly that text opened, the console error count, and the digest of a screenshot the Harness keeps. ${resumed === undefined ? `This Trial may observe at most ${maxObservations} times` : `This Trial may observe at most ${maxObservations} times in all and has used ${resumed.observationsUsed}`}, and the answer states how many are used. The answer is an observation, not a confirmation; report what you observed in \`labObservations\`.`,
    "The Harness records the HTTP traffic through the site address and the site state before and after each reset. Nothing observed in this Lab is a confirmation. A setting you make as administrator is a configuration precondition; state it in `configurationPrecondition`. In a Finding or Lead, `labObservations` states what you tried in the Lab and what you saw.",
  ].join("\n\n");
}

/**
 * The last paragraph of the objective is the pinned directive early Root
 * resumes receive. The deep objective's starts "Before giving up,"; the wide
 * objective's is its bounded stop rule and starts "Stop when" (ADR 0039).
 */
const WORDPRESS_RESUME_PARAGRAPH_PREFIX = {
  deep: "Before giving up,",
  wide: "Stop when",
} as const;

function wordPressResumeParagraph(objective: WordPressDiscoveryAsset): string {
  const resumePrompt = objective.text
    .trim()
    .split(/\n\s*\n/)
    .at(-1);
  const mode = wordPressDiscoveryModeOf(objective.id) ?? "deep";
  // ADR 0042: a partitioned objective is handed to one-shot tracers, which are never resumed.
  if (mode === "partitioned")
    throw new Error("A partitioned objective has no resume paragraph");
  if (
    resumePrompt === undefined ||
    !resumePrompt.startsWith(WORDPRESS_RESUME_PARAGRAPH_PREFIX[mode])
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

/** The source mount notes every role receives, as the cooperative prompt states them. */
function wordPressSourceNotes(source: WordPressDiscoverySource): string[] {
  return [
    ...(source.dependency === undefined
      ? []
      : [`WordPress core source (read-only): ${source.dependency.path}.`]),
    ...(source.dependencySources ?? []).map(
      (dependency) => `Dependency source (read-only): ${dependency.path}.`,
    ),
  ];
}

const sha256 = (text: string) =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;

/**
 * The runtime profile one role runs on: the host's Claude profile, with the
 * role's model and effort when the config names them. Both roles of a Trial
 * must agree, because one CampaignInput binds one profile digest.
 */
function wordPressRoleProfile(
  base: AgentRuntimeProfile,
  role: {
    readonly model?: string | undefined;
    readonly effort?: string | undefined;
  },
): AgentRuntimeProfile {
  if (base.transportKind !== "claude-code/v1")
    throw new Error("A partitioned Trial runs on the Claude runtime only");
  if (role.model === undefined && role.effort === undefined) return base;
  const requestedModelId = (role.model ??
    base.requestedModelId) as typeof base.requestedModelId;
  const requestedEffort = (role.effort ??
    base.requestedEffort) as typeof base.requestedEffort;
  return defineClaudeRuntimeProfile(
    {
      id: base.id,
      requestedModelId,
      requestedEffort,
      claudeCliVersion: base.claudeCliVersion,
      authenticationMethod: base.authenticationMethod,
      subagent: { modelId: requestedModelId, effort: requestedEffort },
    },
    base.sandboxImageDigest,
  );
}

/**
 * One partitioned Trial per target (ADR 0042): the enumerator's prompt is its
 * role body, the enforced run parameters and limits, and the source notes;
 * a tracer's is its role body, the partition objective, the solo contract,
 * the trust and Programme boundaries and the source notes, with the
 * partition itself in `/workspace/input/partition.json`. Every role mounts
 * the tool files the config names. Existing prompt ids and texts are reused
 * unchanged.
 */
async function planWordPressPartitionedDiscovery(
  { snapshot, lab }: WordPressDiscoveryInput,
  context: WordPressDiscoveryContext,
): Promise<WordPressDiscoveryPlan> {
  const { config, boundaries, state, objective, trustBoundary } = context;
  const discovery = config.discovery;
  if (
    discovery.mode !== "partitioned" ||
    discovery.enumerator === undefined ||
    discovery.partition === undefined ||
    discovery.tracer === undefined
  )
    throw new Error("The campaign is not partitioned");
  if (lab !== undefined || discovery.lab.mode !== "none")
    throw new Error("The partitioned mode runs without an exploration Lab");
  if (discovery.enumerator.rowSource !== "agent")
    throw new Error(
      "rowSource script-only is the stage 3 measurement arm; not runnable yet",
    );
  if (wordPressDiscoveryModeOf(objective.id) !== "partitioned")
    throw new Error("The partitioned mode runs a partitioned objective only");
  const claude = boundaries.claude;
  if (claude?.oneShot === undefined)
    throw new Error(
      "The partitioned mode needs the host's Claude runtime with one-shot runs",
    );
  const enumeratorProfile = wordPressRoleProfile(
    claude.runtimeProfile,
    discovery.enumerator,
  );
  const tracerProfile = wordPressRoleProfile(
    claude.runtimeProfile,
    discovery.tracer,
  );
  if (enumeratorProfile.digest !== tracerProfile.digest)
    throw new Error(
      "The enumerator and tracer must run on the same model and effort in stage 1",
    );
  const profile = enumeratorProfile;
  const [enumeratorRole, tracerRole, source] = await Promise.all([
    loadWordPressRoleDefinition(
      WORDPRESS_CURRENT_ROLE_DEFINITION_IDS.enumerator,
    ),
    loadWordPressRoleDefinition(WORDPRESS_CURRENT_ROLE_DEFINITION_IDS.tracer),
    boundaries.sourceFor(snapshot),
  ]);
  const toolIds = [...new Set(discovery.enumerator.tools)];
  const toolFiles: OneShotToolFile[] = (
    await Promise.all(toolIds.map(loadWordPressEnumerationTool))
  ).map((tool) => ({ name: tool.file, content: tool.bytes }));
  const toolsDigest = wordPressEnumerationToolsDigest(toolIds);
  const limits = discovery.partition;
  const runtime = {
    transportKind: profile.transportKind,
    model: profile.requestedModelId,
    effort: profile.requestedEffort,
  };
  const enumeratorParameters: RunParameters = {
    wallMinutes: discovery.enumerator.wallMinutes,
    minimumActiveMinutes: 0,
    maxChildren: 0,
    lab: { mode: "none", maxResets: discovery.lab.maxResets },
    runtime,
  };
  const sourceNotes = wordPressSourceNotes(source);
  const enumeratorPrompt = [
    enumeratorRole.body.trim(),
    runParametersSection(enumeratorParameters),
    partitionLimitsSection({
      ...limits,
      sentBack: {
        previous: `${SANDBOX_INPUT_MOUNT_PATH}/${PARTITION_INPUT_FILES.previous}`,
        reasons: `${SANDBOX_INPUT_MOUNT_PATH}/${PARTITION_INPUT_FILES.sentBack}`,
      },
    }),
    ...sourceNotes,
  ].join("\n\n");
  const contract = wordPressDiscoveryOutputContractV4Solo();
  const tracerPrompt = [
    tracerRole.body.trim(),
    objective.text.trim(),
    contract.text,
    "## Trust boundary",
    trustBoundary.text.trim(),
    `## Programme Boundary (${config.programmeBoundary.version})`,
    config.programmeBoundary.text.trim(),
    ...sourceNotes,
  ].join("\n\n");
  const shared = {
    promptVariant: objective.id,
    promptDigest: objective.digest,
    trustBoundaryVersion: trustBoundary.id,
    sourcePack: {
      dependency:
        source.dependency === undefined
          ? ("none" as const)
          : ("mounted" as const),
    },
    labAccess: { database: "none" as const },
    runtime: profile.transportKind,
    mode: "partitioned" as const,
    lab: { mode: "none" as const, maxResets: discovery.lab.maxResets },
    model: profile.requestedModelId,
    effort: profile.requestedEffort,
  };
  const mounts = wordPressSourceMounts(source);
  const enumerate: PartitionedRolePlan = {
    configuration: {
      ...shared,
      inputDigest: sha256(enumeratorPrompt),
      wallMinutes: discovery.enumerator.wallMinutes,
      role: {
        kind: enumeratorRole.role,
        definitionDigest: enumeratorRole.digest,
        toolsDigest,
      },
    },
    run: {
      targetSnapshotDigest: snapshot.digest,
      profile,
      prompt: enumeratorPrompt,
      toolFiles,
      output: "files",
      wallMs: discovery.enumerator.wallMinutes * 60_000,
      ...mounts,
    },
  };
  const trace: PartitionedRolePlan = {
    configuration: {
      ...shared,
      objectiveDigest: objective.digest,
      contractDigest: contract.digest,
      ...(objective.sectionDigests === undefined
        ? {}
        : { sectionDigests: objective.sectionDigests }),
      inputDigest: sha256(tracerPrompt),
      wallMinutes: discovery.tracer.wallMinutes,
      role: {
        kind: tracerRole.role,
        definitionDigest: tracerRole.digest,
        toolsDigest,
      },
    },
    run: {
      targetSnapshotDigest: snapshot.digest,
      profile,
      prompt: tracerPrompt,
      toolFiles,
      output: "report",
      wallMs: discovery.tracer.wallMinutes * 60_000,
      ...mounts,
    },
  };
  // The worst case the config's superRefine already bounded; enforced again here.
  const targetWallMs = Math.min(
    PARTITIONED_TARGET_CEILING_MS,
    (discovery.enumerator.wallMinutes * (1 + limits.maxResubmits) +
      Math.ceil(limits.maxPartitions / discovery.tracer.maxParallel) *
        discovery.tracer.wallMinutes) *
      60_000,
  );
  const trialId = state.newId();
  return {
    input: {
      schemaVersion: 1,
      snapshotDigest: snapshot.digest,
      trustBoundary: { version: trustBoundary.id, text: trustBoundary.text },
      programmeBoundary: config.programmeBoundary,
      modelProfileDigest: profile.digest,
      promptDigest: objective.digest,
      stopRules: { maxRuns: 1, noFindingRuns: 1 },
      lab: { mode: "none" },
      history: { mode: "none" },
    },
    concurrency: 1,
    plannedTrials: [
      {
        trialId,
        trialOrdinal: 0,
        // The Trial's attempt for the campaign loop: the enumerator's first run.
        explore: {
          configuration: enumerate.configuration,
          run: {
            runId: trialId,
            targetSnapshotDigest: snapshot.digest,
            profile,
            prompt: enumeratorPrompt,
            ...mounts,
            expiresAt: new Date(
              state.clock().getTime() + targetWallMs,
            ).toISOString(),
          },
        },
        partitioned: {
          enumerate,
          trace,
          limits,
          maxParallel: discovery.tracer.maxParallel,
          targetWallMs,
          rowSource: discovery.enumerator.rowSource,
          definitionDigests: {
            enumerator: enumeratorRole.digest,
            tracer: tracerRole.digest,
          },
          toolsDigest,
        },
      },
    ],
    executor: claude.executor,
    oneShotExecutor: claude.oneShot,
    attachments: boundaries.attachments,
    recordReport: recordWordPressReport,
  };
}

async function planWordPressDiscovery(
  input: WordPressDiscoveryInput,
  context: WordPressDiscoveryContext,
): Promise<WordPressDiscoveryPlan> {
  // ADR 0042: the role-based Trial has its own planner; deep and wide are unchanged.
  if (context.config.discovery.mode === "partitioned")
    return planWordPressPartitionedDiscovery(input, context);
  const { snapshot, lab } = input;
  const { config, repeat, boundaries, state, objective, trustBoundary } =
    context;
  if ((lab === undefined) !== (config.discovery.lab.mode === "none"))
    throw new Error(
      "Discovery Lab mode differs from the campaign configuration",
    );
  if (lab !== undefined && lab.exploration === undefined)
    throw new Error("The discovery Lab is not an exploration Lab");
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
  const runParameters = wordPressRunParameters(config, runtime.runtimeProfile);
  const promptFor = (selectedObjective: typeof objective) =>
    wordPressDiscoveryPromptText({
      objective: selectedObjective,
      trustBoundary,
      config,
      lab,
      source,
      runParameters,
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
      const prompt = promptFor(selectedObjective);
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
          ...(selectedObjective.sectionDigests === undefined
            ? {}
            : { sectionDigests: selectedObjective.sectionDigests }),
          // The whole text the Root receives: objective plus generated sections.
          inputDigest: `sha256:${createHash("sha256").update(prompt).digest("hex")}`,
          trustBoundaryVersion: trustBoundary.id,
          sourcePack: {
            dependency:
              source.dependency === undefined
                ? ("none" as const)
                : ("mounted" as const),
          },
          labAccess: {
            database: "none",
          },
          ...(share === undefined
            ? {}
            : { runtime: runtime.runtimeProfile.transportKind }),
          mode: config.discovery.mode,
          wallMinutes: runParameters.wallMinutes,
          minimumActiveMinutes: runParameters.minimumActiveMinutes,
          maxChildren: runParameters.maxChildren,
          lab: runParameters.lab,
          model: runParameters.runtime.model,
          effort: runParameters.runtime.effort,
        },
        run: {
          runId: trialId,
          targetSnapshotDigest: snapshot.digest,
          profile: runtime.runtimeProfile,
          coordination: "cooperative" as const,
          prompt,
          maxChildren: runParameters.maxChildren,
          minimumActiveMs: wordPressMinimumActiveMs(config),
          resumePrompt,
          ...(lab?.exploration === undefined
            ? {}
            : {
                // HTTP only: `wordpress` resolves to the Lab recorder, which
                // captures every exchange; the database is not exposed.
                lab: {
                  endpoint: lab.endpoint,
                  networkName: lab.networkName,
                  internalIp: lab.recorderIp,
                  control: {
                    host: lab.exploration.control.host,
                    ipv4: lab.exploration.control.ipv4,
                  },
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
    ...(context.resumeInterrupted === undefined
      ? {}
      : {
          resumeInterrupted: resumeInterruptedFor(
            context,
            context.resumeInterrupted.log,
          ),
        }),
    ...(context.resumeProviderLimited === undefined
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
    setupFor,
  }: Pick<WordPressCampaignSession, "config" | "boundaries" | "setupFor">,
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
  // A segment continues the objective its Trial recorded, not the campaign's
  // current one (#548, ADR 0036 addendum 2026-10-27). Archived versions stay
  // in the registry; a version the registry no longer has cannot be rebuilt.
  const recordedPrompt = WORDPRESS_DISCOVERY_PROMPT_IDS.find(
    (id) => id === started.configuration.promptVariant,
  );
  if (recordedPrompt === undefined)
    return {
      status: "refused",
      reason: "prompt-version-differs",
      detail: `${started.configuration.promptVariant} is not in the prompt registry`,
    };
  const [objective, trustBoundary] = await Promise.all([
    loadWordPressDiscoveryAsset(recordedPrompt),
    loadWordPressDiscoveryAsset(WORDPRESS_TRUST_BOUNDARY.id),
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
  // A Trial with an exploration Lab resumes with a fresh Lab of the same
  // setup (ADR 0003, 2026-10-25 addendum); the earlier one is already sealed.
  const recordedLab = started.configuration.lab;
  const attached = recordedLab?.mode === "attached";
  if (attached && config.discovery.lab.mode === "none")
    return {
      status: "refused",
      reason: "lab-mode-differs",
      detail: "the campaign configuration has discovery.lab none",
    };
  // The Lab budget is the Trial's: a segment keeps the one the Trial started
  // with, and a campaign configured otherwise does not resume it.
  let labBudget: WordPressLabBudget | undefined;
  if (attached) {
    const current = config.discovery.lab;
    const budgetDiffers = (
      name: "maxResets" | "maxObservations",
      recorded: number | undefined,
    ) => ({
      status: "refused" as const,
      reason: "lab-budget-differs",
      detail:
        recorded === undefined
          ? `the Trial started without discovery.lab.${name}; the campaign configuration has ${current[name]}`
          : `the Trial started with discovery.lab.${name} ${recorded}; the campaign configuration has ${current[name]}`,
    });
    if (recordedLab.maxResets !== current.maxResets)
      return budgetDiffers("maxResets", recordedLab.maxResets);
    const { maxObservations } = recordedLab;
    if (
      maxObservations === undefined ||
      maxObservations !== current.maxObservations
    )
      return budgetDiffers("maxObservations", maxObservations);
    labBudget = { maxResets: recordedLab.maxResets, maxObservations };
  }
  const source = await boundaries.sourceFor(snapshot);
  // A segment enforces the values its Trial recorded, not the campaign's
  // current ones, so the copied configuration stays true (#548). Trials from
  // before #537 recorded none: their children were capped at the default,
  // and their wall and floor stay the configuration's as before.
  const recorded = started.configuration;
  const runParameters: RunParameters = {
    ...wordPressRunParameters(config, runtime.runtimeProfile),
    wallMinutes: recorded.wallMinutes ?? config.runWallTimeMinutes,
    minimumActiveMinutes:
      recorded.minimumActiveMinutes ?? config.discovery.minimumActiveMinutes,
    maxChildren: recorded.maxChildren ?? DEFAULT_MAX_CHILDREN,
  };
  const minimumActiveMs = runParameters.minimumActiveMinutes * 60_000;
  const promptWith = (
    lab: WordPressLabHandle | undefined,
    resumedLab?: WordPressLabUsed,
  ) =>
    wordPressDiscoveryPromptText({
      objective,
      trustBoundary,
      config,
      lab,
      ...(resumedLab === undefined ? {} : { resumedLab }),
      source,
      runParameters,
    });
  const prompt = promptWith(undefined);
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
    maxChildren: runParameters.maxChildren,
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
    wallTimeMs: runParameters.wallMinutes * 60_000,
    minimumActiveMs,
    lab: attached,
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
              { ...run, minimumActiveMs },
            ),
        }),
  });
  if (assessment.status === "refused") return assessment;
  const { plan } = assessment;
  if (plan.lab === undefined) {
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
  return resumeWithExplorationLab({
    state,
    config,
    boundaries,
    setup: setupFor(snapshot),
    snapshot,
    campaignId: input.campaignId,
    previousLabId: started.labId,
    plan,
    budget: labBudget!,
    used: plan.lab,
    promptWith,
    context,
    run,
    executor: runtime.executor,
    ...(signal === undefined ? {} : { signal }),
  });
}

/**
 * One resumed segment of a Trial with an exploration Lab: a fresh Lab of the
 * setup the previous segment's Lab recorded, the reset budget that is left,
 * and a `## Lab` section saying so as the segment's first-turn notice. The
 * segment seals its own `exploration-lab` bundle; the Lab is torn down after.
 */
async function resumeWithExplorationLab(options: {
  readonly state: CliState;
  readonly config: WordPressCampaignConfig;
  readonly boundaries: WordPressCampaignBoundaries;
  readonly setup: WordPressLabSetup;
  readonly snapshot: Snapshot;
  readonly campaignId: string;
  readonly previousLabId: string | undefined;
  readonly plan: ResumePlan;
  /** The Lab budget the resumed run recorded when it started. */
  readonly budget: WordPressLabBudget;
  readonly used: WordPressLabUsed;
  readonly promptWith: (
    lab: WordPressLabHandle,
    resumedLab: WordPressLabUsed,
  ) => string;
  readonly context: Omit<
    Parameters<typeof executeTrialResume>[0],
    "executor" | "signal"
  >;
  readonly run: Omit<Parameters<typeof executeTrialResume>[2], "runId">;
  readonly executor: Parameters<typeof executeTrialResume>[0]["executor"];
  readonly signal?: AbortSignal;
}): Promise<
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
  const { state, boundaries, snapshot, campaignId, plan } = options;
  const previous = state.ledger
    .readAll({ campaignId, type: "lab-provisioned" })
    .map(({ event }) => event)
    .find(
      (event) =>
        event.type === "lab-provisioned" &&
        event.labId === options.previousLabId,
    );
  const previousSetupDigest =
    previous?.type === "lab-provisioned" ? previous.setupDigest : undefined;
  if (previousSetupDigest === undefined)
    return {
      status: "refused",
      reason: "lab-setup-unrecorded",
      ...(options.previousLabId === undefined
        ? {}
        : { detail: options.previousLabId }),
    };
  const base = () => ({
    schemaVersion: 1 as const,
    campaignId,
    snapshotDigest: snapshot.digest,
    occurredAt: state.clock().toISOString(),
  });
  const provisioned = await boundaries.lab.provision(snapshot, options.setup, {
    purpose: "discovery",
  });
  if (provisioned.status !== "ready") {
    const labId = state.newId();
    await state.ledger.append({
      ...base(),
      identity: `lab-provisioned-${labId}`,
      type: "lab-provisioned",
      labId,
      status: "failed",
      purpose: "discovery",
      failureStage: "provision",
      reason: provisioned.reason,
      artifacts: [
        {
          kind: "lab-diagnostic",
          digest: await storeLabDiagnostic(
            state.store,
            "provision",
            provisioned,
          ),
        },
      ],
    });
    return { status: "refused", reason: "lab-provision-failed" };
  }
  const handle = provisioned.handle;
  let outcome: Awaited<ReturnType<typeof executeTrialResume>> | undefined;
  try {
    await state.ledger.append({
      ...base(),
      identity: `lab-provisioned-${handle.id}`,
      type: "lab-provisioned",
      labId: handle.id,
      status: "ready",
      purpose: "discovery",
      setupDigest: handle.setupDigest,
    });
    if (handle.setupDigest !== previousSetupDigest)
      return {
        status: "refused",
        reason: "lab-setup-differs",
        detail: previousSetupDigest,
      };
    if (handle.exploration === undefined)
      throw new Error("The discovery Lab is not an exploration Lab");
    const resumedLab = options.used;
    const notice = wordPressLabSection(handle, options.budget, resumedLab);
    outcome = await executeTrialResume(
      {
        ...options.context,
        input: {
          ...options.context.input,
          lab: { setupDigest: handle.setupDigest },
        },
        labId: handle.id,
        lab: openWordPressExplorationLab({
          lab: boundaries.lab,
          handle,
          maxResets: options.budget.maxResets,
          resetsUsedBefore: options.used.resetsUsed,
          maxObservations: options.budget.maxObservations,
          observationsUsedBefore: options.used.observationsUsed,
          store: state.store,
          clock: state.clock,
        }),
        executor: options.executor,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      plan,
      {
        runId: state.newId(),
        ...options.run,
        prompt: options.promptWith(handle, resumedLab),
        resumeNotice: notice,
        lab: {
          endpoint: handle.endpoint,
          networkName: handle.networkName,
          internalIp: handle.recorderIp,
          control: {
            host: handle.exploration.control.host,
            ipv4: handle.exploration.control.ipv4,
          },
        },
      },
    );
  } finally {
    const removed = await boundaries.lab.teardown(handle).catch(() => null);
    if (removed?.status !== "removed") {
      await state.ledger.append({
        ...base(),
        identity: `campaign-stopped-${state.newId()}`,
        type: "campaign-stopped",
        reason: "incomplete",
        cleanupLabIds: [handle.id],
      });
      throw new Error(
        removed?.nextStep ??
          "Inspect and remove remaining Lab resources before retry",
      );
    }
  }
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
          input.selectionBatchId,
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
    loadWordPressDiscoveryAsset(WORDPRESS_TRUST_BOUNDARY.id),
  ]);
  return runCampaignPipeline({
    campaignId: input.campaignId,
    discoveryLab: config.discovery.lab.mode,
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
      explorationLab: (handle) =>
        openWordPressExplorationLab({
          lab: boundaries.lab,
          handle,
          maxResets: config.discovery.lab.maxResets,
          maxObservations: config.discovery.lab.maxObservations,
          store: state.store,
          clock: state.clock,
        }),
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
          setupFor: session.setupFor,
          state,
          objective,
          trustBoundary,
        }),
      get verification() {
        return session.verification;
      },
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
      }).decide(policy, {
        minimum,
        ...(input.reservedBatches === undefined
          ? {}
          : { reservedBatches: input.reservedBatches }),
      });
      let inspected = decision.inspections;
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
      // Ranked beyond the cutoff fills in when a better-ranked source fails to
      // freeze. When a band's freezes leave fewer than `minimum` targets, the
      // next cascade bands are tried in turn, as the pre-freeze decision would
      // have done had the failed sources not counted as eligible (#623).
      const tried = [...decision.cascade];
      const attempted = new Set<string>();
      let bandUsed = decision.cascadeStep ?? 0;
      const firstBand = Math.max(
        0,
        decision.bands.findIndex((band) => band.step === bandUsed),
      );
      for (const band of decision.bands.slice(firstBand)) {
        if (band.step !== bandUsed) {
          if (chosen.length >= minimum) break;
          bandUsed = band.step;
          if (!tried.some((entry) => entry.step === band.step))
            tried.push({ step: band.step, eligible: band.ranked.length });
          inspected = band.inspections;
          for (const item of band.inspections)
            if (!attempted.has(item.slug))
              reasons.set(item.slug, [...item.reasons]);
        }
        for (const target of band.ranked) {
          if (attempted.has(target.slug)) continue;
          attempted.add(target.slug);
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
      }
      const inspectionBySlug = new Map(
        inspected.map((item) => [item.slug, item]),
      );
      // A runner stop that arrived while sources froze records no batch, so
      // none is left unconsumed for the next start (#302).
      if (input.stop?.() === true)
        for (const { target } of chosen.splice(0))
          reasons.get(target.slug)?.push("stopped");
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
        ...(bandUsed === 0 ? {} : { cascadeStep: bandUsed }),
        cascade: tried,
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
        ...(bandUsed === 0 ? {} : { cascadeStep: bandUsed }),
        cascade: tried,
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
    async discardStaleSelection(state, input) {
      const parsed = await readWordPressCampaignConfig(input.configPath);
      const policy = await readWordPressCampaignPolicy(
        input.selectionPolicyPath === undefined
          ? parsed
          : { ...parsed, selectionPolicyPath: input.selectionPolicyPath },
      );
      return discardStaleSelectionBatch(state, policy, input.campaignId);
    },
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
      const { lab } = session.boundaries;
      const observation = input.observation;
      let heldLabId: string | undefined;
      try {
        return await verifyNextFinding({
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
          verification: session.verification,
          // #600: a person observes in this Lab, which already holds the setup and the route.
          ...(observation === undefined
            ? {}
            : {
                hold: async (held: HeldVerificationLab<WordPressLabHandle>) => {
                  heldLabId = held.lab.id;
                  const kept = await holdWordPressVerificationLab({
                    held,
                    lab,
                    ledger: state.ledger,
                    store: state.store,
                    stateDirectory: state.stateDirectory,
                    clock: state.clock,
                    wallMs: HANDOFF_WALL_MS,
                    present: (held) => observation.present(held),
                  });
                  if (kept.status === "not-held")
                    observation.skipped(kept.reason);
                },
              }),
        });
      } finally {
        if (heldLabId !== undefined)
          await releaseHeldLabRecord({
            stateDirectory: state.stateDirectory,
            labId: heldLabId,
            lab,
          });
      }
    },
    restoreParked: (state, input) =>
      restoreParkedWordPressFinding({
        ledger: state.ledger,
        evidence: state.store,
        campaignId: input.campaignId,
        findingId: input.findingId,
        clock: state.clock,
        note: { restoredBy: input.restoredBy, reason: input.reason },
      }),
    stateDiffReader: (state) =>
      createWordPressStateDiffReader({ store: state.store }),
    httpEvidenceReader: (state) =>
      createWordPressHttpEvidenceReader({ store: state.store }),
    verifierRecordReader: (state) =>
      createWordPressVerifierRecordReader({ store: state.store }),
    labDown: (state, input) => wordPressLabDown(state, input, options),
    targetCeiling: async (configPath) =>
      (await readWordPressCampaignConfig(configPath)).resources
        .maxConcurrentTargets,
    runtimeCeilings: async (configPath) =>
      wordPressRuntimeCeilings(await readWordPressCampaignConfig(configPath)),
    async cleanupLeftovers(state, input) {
      const { boundaries } = await openWordPressCampaignSession(
        options,
        state,
        input,
      );
      return boundaries.lab.cleanupLeftovers({
        remove: input.remove,
        labs: input.labs,
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
                    cascade: _cascade,
                    ...rest
                  }) => rest)(unranked)
                : unranked;
            const {
              targetSourcePins: _targetSourcePins,
              maximumActiveInstallations: _maximumActiveInstallations,
              ...policyWithoutCapturedSources
            } = reverifyPolicy as WordPressSelectionPolicy & {
              targetSourcePins?: Readonly<Record<string, unknown>>;
            };
            const sameOriginalVersion =
              version === originalSnapshot.target.version;
            let capturedSourcePin: WordPressTargetSelection["targetSourcePin"];
            if (sameOriginalVersion) {
              const originalSelectionEvent = state.ledger
                .readAll({
                  campaignId: input.campaignId,
                  type: "target-selected",
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
              // This Finding was already selected. Re-verification needs its
              // current source, even if it has moved out of the selection band.
              minimumActiveInstallations: 0,
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
        },
      });
    },
  };
}
