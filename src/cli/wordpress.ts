import { readFile } from "node:fs/promises";

import { z } from "zod";

import {
  CODEX_SANDBOX_MEMORY_MIB,
  EGRESS_BROKER_LEFTOVER_PATTERNS,
  EGRESS_BROKER_MEMORY_MIB,
} from "../discovery/index.js";
import type {
  AgentRuntimeProfile,
  CampaignHistory,
  DiscoveryTransportResult,
  DiscoveryTransportRun,
  ProviderAttachmentStore,
} from "../discovery/index.js";
import type { ExpectedSourceTree } from "../infrastructure/canonical-source-tree.js";
import { Review, type ScopeFactsProvider } from "../review/index.js";
import type { Selection } from "../selection/index.js";
import type { Snapshot } from "../snapshot/index.js";
import { Verification, type Verifier } from "../verification/index.js";
import { parseWordPressAdvisories } from "../profiles/wordpress/advisory.js";
import {
  parseWordPressAnswerKeys,
  wordpressFindingLocations,
} from "../profiles/wordpress/answer-key.js";
import {
  admitWordPressFinding,
  readWordPressFinding,
  type WordPressFinding,
} from "../profiles/wordpress/discovery/finding.js";
import type {
  WordPressLab,
  WordPressLabHandle,
  WordPressLabSetup,
} from "../profiles/wordpress/lab/index.js";
import {
  loadWordPressDiscoveryAsset,
  WORDPRESS_DISCOVERY_PROMPT_IDS,
} from "../profiles/wordpress/prompts/index.js";
import {
  createWordpressScopeEvaluator,
  type WordpressScopeInput,
  type WordpressScopePolicy,
} from "../profiles/wordpress/scope-policy.js";
import {
  loadWordPressSelectionPolicy,
  wordPressSelectionPolicySchema,
  type WordPressSelectionPolicy,
  type WordPressTargetSelection,
} from "../profiles/wordpress/selection/index.js";
import { createWordPressScopeFacts } from "../profiles/wordpress/scope-facts.js";
import { createWordfenceDuplicateLookup } from "../profiles/wordpress/wordfence-history/duplicate-lookup.js";
import {
  extractCampaignHistory,
  inspectHistoryMirror,
} from "../profiles/wordpress/wordfence-history/index.js";
import { createWordPressJudges } from "../profiles/wordpress/verification/judges.js";
import {
  wordpressReproductionRenderer,
  type WordPressReconstruction,
} from "../profiles/wordpress/verification/reproduction-package.js";
import type { CliProfile, CliState } from "./index.js";
import { reverifyOnLatestVersion, runCampaignPipeline } from "./pipeline.js";

const text = z.strictObject({
  version: z.string().min(1).max(64),
  text: z.string().min(1).max(16_384),
});

/** One discovery run holds a Codex sandbox and its own egress broker. */
const DISCOVERY_RUN_MEMORY_MIB =
  CODEX_SANDBOX_MEMORY_MIB + EGRESS_BROKER_MEMORY_MIB;

/** Human-edited, Git-tracked run configuration. It carries no credentials or keys. */
export const wordpressCampaignConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  selectionPolicyPath: z.string().min(1).optional(),
  promptId: z
    .enum(WORDPRESS_DISCOVERY_PROMPT_IDS)
    .default("short-objective-v1"),
  programmeBoundary: text,
  stopRules: z
    .strictObject({
      maxRuns: z.number().int().positive().max(40),
      noFindingRuns: z.number().int().positive(),
    })
    .default({ maxRuns: 40, noFindingRuns: 4 }),
  runWallTimeMinutes: z.number().positive().max(240).default(30),
  /** Host bounds: concurrent discovery runs and the memory the Harness may use for them. */
  resources: z
    .strictObject({
      maxConcurrentRuns: z.number().int().min(1).max(4).default(4),
      memoryBudgetMiB: z.number().int().positive(),
    })
    .default({
      maxConcurrentRuns: 4,
      memoryBudgetMiB: 4 * DISCOVERY_RUN_MEMORY_MIB,
    }),
  /** Optional ceiling on discovery runs started per UTC day across campaigns. */
  dailyRunCap: z.number().int().positive().optional(),
  /** Splits runs into arm a without history and arm b with the local public history. */
  ablation: z
    .strictObject({
      axis: z.literal("history"),
      armBFraction: z.number().min(0).max(1),
    })
    .optional(),
  wordpressVersion: z.string().min(1).max(32),
  lab: z.strictObject({
    siteTitle: z.string().min(1).max(120),
    initialPosts: z.array(z.string().min(1).max(120)).max(20),
    customerRole: z.boolean(),
  }),
});
export type WordPressCampaignConfig = z.infer<
  typeof wordpressCampaignConfigSchema
