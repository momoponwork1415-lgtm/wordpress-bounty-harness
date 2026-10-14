import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  allocateTrialArms,
  CODEX_SANDBOX_MEMORY_MIB,
  CODEX_COOPERATIVE_SANDBOX_MEMORY_MIB,
  DISCOVERY_LEFTOVER_PATTERNS,
  EGRESS_BROKER_MEMORY_MIB,
} from "../discovery/index.js";
import type {
  AgentRuntimeProfile,
  CampaignHistory,
  DiscoveryTransportResult,
  DiscoveryTransportRun,
  PlannedDiscoveryRun,
  AdmittedLead,
  ProviderAttachmentStore,
} from "../discovery/index.js";
import type { ExpectedSourceTree } from "../infrastructure/canonical-source-tree.js";
import type { SqliteHostResourceClaims } from "../infrastructure/host-resource-claims.js";
import type { TargetResourceScope } from "../infrastructure/target-resource-scope.js";
import { Review, type ScopeFactsProvider } from "../review/index.js";
import type { Snapshot } from "../snapshot/index.js";
import { Verification, type Verifier } from "../verification/index.js";
import { WORDPRESS_VERIFIER_PROMPT_ID } from "../profiles/wordpress/prompts/index.js";
import { parseWordPressAdvisories } from "../profiles/wordpress/advisory.js";
import {
  parseWordPressAnswerKeys,
  wordpressFindingLocations,
} from "../profiles/wordpress/answer-key.js";
import {
  planWordPressEntryAssignments,
  renderWordPressEntryAssignment,
  renderWordPressEntryIndex,
  type WordPressEntryAssignment,
} from "../profiles/wordpress/discovery/entry-points.js";
import { buildWordPressSourceIndex } from "../profiles/wordpress/discovery/storage-index.js";
import {
  canonicalDigest,
  canonicalJson,
} from "../infrastructure/canonical-json.js";
import {
  admitWordPressLead,
  readWordPressLead,
  wordPressLeadSignature,
} from "../profiles/wordpress/discovery/lead.js";
import {
  admitWordPressFinding,
  readWordPressFinding,
  type WordPressFinding,
} from "../profiles/wordpress/discovery/finding.js";
import { isWordPressProgrammeImpact } from "../profiles/wordpress/discovery/programme-impacts.js";
import {
  normalizeWordPressCandidate,
  classifyWordPressCandidate,
} from "../profiles/wordpress/discovery/normalize-candidate.js";
import {
  wordPressDiscoveryOutputContract,
  wordPressDiscoveryOutputContractV2,
} from "../profiles/wordpress/discovery/output-contract.js";
import type {
  WordPressLab,
  WordPressLabHandle,
  WordPressLabSetup,
} from "../profiles/wordpress/lab/index.js";
import { wordPressScenario } from "../profiles/wordpress/lab/scenarios.js";
import type { RepeatTrialGate } from "../profiles/wordpress/discovery/repeat-trial-gate.js";
import {
  loadWordPressDiscoveryAsset,
  WORDPRESS_OBJECTIVE_ONLY_PROMPT_IDS,
  WORDPRESS_DISCOVERY_PROMPT_IDS,
  type WordPressDiscoveryAsset,
} from "../profiles/wordpress/prompts/index.js";
import {
  createWordpressScopeEvaluator,
  type WordpressScopeInput,
  type WordpressScopePolicy,
} from "../profiles/wordpress/scope-policy.js";
import {
  collectWordPressCandidateInventory,
  hasVerifiedWordPressCandidateInventoryChainCoverage,
  loadWordPressSelectionPolicy,
  readWordPressCandidateInventoryCursor,
  wordPressSelectionPolicySchema,
  wordPressTargetSelectionSchema,
  type WordPressSelectionPolicy,
  type WordPressSelectionInspection,
  type WordPressSelectionWithBatchInspection,
  type WordPressTargetSelection,
} from "../profiles/wordpress/selection/index.js";
import { inspectWordPressLedgerExclusions } from "../profiles/wordpress/selection/ledger-exclusions.js";
import { createWordPressScopeFacts } from "../profiles/wordpress/scope-facts.js";
import { createWordfenceDuplicateLookup } from "../profiles/wordpress/wordfence-history/duplicate-lookup.js";
import {
  extractCampaignHistory,
  inspectHistoryMirror,
} from "../profiles/wordpress/wordfence-history/index.js";
import { createWordPressJudges } from "../profiles/wordpress/verification/judges.js";
import { SmokeReplayVerifier } from "../profiles/wordpress/verification/smoke-replay-verifier.js";
import {
  createWordPressLabStateObserver,
  createWordPressStateDiffReader,
} from "../profiles/wordpress/verification/lab-state-diff.js";
import {
  wordpressReproductionRenderer,
  type WordPressReconstruction,
} from "../profiles/wordpress/verification/reproduction-package.js";
import type { CliProfile, CliState, LabUpSummary } from "./index.js";
import {
  provisionFindingLab,
  reverifyOnSelectedVersion,
  runCampaignPipeline,
  type CampaignPipeline,
} from "./pipeline.js";

const text = z.strictObject({
  version: z.string().min(1).max(64),
  text: z.string().min(1).max(16_384),
});

/** One discovery run holds a Codex sandbox and its own egress broker. */
const DISCOVERY_RUN_MEMORY_MIB =
  CODEX_SANDBOX_MEMORY_MIB + EGRESS_BROKER_MEMORY_MIB;

const armBFraction = z.number().min(0).max(1);
const runnablePrompt = z
  .enum(WORDPRESS_DISCOVERY_PROMPT_IDS)
  .exclude(["screening-v1"]);
const ablationAxis = z.discriminatedUnion("axis", [
  z.strictObject({ axis: z.literal("history"), armBFraction }),
  z.strictObject({
    axis: z.literal("prompt"),
    armBFraction,
    armBPromptId: runnablePrompt,
  }),
]);
const ablation = z
  .union([
    z.strictObject({ axes: z.array(ablationAxis).min(1).max(2) }),
    z.strictObject({ axis: z.literal("history"), armBFraction }),
  ])
  .transform((value) => ("axes" in value ? value : { axes: [value] }));

