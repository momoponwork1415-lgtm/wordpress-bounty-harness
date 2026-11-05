import type { LabEgressPlan } from "../lab/egress-plan.js";
import type { WordPressCoreReleaseObservation } from "../profiles/wordpress/acquisition/wordpress-core-release.js";
import {
  CURRENT_WORDPRESS_LAB_BASELINE_ID,
  loadWordPressLabBaseline,
} from "../profiles/wordpress/lab/baseline.js";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import {
  assignDiscoveryRuntime,
  CODEX_COOPERATIVE_SANDBOX_MEMORY_MIB,
  DEFAULT_MAX_CHILDREN,
  MAX_CHILDREN_LIMIT,
  EGRESS_BROKER_MEMORY_MIB,
  runtimeShareSchema,
} from "../discovery/index.js";
import type {
  AgentRuntimeProfile,
  DiscoveryTransportResult,
  InterruptedRunRecovery,
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
import {
  WORDPRESS_CURRENT_DISCOVERY_PROMPT_IDS,
  WORDPRESS_LAUNCHABLE_DISCOVERY_PROMPT_IDS,
  wordPressDiscoveryModeOf,
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
import { createWordPressAttemptObserver } from "../profiles/wordpress/verification/attempt-observer.js";
import { WBH_VERIFY_SKILL_ID } from "../profiles/wordpress/verification/handoff-verifier.js";
import { createWordPressLabStateObserver } from "../profiles/wordpress/verification/lab-state-diff.js";
import type { CliState } from "./index.js";
import type { RuntimeTargetCaps } from "./pipeline.js";

const text = z.strictObject({
  version: z.string().min(1).max(64),
  text: z.string().min(1).max(16_384),
});

/** One discovery run holds a Codex sandbox and its own egress broker. */
export const DISCOVERY_RUN_MEMORY_MIB =
  CODEX_COOPERATIVE_SANDBOX_MEMORY_MIB + EGRESS_BROKER_MEMORY_MIB;

/**
 * The current or candidate objective of either launch mode; superRefine ties
 * it to the mode (ADR 0039, DEVELOPMENT §5).
 */
const runnablePrompt = z.enum(WORDPRESS_LAUNCHABLE_DISCOVERY_PROMPT_IDS);

/**
 * ADR 0029 cap and the default wall. `wide` used 20 until the owner's
 * 2026-10-25 decision (ADR 0039 addendum 3).
 */
const WORDPRESS_DEFAULT_WALL_MINUTES = 120;
/**
 * ADR 0033 / 0039: the active floor unless discovery.minimumActiveMinutes
 * sets one. ADR 0039 addendum 20 (#686): there is no floor by default; the
 * ending is the Root's judgment.
 */
const WORDPRESS_DEFAULT_MINIMUM_ACTIVE_MINUTES = 0;

/**
 * The discovery Lab's budgets (redesign 2026-10-25 §7). The string form is
 * normalised to the object. Each Trial has one exploration Lab for its whole
 * wall (ADR 0003, 2026-10-25 addendum); resets are budgeted by `maxResets`,
 * observer visits (`POST /observe`, Phase D2) by `maxObservations`, and the
 * storage lookups `POST /find` / `POST /sql` (ADR 0049) share `maxLookups`.
 * `attached` is the only mode: `none` was removed on 2026-11-05 (owner).
 */
const discoveryLabSchema = z
  .union([
    z.literal("attached").transform((mode) => ({
      mode,
      maxResets: undefined,
      maxObservations: undefined,
      maxLookups: undefined,
    })),
    z.strictObject({
      mode: z.literal("attached"),
      maxResets: z.number().int().min(0).max(5).optional(),
      maxObservations: z.number().int().min(0).max(100).optional(),
      maxLookups: z.number().int().min(0).max(300).optional(),
    }),
  ])
  .transform(({ mode, maxResets, maxObservations, maxLookups }) => ({
    mode,
    maxResets: maxResets ?? 2,
    maxObservations: maxObservations ?? 20,
    maxLookups: maxLookups ?? 60,
  }));

/** Human-edited, Git-tracked run configuration. It carries no credentials or keys. */
const commonCampaignFields = {
  schemaVersion: z.literal(1),
  discovery: z
    .strictObject({
      lab: discoveryLabSchema.prefault("attached"),
      /** Opt-in split of targets between Codex and Claude; absent, all run on Codex. */
      runtimeShare: runtimeShareSchema.optional(),
      /** The launch mode of every Trial this campaign starts (ADR 0039). */
      mode: z.enum(["wide"]).default("wide"),
      /** Ceiling on live children; the Root decides how many it uses. */
      maxChildren: z
        .number()
        .int()
        .min(1)
        .max(MAX_CHILDREN_LIMIT)
        .default(DEFAULT_MAX_CHILDREN),
      /** Defaults to 0 (ADR 0039 addendum 20). */
      minimumActiveMinutes: z.number().int().min(0).max(119).optional(),
      /**
       * ADR 0048: `same-target` passes the map and setup record of the latest
       * earlier Trial on another Snapshot of the same target under the
       * Harness's `## Prior research` section; `none` (the default) passes
       * nothing.
       */
      priorResearch: z.enum(["none", "same-target"]).default("none"),
      /** ADR 0049 addendum 7: `none` still parses; the follow-up Trial is gone. */
      followUp: z.literal("none").optional(),
    })
    .prefault({}),
  selectionPolicyPath: z.string().min(1).optional(),
  programmeBoundary: text,
  /** Host bounds: targets, per-target discovery runs and their memory budget. */
  resources: z
    .strictObject({
      maxConcurrentRuns: z.number().int().min(1).max(4).default(1),
      maxConcurrentTargets: z.number().int().min(1).max(10).default(1),
      memoryBudgetMiB: z.number().int().positive(),
      /**
       * Opt-in caps per discovery runtime under maxConcurrentTargets (2026-10-19).
       * Absent, only the total applies.
       */
      maxConcurrentTargetsByRuntime: z
        .strictObject({
          codex: z.number().int().min(0).max(10).optional(),
          claude: z.number().int().min(0).max(10).optional(),
        })
        .optional(),
    })
    .default({
      maxConcurrentRuns: 1,
      maxConcurrentTargets: 1,
      memoryBudgetMiB: DISCOVERY_RUN_MEMORY_MIB,
    }),
  /** Absent (#741): the Lab image's core version, checked against the latest stable at select. */
  wordpressVersion: z.string().min(1).max(32).optional(),
  lab: z.strictObject({
    siteTitle: z.string().min(1).max(120),
    initialPosts: z.array(z.string().min(1).max(120)).max(20),
    customerRole: z.boolean(),
    databaseAccess: z.enum(["read-only", "none"]).default("read-only"),
  }),
};
export const wordpressCampaignConfigSchema = z
  .strictObject({
    ...commonCampaignFields,
    /** Defaults to the 120-minute cap (ADR 0039 addendum 3). */
    runWallTimeMinutes: z.number().positive().max(120).optional(),
    /** Defaults to the current objective of the mode. */
    promptId: runnablePrompt.optional(),
  })
  .superRefine((config, context) => {
    const mode = config.discovery.mode;
    if (
      config.promptId !== undefined &&
      wordPressDiscoveryModeOf(config.promptId) !== mode
    )
      context.addIssue({
        code: "custom",
        path: ["promptId"],
        message: `The ${mode} mode runs ${WORDPRESS_LAUNCHABLE_DISCOVERY_PROMPT_IDS.filter((id) => wordPressDiscoveryModeOf(id) === mode).join(" or ")} only`,
      });
    const floor =
      config.discovery.minimumActiveMinutes ??
      WORDPRESS_DEFAULT_MINIMUM_ACTIVE_MINUTES;
    if (
      floor > 0 &&
      (config.runWallTimeMinutes ?? WORDPRESS_DEFAULT_WALL_MINUTES) <= floor
    )
      context.addIssue({
        code: "custom",
        path: ["runWallTimeMinutes"],
        message: `A ${mode} wall must exceed the ${floor}-minute active floor`,
      });
    const caps = config.resources.maxConcurrentTargetsByRuntime;
    if (caps !== undefined) {
      const share = config.discovery.runtimeShare ?? { codex: 1, claude: 0 };
      for (const runtime of ["codex", "claude"] as const) {
        const cap = caps[runtime];
        if (cap !== undefined && cap > config.resources.maxConcurrentTargets)
          context.addIssue({
            code: "custom",
            path: ["resources", "maxConcurrentTargetsByRuntime", runtime],
            message: "A runtime cap exceeds maxConcurrentTargets",
          });
        // A runtime that gets targets needs a cap that lets them start.
        if (share[runtime] > 0 && (cap === undefined || cap < 1))
          context.addIssue({
            code: "custom",
            path: ["resources", "maxConcurrentTargetsByRuntime", runtime],
            message:
              "A runtime with a positive share needs a cap of at least 1",
          });
      }
    }
  })
  .transform((config) => ({
    ...config,
    discovery: {
      ...config.discovery,
      minimumActiveMinutes:
        config.discovery.minimumActiveMinutes ??
        WORDPRESS_DEFAULT_MINIMUM_ACTIVE_MINUTES,
    },
    promptId:
      config.promptId ??
      WORDPRESS_CURRENT_DISCOVERY_PROMPT_IDS[config.discovery.mode],
    runWallTimeMinutes:
      config.runWallTimeMinutes ?? WORDPRESS_DEFAULT_WALL_MINUTES,
  }));
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
  /** #741: the latest stable WordPress release, from WordPress.org's version check. */
  readonly coreRelease?: () => Promise<WordPressCoreReleaseObservation>;
  /** #741: the core version the pinned Lab image ships. */
  readonly coreImageVersion?: () => Promise<string>;
  readonly runtimeProfile: AgentRuntimeProfile;
  /** What the pinned Codex image actually ships (GvisorCodexSandbox.probe). */
  readonly probeRuntime: () => Promise<{
    readonly cliVersion: string;
    readonly bundledCatalogDigest: string;
  }>;
  readonly executor: {
    execute(run: DiscoveryTransportRun): Promise<DiscoveryTransportResult>;
    /** Seals what a dead run's sandbox left on disk (ADR 0036); absent in fakes without a sandbox. */
    recoverInterrupted?(
      run: DiscoveryTransportRun,
      startedAt: string,
    ): Promise<InterruptedRunRecovery>;
    /** Removes a run's marker and directories once its finish is appended (#512). */
    release?(runId: string): Promise<void>;
  };
  /** The Claude discovery runtime, present when the host configures it. */
  readonly claude?: {
    readonly runtimeProfile: AgentRuntimeProfile;
    readonly executor: WordPressCampaignBoundaries["executor"];
  };
  readonly attachments: ProviderAttachmentStore;
  /** `verify next --handoff`: a Verifier that hands the Lab to a skill on the host (#352). */
  readonly handoffVerifier?: (
    handoff: VerifierHandoff,
  ) => Verifier<WordPressFinding, WordPressLabHandle>;
}

/**
 * Where `verify next --handoff` exchanges files with the skill, and the host
 * ports it asks for; 0 takes a free port, which `lab.json` then names (#432).
 */
export type VerifierHandoff = {
  readonly directory: string;
  readonly httpPort: number;
  readonly databasePort: number;
  /** ADR 0046: the fixed destinations the Lab's relay forwards to until `setup-done`. */
  readonly egress?: LabEgressPlan;
};

export type WordPressCliProfileOptions = {
  readonly boundaries: (
    config: WordPressCampaignConfig,
    state: CliState,
  ) => Promise<WordPressCampaignBoundaries>;
  /** Selection can inspect and freeze public sources without booting a Lab. */
  readonly selectionBoundaries?: (
    state: CliState,
    /** The pinned core version; undefined takes the image's (#741). */
    wordpressVersion: string | undefined,
  ) => Promise<
    Pick<
      WordPressCampaignBoundaries,
      "selection" | "freeze" | "coreRelease" | "coreImageVersion"
    >
  >;
  readonly scopePolicy: WordpressScopePolicy;
  /** Git-outside legacy history JSON, read on every selection (D2). */
  /** Overrides the scope facts read from recorded judge evidence and the selection record. */
  readonly scopeFacts?: ScopeFactsProvider<WordpressScopeInput>;
  /** Local Wordfence history mirror; absent, duplicate lookup is unavailable. */
  readonly wordfenceHistory?: {
    readonly databasePath: string;
    readonly statePath: string;
  };
  /** The shared attachment store (ADR 0049 D: `research import` reads sealed notes from it). */
  readonly attachments?: Pick<ProviderAttachmentStore, "readByDigest">;
};

export type WordPressVerification = Verification<
  WordPressFinding,
  WordPressLabSetup,
  WordPressLabHandle
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

/** The configured per-runtime caps, only those set; empty when the config has none. */
export function wordPressRuntimeCeilings(
  config: WordPressCampaignConfig,
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    Object.entries(config.resources.maxConcurrentTargetsByRuntime ?? {}).filter(
      (entry): entry is [string, number] => entry[1] !== undefined,
    ),
  );
}