>;

/** System-boundary adapters: WordPress.org, Docker/runsc and the provider CLI. */
export interface WordPressCampaignBoundaries {
  readonly selection: Selection<
    WordPressSelectionPolicy,
    WordPressTargetSelection,
    unknown
  >;
  readonly freeze: (target: WordPressTargetSelection) => Promise<Snapshot>;
  readonly lab: WordPressLab;
  readonly sourceFor: (snapshot: Snapshot) => Promise<{
    readonly directory: string;
    readonly tree: ExpectedSourceTree;
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

const setupFor =
  (config: WordPressCampaignConfig) =>
  (snapshot: Snapshot): WordPressLabSetup => ({
    schemaVersion: 1,
    snapshotDigest: snapshot.digest,
    ...config.lab,
  });

const reconstructionFor =
  (config: WordPressCampaignConfig) =>
  (snapshot: Snapshot): WordPressReconstruction => ({
    wordpressVersion: config.wordpressVersion,
    target: snapshot.target,
    enabledSettings: [],
    roles: [
      "unauthenticated",
      "subscriber",
      ...(config.lab.customerRole ? ["customer"] : []),
    ],
  });

function verificationFor(
  state: CliState,
  boundaries: WordPressCampaignBoundaries,
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
    verifier: boundaries.verifier,
    judges: createWordPressJudges({ store: state.store, lab: boundaries.lab }),
    readFinding: readWordPressFinding,
    renderer: wordpressReproductionRenderer,
    clock: state.clock,
  });
}