/** Human-edited, Git-tracked run configuration. It carries no credentials or keys. */
const commonCampaignFields = {
  schemaVersion: z.literal(1),
  selectionPolicyPath: z.string().min(1).optional(),
  programmeBoundary: text,
  runWallTimeMinutes: z.number().positive().max(240).optional(),
  /** Host bounds: targets, per-target discovery runs and their memory budget. */
  resources: z
    .strictObject({
      maxConcurrentRuns: z.number().int().min(1).max(4).default(2),
      maxConcurrentTargets: z.number().int().min(1).max(4).default(1),
      memoryBudgetMiB: z.number().int().positive(),
    })
    .default({
      maxConcurrentRuns: 2,
      maxConcurrentTargets: 1,
      memoryBudgetMiB: 4 * DISCOVERY_RUN_MEMORY_MIB,
    }),
  wordpressVersion: z.string().min(1).max(32),
  lab: z.strictObject({
    siteTitle: z.string().min(1).max(120),
    initialPosts: z.array(z.string().min(1).max(120)).max(20),
    initialApprovedComment: z.boolean().optional(),
    customerRole: z.boolean(),
    databaseAccess: z.enum(["read-only", "none"]).default("read-only"),
    translatePress: z
      .strictObject({
        administratorSecondaryLocale: z.string().regex(/^[a-z]{2}_[A-Z]{2}$/),
      })
      .optional(),
    scenarioId: z.string().optional(),
  }),
};
const singleTrialStop = z
  .strictObject({ maxRuns: z.literal(1), noFindingRuns: z.literal(1) })
  .default({ maxRuns: 1, noFindingRuns: 1 });
const comparisonStop = z
  .strictObject({
    maxRuns: z.number().int().positive().max(40),
    noFindingRuns: z.number().int().positive(),
  })
  .default({ maxRuns: 1, noFindingRuns: 1 });
const assignment = z.strictObject({
  unit: z.literal("entry-point"),
  entriesPerRun: z.number().int().min(1).max(64).default(8),
});
const campaignModes = z.discriminatedUnion("mode", [
  z.strictObject({
    ...commonCampaignFields,
    mode: z.literal("wp2shell"),
    runWallTimeMinutes: z.number().positive().max(60).default(60),
    promptId: z
      .enum([
        "wp2shell-bounty-v2",
        "wp2shell-bounty-v3",
        "wp2shell-whitebox-v1.7",
      ])
      .default("wp2shell-bounty-v3"),
    stopRules: singleTrialStop,
    entryIndex: z.literal(true).default(true),
  }),
  z.strictObject({
    ...commonCampaignFields,
    mode: z.literal("entry-index-control"),
    runWallTimeMinutes: z.number().positive().max(60).default(60),
    promptId: z
      .enum([
        "wp2shell-bounty-v2",
        "wp2shell-bounty-v3",
        "wp2shell-whitebox-v1.7",
      ])
      .default("wp2shell-bounty-v3"),
    stopRules: singleTrialStop,
    entryIndex: z.literal(false),
  }),
  z.strictObject({
    ...commonCampaignFields,
    mode: z.literal("comparison"),
    promptId: runnablePrompt,
    stopRules: comparisonStop,
    entryIndex: z.boolean().default(true),
  }),
  z.strictObject({
    ...commonCampaignFields,
    mode: z.literal("ablation"),
    promptId: runnablePrompt.default("wp2shell-bounty-v3"),
    stopRules: comparisonStop,
    entryIndex: z.boolean().default(true),
    ablation,
  }),
  z.strictObject({
    ...commonCampaignFields,
    mode: z.literal("assignment"),
    promptId: runnablePrompt.default("wp2shell-bounty-v3"),
    stopRules: comparisonStop,
    entryIndex: z.literal(true).default(true),
    assignment,
  }),
]);
export const wordpressCampaignConfigSchema = z
  .preprocess((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return value;
    const config = value as Record<string, unknown>;
    if (config.mode !== undefined) return value;
    const mode =
      config.assignment !== undefined
        ? "assignment"
        : config.ablation !== undefined
          ? "ablation"
          : config.promptId !== undefined &&
              config.promptId !== "wp2shell-bounty-v2" &&
              config.promptId !== "wp2shell-bounty-v3" &&
              config.promptId !== "wp2shell-whitebox-v1.7"
            ? "comparison"
            : config.entryIndex === false
              ? "entry-index-control"
              : "wp2shell";
    return { ...config, mode };
  }, campaignModes)
  .superRefine((config, context) => {
    if (
      config.lab.initialApprovedComment === true &&
      config.lab.initialPosts.length === 0
    )
      context.addIssue({
        code: "custom",
        path: ["lab", "initialApprovedComment"],
        message: "An approved comment requires an initial post",
      });
    if (
      config.lab.scenarioId !== undefined &&
      wordPressScenario(config.lab.scenarioId) === undefined
    )
      context.addIssue({
        code: "custom",
        path: ["lab", "scenarioId"],
        message: "Unknown WordPress Lab scenario",
      });
    const axes = config.mode === "ablation" ? config.ablation.axes : [];
    if (new Set(axes.map((axis) => axis.axis)).size !== axes.length)
      context.addIssue({
        code: "custom",
        path: ["ablation", "axes"],
        message: "Ablation axes must be distinct",
      });
  });
export type WordPressCampaignConfig = z.infer<
  typeof wordpressCampaignConfigSchema
>;