/**
 * The per-runtime caps and runtime of each target, or undefined when the
 * campaign has neither caps nor a share. A provider limit stops only one
 * runtime's targets when both runtimes get targets. Campaigns run discovery
 * without a Lab or an in-campaign Verifier.
 */
export function wordPressRuntimeCaps(
  config: WordPressCampaignConfig,
): RuntimeTargetCaps<WordPressTargetSelection> | undefined {
  const share = config.discovery.runtimeShare;
  if (config.resources.maxConcurrentTargetsByRuntime === undefined && !share)
    return undefined;
  return {
    runtimeOf: (target) => assignDiscoveryRuntime(target.targetId, share),
    ceilings: wordPressRuntimeCeilings(config),
    providerLimitPerRuntime:
      share !== undefined && share.codex > 0 && share.claude > 0,
  };
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
 * agree on the WordPress core version, and a policy's prompt variant must be a
 * current objective; both modes select from the same policy (ADR 0039). This
 * is the one place that checks it.
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
    config.wordpressVersion !== undefined &&
    policy.wordpressVersion !== config.wordpressVersion
  )
    throw new Error("Selection and campaign WordPress versions differ");
  if (
    policy.promptVariant !== undefined &&
    !WORDPRESS_LAUNCHABLE_DISCOVERY_PROMPT_IDS.some(
      (id) => id === policy.promptVariant,
    )
  )
    throw new Error("Selection and campaign prompt variants differ");
  return policy;
}

