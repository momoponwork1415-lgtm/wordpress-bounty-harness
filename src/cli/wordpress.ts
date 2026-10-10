import { readFile } from "node:fs/promises";

import { z } from "zod";

import {
  allocateTrialArms,
  CODEX_SANDBOX_MEMORY_MIB,
  CODEX_COOPERATIVE_SANDBOX_MEMORY_MIB,
  EGRESS_BROKER_LEFTOVER_PATTERNS,
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
  planWordPressEntryAssignments,
  renderWordPressEntryAssignment,
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
  renderWordPressLeadNeighbourhood,
  wordPressLeadSignature,
} from "../profiles/wordpress/discovery/lead.js";
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
import { reverifyOnSelectedVersion, runCampaignPipeline } from "./pipeline.js";

const text = z.strictObject({
  version: z.string().min(1).max(64),
  text: z.string().min(1).max(16_384),
});

/** One discovery run holds a Codex sandbox and its own egress broker. */
const DISCOVERY_RUN_MEMORY_MIB =
  CODEX_SANDBOX_MEMORY_MIB + EGRESS_BROKER_MEMORY_MIB;

const armBFraction = z.number().min(0).max(1);
const ablationAxis = z.discriminatedUnion("axis", [
  z.strictObject({ axis: z.literal("history"), armBFraction }),
  z.strictObject({
    axis: z.literal("prompt"),
    armBFraction,
    armBPromptId: z.enum(WORDPRESS_DISCOVERY_PROMPT_IDS),
  }),
  z.strictObject({ axis: z.literal("continuation"), armBFraction }),
]);
const ablation = z
  .union([
    z.strictObject({ axes: z.array(ablationAxis).min(1).max(3) }),
    z.strictObject({ axis: z.literal("history"), armBFraction }),
  ])
  .transform((value) => ("axes" in value ? value : { axes: [value] }));