/** System-boundary adapters: WordPress.org, Docker/runsc and the provider CLI. */
export interface WordPressCampaignBoundaries {
  readonly selection: WordPressSelectionWithBatchInspection;
  readonly freeze: (target: WordPressTargetSelection) => Promise<Snapshot>;
  readonly loadSnapshot: (digest: string) => Promise<Snapshot>;
  readonly lab: WordPressLab;
  readonly sourceFor: (snapshot: Snapshot) => Promise<{
    readonly directory: string;
    readonly tree: ExpectedSourceTree;
    readonly dependency?: {
      readonly directory: string;
      readonly tree: ExpectedSourceTree;
    };
  }>;
  readonly runtimeProfile: AgentRuntimeProfile;
  /** What the pinned Codex image actually ships (GvisorCodexSandbox.probe). */
  readonly probeRuntime: () => Promise<{
    readonly cliVersion: string;
    readonly bundledCatalogDigest: string;
  }>;
  readonly executor: {
    execute(run: DiscoveryTransportRun): Promise<DiscoveryTransportResult>;
  };
  readonly attachments: ProviderAttachmentStore;
  readonly verifier: Verifier<WordPressFinding, WordPressLabHandle>;
}

async function loadConfig(configPath: string): Promise<{
  readonly config: WordPressCampaignConfig;
  readonly policy: WordPressSelectionPolicy;
}> {
  const config = wordpressCampaignConfigSchema.parse(
    JSON.parse(await readFile(configPath, "utf8")) as unknown,
  );
  if (config.resources.memoryBudgetMiB < DISCOVERY_RUN_MEMORY_MIB)
    throw new Error(
      `The memory budget is below one discovery run (${DISCOVERY_RUN_MEMORY_MIB} MiB)`,
    );
  const policy =
    config.selectionPolicyPath === undefined
      ? await loadWordPressSelectionPolicy()
      : wordPressSelectionPolicySchema.parse(
          JSON.parse(
            await readFile(config.selectionPolicyPath, "utf8"),
          ) as unknown,
        );
  return { config, policy };
}

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
    return {
      policy: directPolicy.data,
      wordpressVersion: directPolicy.data.wordpressVersion,
    };
  }
  const { config, policy } = await loadConfig(configPath);
  if (
    "wordpressVersion" in policy &&
    policy.wordpressVersion !== config.wordpressVersion
  )
    throw new Error("Selection and campaign WordPress versions differ");
  if ("candidateSource" in policy && policy.promptVariant !== config.promptId)
    throw new Error("Selection and campaign prompt variants differ");
  return { config, policy, wordpressVersion: config.wordpressVersion };
}

type ReservedSelection = {
  readonly target: WordPressTargetSelection;
  readonly snapshotDigest: string;
};

type ReservedSelectionBatch = {
  readonly id: string;
  readonly reportDigest: string;
  readonly selections: readonly ReservedSelection[];
};

/** The most recent complete batch with this exact policy feeds campaign run. */
async function reservedSelectionBatch(
  state: CliState,
  policy: WordPressSelectionPolicy,
  selectionBatchId?: string,
): Promise<ReservedSelectionBatch> {
  const all: ReturnType<CliState["ledger"]["read"]>[number][] = [];
  let afterSequence = 0;
  for (;;) {
    const page = state.ledger.read({
      type: "target-selected",
      afterSequence,
      limit: 1000,
    });
    all.push(...page);
    if (page.length < 1000) break;
    afterSequence = page.at(-1)!.sequence;
  }
  const batches = new Map<string, typeof all>();
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
        `${target.targetId}@${target.version}` !== event.selectionId
      )
        throw new Error("Reserved target selection does not match the ledger");
      result.push({ target, snapshotDigest: event.snapshotDigest });
    }
    return {
      id: batch[0]!.event.campaignId,
      reportDigest: reportRef.digest,
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
  expected?: {
    readonly selectionBatchId: string;
    readonly snapshotDigests: readonly string[];
  },
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
  if (
    binding !== undefined &&
    expected !== undefined &&
    binding.selectionBatchId !== expected.selectionBatchId
  )
    throw new Error("Campaign selection batch differs from its requested pin");
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
    binding?.selectionBatchId ?? expected?.selectionBatchId,
  );
  if (
    expected !== undefined &&
    canonicalJson(
      batch.selections.map(({ snapshotDigest }) => snapshotDigest),
    ) !== canonicalJson(expected.snapshotDigests)
  )
    throw new Error("Reserved selection Snapshots differ from requested pin");
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
  const selectionIds = selected.map(
    ({ target }) => `${target.targetId}@${target.version}`,
  );
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

const setupFor =
  (config: WordPressCampaignConfig) =>
  (snapshot: Snapshot): WordPressLabSetup => {
    const { scenarioId, ...lab } = config.lab;
    const scenario =
      scenarioId === undefined ? undefined : wordPressScenario(scenarioId);
    return {
      schemaVersion: 1,
      snapshotDigest: snapshot.digest,
      ...lab,
      ...(scenario === undefined
        ? {}
        : { scenario: { id: scenario.id, digest: scenario.digest } }),
    };
  };

const reconstructionFor =
  (config: WordPressCampaignConfig) =>
  (snapshot: Snapshot): WordPressReconstruction => ({
    wordpressVersion: config.wordpressVersion,
    target: snapshot.target,
    enabledSettings: [
      ...(config.lab.translatePress === undefined &&
      config.lab.scenarioId !== "translatepress-translation-data-v1"
        ? []
        : [
            `TranslatePress publishes ${config.lab.translatePress?.administratorSecondaryLocale ?? "fr_FR"} as a secondary language`,
            `The administrator uses ${config.lab.translatePress?.administratorSecondaryLocale ?? "fr_FR"} as profile locale`,
          ]),
      ...(config.lab.scenarioId === "translatepress-translation-data-v1"
        ? ["TranslatePress has one ordinary reviewed translation"]
        : []),
      ...(config.lab.initialApprovedComment === true ||
      config.lab.scenarioId === "approved-comment-v1" ||
      config.lab.scenarioId === "translatepress-translation-data-v1"
        ? ["The first published post has one approved comment"]
        : []),
    ],
    roles: [
      "unauthenticated",
      "subscriber",
      ...(config.lab.customerRole ? ["customer"] : []),
    ],
  });

