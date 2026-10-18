import { readFile } from "node:fs/promises";

import { z } from "zod";

import {
  CODEX_COOPERATIVE_SANDBOX_MEMORY_MIB,
  EGRESS_BROKER_MEMORY_MIB,
} from "../discovery/index.js";
import type {
  AgentRuntimeProfile,
  DiscoveryTransportResult,
  DiscoveryTransportRun,
  ProviderAttachmentStore,
} from "../discovery/index.js";
import type { ExpectedSourceTree } from "../infrastructure/canonical-source-tree.js";
import type { ScopeFactsProvider } from "../review/index.js";
import type { Snapshot } from "../snapshot/index.js";
import { Verification, type Verifier } from "../verification/index.js";
import {
  readWordPressFinding,
  type WordPressFinding,
} from "../profiles/wordpress/discovery/finding.js";
import type {
  WordPressLab,
  WordPressLabHandle,
  WordPressLabSetup,
} from "../profiles/wordpress/lab/index.js";
import { wordPressScenario } from "../profiles/wordpress/lab/scenarios.js";
import {
  WORDPRESS_CURRENT_DISCOVERY_PROMPT_ID,
  WORDPRESS_VERIFIER_PROMPT_ID,
} from "../profiles/wordpress/prompts/index.js";
import type {
  WordpressScopeInput,
  WordpressScopePolicy,
} from "../profiles/wordpress/scope-policy.js";
import {
  loadWordPressSelectionPolicy,
  wordPressSelectionPolicySchema,
  type WordPressCandidateInspection,
  type WordPressSelectionPolicy,
  type WordPressTargetSelection,
} from "../profiles/wordpress/selection/index.js";
import { WBH_VERIFY_SKILL_ID } from "../profiles/wordpress/verification/handoff-verifier.js";
import { createWordPressJudges } from "../profiles/wordpress/verification/judges.js";
import { createWordPressLabStateObserver } from "../profiles/wordpress/verification/lab-state-diff.js";
import {
  wordpressReproductionRenderer,
  type WordPressReconstruction,
} from "../profiles/wordpress/verification/reproduction-package.js";
import type { CliState } from "./index.js";

const text = z.strictObject({
  version: z.string().min(1).max(64),
  text: z.string().min(1).max(16_384),
});

/** One discovery run holds a Codex sandbox and its own egress broker. */
export const DISCOVERY_RUN_MEMORY_MIB =
  CODEX_COOPERATIVE_SANDBOX_MEMORY_MIB + EGRESS_BROKER_MEMORY_MIB;

const runnablePrompt = z.literal(WORDPRESS_CURRENT_DISCOVERY_PROMPT_ID);