export function createWordPressCliProfile(options: {
  readonly boundaries: (
    config: WordPressCampaignConfig,
    state: CliState,
  ) => Promise<WordPressCampaignBoundaries>;
  readonly scopePolicy: WordpressScopePolicy;
  /** Overrides the scope facts read from judge evidence and the selection record. */
  readonly scopeFacts?: ScopeFactsProvider<WordpressScopeInput>;
  /** Local Wordfence history mirror; absent, duplicate lookup is unavailable. */
  readonly wordfenceHistory?: {
    readonly databasePath: string;
    readonly statePath: string;
  };
}): CliProfile {
  /** Public records before the stable version's release; none when the cutoff or mirror is missing. */
  const historyFor = (
    config: WordPressCampaignConfig,
    target: WordPressTargetSelection,
  ): CampaignHistory => {
    if (
      config.ablation === undefined ||
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
    async select(state, input) {
      const { config, policy } = await loadConfig(input.configPath);
      const boundaries = await options.boundaries(config, state);
      return (await boundaries.selection.select(policy)).map((target) => ({
        targetId: target.targetId,
        version: target.version,
        score: target.score,
      }));
    },
    async runCampaign(state, input) {
      const { config, policy } = await loadConfig(input.configPath);
      const boundaries = await options.boundaries(config, state);
      const [objective, trustBoundary] = await Promise.all([
        loadWordPressDiscoveryAsset(config.promptId),
        loadWordPressDiscoveryAsset("trust-boundary-v1"),
      ]);
      return runCampaignPipeline({
        campaignId: input.campaignId,
        ledger: state.ledger,
        store: state.store,
        clock: state.clock,
        newId: state.newId,
        pipeline: {
          select: async () =>
            (await boundaries.selection.select(policy)).filter(
              (target) => input.target === null || target.slug === input.target,
            ),
          freeze: boundaries.freeze,
          lab: boundaries.lab,
          setupFor: setupFor(config),
          async discovery({ target, snapshot, lab }) {
            const source = await boundaries.sourceFor(snapshot);
            // The campaign ceiling is a safety bound; selection decides depth per target.
            const maxRuns = Math.min(
              config.stopRules.maxRuns,
              target.runBudget,
            );
            const stopRules = {
              maxRuns,
              noFindingRuns: Math.min(config.stopRules.noFindingRuns, maxRuns),
            };
            const accounts = Object.entries(lab.attackerAccounts).map(
              ([role, account]) =>
                `- ${role}: ${account.username} / ${account.password} (Lab only)`,
            );
            // Only low-privilege Lab accounts exist on the handle; nothing else is offered.
            const prompt = [
              objective.text.trim(),
              "## Trust boundary",
              trustBoundary.text.trim(),
              `## Programme Boundary (${config.programmeBoundary.version})`,
              config.programmeBoundary.text.trim(),
              "## Lab",
              `Endpoint: ${lab.endpoint}`,
              ...accounts,
              "## Assigned files",
              "All files under /workspace/main.",
            ].join("\n\n");
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
                modelProfileDigest: boundaries.runtimeProfile.digest,
                promptDigest: objective.digest,
                stopRules,
                lab: { setupDigest: lab.setupDigest },
                history: historyFor(config, target),
              },
              historyFraction: config.ablation?.armBFraction ?? 0,
              concurrency: Math.min(
                config.resources.maxConcurrentRuns,
                Math.floor(
                  config.resources.memoryBudgetMiB / DISCOVERY_RUN_MEMORY_MIB,
                ),
              ),
              ...(config.dailyRunCap === undefined
                ? {}
                : { dailyRunCap: config.dailyRunCap }),
              ...(config.ablation === undefined
                ? {}
                : { ablation: { axis: config.ablation.axis } }),
              plannedRuns: Array.from({ length: maxRuns }, () => ({
                configuration: {
                  promptVariant: config.promptId,
                  assignmentUnit: "plugin",
                },
                run: {
                  runId: state.newId(),
                  targetSnapshotDigest: snapshot.digest,
                  profile: boundaries.runtimeProfile,
                  prompt,
                  lab: {
                    endpoint: lab.endpoint,
                    networkName: lab.networkName,
                    internalIp: lab.internalIp,
                  },
                  sourceDirectory: source.directory,
                  sourceTree: source.tree,
                  expiresAt: new Date(
                    now + config.runWallTimeMinutes * 60_000,
                  ).toISOString(),
                },
              })),
              executor: boundaries.executor,
              attachments: boundaries.attachments,
              admitFinding: admitWordPressFinding,
            };
          },
          verification: verificationFor(state, boundaries),
          reconstructionFor: reconstructionFor(config),
        },
      });
    },
    async cleanupLeftovers(state, input) {
      const { config } = await loadConfig(input.configPath);
      const boundaries = await options.boundaries(config, state);
      return boundaries.lab.cleanupLeftovers({
        remove: input.remove,
        patterns: EGRESS_BROKER_LEFTOVER_PATTERNS,
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
      return reverifyOnLatestVersion({
        campaignId: input.campaignId,
        findingId: input.findingId,
        ledger: state.ledger,
        store: state.store,
        clock: state.clock,
        newId: state.newId,
        pipeline: {
          async selectLatest({ selectionId }) {
            const slug = /^wporg:([a-z0-9][a-z0-9-]*)@/.exec(selectionId)?.[1];
            if (slug === undefined) return null;
            // No pin: the observed stable version is the latest one.
            const latest = await boundaries.selection.select({
              ...policy,
              candidateSlugs: [slug],
              pinnedVersions: {},
              maximumTargets: 1,
            });
            return latest[0] ?? null;
          },
          freeze: boundaries.freeze,
          setupFor: setupFor(config),
          verification: verificationFor(state, boundaries),
          reconstructionFor: reconstructionFor(config),
        },
      });
    },
  };
}