function verificationFor(
  state: CliState,
  boundaries: WordPressCampaignBoundaries,
  verifier: Verifier<
    WordPressFinding,
    WordPressLabHandle
  > = boundaries.verifier,
) {
  return new Verification<
    WordPressFinding,
    WordPressLabSetup,
    WordPressLabHandle,
    WordPressReconstruction
  >({
    ledger: state.ledger,
    store: state.store,
    lab: boundaries.lab,
    verifier,
    judges: createWordPressJudges({ store: state.store, lab: boundaries.lab }),
    readFinding: readWordPressFinding,
    renderer: wordpressReproductionRenderer,
    promptVersion: WORDPRESS_VERIFIER_PROMPT_ID,
    // Whole-site before / after diff around the Verifier run; review material, not proof (#186).
    stateObserver: createWordPressLabStateObserver({
      store: state.store,
      lab: boundaries.lab,
    }),
    clock: state.clock,
  });
}

/** The one Lab `lab up` keeps between invocations; `lab down` reads and removes it. */
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

async function wordPressLabUp(
  state: CliState,
  input: Parameters<CliProfile["labUp"]>[1],
  options: WordPressCliProfileOptions,
): Promise<LabUpSummary> {
  if ((await readLabUpRecord(state)) !== null)
    throw new Error("A lab is already up; run lab down first");
  const { config } = await loadConfig(input.configPath);
  const boundaries = await options.boundaries(config, state);
  const lab = await provisionFindingLab({
    campaignId: input.campaignId,
    findingId: input.findingId,
    ledger: state.ledger,
    store: state.store,
    pipeline: {
      freeze: boundaries.freeze,
      setupFor: setupFor(config),
      lab: boundaries.lab,
    },
    readTarget: (value) => wordPressTargetSelectionSchema.parse(value),
  });
  const handle = lab.handle;
  const exposed = await boundaries.lab.exposeToHost(handle, {
    httpPort: input.httpPort,
    ...(handle.database === undefined
      ? {}
      : { databasePort: input.databasePort }),
  });
  if (exposed.status !== "exposed") {
    await boundaries.lab.cleanupLeftovers({ remove: true, labId: handle.id });
    throw new Error(
      `The Lab could not be published on the host: ${exposed.diagnostic}`,
    );
  }
  await writeFile(
    labUpRecordPath(state),
    canonicalJson({
      schemaVersion: 1,
      labId: handle.id,
      campaignId: input.campaignId,
      findingId: input.findingId,
      configPath: input.configPath,
      startedAt: state.clock().toISOString(),
    }),
    { mode: 0o600 },
  );
  return {
    labId: handle.id,
    campaignId: input.campaignId,
    findingId: input.findingId,
    snapshotDigest: lab.snapshot.digest,
    scenario: handle.scenario ?? null,
    setupDigest: handle.setupDigest,
    matchesVerification:
      lab.verification === null
        ? null
        : {
            verificationId: lab.verification.verificationId,
            same: lab.verification.labSetupDigest === handle.setupDigest,
          },
    http: { port: exposed.httpPort, hostHeader: new URL(handle.endpoint).host },
    database:
      handle.database === undefined || exposed.databasePort === null
        ? null
        : {
            port: exposed.databasePort,
            name: handle.database.name,
            username: handle.database.readOnlyAccount.username,
            password: handle.database.readOnlyAccount.password,
          },
    attackerAccounts: Object.entries(handle.attackerAccounts).map(
      ([role, account]) => ({
        role,
        username: account.username,
        password: account.password,
      }),
    ),
  };
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
  const { config } = await loadConfig(input.configPath ?? record.configPath);
  const boundaries = await options.boundaries(config, state);
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

export type WordPressCliProfileOptions = {
  /** Host-common gate; production uses one registry across every --state. */
  readonly repeatTrialGate: RepeatTrialGate;
  /** Host-common claim held from before Lab provision through teardown. */
  readonly resourceClaims?: SqliteHostResourceClaims;
  /** Reserve all providers this target may use, including its verifier. */
  readonly resourceProviderKeys?: readonly string[];
  readonly cleanupScope?: TargetResourceScope;
  readonly onResourceWait?: (reason: string) => void;
  readonly boundaries: (
    config: WordPressCampaignConfig,
    state: CliState,
  ) => Promise<WordPressCampaignBoundaries>;
  /** Selection can inspect and freeze public sources without booting a Lab. */
  readonly selectionBoundaries?: (
    state: CliState,
    wordpressVersion: string,
  ) => Promise<Pick<WordPressCampaignBoundaries, "selection" | "freeze">>;
  readonly scopePolicy: WordpressScopePolicy;
  /** Overrides the scope facts read from judge evidence and the selection record. */
  readonly scopeFacts?: ScopeFactsProvider<WordpressScopeInput>;
  /** Local Wordfence history mirror; absent, duplicate lookup is unavailable. */
  readonly wordfenceHistory?: {
    readonly databasePath: string;
    readonly statePath: string;
  };
};

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
  readonly repeatTrialGate: RepeatTrialGate;
  readonly config: WordPressCampaignConfig;
  readonly boundaries: WordPressCampaignBoundaries;
  readonly state: CliState;
  readonly objective: WordPressDiscoveryAsset;
  readonly trustBoundary: WordPressDiscoveryAsset;
  readonly armBObjective?: WordPressDiscoveryAsset;
  readonly historyFor: (
    config: WordPressCampaignConfig,
    target: WordPressTargetSelection,
  ) => CampaignHistory;
};