/** Human-edited, Git-tracked run configuration. It carries no credentials or keys. */
const commonCampaignFields = {
  schemaVersion: z.literal(1),
  discovery: z
    .strictObject({ lab: z.enum(["attached", "none"]) })
    .default({ lab: "none" }),
  selectionPolicyPath: z.string().min(1).optional(),
  programmeBoundary: text,
  runWallTimeMinutes: z.number().positive().max(120).default(120),
  /** Host bounds: targets, per-target discovery runs and their memory budget. */
  resources: z
    .strictObject({
      maxConcurrentRuns: z.number().int().min(1).max(4).default(1),
      maxConcurrentTargets: z.number().int().min(1).max(4).default(1),
      memoryBudgetMiB: z.number().int().positive(),
    })
    .default({
      maxConcurrentRuns: 1,
      maxConcurrentTargets: 1,
      memoryBudgetMiB: DISCOVERY_RUN_MEMORY_MIB,
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
export const wordpressCampaignConfigSchema = z
  .strictObject({
    ...commonCampaignFields,
    mode: z.literal("wp2shell").default("wp2shell"),
    runWallTimeMinutes: z.number().gt(60).max(120).default(120),
    promptId: runnablePrompt.default(WORDPRESS_CURRENT_DISCOVERY_PROMPT_ID),
    stopRules: singleTrialStop,
  })
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
  });
export type WordPressCampaignConfig = z.infer<
  typeof wordpressCampaignConfigSchema
>;

/** System-boundary adapters: WordPress.org, Docker/runsc and the provider CLI. */
export interface WordPressCampaignBoundaries {
  readonly selection: WordPressCandidateInspection;
  readonly freeze: (target: WordPressTargetSelection) => Promise<Snapshot>;
  readonly loadSnapshot: (digest: string) => Promise<Snapshot>;
  readonly lab: WordPressLab;
  readonly sourceFor: (snapshot: Snapshot) => Promise<{
    readonly directory: string;
    readonly tree: ExpectedSourceTree;
    readonly dependency?: {
      readonly path: string;
      readonly directory: string;
      readonly tree: ExpectedSourceTree;
    };
    readonly dependencySources?: readonly {
      readonly path: string;
      readonly directory: string;
      readonly tree: ExpectedSourceTree;
    }[];
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
  /** `verify next --handoff`: a Verifier that hands the Lab to a skill on the host (#352). */
  readonly handoffVerifier?: (
    handoff: VerifierHandoff,
  ) => Verifier<WordPressFinding, WordPressLabHandle>;
}

/** Where `verify next --handoff` exchanges files with the skill, and the host ports it uses. */
export type VerifierHandoff = {
  readonly directory: string;
  readonly httpPort: number;
  readonly databasePort: number;
};

export type WordPressCliProfileOptions = {
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
  /** Git-outside legacy history JSON, read on every selection (D2). */
  readonly legacyHistoryFile?: string;
  /** Overrides the scope facts read from judge evidence and the selection record. */
  readonly scopeFacts?: ScopeFactsProvider<WordpressScopeInput>;
  /** Local Wordfence history mirror; absent, duplicate lookup is unavailable. */
  readonly wordfenceHistory?: {
    readonly databasePath: string;
    readonly statePath: string;
  };
};

export type WordPressVerification = Verification<
  WordPressFinding,
  WordPressLabSetup,
  WordPressLabHandle,
  WordPressReconstruction
>;

/** The campaign config file, validated; a budget below one discovery run stops here. */
export async function readWordPressCampaignConfig(
  configPath: string,
): Promise<WordPressCampaignConfig> {
  const config = wordpressCampaignConfigSchema.parse(
    JSON.parse(await readFile(configPath, "utf8")) as unknown,
  );
  if (config.resources.memoryBudgetMiB < DISCOVERY_RUN_MEMORY_MIB)
    throw new Error(
      `The memory budget is below one discovery run (${DISCOVERY_RUN_MEMORY_MIB} MiB)`,
    );
  return config;
}

/** A selection policy file, validated against the profile schema. */
export async function readWordPressSelectionPolicyFile(
  policyPath: string,
): Promise<WordPressSelectionPolicy> {
  return wordPressSelectionPolicySchema.parse(
    JSON.parse(await readFile(policyPath, "utf8")) as unknown,
  );
}

/**
 * The policy a campaign config names (or the profile default). The two must
 * agree on the WordPress core version and the prompt variant; this is the one
 * place that checks it.
 */
export async function readWordPressCampaignPolicy(
  config: WordPressCampaignConfig,
): Promise<WordPressSelectionPolicy> {
  const policy =
    config.selectionPolicyPath === undefined
      ? await loadWordPressSelectionPolicy()
      : await readWordPressSelectionPolicyFile(config.selectionPolicyPath);
  if (
    policy.wordpressVersion !== undefined &&
    policy.wordpressVersion !== config.wordpressVersion
  )
    throw new Error("Selection and campaign WordPress versions differ");
  if (
    policy.promptVariant !== undefined &&
    policy.promptVariant !== config.promptId
  )
    throw new Error("Selection and campaign prompt variants differ");
  return policy;
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
  handoff: VerifierHandoff | undefined,
): WordPressVerification {
  if (handoff !== undefined && boundaries.handoffVerifier === undefined)
    throw new Error("This profile has no handoff Verifier");
  return new Verification({
    ledger: state.ledger,
    store: state.store,
    lab: boundaries.lab,
    // The skill id is the prompt version of a handoff run; the ledger tells the two apart.
    verifier:
      handoff === undefined
        ? boundaries.verifier
        : boundaries.handoffVerifier!(handoff),
    judges: createWordPressJudges({ store: state.store, lab: boundaries.lab }),
    readFinding: readWordPressFinding,
    renderer: wordpressReproductionRenderer,
    promptVersion:
      handoff === undefined
        ? WORDPRESS_VERIFIER_PROMPT_ID
        : WBH_VERIFY_SKILL_ID,
    // Whole-site before / after diff around the Verifier run; review material, not proof (#186).
    stateObserver: createWordPressLabStateObserver({
      store: state.store,
      lab: boundaries.lab,
    }),
    clock: state.clock,
  });
}

/**
 * Everything a campaign command shares: the validated config, the host
 * boundaries built for that config, and the Lab setup, reconstruction and
 * Verification derived from them. Commands keep only their own body.
 */
export interface WordPressCampaignSession {
  readonly config: WordPressCampaignConfig;
  /**
   * The selection policy the config names, read and checked against the
   * config on first use. Commands that never select (`runtime check`,
   * `lab *`, `verify next`) do not fail on a policy they do not read.
   */
  readonly policy: () => Promise<WordPressSelectionPolicy>;
  readonly boundaries: WordPressCampaignBoundaries;
  readonly setupFor: (snapshot: Snapshot) => WordPressLabSetup;
  readonly reconstructionFor: (snapshot: Snapshot) => WordPressReconstruction;
  readonly verification: WordPressVerification;
}

export async function openWordPressCampaignSession(
  options: Pick<WordPressCliProfileOptions, "boundaries">,
  state: CliState,
  input: {
    readonly configPath: string;
    /** Replaces the campaign config's selection policy path in process. */
    readonly selectionPolicyPath?: string;
    /** Verifies through the handoff transport instead of the Codex Verifier. */
    readonly handoff?: VerifierHandoff;
  },
): Promise<WordPressCampaignSession> {
  const parsed = await readWordPressCampaignConfig(input.configPath);
  const config =
    input.selectionPolicyPath === undefined
      ? parsed
      : { ...parsed, selectionPolicyPath: input.selectionPolicyPath };
  const boundaries = await options.boundaries(config, state);
  let policy: Promise<WordPressSelectionPolicy> | undefined;
  return {
    config,
    policy: () => (policy ??= readWordPressCampaignPolicy(config)),
    boundaries,
    setupFor: setupFor(config),
    reconstructionFor: reconstructionFor(config),
    verification: verificationFor(state, boundaries, input.handoff),
  };
}