const setupFor =
  (config: WordPressCampaignConfig) =>
  (snapshot: Snapshot): WordPressLabSetup => {
    return {
      schemaVersion: 1,
      snapshotDigest: snapshot.digest,
      ...config.lab,
    };
  };

function verificationFor(
  state: CliState,
  boundaries: WordPressCampaignBoundaries,
  handoff: VerifierHandoff | undefined,
): WordPressVerification {
  // The CLI requires `--handoff` for every verifying command (ADR 0035).
  if (handoff === undefined)
    throw new Error("Verification runs only through a skill handoff");
  if (boundaries.handoffVerifier === undefined)
    throw new Error("This profile has no handoff Verifier");
  const verifier = boundaries.handoffVerifier(handoff);
  return new Verification({
    ledger: state.ledger,
    store: state.store,
    lab: boundaries.lab,
    verifier,
    // Records the Lab's capture and browser; a person confirms in a Lab (#525).
    observer: createWordPressAttemptObserver({
      store: state.store,
      lab: boundaries.lab,
      // Victim-page WebM is opt-in (#549); it stays in Private Evidence.
      recordVideo: process.env.WBH_RECORD_VIDEO === "1",
    }),
    readFinding: readWordPressFinding,
    // The skill id is the prompt version of a handoff run.
    promptVersion: WBH_VERIFY_SKILL_ID,
    // Whole-site before / after diff around the Verifier run; review material, not proof (#186).
    stateObserver: createWordPressLabStateObserver({
      store: state.store,
      lab: boundaries.lab,
    }),
    ...(handoff.egress === undefined ? {} : { labEgress: handoff.egress }),
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
  /**
   * The campaign's setup on the profile's current base environment (#699),
   * for discovery and verification Labs alike (#746). Review Labs rebuild it
   * from the package.
   */
  readonly setupFor: (snapshot: Snapshot) => WordPressLabSetup;
  /** Built once on use; administration and history access require no Verifier. */
  readonly verification: WordPressVerification;
}

export async function openWordPressCampaignSession(
  options: Pick<WordPressCliProfileOptions, "boundaries">,
  state: CliState,
  input: {
    readonly configPath: string;
    /** Replaces the campaign config's selection policy path in process. */
    readonly selectionPolicyPath?: string;
    /** The skill handoff; `verify next` and `review reverify` always pass one. */
    readonly handoff?: VerifierHandoff;
  },
): Promise<WordPressCampaignSession> {
  const parsed = await readWordPressCampaignConfig(input.configPath);
  const config =
    input.selectionPolicyPath === undefined
      ? parsed
      : { ...parsed, selectionPolicyPath: input.selectionPolicyPath };
  const boundaries = await options.boundaries(config, state);
  const baseline = (
    await loadWordPressLabBaseline(CURRENT_WORDPRESS_LAB_BASELINE_ID)
  ).ref;
  let policy: Promise<WordPressSelectionPolicy> | undefined;
  let verification: WordPressVerification | undefined;
  return {
    config,
    policy: () => (policy ??= readWordPressCampaignPolicy(config)),
    boundaries,
    setupFor: (snapshot) => ({
      ...setupFor(config)(snapshot),
      baseline: { id: baseline.id, digest: baseline.digest },
    }),
    get verification() {
      return (verification ??= verificationFor(
        state,
        boundaries,
        input.handoff,
      ));
    },
  };
}