async function planWordPressDiscovery(
  { target, snapshot, lab }: WordPressDiscoveryInput,
  context: WordPressDiscoveryContext,
): Promise<WordPressDiscoveryPlan> {
  const {
    config,
    boundaries,
    state,
    objective,
    trustBoundary,
    armBObjective,
    historyFor,
    campaignId,
    repeatTrialGate,
  } = context;
  const wallMinutes = config.runWallTimeMinutes ?? 60;
  const ablationConfig =
    config.mode === "ablation" ? config.ablation : undefined;
  const assignmentConfig =
    config.mode === "assignment" ? config.assignment : undefined;
  const outputContractV1 = wordPressDiscoveryOutputContract();
  const outputContractV2 = wordPressDiscoveryOutputContractV2();
  const outputContractFor = (id: string) =>
    id === "wp2shell-bounty-v3" || id === "wp2shell-whitebox-v1.7"
      ? outputContractV2
      : outputContractV1;
  const objectiveOnly = (id: string) =>
    WORDPRESS_OBJECTIVE_ONLY_PROMPT_IDS.some((entry) => entry === id);
  const source = await boundaries.sourceFor(snapshot);
  // The campaign stop rule decides depth; legacy per-target budgets only lower it (ADR 0032 Q6).
  const maxRuns = Math.min(
    config.stopRules.maxRuns,
    target.runBudget ?? config.stopRules.maxRuns,
  );
  const sourceIndex =
    !config.entryIndex && assignmentConfig === undefined
      ? undefined
      : await buildWordPressSourceIndex(source.directory, target.slug);
  const entryIndexMetadata =
    !config.entryIndex || sourceIndex === undefined
      ? ({ enabled: false } as const)
      : ({ enabled: true, digest: sourceIndex.digest } as const);
  let assignments: readonly WordPressEntryAssignment[] = [];
  if (assignmentConfig !== undefined) {
    if (sourceIndex === undefined)
      throw new Error("Source index is unavailable");
    assignments = planWordPressEntryAssignments(
      sourceIndex,
      assignmentConfig.entriesPerRun,
    );
  }
  if (assignmentConfig !== undefined && assignments.length === 0)
    throw new Error(
      "Entry-point assignment found no registrations in the source",
    );
  const stopRules = {
    maxRuns,
    noFindingRuns: Math.min(
      Math.max(config.stopRules.noFindingRuns, assignments.length),
      maxRuns,
    ),
  };
  const accounts = Object.entries(lab.attackerAccounts).map(
    ([role, account]) =>
      `- ${role}: ${account.username} / ${account.password} (Lab only)`,
  );
  // Only low-privilege Lab accounts exist on the handle; nothing else is offered.
  const promptFor = (
    assignment: WordPressEntryAssignment | undefined,
    selectedObjective: typeof objective,
  ) =>
    [
      selectedObjective.text.trim(),
      ...(objectiveOnly(selectedObjective.id)
        ? [outputContractFor(selectedObjective.id).text]
        : []),
      "## Trust boundary",
      trustBoundary.text.trim(),
      `## Programme Boundary (${config.programmeBoundary.version})`,
      config.programmeBoundary.text.trim(),
      "## Lab",
      `Endpoint: ${lab.endpoint}`,
      ...accounts,
      ...(lab.database === undefined
        ? ["Database: not exposed to this run."]
        : [
            `Database (read-only, Lab only): host ${lab.database.host} port ${lab.database.port} database ${lab.database.name} user ${lab.database.readOnlyAccount.username} / ${lab.database.readOnlyAccount.password}`,
          ]),
      ...(source.dependency === undefined
        ? []
        : [
            "WordPress core source (read-only): /workspace/wordpress, the same version the Lab runs.",
          ]),
      ...(objectiveOnly(selectedObjective.id)
        ? ["Writable notes directory: /workspace/research."]
        : []),
      ...(assignment === undefined
        ? ["## Assigned files", "All files under /workspace/main."]
        : [
            renderWordPressEntryAssignment(
              assignment,
              source.dependency !== undefined,
            ),
          ]),
      ...(config.entryIndex && sourceIndex !== undefined
        ? [renderWordPressEntryIndex(sourceIndex)]
        : []),
    ].join("\n\n");
  const assignmentMetadata = (assignment: WordPressEntryAssignment) => {
    if (
      assignment.indexDigest === undefined ||
      assignment.componentIds === undefined
    )
      throw new Error("Indexed assignment metadata is missing");
    return {
      partition: assignment.partition,
      of: assignment.of,
      planDigest: assignment.planDigest,
      indexDigest: assignment.indexDigest,
      componentDigest: canonicalDigest(assignment.componentIds),
    };
  };
  const now = state.clock().getTime();
  return {
    beforeTrialStart: ({ snapshotDigest, promptDigest, trialOrdinal }) =>
      repeatTrialGate.reserve({
        stateDirectory: state.stateDirectory,
        slug: target.slug,
        snapshotDigest,
        promptDigest,
        campaignId,
        trialOrdinal,
      }),
    input: {
      schemaVersion: 1,
      snapshotDigest: snapshot.digest,
      trustBoundary: {
        version: trustBoundary.id,
        text: trustBoundary.text,
      },
      programmeBoundary: config.programmeBoundary,
      modelProfileDigest: boundaries.runtimeProfile.digest,
      promptDigest: objective.digest,
      stopRules,
      lab: { setupDigest: lab.setupDigest },
      history: historyFor(config, target),
      entryIndex: entryIndexMetadata,
    },
    historyFraction:
      ablationConfig?.axes.find((axis) => axis.axis === "history")
        ?.armBFraction ?? 0,
    runWallTimeMs: wallMinutes * 60_000,
    // A comparison may plan several independent Trials on one slug. Its next
    // approval is decided after the previous Trial, so those run serially.
    concurrency:
      maxRuns > 1
        ? 1
        : Math.min(
            config.resources.maxConcurrentRuns,
            Math.floor(
              config.resources.memoryBudgetMiB /
                (boundaries.runtimeProfile.subagent.modelId === "unavailable"
                  ? DISCOVERY_RUN_MEMORY_MIB
                  : CODEX_COOPERATIVE_SANDBOX_MEMORY_MIB +
                    EGRESS_BROKER_MEMORY_MIB),
            ),
          ),
    ...(ablationConfig === undefined
      ? {}
      : { ablation: { axes: ablationConfig.axes } }),
    plannedTrials: Array.from({ length: maxRuns }, (_, trialOrdinal) => {
      const trialId = state.newId();
      const arms = allocateTrialArms(trialOrdinal, ablationConfig?.axes ?? []);
      const selectedObjective =
        arms.prompt === "b" && armBObjective !== undefined
          ? armBObjective
          : objective;
      const assignment =
        assignments.length === 0
          ? undefined
          : assignments[trialOrdinal % assignments.length]!;
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
          assignmentUnit: assignment === undefined ? "plugin" : "entry-point",
          entryIndex: entryIndexMetadata,
          ...(assignment === undefined
            ? {}
            : { assignment: assignmentMetadata(assignment) }),
          labAccess: {
            database: lab.database === undefined ? "none" : "read-only",
          },
        },
        run: {
          runId: trialId,
          targetSnapshotDigest: snapshot.digest,
          profile: boundaries.runtimeProfile,
          coordination: "cooperative" as const,
          prompt: promptFor(assignment, selectedObjective),
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
          sourceDirectory: source.directory,
          sourceTree: source.tree,
          ...(source.dependency === undefined
            ? {}
            : { dependencySource: source.dependency }),
          expiresAt: new Date(now + wallMinutes * 60_000).toISOString(),
        },
      };
      return {
        trialId,
        trialOrdinal,
        explore,
      };
    }),
    executor: boundaries.executor,
    attachments: boundaries.attachments,
    admitFinding: admitWordPressFinding,
    isProgrammeImpact: isWordPressProgrammeImpact,
    normalizeCandidate: normalizeWordPressCandidate,
    classifyCandidate: classifyWordPressCandidate,
    admitLead: admitWordPressLead,
    leadSignature: (lead: AdmittedLead) =>
      wordPressLeadSignature(readWordPressLead(lead)),
  };
}