/** Human-edited, Git-tracked run configuration. It carries no credentials or keys. */
export const wordpressCampaignConfigSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    selectionPolicyPath: z.string().min(1).optional(),
    promptId: z
      .enum(WORDPRESS_DISCOVERY_PROMPT_IDS)
      .default("short-objective-managed-v3"),
    programmeBoundary: text,
    stopRules: z
      .strictObject({
        maxRuns: z.number().int().positive().max(40),
        noFindingRuns: z.number().int().positive(),
      })
      .default({ maxRuns: 6, noFindingRuns: 3 }),
    runWallTimeMinutes: z.number().positive().max(240).default(90),
    /** Host bounds: concurrent discovery runs and the memory the Harness may use for them. */
    resources: z
      .strictObject({
        maxConcurrentRuns: z.number().int().min(1).max(4).default(2),
        memoryBudgetMiB: z.number().int().positive(),
      })
      .default({
        maxConcurrentRuns: 2,
        memoryBudgetMiB: 4 * DISCOVERY_RUN_MEMORY_MIB,
      }),
    /** Splits runs into arm a without history and arm b with the local public history. */
    ablation: ablation.optional(),
    continuation: z
      .strictObject({
        maxRunsPerTrial: z.number().int().min(1).max(2).default(2),
        runWallTimeMinutes: z.number().positive().max(120).default(30),
      })
      .optional(),
    /** Opt-in connected entry scopes; the index is profile-owned and does not constrain exploration. */
    assignment: z
      .strictObject({
        unit: z.literal("entry-point"),
        entriesPerRun: z.number().int().min(1).max(64).default(8),
      })
      .optional(),
    wordpressVersion: z.string().min(1).max(32),
    lab: z.strictObject({
      siteTitle: z.string().min(1).max(120),
      initialPosts: z.array(z.string().min(1).max(120)).max(20),
      customerRole: z.boolean(),
      databaseAccess: z.enum(["read-only", "none"]).default("read-only"),
      translatePress: z
        .strictObject({
          administratorSecondaryLocale: z.string().regex(/^[a-z]{2}_[A-Z]{2}$/),
        })
        .optional(),
    }),
  })
  .superRefine((config, context) => {
    const axes = config.ablation?.axes ?? [];
    if (new Set(axes.map((axis) => axis.axis)).size !== axes.length)
      context.addIssue({
        code: "custom",
        path: ["ablation", "axes"],
        message: "Ablation axes must be distinct",
      });
    if (
      axes.some((axis) => axis.axis === "continuation") &&
      config.continuation === undefined
    )
      context.addIssue({
        code: "custom",
        path: ["continuation"],
        message: "Continuation axis requires a continuation block",
      });
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
    enabledSettings:
      config.lab.translatePress === undefined
        ? []
        : [
            `TranslatePress publishes ${config.lab.translatePress.administratorSecondaryLocale} as a secondary language`,
            `The administrator uses ${config.lab.translatePress.administratorSecondaryLocale} as profile locale`,
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
      !config.ablation?.axes.some((axis) => axis.axis === "history") ||
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
      const promptAxis = config.ablation?.axes.find(
        (axis) => axis.axis === "prompt",
      );
      const armBObjective =
        promptAxis?.axis === "prompt"
          ? await loadWordPressDiscoveryAsset(promptAxis.armBPromptId)
          : undefined;
      return runCampaignPipeline({
        campaignId: input.campaignId,
        ...(input.retryIncompleteVerifications === undefined
          ? {}
          : {
              retryIncompleteVerifications: input.retryIncompleteVerifications,
            }),
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
            const sourceIndex =
              config.assignment === undefined &&
              config.continuation === undefined
                ? undefined
                : await buildWordPressSourceIndex(
                    source.directory,
                    target.slug,
                  );
            let assignments: readonly WordPressEntryAssignment[] = [];
            if (config.assignment !== undefined) {
              if (sourceIndex === undefined)
                throw new Error("Source index is unavailable");
              assignments = planWordPressEntryAssignments(
                sourceIndex,
                config.assignment.entriesPerRun,
              );
            }
            if (config.assignment !== undefined && assignments.length === 0)
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
              objectiveText: string,
            ) =>
              [
                objectiveText.trim(),
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
                ...(assignment === undefined
                  ? ["## Assigned files", "All files under /workspace/main."]
                  : [
                      renderWordPressEntryAssignment(
                        assignment,
                        source.dependency !== undefined,
                      ),
                    ]),
              ].join("\n\n");
            const assignmentMetadata = (
              assignment: WordPressEntryAssignment,
            ) => {
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
              historyFraction:
                config.ablation?.axes.find((axis) => axis.axis === "history")
                  ?.armBFraction ?? 0,
              runWallTimeMs: config.runWallTimeMinutes * 60_000,
              concurrency: Math.min(
                config.resources.maxConcurrentRuns,
                Math.floor(
                  config.resources.memoryBudgetMiB /
                    (boundaries.runtimeProfile.subagent.modelId ===
                    "unavailable"
                      ? DISCOVERY_RUN_MEMORY_MIB
                      : CODEX_COOPERATIVE_SANDBOX_MEMORY_MIB +
                        EGRESS_BROKER_MEMORY_MIB),
                ),
              ),
              ...(config.ablation === undefined
                ? {}
                : { ablation: { axes: config.ablation.axes } }),
              plannedTrials: Array.from(
                { length: maxRuns },
                (_, trialOrdinal) => {
                  const trialId = state.newId();
                  const arms = allocateTrialArms(
                    trialOrdinal,
                    config.ablation?.axes ?? [],
                  );
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
                      trustBoundaryVersion: trustBoundary.id,
                      sourcePack: {
                        dependency:
                          source.dependency === undefined
                            ? ("none" as const)
                            : ("mounted" as const),
                      },
                      assignmentUnit:
                        assignment === undefined ? "plugin" : "entry-point",
                      ...(assignment === undefined
                        ? {}
                        : { assignment: assignmentMetadata(assignment) }),
                      labAccess: {
                        database:
                          lab.database === undefined ? "none" : "read-only",
                      },
                    },
                    run: {
                      runId: trialId,
                      targetSnapshotDigest: snapshot.digest,
                      profile: boundaries.runtimeProfile,
                      prompt: promptFor(assignment, selectedObjective.text),
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
                      expiresAt: new Date(
                        now + config.runWallTimeMinutes * 60_000,
                      ).toISOString(),
                    },
                  };
                  const continuationConfig = config.continuation;
                  if (
                    continuationConfig === undefined ||
                    arms.continuation === "a"
                  )
                    return { trialId, trialOrdinal, explore };
                  if (sourceIndex === undefined)
                    throw new Error("Continuation index is unavailable");
                  return {
                    trialId,
                    trialOrdinal,
                    explore,
                    continuation: {
                      maxRuns: continuationConfig.maxRunsPerTrial,
                      wallTimeMs:
                        continuationConfig.runWallTimeMinutes * 60_000,
                      plan: (lead: AdmittedLead): PlannedDiscoveryRun => {
                        const admitted = readWordPressLead(lead);
                        if (
                          admitted.trialId !== trialId ||
                          admitted.snapshotDigest !== snapshot.digest
                        )
                          throw new Error("Lead differs from its Trial");
                        return {
                          configuration: explore.configuration,
                          run: {
                            ...explore.run,
                            runId: state.newId(),
                            prompt: [
                              explore.run.prompt,
                              "## Lead",
                              canonicalJson(admitted),
                              "## Neighbourhood",
                              renderWordPressLeadNeighbourhood(
                                admitted,
                                sourceIndex,
                              ),
                            ].join("\n\n"),
                          },
                        };
                      },
                    },
                  };
                },
              ),
              executor: boundaries.executor,
              attachments: boundaries.attachments,
              admitFinding: admitWordPressFinding,
              admitLead: admitWordPressLead,
              leadSignature: (lead: AdmittedLead) =>
                wordPressLeadSignature(readWordPressLead(lead)),
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
      return reverifyOnSelectedVersion({
        campaignId: input.campaignId,
        findingId: input.findingId,
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
            const {
              historySignals: _historySignals,
              historySource: _historySource,
              ...reverifyPolicy
            } = policy;
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
          setupFor: setupFor(config),
          verification: verificationFor(state, boundaries),
          reconstructionFor: reconstructionFor(config),
        },
      });
    },
  };
}
