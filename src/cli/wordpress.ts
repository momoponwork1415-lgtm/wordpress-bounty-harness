import { readFile } from "node:fs/promises";

import { z } from "zod";

import type {
  AgentRuntimeProfile,
  DiscoveryTransportResult,
  DiscoveryTransportRun,
  ProviderAttachmentStore,
} from "../discovery/index.js";
import type { ExpectedSourceTree } from "../infrastructure/canonical-source-tree.js";
import { Review, type ScopeFactsProvider } from "../review/index.js";
import type { Selection } from "../selection/index.js";
import type { Snapshot } from "../snapshot/index.js";
import { Verification, type Verifier } from "../verification/index.js";
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
import { createWordfenceDuplicateLookup } from "../profiles/wordpress/wordfence-history/duplicate-lookup.js";
import { createWordPressJudges } from "../profiles/wordpress/verification/judges.js";
import {
  wordpressReproductionRenderer,
  type WordPressReconstruction,
} from "../profiles/wordpress/verification/reproduction-package.js";
import type { CliProfile, CliState } from "./index.js";
import { runCampaignPipeline } from "./pipeline.js";

const text = z.strictObject({
  version: z.string().min(1).max(64),
  text: z.string().min(1).max(16_384),
});

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
  readonly executor: {
    execute(run: DiscoveryTransportRun): Promise<DiscoveryTransportResult>;
  };
  readonly attachments: ProviderAttachmentStore;
  readonly verifier: Verifier<WordPressFinding, WordPressLabHandle>;
}

/** Scope facts come from judge evidence; until that reader exists scope stays incomplete. */
const noScopeFacts = {
  async load(): Promise<WordpressScopeInput> {
    throw new Error("Scope facts from judge evidence are not wired yet");
  },
};

async function loadConfig(configPath: string): Promise<{
  readonly config: WordPressCampaignConfig;
  readonly policy: WordPressSelectionPolicy;
}> {
  const config = wordpressCampaignConfigSchema.parse(
    JSON.parse(await readFile(configPath, "utf8")) as unknown,
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

export function createWordPressCliProfile(options: {
  readonly boundaries: (
    config: WordPressCampaignConfig,
    state: CliState,
  ) => Promise<WordPressCampaignBoundaries>;
  readonly scopePolicy: WordpressScopePolicy;
  /** Scope facts from judge evidence; absent, every scope assessment stays incomplete. */
  readonly scopeFacts?: ScopeFactsProvider<WordpressScopeInput>;
  /** Local Wordfence history mirror; absent, duplicate lookup is unavailable. */
  readonly wordfenceHistory?: {
    readonly databasePath: string;
    readonly statePath: string;
  };
}): CliProfile {
  return {
    review: (state) =>
      new Review({
        ledger: state.ledger,
        artifactStore: state.store,
        scopeEvaluator: createWordpressScopeEvaluator(options.scopePolicy),
        factsProvider: options.scopeFacts ?? noScopeFacts,
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
      const setupFor = (snapshot: Snapshot): WordPressLabSetup => ({
        schemaVersion: 1,
        snapshotDigest: snapshot.digest,
        ...config.lab,
      });
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
          setupFor,
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
                history: { mode: "none" },
              },
              historyFraction: 0,
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
          verification: new Verification<
            WordPressFinding,
            WordPressLabSetup,
            WordPressLabHandle,
            WordPressReconstruction
          >({
            ledger: state.ledger,
            store: state.store,
            lab: boundaries.lab,
            verifier: boundaries.verifier,
            judges: createWordPressJudges({
              store: state.store,
              lab: boundaries.lab,
            }),
            readFinding: readWordPressFinding,
            renderer: wordpressReproductionRenderer,
            clock: state.clock,
          }),
          reconstructionFor: (snapshot) => ({
            wordpressVersion: config.wordpressVersion,
            target: snapshot.target,
            enabledSettings: [],
            roles: [
              "unauthenticated",
              "subscriber",
              ...(config.lab.customerRole ? ["customer"] : []),
            ],
          }),
        },
      });
    },
  };
}