async function runWordPressCampaign(
  state: CliState,
  input: Parameters<CliProfile["runCampaign"]>[1],
  options: WordPressCliProfileOptions,
  historyFor: (
    config: WordPressCampaignConfig,
    target: WordPressTargetSelection,
  ) => CampaignHistory,
): ReturnType<CliProfile["runCampaign"]> {
  options.repeatTrialGate.ensureReady(state.stateDirectory);
  const { config, policy } = await loadConfig(input.configPath);
  if (
    "wordpressVersion" in policy &&
    policy.wordpressVersion !== config.wordpressVersion
  )
    throw new Error("Selection and campaign WordPress versions differ");
  if ("candidateSource" in policy && policy.promptVariant !== config.promptId)
    throw new Error("Selection and campaign prompt variants differ");
  if (
    (input.selectionBatchId === undefined) !==
    (input.snapshotDigests === undefined)
  )
    throw new Error("Selection batch pin requires both ID and Snapshots");
  if (
    input.selectionBatchId !== undefined &&
    (!("candidateSource" in policy) ||
      input.snapshotDigests === undefined ||
      input.snapshotDigests.length === 0 ||
      input.snapshotDigests.some(
        (digest) => !/^sha256:[a-f0-9]{64}$/.test(digest),
      ))
  )
    throw new Error("Invalid reserved selection batch pin");
  const requestedBatch =
    input.selectionBatchId === undefined || input.snapshotDigests === undefined
      ? undefined
      : {
          selectionBatchId: input.selectionBatchId,
          snapshotDigests: input.snapshotDigests,
        };
  const reservedSelections =
    "candidateSource" in policy
      ? await bindCampaignSelectionBatch(
          state,
          policy,
          input.campaignId,
          input.target,
          requestedBatch,
        )
      : undefined;
  const reservedDigests = new Map(
    reservedSelections?.map(({ target, snapshotDigest }) => [
      `${target.targetId}@${target.version}`,
      snapshotDigest,
    ]) ?? [],
  );
  const ablationConfig =
    config.mode === "ablation" ? config.ablation : undefined;
  const boundaries = await options.boundaries(config, state);
  const [objective, trustBoundary] = await Promise.all([
    loadWordPressDiscoveryAsset(config.promptId),
    loadWordPressDiscoveryAsset("trust-boundary-v1"),
  ]);
  const promptAxis = ablationConfig?.axes.find(
    (axis) => axis.axis === "prompt",
  );
  const armBObjective =
    promptAxis?.axis === "prompt"
      ? await loadWordPressDiscoveryAsset(promptAxis.armBPromptId)
      : undefined;
  return runCampaignPipeline({
    campaignId: input.campaignId,
    maxConcurrentTargets: config.resources.maxConcurrentTargets,
    ...(input.stopSignal === undefined ? {} : { stopSignal: input.stopSignal }),
    ...(input.retryIncompleteVerifications === undefined
      ? {}
      : {
          retryIncompleteVerifications: input.retryIncompleteVerifications,
        }),
    ledger: state.ledger,
    store: state.store,
    clock: state.clock,
    newId: state.newId,
    ...(options.cleanupScope === undefined
      ? {}
      : {
          withTargetScope: <T>(operation: () => Promise<T>) =>
            options.cleanupScope!.run(operation),
        }),
    beforeLab: async ({ target, snapshot, signal }) => {
      signal.throwIfAborted();
      const assertPendingTrial = () => {
        let concluded = false;
        let conclusionAfter = 0;
        for (;;) {
          const page = state.ledger.read({
            campaignId: input.campaignId,
            type: "discovery-concluded",
            afterSequence: conclusionAfter,
            limit: 1000,
          });
          if (
            page.some(({ event }) => event.snapshotDigest === snapshot.digest)
          ) {
            concluded = true;
            break;
          }
          if (page.length < 1000) break;
          conclusionAfter = page.at(-1)!.sequence;
        }
        if (concluded) return;
        let afterSequence = 0;
        let spent = 0;
        for (;;) {
          const page = state.ledger.read({
            campaignId: input.campaignId,
            type: "discovery-run-started",
            afterSequence,
            limit: 1000,
          });
          spent += page.filter(
            ({ event }) =>
              event.type === "discovery-run-started" &&
              event.snapshotDigest === snapshot.digest &&
              (event.runKind ?? "explore") === "explore",
          ).length;
          if (page.length < 1000) break;
          afterSequence = page.at(-1)!.sequence;
        }
        const maxRuns = Math.min(
          config.stopRules.maxRuns,
          target.runBudget ?? config.stopRules.maxRuns,
        );
        if (spent >= maxRuns) return;
        const arms = allocateTrialArms(spent, ablationConfig?.axes ?? []);
        const selectedObjective =
          arms.prompt === "b" && armBObjective !== undefined
            ? armBObjective
            : objective;
        options.repeatTrialGate.assertMayStart({
          stateDirectory: state.stateDirectory,
          slug: target.slug,
          snapshotDigest: snapshot.digest,
          promptDigest: selectedObjective.digest,
          campaignId: input.campaignId,
          trialOrdinal: spent,
        });
      };
      assertPendingTrial();
      if (options.resourceClaims === undefined) return;
      let previousWait = "";
      const handle = await options.resourceClaims.waitForClaim(
        {
          targetKey: `wordpress:plugin:${target.slug}`,
          ownerKey: `run:${state.newId()}`,
          ownerPid: process.pid,
          stateDirectory: state.stateDirectory,
          campaignId: input.campaignId,
          snapshotDigest: snapshot.digest,
          providerKeys: [...(options.resourceProviderKeys ?? ["codex"])],
          leaseDurationMs: 3 * 60 * 60_000,
        },
        {
          signal,
          onWait: (waiting) => {
            const reason =
              waiting.reason === "provider-capacity"
                ? `${waiting.reason}:${waiting.providerKey}`
                : waiting.reason;
            if (reason !== previousWait) options.onResourceWait?.(reason);
            previousWait = reason;
          },
        },
      );
      try {
        // A different process may have started a Trial while this one waited.
        assertPendingTrial();
      } catch (error) {
        options.resourceClaims.release(handle);
        throw error;
      }
      return {
        finish: (status: "clean" | "recovery-needed") => {
          const finalStatus =
            status === "recovery-needed" ||
            options.cleanupScope?.isCleanupUncertain() === true
              ? "recovery-needed"
              : "clean";
          if (finalStatus === "clean") options.resourceClaims!.release(handle);
          else options.resourceClaims!.requireRecovery(handle);
          return finalStatus;
        },
      };
    },
    pipeline: {
      select: async () =>
        (reservedSelections === undefined
          ? await boundaries.selection.select(policy)
          : reservedSelections.map(({ target }) => target)
        ).filter(
          (target) =>
            reservedSelections !== undefined ||
            input.target === null ||
            target.slug === input.target,
        ),
      freeze: async (target) => {
        const snapshot = await boundaries.freeze(target);
        const reservedDigest = reservedDigests.get(
          `${target.targetId}@${target.version}`,
        );
        if (
          reservedSelections !== undefined &&
          snapshot.digest !== reservedDigest
        )
          throw new Error("Reserved selection Snapshot changed");
        return snapshot;
      },
      lab: boundaries.lab,
      setupFor: setupFor(config),
      discovery: (discoveryInput) =>
        planWordPressDiscovery(discoveryInput, {
          config,
          boundaries,
          state,
          campaignId: input.campaignId,
          repeatTrialGate: options.repeatTrialGate,
          objective,
          trustBoundary,
          ...(armBObjective === undefined ? {} : { armBObjective }),
          historyFor,
        }),
      verification: verificationFor(state, boundaries),
      reconstructionFor: reconstructionFor(config),
    },
  });
}

export function createWordPressCliProfile(
  options: WordPressCliProfileOptions,
): CliProfile {
  /** Public records before the stable version's release; none when the cutoff or mirror is missing. */
  const historyFor = (
    config: WordPressCampaignConfig,
    target: WordPressTargetSelection,
  ): CampaignHistory => {
    if (
      config.mode !== "ablation" ||
      !config.ablation.axes.some((axis) => axis.axis === "history") ||
      options.wordfenceHistory === undefined ||
      target.versionPublishedAt === undefined
    )
      return { mode: "none" };
    const extracted = extractCampaignHistory(
      target.slug,
      target.versionPublishedAt,
      options.wordfenceHistory,
    );
    return extracted.status === "ready" ? extracted.history : { mode: "none" };
  };
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
    answerKeys: parseWordPressAnswerKeys,
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
    advisories: parseWordPressAdvisories,
    locationsOf: wordpressFindingLocations,
    async collectInventory(state, input) {
      const { policy, wordpressVersion } = await loadSelectInput(
        input.configPath,
      );
      if (!("candidateSource" in policy))
        throw new Error("Candidate inventory requires automatic selection");
      if (options.selectionBoundaries === undefined)
        throw new Error("Candidate inventory requires selection boundaries");
      const boundaries = await options.selectionBoundaries(
        state,
        wordpressVersion,
      );
      const inspectBatch = boundaries.selection.inspectBatch;
      if (inspectBatch === undefined)
        throw new Error("Candidate inventory requires listing observations");
      const cursor =
        input.afterDigest === undefined
          ? undefined
          : await readWordPressCandidateInventoryCursor({
              digest: input.afterDigest,
              policy,
              store: state.store,
              clock: state.clock,
            });
      const { digest, inventory } = await collectWordPressCandidateInventory({
        policy,
        inspectBatch: (value, after, pool) => inspectBatch(value, after, pool),
        ...(cursor === undefined ? {} : { cursor }),
        ...(input.afterDigest === undefined
          ? {}
          : { previousInventoryDigest: input.afterDigest }),
        store: state.store,
        clock: state.clock,
      });
      if (
        cursor !== undefined &&
        inventory.source.pool?.digest !== cursor.sourcePoolDigest
      )
        throw new Error("Candidate inventory changed source pool");
      const traversal = inventory.source.traversal;
      if (traversal === undefined)
        throw new Error("Candidate inventory has no traversal record");
      return {
        inventoryDigest: digest,
        candidates: inventory.candidates.length,
        observedCandidates: inventory.observedCandidates,
        sourceCoverageVerified:
          await hasVerifiedWordPressCandidateInventoryChainCoverage({
            digest,
            policy,
            store: state.store,
            clock: state.clock,
          }),
        ineligibleByReason: inventory.ineligibleByReason,
        source: {
          status: inventory.source.status,
          requestedListingCoverage: inventory.source.requestedListingCoverage,
        },
        traversal: {
          offset: traversal.offset,
          observedUniqueCandidates: traversal.observedUniqueCandidates,
          complete: traversal.complete,
          nextPageAvailable: traversal.nextCursor !== undefined,
        },
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
      if (
        "candidateSource" in policy &&
        boundaries.selection.inspectBatch === undefined
      )
        throw new Error("Automatic selection requires listing observations");
      const inspectedBatch = await boundaries.selection.inspectBatch?.(policy);
      const inspected: readonly WordPressSelectionInspection[] =
        inspectedBatch?.inspections ??
        (await boundaries.selection.inspect(policy));
      const inspectionBySlug = new Map(
        inspected.map((item) => [item.slug, item]),
      );
      const eligible = inspected.flatMap((item) =>
        item.selection === undefined ? [] : [item.selection],
      );
      const excludedByLedger = inspectWordPressLedgerExclusions({
        ledger: state.ledger,
        candidates: eligible.map(({ slug, version }) => ({ slug, version })),
        currentPromptVariant:
          policy.promptVariant ?? config?.promptId ?? "wp2shell-bounty-v3",
        revisitPolicy: policy.revisitPolicy ?? { kind: "never" },
      });
      const ledgerReasons = new Map(
        excludedByLedger.map(({ slug, reasons }) => [slug, reasons]),
      );
      const reasons = new Map<string, string[]>(
        inspected.map((item) => [
          item.slug,
          [...item.reasons, ...(ledgerReasons.get(item.slug) ?? [])],
        ]),
      );
      const rankable = eligible
        .filter((target) => (reasons.get(target.slug) ?? []).length === 0)
        .sort(
          (left, right) =>
            right.score - left.score || left.slug.localeCompare(right.slug),
        );
      const chosen: { target: WordPressTargetSelection; snapshot: Snapshot }[] =
        [];
      for (const target of rankable) {
        if (chosen.length >= policy.maximumTargets) {
          reasons.get(target.slug)?.push("below-rank-cutoff");
          continue;
        }
        try {
          chosen.push({ target, snapshot: await boundaries.freeze(target) });
        } catch {
          reasons.get(target.slug)?.push("snapshot-unavailable");
        }
      }
      const report = {
        schemaVersion: 1,
        policyDigest: canonicalDigest(policy),
        inspectedAt: state.clock().toISOString(),
        sourceStatus: inspectedBatch?.sourceStatus ?? "manual",
        sourceListings: inspectedBatch?.sourceListings ?? [],
        inspections: inspected.map((item) => ({
          ...item,
          reasons: reasons.get(item.slug) ?? [],
        })),
        selectedSnapshotDigests: chosen.map(({ snapshot }) => snapshot.digest),
      };
      const reportDigest = await state.store.putFiles({
        "selection-report.json": canonicalJson(report),
      });
      if ("candidateSource" in policy && chosen.length < 3)
        throw new Error(
          `Selection found ${chosen.length} eligible frozen targets; at least 3 are required (report ${reportDigest})`,
        );
      const batchId = chosen.length === 0 ? null : `selection-${state.newId()}`;
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
          selectionId: `${target.targetId}@${target.version}`,
          promptVariant:
            policy.promptVariant ?? config?.promptId ?? "wp2shell-bounty-v3",
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
        selected: chosen.map(({ target }) => ({
          targetId: target.targetId,
          version: target.version,
          score: target.score,
          scoreBreakdown: target.scoreBreakdown,
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
            targetId: `wporg:${item.slug}`,
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
    runCampaign: (state, input) =>
      runWordPressCampaign(state, input, options, historyFor),
    stateDiffReader: (state) =>
      createWordPressStateDiffReader({ store: state.store }),
    labUp: (state, input) => wordPressLabUp(state, input, options),
    labDown: (state, input) => wordPressLabDown(state, input, options),
    async cleanupLeftovers(state, input) {
      const { config } = await loadConfig(input.configPath);
      const boundaries = await options.boundaries(config, state);
      return boundaries.lab.cleanupLeftovers({
        remove: input.remove,
        patterns: DISCOVERY_LEFTOVER_PATTERNS,
      });
    },
    async checkRuntime(state, input) {
      const { config } = await loadConfig(input.configPath);
      const boundaries = await options.boundaries(config, state);
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
      const { config, policy } = await loadConfig(input.configPath);
      const boundaries = await options.boundaries(config, state);
      const verifier =
        input.smokeReplayDigest === undefined
          ? boundaries.verifier
          : new SmokeReplayVerifier({
              lab: boundaries.lab,
              store: state.store,
              recipeDigest: input.smokeReplayDigest,
            });
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
          async selectVersion({ selectionId, version }) {
            const slug = /^wporg:([a-z0-9][a-z0-9-]*)@/.exec(selectionId)?.[1];
            if (slug === undefined) return null;
            // Rechecking a known Finding does not need the candidate batch's
            // history ranking.
            const reverifyPolicy =
              "candidateSource" in policy
                ? (({ candidateSource: _candidateSource, ...rest }) => rest)(
                    policy,
                  )
                : (({
                    historySignals: _historySignals,
                    historySource: _historySource,
                    ...rest
                  }) => rest)(policy);
            const selected = await boundaries.selection.select({
              ...reverifyPolicy,
              candidateSlugs: [slug],
              pinnedVersions: version === undefined ? {} : { [slug]: version },
              maximumTargets: 1,
            });
            const target = selected[0] ?? null;
            if (version !== undefined && target?.version !== version)
              throw new Error("Pinned verification version mismatch");
            return target;
          },
          freeze: boundaries.freeze,
          loadSnapshot: boundaries.loadSnapshot,
          setupFor: setupFor(config),
          verification: verificationFor(state, boundaries, verifier),
          reconstructionFor: reconstructionFor(config),
        },
      });
    },
  };
}
