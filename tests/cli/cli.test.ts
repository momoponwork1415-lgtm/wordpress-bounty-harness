import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/index.js";
import { reviewExportV1Schema } from "../../src/review/index.js";
import {
  createWordPressCliProfile,
  wordpressCampaignConfigSchema,
  type WordPressCampaignBoundaries,
} from "../../src/cli/wordpress.js";
import {
  createNativeRunReceipt,
  defineAgentRuntimeProfile,
  ProviderAttachmentStore,
  type DiscoveryTransportRun,
} from "../../src/discovery/index.js";
import { measureCanonicalSourceTree } from "../../src/infrastructure/canonical-source-tree.js";
import { SqliteContinuousRunJournal } from "../../src/infrastructure/continuous-run-journal.js";
import { SqliteHostResourceClaims } from "../../src/infrastructure/host-resource-claims.js";
import { TargetResourceScope } from "../../src/infrastructure/target-resource-scope.js";
import type { WordPressOrgTargetSource } from "../../src/profiles/wordpress/acquisition/index.js";
import {
  wordPressDiscoveryOutputContract,
  wordPressDiscoveryOutputContractV2,
} from "../../src/profiles/wordpress/discovery/output-contract.js";
import { buildWordPressSourceIndex } from "../../src/profiles/wordpress/discovery/storage-index.js";
import {
  openWordPressLab,
  type DockerRequest,
} from "../../src/profiles/wordpress/lab/index.js";
import type { ProgrammeIntelligence } from "../../src/profiles/wordpress/programme-intelligence/index.js";
import { loadWordpressScopePolicy } from "../../src/profiles/wordpress/scope-policy.js";
import { loadWordPressDiscoveryAsset } from "../../src/profiles/wordpress/prompts/index.js";
import type { RepeatTrialGate } from "../../src/profiles/wordpress/discovery/repeat-trial-gate.js";
import { createWordPressSelection } from "../../src/profiles/wordpress/selection/index.js";
import type { WordPressOrgListingObservation } from "../../src/profiles/wordpress/selection/wordpress-org-candidate-enumerator.js";
import { openSnapshot } from "../../src/snapshot/index.js";

const sha = (value: string) => `sha256:${value.repeat(64)}`;
const uuid = "0f1e2d3c-4b5a-4987-a654-3210fedcba98";
const now = "2026-10-08T00:00:00.000Z";
const syntheticTrialGate: RepeatTrialGate = {
  ensureReady: () => {},
  inspectInitialSlug: () => ({
    status: "coverage-incomplete",
    reason: "legacy-history-unverified",
  }),
  assertMayStart: () => {},
  reserve: () => {},
  bootstrap: () => ({ importedTrials: 0 }),
  importCoverage: () => sha("0"),
  approve: () => {},
};
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const profile = defineAgentRuntimeProfile({
  id: "synthetic",
  transportKind: "codex-native/v1",
  sandboxImageDigest: sha("d"),
  requestedModelId: "gpt-6.1-sol",
  requestedEffort: "high",
  codexCliVersion: "0.161.0",
  bundledCatalogDigest: sha("e"),
  authenticationMethod: "host-private-bearer",
  cyberAccessProgram: "standard",
  serviceTier: "priority",
  subagent: { modelId: "unavailable", effort: "unavailable" },
});

const claim = (impact: string, file: string) => ({
  claim: `Synthetic ${impact} claim`,
  attackerPosition: "subscriber",
  impact,
  configurationPrecondition: "default",
  brokenProperty: "Synthetic property",
  sourceTrace: [{ file, function: "synthetic_handler", line: 3 }],
  existingControls: "Synthetic control",
  labObservations: "Synthetic observation",
});

/** Real modules; only WordPress.org, Docker/runsc and the provider CLI are fakes. */
async function harness(
  options: {
    readonly scopeFacts?: Parameters<
      typeof createWordPressCliProfile
    >[0]["scopeFacts"];
    readonly repeatTrialGate?: RepeatTrialGate;
    readonly runBudget?: {
      readonly default: number;
      readonly highThreat: number;
    };
    /** Arm b fraction of a history ablation in the campaign config. */
    readonly ablation?: number;
    /** False selects the observed stable version instead of the 3.3.1 pin. */
    readonly pinned?: boolean;
    /** Opens a synthetic local Wordfence mirror holding one public record. */
    readonly history?: boolean;
    /** Provider calls (1-based) that the subscription refuses with a quota limit. */
    readonly limitOnCalls?: readonly number[];
    /** A completed child report survives a provider-limited Root Trial. */
    readonly childFindingOnLimitedCall?: boolean;
    readonly failOnCalls?: readonly number[];
    readonly leadsOnCalls?: Readonly<Record<number, readonly unknown[]>>;
    readonly zeroFindings?: boolean;
    /** Candidate slugs; the first is not pinned. */
    readonly candidates?: readonly string[];
    readonly listingObservations?: readonly WordPressOrgListingObservation[];
    /** Use the real bounded listing enumerator for inventory CLI tests. */
    readonly inventoryFetch?: typeof fetch;
    readonly inventoryObservationFails?: (slug: string) => boolean;
    readonly currentStableVersion?: (slug: string) => string;
    readonly programmeAvailable?: () => boolean;
    readonly programmeEligible?: () => boolean;
    readonly onResourceWait?: (reason: string) => void;
    /** A slug whose snapshot cannot be frozen. */
    readonly failFreeze?: string;
    /** Extra campaign config fields. */
    readonly config?: Readonly<Record<string, unknown>>;
    readonly entryPoints?: boolean;
    /** What the Codex image reports; defaults to the runtime profile's values. */
    readonly probe?: {
      readonly cliVersion: string;
      readonly bundledCatalogDigest: string;
    };
    readonly labProbeHttp?: "ok" | "failed";
    readonly labProvisionFailure?: boolean;
    readonly labMissingExtension?: boolean;
    readonly labSeedFailure?: boolean;
    readonly labSeedThrows?: boolean;
    readonly withResourceClaims?: boolean;
    readonly markCleanupUncertainOnCall?: number;
    /** The first Finding lacks a runnable recipe until a new Lab scenario is selected. */
    readonly firstVerifierIncomplete?: boolean;
    readonly verifierRecipeFailures?: number;
    readonly verifierLabProvisionFailures?: number;
    readonly coreSource?: boolean;
    readonly databaseAccess?: "read-only" | "none";
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "wbh-cli-"));
  directories.push(root);
  const cleanupScope =
    options.withResourceClaims === true ? new TargetResourceScope() : undefined;
  const sourceDirectory = join(root, "source");
  await mkdir(join(sourceDirectory, "includes"), { recursive: true });
  await writeFile(
    join(sourceDirectory, "includes", "synthetic.php"),
    options.entryPoints === true
      ? "<?php\nadd_action('wp_ajax_nopriv_synthetic_save', 'synthetic_save');\nadd_action('wp_ajax_nopriv_synthetic_load', 'synthetic_load');\nfunction synthetic_save() { update_option('synthetic_plugin_shared', 'value'); }\nfunction synthetic_load() { get_option('synthetic_plugin_shared'); }\n"
      : "<?php // harmless synthetic fixture\n",
  );
  await writeFile(
    join(sourceDirectory, "synthetic-plugin.php"),
    options.entryPoints === true
      ? "<?php\nadd_action('init', 'synthetic_boot');\nfunction synthetic_boot() {}\n"
      : "<?php // harmless synthetic fixture\n",
  );
  const tree = await measureCanonicalSourceTree(sourceDirectory, {
    maxEntries: 10,
    maxBytes: 10_000,
  });
  const files = ["includes/synthetic.php", "synthetic-plugin.php"];
  const manifest = {
    kind: "canonical-file-manifest" as const,
    schemaVersion: 1 as const,
    entries: await Promise.all(
      files.map(async (path) => {
        const bytes = await readFile(join(sourceDirectory, path));
        return {
          path,
          digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          size: bytes.byteLength,
        };
      }),
    ),
  };

  const docker: DockerRequest[] = [];
  // Docker resources the fake has created and not yet removed, so `lab down` sees real leftovers.
  const live = {
    containers: new Set<string>(),
    networks: new Set<string>(),
    volumes: new Set<string>(),
  };
  const track = (args: readonly string[]) => {
    const names = (from: number) =>
      args.slice(from).filter((arg) => !arg.startsWith("-"));
    if (args[0] === "run" || args[0] === "create") {
      const nameIndex = args.indexOf("--name");
      const name = nameIndex < 0 ? undefined : args[nameIndex + 1];
      if (name !== undefined) live.containers.add(name);
    } else if (args[0] === "rm")
      for (const name of names(1)) live.containers.delete(name);
    else if (args[0] === "network" || args[0] === "volume") {
      const kind = args[0] === "network" ? live.networks : live.volumes;
      if (args[1] === "create") kind.add(args.at(-1) ?? "");
      if (args[1] === "rm") for (const name of names(2)) kind.delete(name);
    }
  };
  // Whole-site state the capture reads around the Verifier run (#186); one option changes once the Verifier ran.
  let verifierAttempts = 0;
  const labState = (sql: string) => {
    if (sql === "SHOW TABLES") return "wp_options\nwp_users\nwp_usermeta\n";
    if (sql.startsWith("SELECT option_name"))
      return `blogname\tSynthetic\tyes\nsynthetic_plugin_shared\t${
        verifierAttempts === 0 ? "untouched" : `written-${verifierAttempts}`
      }\tno\n`;
    if (sql.startsWith("SELECT u.ID"))
      return (
        "1\tharness-admin\tadmin@lab.invalid\t2026-10-08 00:00:00\t" +
        `${"a".repeat(64)}\ta:1:{s:13:"administrator";b:1;}\n`
      );
    if (sql.startsWith("SELECT 'wp_"))
      return "wp_options\t2\nwp_users\t1\nwp_usermeta\t3\n";
    if (sql.startsWith("CHECKSUM TABLE"))
      return "wordpress.wp_options\t1\nwordpress.wp_users\t2\nwordpress.wp_usermeta\t3\n";
    return undefined;
  };
  const lab = openWordPressLab({
    dockerExecutablePath: "/usr/bin/docker",
    images: {
      database: `mariadb@${sha("1")}`,
      wordpress: `wordpress@${sha("2")}`,
      wordpressCli: `wordpress-cli@${sha("3")}`,
      browser: `verification-browser@${sha("4")}`,
      recorder: `node-recorder@${sha("5")}`,
    },
    source: {
      resolve: async () => ({
        target: {
          kind: "plugin",
          pluginSlug: "synthetic-plugin",
          sourceDirectory,
          sourceTree: tree,
        },
        dependencies: [],
      }),
    },
    runner: {
      async run(request) {
        docker.push(request);
        track(request.args);
        if (request.args[0] === "ps")
          return {
            exitCode: 0,
            stdout: [
              `wbh-${uuid}-db`,
              `wbh-${uuid}-wp`,
              `wbh-${uuid}-proxy`,
              `provider-egress-broker-${uuid}`,
              `codex-agent-${uuid}`,
              "operator-postgres",
              "wbh-notes",
              ...live.containers,
            ].join("\n"),
            stderr: "",
          };
        if (request.args[0] === "network" && request.args[1] === "ls")
          return {
            exitCode: 0,
            stdout: [
              `wbh-${uuid}-net`,
              `provider-egress-${uuid}`,
              "bridge",
              ...live.networks,
            ].join("\n"),
            stderr: "",
          };
        if (request.args[0] === "volume" && request.args[1] === "ls")
          return {
            exitCode: 0,
            stdout: [`wbh-${uuid}-site`, "operator-data", ...live.volumes].join(
              "\n",
            ),
            stderr: "",
          };
        if (request.args[0] === "exec" && request.args[2] === "mariadb") {
          const sql = request.args[request.args.indexOf("--execute") + 1];
          const stdout = sql === undefined ? undefined : labState(sql);
          if (stdout !== undefined) return { exitCode: 0, stdout, stderr: "" };
        }
        if (request.args[0] === "info")
          return { exitCode: 0, stdout: '{"runsc":{}}', stderr: "" };
        if (
          options.labMissingExtension === true &&
          request.args[0] === "exec" &&
          request.args[2] === "php" &&
          request.args[4]?.includes('extension_loaded("pdo_mysql")')
        )
          return { exitCode: 43, stdout: "", stderr: "" };
        if (
          options.labProvisionFailure === true &&
          request.args[0] === "network" &&
          request.args[1] === "create"
        )
          return { exitCode: 1, stdout: "", stderr: "fixture docker error" };
        if (
          options.labSeedFailure === true &&
          request.args.includes("wbh_canary_fixed-nonce") &&
          request.args.includes("add")
        )
          return { exitCode: 1, stdout: "", stderr: "fixture seed error" };
        if (request.args[0] === "inspect")
          return { exitCode: 0, stdout: "172.20.0.2", stderr: "" };
        if (request.args.some((arg) => arg.startsWith("SHOW TABLES FROM ")))
          return { exitCode: 0, stdout: "wp_options\nwp_posts\n", stderr: "" };
        if (request.args.includes("--entrypoint=php"))
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              http: options.labProbeHttp ?? "ok",
              database: request.args.some((arg) =>
                arg.startsWith("WBH_DB_USER="),
              )
                ? "ok"
                : "not-exposed",
            }),
            stderr: "",
          };
        if (request.args.includes("--field=roles"))
          return { exitCode: 0, stdout: "subscriber\n", stderr: "" };
        if (request.args.includes("eval"))
          return {
            exitCode: 0,
            stdout: request.args.includes(
              "WBH_SESSION_COOKIE=synthetic-victim-session",
            )
              ? "wbh-canary-admin-fixed-nonce\n"
              : "\n",
            stderr: "",
          };
        if (request.args.includes("--porcelain"))
          return { exitCode: 0, stdout: "7", stderr: "" };
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    },
    nonce: () => "fixed-nonce",
    healthAttempts: 1,
    ...(cleanupScope === undefined
      ? {}
      : {
          onCleanupUncertain: () => cleanupScope.markCleanupUncertain(),
        }),
  });

  const selection = createWordPressSelection({
    targetSource: {
      observe: async ({ slug }: { slug: string }) =>
        options.inventoryObservationFails?.(slug) === true
          ? {
              status: "failed" as const,
              operation: "observe" as const,
              reason: "not-found" as const,
              pluginIdentity: `wporg:${slug}`,
            }
          : {
              status: "observed",
              observation: {
                kind: "wordpress-org-target-observation",
                schemaVersion: 1,
                pluginIdentity: `wporg:${slug}`,
                officialSlug: slug,
                displayName: slug,
                stableVersion: options.currentStableVersion?.(slug) ?? "9.9.9",
                minimumWordPressVersion: "6.0",
                activeInstallations: 5000,
                lastUpdated: "2026-09-01 12:00am GMT",
                observedAt: now,
                author: "Independent Author",
                tags: [],
                intelligenceSource: {
                  kind: "wordpress-org-plugin-directory",
                  sourceUrl: "https://api.wordpress.org/plugins/info/1.2/",
                  retrievedAt: now,
                  contentDigest: sha("b"),
                  parserVersion: "wordpress-org-plugin-information-v1",
                },
                downloadProvenance: {
                  sourceUrl: `https://downloads.wordpress.org/plugin/${slug}.${options.currentStableVersion?.(slug) ?? "9.9.9"}.zip`,
                },
              },
              observationRef: {
                kind: "wordpress-org-target-observation-ref",
                schemaVersion: 1,
                id: `observation-${slug}`,
                digest: sha("c"),
              },
            },
    } as unknown as WordPressOrgTargetSource,
    programme: {
      inspect: async () =>
        options.programmeAvailable?.() === false
          ? { status: "stale", reason: "snapshot-expired" }
          : {
              status: "current",
              snapshotRef: programmeRef,
              snapshot: {
                programmeIdentity: "programme:wordfence",
                policy: {
                  programmeOpportunityBand:
                    options.programmeEligible?.() === false
                      ? "research-only"
                      : "high-impact-only",
                  eligibility: {
                    assets: [
                      {
                        kind: "wordpress-plugin",
                        scope: "publicly-distributed",
                      },
                    ],
                  },
                },
              },
            },
    } as unknown as ProgrammeIntelligence,
    programmeRef,
    clock: () => new Date(now),
    ...(options.inventoryFetch === undefined
      ? {
          enumerateCandidates: async () => ({
            status: "available" as const,
            candidates: (options.candidates ?? ["synthetic-plugin"]).map(
              (slug) => ({
                slug,
                sourceKind: "popular" as const,
                sourcePage: 1,
                sourceUrl: "https://api.wordpress.org/plugins/info/1.2/",
                observedAt: now,
                contentDigest: sha("b"),
              }),
            ),
            listings: options.listingObservations ?? [],
            traversal: {
              listingSetDigest: sha("b"),
              offset: 0,
              observedUniqueCandidates: (
                options.candidates ?? ["synthetic-plugin"]
              ).length,
              complete: true,
            },
          }),
        }
      : { fetch: options.inventoryFetch }),
  });
  const snapshots = openSnapshot({
    storageDirectory: join(root, "snapshots"),
    source: {
      acquire: async (target: { targetId: string; version: string }) => ({
        target: {
          identity: target.targetId,
          version: target.version,
          manifest,
          readFile: (path: string) => readFile(join(sourceDirectory, path)),
        },
        dependencies: [],
      }),
    },
  });
  await mkdir(join(root, "snapshots"));
  const frozen = new Map<
    string,
    Awaited<ReturnType<typeof snapshots.freeze>>
  >();

  const attachments = new ProviderAttachmentStore(join(root, "provider"));
  const prompts: string[] = [];
  const promptDigests: string[] = [];
  const entryIndexes: DiscoveryTransportRun["campaignInput"]["entryIndex"][] =
    [];
  const histories: string[] = [];
  const coordinations: (DiscoveryTransportRun["coordination"] | undefined)[] =
    [];
  const expirations: string[] = [];
  const verifierReferenceRoutes: unknown[] = [];
  const labIdsDuringVerification: string[][] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let verificationProvisionAttempts = 0;
  const boundaries: WordPressCampaignBoundaries = {
    selection,
    freeze: async (target) => {
      if (target.slug === options.failFreeze)
        throw new Error("Synthetic download failure");
      const snapshot = await snapshots.freeze(target);
      frozen.set(snapshot.digest, snapshot);
      return snapshot;
    },
    loadSnapshot: async (digest) => {
      const snapshot = frozen.get(digest);
      if (snapshot === undefined)
        throw new Error("Synthetic Snapshot is absent");
      return snapshot;
    },
    lab: {
      ...lab,
      ...(options.labSeedThrows === true
        ? {
            seedCanaries: async () => {
              throw new Error("Synthetic seed exception");
            },
          }
        : {}),
      provision: async (...args: Parameters<typeof lab.provision>) => {
        if (args[2]?.purpose === "verification") {
          verificationProvisionAttempts++;
          if (
            verificationProvisionAttempts <=
            (options.verifierLabProvisionFailures ?? 0)
          )
            throw new Error("Synthetic verification Lab provision failure");
        }
        return lab.provision(...args);
      },
    },
    sourceFor: async () => ({
      directory: sourceDirectory,
      tree,
      ...(options.coreSource === true
        ? { dependency: { directory: sourceDirectory, tree } }
        : {}),
    }),
    runtimeProfile: profile,
    probeRuntime: async () =>
      options.probe ?? {
        cliVersion: profile.codexCliVersion,
        bundledCatalogDigest: profile.bundledCatalogDigest,
      },
    attachments,
    executor: {
      async execute(run: DiscoveryTransportRun) {
        const call = prompts.push(run.prompt);
        if (options.markCleanupUncertainOnCall === call)
          cleanupScope?.markCleanupUncertain();
        promptDigests.push(run.campaignInput.promptDigest);
        entryIndexes.push(run.campaignInput.entryIndex);
        histories.push(run.campaignInput.history.mode);
        coordinations.push(run.coordination);
        expirations.push(run.expiresAt);
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        if (options.limitOnCalls?.includes(call) === true) {
          const childAttachment =
            options.childFindingOnLimitedCall === true
              ? await attachments.put(
                  "findings",
                  Buffer.from(
                    JSON.stringify({
                      findings: [
                        claim("account-takeover", "includes/synthetic.php"),
                      ],
                      leads: [],
                      examined: "child source",
                      unexamined: "none",
                    }),
                  ),
                )
              : undefined;
          return {
            receipt: createNativeRunReceipt({
              runId: run.runId,
              targetSnapshotDigest: run.targetSnapshotDigest,
              profile: run.profile,
              terminal: "incomplete",
              reason: "provider",
              providerLimit: "quota",
              startedAt: now,
              completedAt: now,
            }),
            ...(childAttachment === undefined
              ? {}
              : {
                  agentRuns: [
                    {
                      agentPath: "/root/child-1",
                      attachment: childAttachment,
                      receipt: createNativeRunReceipt({
                        runId: `${run.runId}-child`,
                        targetSnapshotDigest: run.targetSnapshotDigest,
                        profile: run.profile,
                        terminal: "completed",
                        reason: "unavailable",
                        startedAt: now,
                        completedAt: now,
                        reportArtifactDigest: childAttachment.digest,
                      }),
                    },
                  ],
                }),
          };
        }
        if (options.failOnCalls?.includes(call) === true)
          return {
            receipt: createNativeRunReceipt({
              runId: run.runId,
              targetSnapshotDigest: run.targetSnapshotDigest,
              profile: run.profile,
              terminal: "incomplete",
              reason: "sandbox",
              reasonDetail: "cli-exit:137",
              startedAt: now,
              completedAt: now,
            }),
          };
        const report = {
          findings:
            call === 1 && !options.zeroFindings
              ? [
                  claim("account-takeover", "includes/synthetic.php"),
                  claim("sensitive-object-access", "synthetic-plugin.php"),
                ]
              : [],
          leads: options.leadsOnCalls?.[call] ?? [],
          examined: "synthetic",
          unexamined: "none",
        };
        const attachment = await attachments.put(
          "findings",
          Buffer.from(JSON.stringify(report)),
        );
        return {
          attachment,
          receipt: createNativeRunReceipt({
            runId: run.runId,
            targetSnapshotDigest: run.targetSnapshotDigest,
            profile: run.profile,
            terminal: "completed",
            reason: "unavailable",
            startedAt: now,
            completedAt: "2026-10-08T00:00:02.000Z",
            reportArtifactDigest: attachment.digest,
            usage: {
              inputTokens: 1000,
              cachedInputTokens: 100,
              outputTokens: 20,
              reasoningOutputTokens: "unavailable",
            },
          }),
        };
      },
    },
    verifier: {
      // A fresh-container Verifier; it hands back a recipe, never a verdict.
      async attempt(input) {
        verifierReferenceRoutes.push(input.referenceRoute);
        labIdsDuringVerification.push(
          [...live.containers].flatMap((name) => {
            const id = /^wbh-([0-9a-f-]{36})-wp$/.exec(name)?.[1];
            return id === undefined ? [] : [id];
          }),
        );
        const attempt = ++verifierAttempts;
        if (attempt <= (options.verifierRecipeFailures ?? 0))
          return {
            status: "incomplete",
            reason: "recipe",
            nextStep: "Repeat the synthetic recipe",
          };
        if (attempt === 1 && options.firstVerifierIncomplete === true)
          return {
            status: "incomplete",
            reason: "precondition",
            nextStep: "Repeat with another ordinary Lab scenario",
          };
        return {
          status: "attempted",
          recipeDigest: await state.store.putFiles({
            "route.json": JSON.stringify({
              role: "subscriber",
              account: "lab-subscriber",
              defaultSettings: true,
              configurationChanges: [],
              steps: [
                {
                  kind: "http",
                  method: "GET",
                  path: "/synthetic",
                  expected: "Synthetic observation",
                },
              ],
            }),
            "http.json": JSON.stringify([{ status: 200 }]),
            "session.json": JSON.stringify({
              cookie: "synthetic-victim-session",
            }),
          }),
        };
      },
    },
  };
  let state: Parameters<
    Parameters<typeof createWordPressCliProfile>[0]["boundaries"]
  >[1];
  let ids = 0;
  const resourceClaims = options.withResourceClaims
    ? new SqliteHostResourceClaims(
        join(root, "host-resources.sqlite"),
        { maxTargets: 1, providers: { codex: 1 } },
        () => new Date(now),
      )
    : undefined;
  const environment = {
    stateDirectory: join(root, "state"),
    clock: () => new Date(now),
    newId: () => `id-${++ids}`,
    profile: createWordPressCliProfile({
      repeatTrialGate: options.repeatTrialGate ?? syntheticTrialGate,
      ...(resourceClaims === undefined ? {} : { resourceClaims }),
      ...(options.onResourceWait === undefined
        ? {}
        : { onResourceWait: options.onResourceWait }),
      ...(cleanupScope === undefined ? {} : { cleanupScope }),
      scopePolicy: await loadWordpressScopePolicy(),
      ...(options.scopeFacts === undefined
        ? {}
        : { scopeFacts: options.scopeFacts }),
      ...(options.history === true
        ? { wordfenceHistory: syntheticMirror(root) }
        : {}),
      boundaries: async (_config, opened) => {
        state = opened;
        return boundaries;
      },
      selectionBoundaries: async (opened) => {
        state = opened;
        return boundaries;
      },
    }),
  };
  const policyPath = join(root, "selection.json");
  await writeFile(
    policyPath,
    JSON.stringify({
      kind: "wordpress-selection-policy",
      schemaVersion: 1,
      id: "synthetic-pin",
      candidateSlugs: options.candidates ?? ["synthetic-plugin"],
      pinnedVersions:
        options.pinned === false ? {} : { "synthetic-plugin": "3.3.1" },
      minimumActiveInstallations: 500,
      maximumObservationAgeDays: 2,
      maximumUpdateAgeDays: 365,
      maximumTargets: options.candidates?.length ?? 1,
      excludedAuthors: [],
      excludedSlugs: [],
      surfaceTagWeights: {},
      highThreatTags: [],
      scoreWeights: { installations: 1, recency: 1, surface: 1, highThreat: 1 },
      runBudget: options.runBudget ?? { default: 40, highThreat: 40 },
    }),
  );
  const configPath = join(root, "campaign.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      selectionPolicyPath: policyPath,
      // Legacy campaign fixtures exercise the historical multi-Trial path.
      promptId: "short-objective-managed-v4",
      programmeBoundary: {
        version: "v1",
        text: "Synthetic programme boundary",
      },
      stopRules: { maxRuns: 6, noFindingRuns: 2 },
      ...(options.ablation === undefined
        ? {}
        : { ablation: { axis: "history", armBFraction: options.ablation } }),
      // Sequential by default so the call order is deterministic.
      resources: { maxConcurrentRuns: 1, memoryBudgetMiB: 10_240 },
      ...options.config,
      wordpressVersion: "6.8",
      lab: {
        siteTitle: "Synthetic",
        initialPosts: ["Welcome"],
        customerRole: false,
        ...(options.databaseAccess === undefined
          ? {}
          : { databaseAccess: options.databaseAccess }),
      },
    }),
  );
  const keysPath = join(root, "keys.json");
  await writeFile(
    keysPath,
    JSON.stringify([
      {
        schemaVersion: 1,
        caseId: "synthetic-case",
        cohort: "first-party",
        entryPoint: { kind: "ajax-action", action: "synthetic_action" },
        violatedProperty: "Synthetic property",
        missingCheck: "Synthetic check",
        attackerPosition: "subscriber",
        impact: "account-takeover",
        allowedLocations: [{ file: "includes/synthetic.php" }],
        publishedAt: "2026-01-02",
        modelCutoff: "2026-01-01",
      },
    ]),
  );
  const run = async (...argv: string[]) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(argv, environment, {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  };
  return {
    run,
    configPath,
    keysPath,
    prompts,
    promptDigests,
    entryIndexes,
    histories,
    coordinations,
    expirations,
    verifierReferenceRoutes,
    labIdsDuringVerification,
    docker,
    live,
    root,
    ledger: () => state.ledger,
    state: () => state,
    profile: environment.profile,
    store: () => state.store,
    maxInFlight: () => maxInFlight,
    verificationProvisionAttempts: () => verificationProvisionAttempts,
    resourceClaims,
  };
}

/** A local mirror with one public record for the synthetic plugin, published before its last update. */
function syntheticMirror(root: string) {
  const databasePath = join(root, "wordfence.sqlite");
  const statePath = join(root, "wordfence-state.json");
  const db = new Database(databasePath);
  db.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE vulnerabilities (id TEXT PRIMARY KEY, title TEXT NOT NULL, published TEXT, record_json TEXT NOT NULL);
    CREATE TABLE software (vulnerability_id TEXT NOT NULL, slug TEXT NOT NULL, type TEXT, name TEXT, PRIMARY KEY(vulnerability_id, slug));
    CREATE TABLE signals (vulnerability_id TEXT NOT NULL, slug TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(vulnerability_id, slug, kind, value));
  `);
  for (const [key, value] of [
    ["projection_schema", "wordfence-history/v1"],
    ["content_sha256", "synthetic-digest"],
    ["record_count", "1"],
  ])
    db.prepare("INSERT INTO metadata VALUES (?, ?)").run(key, value);
  db.prepare("INSERT INTO vulnerabilities VALUES (?, ?, ?, ?)").run(
    "synthetic-public-record",
    "Synthetic public title",
    "2026-08-01 00:00:00",
    JSON.stringify({
      software: [
        {
          slug: "synthetic-plugin",
          affected_versions: { "1.0 - 1.4": {} },
          patched_versions: ["1.5"],
        },
      ],
    }),
  );
  db.prepare("INSERT INTO software VALUES (?, ?, ?, ?)").run(
    "synthetic-public-record",
    "synthetic-plugin",
    "plugin",
    "Synthetic",
  );
  db.close();
  writeFileSync(
    statePath,
    JSON.stringify({
      schema_version: "wordfence-cache/v1",
      content_sha256: "synthetic-digest",
      record_count: 1,
      last_successful_at: "2026-10-01T00:00:00Z",
      stale_fallback: false,
    }),
  );
  return {
    databasePath,
    statePath,
  };
}

const programmeRef = {
  kind: "programme-eligibility-snapshot-ref" as const,
  schemaVersion: 1 as const,
  id: "wordfence-policy",
  digest: sha("a"),
};

describe("harness CLI vertical slice", () => {
  it("holds a pinned automatic target when its stable version changes during a claim wait", async () => {
    let stableVersion = "9.9.9";
    let releaseBlocker = () => {};
    const {
      run,
      configPath,
      root,
      state,
      ledger,
      resourceClaims,
      docker,
      prompts,
    } = await harness({
      candidates: ["synthetic-plugin", "second-plugin", "third-plugin"],
      withResourceClaims: true,
      currentStableVersion: () => stableVersion,
      onResourceWait: () => {
        stableVersion = "10.0.0";
        releaseBlocker();
      },
    });
    if (resourceClaims === undefined) throw new Error("Missing claims");
    try {
      const policyPath = join(root, "selection.json");
      const manual = JSON.parse(await readFile(policyPath, "utf8")) as Record<
        string,
        unknown
      >;
      delete manual.candidateSlugs;
      delete manual.pinnedVersions;
      await writeFile(
        policyPath,
        JSON.stringify({
          ...manual,
          promptVariant: "short-objective-managed-v4",
          revisitPolicy: { kind: "never" },
          wordpressVersion: "6.8",
          maximumTargets: 3,
          candidateSource: {
            kind: "wordpress-org",
            popularPages: 1,
            tags: [],
            pagesPerTag: 1,
            perPage: 3,
            maxCandidates: 5,
            maxAgeDays: 1,
          },
        }),
      );
      expect((await run("select", "--config", policyPath)).code).toBe(0);
      const selectionBatch = ledger()
        .read({ type: "target-selected", limit: 10 })
        .filter(({ event }) => event.campaignId.startsWith("selection-"));
      const reserved = selectionBatch.find(
        ({ event }) =>
          event.campaignId.startsWith("selection-") &&
          event.type === "target-selected" &&
          event.selectionId === "wporg:synthetic-plugin@9.9.9",
      );
      expect(reserved).toBeDefined();
      const blocker = resourceClaims.tryAcquire({
        targetKey: "wordpress:plugin:synthetic-plugin",
        ownerKey: "run:synthetic-blocker",
        ownerPid: process.pid,
        stateDirectory: state().stateDirectory,
        campaignId: "other-campaign",
        snapshotDigest: sha("f"),
        providerKeys: ["codex"],
        leaseDurationMs: 60_000,
      });
      if (blocker.status !== "acquired") throw new Error("Missing blocker");
      releaseBlocker = () => resourceClaims.release(blocker.handle);
      const result = await run(
        "campaign",
        "run",
        "synthetic-plugin",
        "--campaign",
        "freshness-child",
        "--config",
        configPath,
      );
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("target-version-changed");
      expect(result.stderr).toContain("held wporg:synthetic-plugin 9.9.9");
      expect(resourceClaims.status().usedTargets).toBe(0);
      expect(docker).toHaveLength(0);
      expect(prompts).toHaveLength(0);
      expect(
        ledger().read({
          campaignId: "freshness-child",
          type: "lab-provisioned",
        }),
      ).toHaveLength(0);
      expect(
        ledger().read({
          campaignId: "freshness-child",
          type: "discovery-run-started",
        }),
      ).toHaveLength(0);
      expect(
        ledger().read({
          campaignId: "freshness-child",
          type: "target-skipped",
        }),
      ).toHaveLength(0);
      expect(
        ledger().read({
          campaignId: "freshness-child",
          type: "selection-batch-bound",
        })[0]?.event,
      ).toMatchObject({
        selectionIds: ["wporg:synthetic-plugin@9.9.9"],
        snapshotDigest: selectionBatch[0]?.event.snapshotDigest,
      });
      expect(
        ledger()
          .read({
            campaignId: reserved!.event.campaignId,
            type: "target-selected",
          })
          .find(
            ({ event }) =>
              event.type === "target-selected" &&
              event.selectionId === "wporg:synthetic-plugin@9.9.9",
          )?.event.snapshotDigest,
      ).toBe(reserved?.event.snapshotDigest);
    } finally {
      resourceClaims.close();
    }
  }, 10_000);

  it("releases the claim on unavailable Programme and can resume the same pinned batch", async () => {
    let programmeAvailable = true;
    let programmeEligible = true;
    const { run, configPath, root, ledger, resourceClaims, docker, prompts } =
      await harness({
        candidates: ["synthetic-plugin", "second-plugin", "third-plugin"],
        withResourceClaims: true,
        zeroFindings: true,
        programmeAvailable: () => programmeAvailable,
        programmeEligible: () => programmeEligible,
        config: { stopRules: { maxRuns: 1, noFindingRuns: 1 } },
      });
    if (resourceClaims === undefined) throw new Error("Missing claims");
    try {
      const policyPath = join(root, "selection.json");
      const manual = JSON.parse(await readFile(policyPath, "utf8")) as Record<
        string,
        unknown
      >;
      delete manual.candidateSlugs;
      delete manual.pinnedVersions;
      await writeFile(
        policyPath,
        JSON.stringify({
          ...manual,
          promptVariant: "short-objective-managed-v4",
          revisitPolicy: { kind: "never" },
          wordpressVersion: "6.8",
          maximumTargets: 3,
          candidateSource: {
            kind: "wordpress-org",
            popularPages: 1,
            tags: [],
            pagesPerTag: 1,
            perPage: 3,
            maxCandidates: 5,
            maxAgeDays: 1,
          },
        }),
      );
      expect((await run("select", "--config", policyPath)).code).toBe(0);
      programmeAvailable = false;
      const held = await run(
        "campaign",
        "run",
        "synthetic-plugin",
        "--campaign",
        "programme-child",
        "--config",
        configPath,
      );
      expect(held.code).toBe(3);
      expect(held.stderr).toContain("target-observation-unavailable");
      expect(resourceClaims.status().usedTargets).toBe(0);
      expect(docker).toHaveLength(0);
      expect(prompts).toHaveLength(0);
      programmeAvailable = true;
      programmeEligible = false;
      const ineligible = await run(
        "campaign",
        "run",
        "synthetic-plugin",
        "--campaign",
        "programme-child",
        "--config",
        configPath,
      );
      expect(ineligible.code).toBe(3);
      expect(ineligible.stderr).toContain("target-eligibility-changed");
      expect(resourceClaims.status().usedTargets).toBe(0);
      expect(docker).toHaveLength(0);
      programmeEligible = true;
      const resumed = await run(
        "campaign",
        "run",
        "synthetic-plugin",
        "--campaign",
        "programme-child",
        "--config",
        configPath,
      );
      expect(resumed.code).toBe(0);
      expect(prompts).toHaveLength(1);
      expect(resourceClaims.status().usedTargets).toBe(0);
      expect(
        ledger().read({
          campaignId: "programme-child",
          type: "selection-batch-bound",
        }),
      ).toHaveLength(1);
    } finally {
      resourceClaims.close();
    }
  });

  it("allows an intentionally pinned manual release after the public stable version changes", async () => {
    let stableVersion = "9.9.9";
    const { run, configPath, resourceClaims, prompts } = await harness({
      withResourceClaims: true,
      zeroFindings: true,
      currentStableVersion: () => stableVersion,
      config: { stopRules: { maxRuns: 1, noFindingRuns: 1 } },
    });
    if (resourceClaims === undefined) throw new Error("Missing claims");
    try {
      expect((await run("select", "--config", configPath)).code).toBe(0);
      stableVersion = "10.0.0";
      const result = await run(
        "campaign",
        "run",
        "synthetic-plugin",
        "--campaign",
        "manual-pin-child",
        "--config",
        configPath,
      );
      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain("target-version-changed");
      expect(prompts).toHaveLength(1);
    } finally {
      resourceClaims.close();
    }
  });

  it("serializes concurrent runs of the same campaign target and releases a clean claim", async () => {
    const { run, configPath, ledger, resourceClaims } = await harness({
      withResourceClaims: true,
      zeroFindings: true,
      config: { stopRules: { maxRuns: 1, noFindingRuns: 1 } },
    });
    if (resourceClaims === undefined) throw new Error("missing claims");
    try {
      const args = [
        "campaign",
        "run",
        "--all",
        "--campaign",
        "shared-target",
        "--config",
        configPath,
      ];
      const outcomes = await Promise.all([run(...args), run(...args)]);
      expect(outcomes.map((outcome) => outcome.code)).toEqual([0, 0]);
      expect(
        ledger().read({
          campaignId: "shared-target",
          type: "discovery-run-started",
        }),
      ).toHaveLength(1);
      expect(resourceClaims.status().usedTargets).toBe(0);
    } finally {
      resourceClaims.close();
    }
  });

  it("holds an uncertain Lab provision claim for recovery", async () => {
    const { run, configPath, resourceClaims } = await harness({
      withResourceClaims: true,
      labProvisionFailure: true,
    });
    if (resourceClaims === undefined) throw new Error("missing claims");
    try {
      const result = await run(
        "campaign",
        "run",
        "synthetic-plugin",
        "--campaign",
        "uncertain-lab",
        "--config",
        configPath,
      );
      expect(result.code).toBe(3);
      expect(resourceClaims.status().claims).toMatchObject([
        {
          targetKey: "wordpress:plugin:synthetic-plugin",
          status: "recovery-needed",
        },
      ]);
    } finally {
      resourceClaims.close();
    }
  });

  it("releases a claim after an incomplete Lab provision that cleaned up", async () => {
    const { run, configPath, resourceClaims } = await harness({
      withResourceClaims: true,
      labMissingExtension: true,
    });
    if (resourceClaims === undefined) throw new Error("missing claims");
    try {
      const result = await run(
        "campaign",
        "run",
        "synthetic-plugin",
        "--campaign",
        "clean-incomplete-lab",
        "--config",
        configPath,
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("incomplete(precondition)");
      expect(resourceClaims.status().usedTargets).toBe(0);
    } finally {
      resourceClaims.close();
    }
  });

  it("stops slot waiters after uncertain Lab cleanup instead of waiting on its own claim", async () => {
    const { run, configPath, resourceClaims, ledger } = await harness({
      withResourceClaims: true,
      candidates: ["synthetic-plugin", "second-plugin"],
      labProvisionFailure: true,
      config: {
        resources: {
          maxConcurrentRuns: 1,
          maxConcurrentTargets: 2,
          memoryBudgetMiB: 10_240,
        },
      },
    });
    if (resourceClaims === undefined) throw new Error("missing claims");
    try {
      const result = await run(
        "campaign",
        "run",
        "--all",
        "--campaign",
        "failed-lab-two-targets",
        "--config",
        configPath,
      );
      expect(result.code).toBe(3);
      expect(resourceClaims.status().usedTargets).toBe(1);
      expect(
        ledger().read({
          campaignId: "failed-lab-two-targets",
          type: "discovery-run-started",
        }),
      ).toHaveLength(0);
    } finally {
      resourceClaims.close();
    }
  }, 10_000);

  it("cancels a waiting target when another target hits the provider limit", async () => {
    const { run, configPath, resourceClaims, ledger } = await harness({
      withResourceClaims: true,
      candidates: ["synthetic-plugin", "second-plugin"],
      limitOnCalls: [1],
      zeroFindings: true,
      config: {
        stopRules: { maxRuns: 1, noFindingRuns: 1 },
        resources: {
          maxConcurrentRuns: 1,
          maxConcurrentTargets: 2,
          memoryBudgetMiB: 10_240,
        },
      },
    });
    if (resourceClaims === undefined) throw new Error("missing claims");
    try {
      const result = await run(
        "campaign",
        "run",
        "--all",
        "--campaign",
        "provider-stop-two-targets",
        "--config",
        configPath,
      );
      expect(result.code).toBe(3);
      expect(resourceClaims.status().usedTargets).toBe(0);
      expect(
        ledger().read({
          campaignId: "provider-stop-two-targets",
          type: "discovery-run-started",
        }),
      ).toHaveLength(1);
    } finally {
      resourceClaims.close();
    }
  }, 10_000);

  it("retains a claim when auxiliary cleanup is uncertain even if the campaign Lab was removed", async () => {
    const { run, configPath, resourceClaims, ledger } = await harness({
      withResourceClaims: true,
      markCleanupUncertainOnCall: 1,
      zeroFindings: true,
      config: { stopRules: { maxRuns: 1, noFindingRuns: 1 } },
    });
    if (resourceClaims === undefined) throw new Error("missing claims");
    try {
      const result = await run(
        "campaign",
        "run",
        "--all",
        "--campaign",
        "auxiliary-cleanup",
        "--config",
        configPath,
      );
      expect(result.code).toBe(3);
      expect(
        ledger().read({
          campaignId: "auxiliary-cleanup",
          type: "discovery-run-started",
        }),
      ).toHaveLength(1);
      expect(resourceClaims.status().claims).toMatchObject([
        { status: "recovery-needed" },
      ]);
    } finally {
      resourceClaims.close();
    }
  });

  it("records a measured evaluation block with a bounded reason code", async () => {
    const { run, ledger, configPath } = await harness();
    expect((await run("select", "--config", configPath)).code).toBe(0);
    const args = [
      "eval",
      "case-blocked",
      "--campaign",
      "benchmark-case",
      "--case",
      "case-a",
      "--snapshot",
      sha("a"),
      "--stage",
      "lab",
      "--reason",
      "external-service-unavailable",
    ];
    expect((await run(...args)).code).toBe(0);
    expect(ledger().read({ type: "evaluation-case-blocked" })).toMatchObject([
      {
        event: {
          campaignId: "benchmark-case",
          caseId: "case-a",
          stage: "lab",
          reason: "external-service-unavailable",
        },
      },
    ]);
    expect((await run(...args.slice(0, -1), "arbitrary text")).code).toBe(2);
    expect(ledger().read({ type: "evaluation-case-blocked" })).toHaveLength(1);
  });

  it("prints only digest references for private keys and blind rubric forms", async () => {
    const { run, keysPath, root } = await harness();
    const keys = await run("eval", "keys", "--keys", keysPath);
    expect(keys.code).toBe(0);
    expect(JSON.parse(keys.stdout)).toMatchObject({
      schemaVersion: 1,
      keys: [
        { caseId: "synthetic-case", digest: expect.stringMatching(/^sha256:/) },
      ],
    });
    expect(keys.stdout).not.toContain("Synthetic property");
    expect(keys.stdout).not.toContain("includes/synthetic.php");
    const manifestPath = join(root, "key-digests.json");
    await writeFile(manifestPath, keys.stdout);
    const verified = await run(
      "eval",
      "score",
      "--campaign",
      "synthetic-campaign",
      "--keys",
      keysPath,
      "--case",
      "synthetic-case",
      "--manifest",
      manifestPath,
    );
    expect(verified.code).toBe(0);
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        keys: [
          { caseId: "synthetic-case", digest: `sha256:${"0".repeat(64)}` },
        ],
      }),
    );
    const rejected = await run(
      "eval",
      "score",
      "--campaign",
      "synthetic-campaign",
      "--keys",
      keysPath,
      "--case",
      "synthetic-case",
      "--manifest",
      manifestPath,
    );
    expect(rejected.code).toBe(2);
    expect(rejected.stderr).toContain("digest differs");
    expect(rejected.stderr).not.toContain("Synthetic property");
    const invalidKeysPath = join(root, "invalid-keys.json");
    await writeFile(
      invalidKeysPath,
      JSON.stringify([{ privateAnswer: "PRIVATE-SYNTHETIC-ANSWER" }]),
    );
    const invalid = await run("eval", "keys", "--keys", invalidKeysPath);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).not.toContain("PRIVATE-SYNTHETIC-ANSWER");

    const rubricPath = join(root, "rubric.json");
    await writeFile(
      rubricPath,
      JSON.stringify([
        {
          schemaVersion: 1,
          caseId: "synthetic-case",
          findingId: "synthetic-finding",
          location: { rating: "match" },
          rootCause: { rating: "partial", note: "Private explanation" },
          attackerConditions: { rating: "unknown" },
          impact: { rating: "mismatch" },
          verdict: "partial",
          assessedBy: "human",
          assessedAt: "2026-10-10T00:00:00Z",
        },
      ]),
    );
    const rubric = await run("eval", "rubric", "--file", rubricPath);
    expect(rubric.code).toBe(0);
    expect(JSON.parse(rubric.stdout)).toMatchObject({
      entries: 1,
      digest: expect.stringMatching(/^sha256:/),
    });
    expect(rubric.stdout).not.toContain("Private explanation");
  });

  it("records read-only DB access without storing its account in the ledger", async () => {
    const { run, configPath, prompts, ledger } = await harness();
    await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-db",
      "--config",
      configPath,
    );
    expect(prompts[0]).toContain(
      "Database (read-only, Lab only): host database port 3306",
    );
    expect(prompts[0]).not.toContain("## Finding and Lead output contract");
    const started = ledger()
      .read({ type: "discovery-run-started" })
      .at(0)?.event;
    expect(started).toMatchObject({
      configuration: { labAccess: { database: "read-only" } },
    });
    if (started?.type === "discovery-run-started")
      expect(started.configuration.contractDigest).toBeUndefined();
    expect(JSON.stringify(started)).not.toContain("wbh_reader");
  });

  it.each([
    {
      promptId: "short-objective-managed-v5",
      config: { promptId: "short-objective-managed-v5" },
    },
    {
      promptId: "wp2shell-bounty-v3",
      config: {
        mode: "wp2shell",
        promptId: "wp2shell-bounty-v3",
        stopRules: { maxRuns: 1, noFindingRuns: 1 },
      },
    },
    {
      promptId: "wp2shell-bounty-v4",
      config: {
        mode: "wp2shell",
        promptId: "wp2shell-bounty-v4",
        stopRules: { maxRuns: 1, noFindingRuns: 1 },
      },
    },
    {
      promptId: "wp2shell-whitebox-v1.7",
      config: {
        promptId: "wp2shell-whitebox-v1.7",
        stopRules: { maxRuns: 1, noFindingRuns: 1 },
      },
    },
  ] as const)(
    "adds the generated contract to $promptId and records separate digests",
    async ({ promptId, config }) => {
      const { run, configPath, prompts, ledger } = await harness({
        config,
      });
      const result = await run(
        "campaign",
        "run",
        "synthetic-plugin",
        "--campaign",
        "campaign-contract",
        "--config",
        configPath,
      );
      expect(result.code).toBe(0);
      const objective = await loadWordPressDiscoveryAsset(promptId);
      const contract =
        promptId === "short-objective-managed-v5"
          ? wordPressDiscoveryOutputContract()
          : wordPressDiscoveryOutputContractV2();
      expect(prompts[0]).toContain(objective.text.trim());
      expect(prompts[0]).toContain(contract.text);
      expect(prompts[0]?.split(contract.text)).toHaveLength(2);
      const started = ledger()
        .read({
          campaignId: "campaign-contract",
          type: "discovery-run-started",
        })
        .at(0)?.event;
      expect(started).toMatchObject({
        configuration: {
          promptVariant: objective.id,
          promptDigest: objective.digest,
          objectiveDigest: objective.digest,
          contractDigest: contract.digest,
        },
      });
    },
  );

  it("keeps explicit v2 on its archived prompt contract", async () => {
    const { run, configPath, prompts, ledger } = await harness({
      config: {
        mode: "wp2shell",
        promptId: "wp2shell-bounty-v2",
        stopRules: { maxRuns: 1, noFindingRuns: 1 },
      },
    });
    const result = await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-v2-compat",
      "--config",
      configPath,
    );
    expect(result.code).toBe(0);
    const objective = await loadWordPressDiscoveryAsset("wp2shell-bounty-v2");
    expect(prompts[0]).toContain(objective.text.trim());
    expect(prompts[0]).not.toContain(wordPressDiscoveryOutputContract().text);
    const started = ledger()
      .read({ campaignId: "campaign-v2-compat", type: "discovery-run-started" })
      .at(0)?.event;
    expect(started).toMatchObject({
      configuration: {
        promptVariant: objective.id,
        promptDigest: objective.digest,
      },
    });
    if (started?.type === "discovery-run-started")
      expect(started.configuration.contractDigest).toBeUndefined();
  });

  it("keeps DB access disabled when the campaign requests none", async () => {
    const { run, configPath, prompts, ledger } = await harness({
      databaseAccess: "none",
    });
    await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-no-db",
      "--config",
      configPath,
    );
    expect(prompts[0]).toContain("Database: not exposed to this run.");
    expect(
      ledger().read({ type: "discovery-run-started" }).at(0)?.event,
    ).toMatchObject({
      configuration: { labAccess: { database: "none" } },
    });
  });

  it("includes the frozen core path in the discovery Lab context", async () => {
    const { run, configPath, prompts } = await harness({ coreSource: true });
    await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-core",
      "--config",
      configPath,
    );
    expect(prompts[0]).toContain(
      "WordPress core source (read-only): /workspace/wordpress",
    );
  });

  it("mentions the writable research directory only for objective-only prompts", async () => {
    const whitebox = await harness({
      config: {
        promptId: "wp2shell-whitebox-v1.7",
        stopRules: { maxRuns: 1, noFindingRuns: 1 },
      },
    });
    await whitebox.run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-research-notes",
      "--config",
      whitebox.configPath,
    );
    expect(whitebox.prompts[0]).toContain(
      "Writable notes directory: /workspace/research.",
    );

    const legacy = await harness();
    await legacy.run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-without-research-notes",
      "--config",
      legacy.configPath,
    );
    expect(legacy.prompts[0]).not.toContain("/workspace/research");
  });

  it("records the seed stage when canary setup fails", async () => {
    const { run, configPath, prompts, ledger } = await harness({
      labSeedFailure: true,
    });
    await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-seed",
      "--config",
      configPath,
    );
    expect(prompts).toHaveLength(0);
    const event = ledger().read({ type: "lab-provisioned" }).at(0)?.event;
    expect(event).toMatchObject({
      status: "failed",
      failureStage: "seed",
      reason: "provision",
    });
    expect(JSON.stringify(event)).not.toContain("fixture seed error");
  });

  it("records the Lab provision stage and stores Docker diagnostics by private digest", async () => {
    const { run, configPath, prompts, ledger } = await harness({
      labProvisionFailure: true,
    });
    const result = await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-provision",
      "--config",
      configPath,
    );
    expect(result.stdout).toContain("stopped by setup-failed");
    expect(prompts).toHaveLength(0);
    const event = ledger().read({ type: "lab-provisioned" }).at(0)?.event;
    expect(event).toMatchObject({
      status: "failed",
      failureStage: "provision",
      reason: "provision",
      artifacts: [
        { kind: "lab-diagnostic", digest: expect.stringMatching(/^sha256:/) },
      ],
    });
    expect(JSON.stringify(event)).not.toContain("fixture docker error");
  });

  it("records a missing PHP extension as an incomplete precondition without starting discovery", async () => {
    const { run, configPath, prompts, ledger } = await harness({
      labMissingExtension: true,
    });
    const result = await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-missing-extension",
      "--config",
      configPath,
    );
    expect(result.stdout).toContain("stopped by incomplete(precondition)");
    expect(prompts).toHaveLength(0);
    expect(
      ledger().read({ type: "lab-provisioned" }).at(0)?.event,
    ).toMatchObject({
      status: "failed",
      failureStage: "provision",
      reason: "precondition",
    });
    expect(ledger().read({ type: "discovery-run-started" })).toHaveLength(0);
  });

  it("records a failed Lab probe before starting discovery", async () => {
    const { run, configPath, prompts, ledger } = await harness({
      labProbeHttp: "failed",
    });
    const result = await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-probe",
      "--config",
      configPath,
    );
    expect(result.stdout).toContain("stopped by setup-failed");
    expect(prompts).toHaveLength(0);
    expect(
      ledger().read({ type: "lab-provisioned" }).at(0)?.event,
    ).toMatchObject({
      status: "failed",
      reachability: { http: "failed", database: "ok" },
      failureStage: "probe",
      reason: "reachability",
    });
  });

  it("automatically retries a recipe twice with fresh Labs and keeps a manual override", async () => {
    const { run, configPath, ledger, labIdsDuringVerification, live } =
      await harness({ verifierRecipeFailures: 3 });
    const args = [
      "campaign",
      "run",
      "--all",
      "--campaign",
      "retry-campaign",
      "--config",
      configPath,
    ];
    expect((await run(...args)).code).toBe(0);
    const events = ledger()
      .read({ campaignId: "retry-campaign", type: "verification-finished" })
      .map(({ event }) => event)
      .filter((event) => event.type === "verification-finished");
    const first = events.filter(
      (event) => event.findingId === events[0]?.findingId,
    );
    expect(first).toHaveLength(3);
    const findingId = first[0]!.findingId;
    expect(first.map((event) => event.result)).toEqual(
      Array.from({ length: 3 }, () =>
        expect.objectContaining({ status: "incomplete", reason: "recipe" }),
      ),
    );
    expect(first.map((event) => event.attempt)).toEqual([1, 2, 3]);
    expect(first.map((event) => event.promptVersion)).toEqual(
      Array.from({ length: 3 }, () => "verifier-v7"),
    );
    expect(first.map((event) => event.retryOf)).toEqual([
      undefined,
      first[0]?.verificationId,
      first[1]?.verificationId,
    ]);
    const verifierLabs = labIdsDuringVerification
      .slice(0, 3)
      .map((ids) => ids.at(-1));
    expect(new Set(verifierLabs).size).toBe(3);
    for (const [index, ids] of labIdsDuringVerification.slice(0, 3).entries()) {
      expect(ids).toHaveLength(2); // Discovery Lab and one fresh verification Lab.
      if (index > 0) expect(ids).not.toContain(verifierLabs[index - 1]);
    }
    expect(live.containers.size).toBe(0);
    expect(live.networks.size).toBe(0);
    expect(live.volumes.size).toBe(0);
    expect((await run(...args)).code).toBe(0);
    expect(
      ledger().read({
        campaignId: "retry-campaign",
        findingId,
        type: "verification-finished",
      }),
    ).toHaveLength(3);
    expect((await run(...args, "--retry-incomplete")).code).toBe(0);
    expect(
      ledger()
        .read({
          campaignId: "retry-campaign",
          findingId,
          type: "verification-finished",
        })
        .at(-1)?.event,
    ).toMatchObject({
      attempt: 4,
      retryOf: first[2]?.verificationId,
    });
  });

  it("bounds verification Lab provision failures to two attempts", async () => {
    const { run, configPath, ledger, verificationProvisionAttempts } =
      await harness({ verifierLabProvisionFailures: 2 });
    const args = [
      "campaign",
      "run",
      "--all",
      "--campaign",
      "provision-retry",
      "--config",
      configPath,
    ];
    expect((await run(...args)).code).toBe(0);
    const events = ledger()
      .read({ campaignId: "provision-retry", type: "verification-finished" })
      .map(({ event }) => event)
      .filter((event) => event.type === "verification-finished");
    const first = events.filter(
      (event) => event.findingId === events[0]?.findingId,
    );
    expect(first.map((event) => event.attempt)).toEqual([1, 2]);
    expect(first.map((event) => event.result)).toEqual([
      expect.objectContaining({ status: "incomplete", reason: "provision" }),
      expect.objectContaining({ status: "incomplete", reason: "provision" }),
    ]);
    expect(first[1]?.retryOf).toBe(first[0]?.verificationId);
    expect(verificationProvisionAttempts()).toBe(events.length);
  });

  it("retries a precondition only after a default Lab changes to a named scenario", async () => {
    const { run, configPath, ledger } = await harness({
      firstVerifierIncomplete: true,
    });
    const args = [
      "campaign",
      "run",
      "--all",
      "--campaign",
      "scenario-retry",
      "--config",
      configPath,
    ];
    expect((await run(...args)).code).toBe(0);
    const first = ledger()
      .read({ campaignId: "scenario-retry", type: "verification-finished" })
      .map(({ event }) => event)
      .find(
        (event) =>
          event.type === "verification-finished" &&
          event.result.status === "incomplete" &&
          event.result.reason === "precondition",
      );
    expect(first).toMatchObject({
      attempt: 1,
      result: { status: "incomplete", reason: "precondition" },
    });
    if (first?.type !== "verification-finished") return;
    expect((await run(...args)).code).toBe(0);
    expect(
      ledger().read({
        campaignId: "scenario-retry",
        findingId: first.findingId,
        type: "verification-finished",
      }),
    ).toHaveLength(1);
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      lab: Record<string, unknown>;
    };
    config.lab.scenarioId = "private-page-v1";
    await writeFile(configPath, JSON.stringify(config));
    expect((await run(...args)).code).toBe(0);
    const after = ledger()
      .read({
        campaignId: "scenario-retry",
        findingId: first.findingId,
        type: "verification-finished",
      })
      .map(({ event }) => event);
    expect(after).toHaveLength(2);
    expect(after[1]).toMatchObject({
      attempt: 2,
      retryOf: first.verificationId,
      result: { status: "runtime-confirmed" },
    });
    const labsBefore = ledger().read({
      campaignId: "scenario-retry",
      type: "lab-provisioned",
    }).length;
    config.lab.scenarioId = "approved-comment-v1";
    await writeFile(configPath, JSON.stringify(config));
    expect((await run(...args)).code).toBe(0);
    expect(
      ledger().read({ campaignId: "scenario-retry", type: "lab-provisioned" })
        .length,
    ).toBeGreaterThan(labsBefore);
    expect(
      ledger()
        .read({
          campaignId: "scenario-retry",
          findingId: first.findingId,
          type: "verification-finished",
        })
        .map(({ event }) => event),
    ).toEqual(after);
  });

  it("runs a pinned campaign end to end and exposes review, funnel and location-overlap", async () => {
    const { run, configPath, keysPath, prompts, docker, ledger } =
      await harness();

    const campaign = await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-1",
      "--config",
      configPath,
    );
    expect(campaign.stderr).toBe("");
    expect(campaign.code).toBe(0);
    expect(campaign.stdout).toContain("wporg:synthetic-plugin 3.3.1");
    expect(campaign.stdout).toContain("stopped by no-new-finding");
    expect(campaign.stdout).toContain(": runtime-confirmed");
    expect(campaign.stdout).toContain(": incomplete");
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain("Trust boundary");
    expect(prompts[0]).toMatch(/subscriber: wbh-subscriber-/);
    // The Lab administrator exists for setup only and never reaches the agent.
    expect(prompts[0]).not.toContain("harness-admin");
    expect(prompts[0]).not.toMatch(/^- (administrator|editor|contributor)/m);
    expect(
      docker.every(
        (request) =>
          request.args[0] !== "run" || request.args.includes("--runtime=runsc"),
      ),
    ).toBe(true);

    const queue = await run("review", "--campaign", "campaign-1");
    expect(queue.code).toBe(0);
    expect(queue.stdout).toMatch(/^runtime-confirmed .* account-takeover$/m);
    expect(queue.stdout).toMatch(
      /reproduction package: sha256:[a-f0-9]{64} \(\S+private-evidence\/sha256:[a-f0-9]{64}\)/,
    );
    expect(queue.stdout).toContain(
      "observed: attackerRole=subscriber defaultSettings=true observedVia=session reachedRole=administrator",
    );
    expect(queue.stdout).toMatch(/evidence: sha256:[a-f0-9]{64}/);
    expect(queue.stdout).toMatch(/^incomplete .* sensitive-object-access$/m);
    expect(queue.stdout).toContain("reason: evidence");
    expect(queue.stdout).toMatch(/next: .+/);
    const confirmedFinding = /^runtime-confirmed\s+\S+\s+finding (\S+)/m.exec(
      queue.stdout,
    )?.[1];
    expect(confirmedFinding).toBeDefined();
    expect(ledger().read({ type: "review-item-opened" })).toHaveLength(0);
    const inspected = await run(
      "review",
      "inspect",
      "--campaign",
      "campaign-1",
      "--finding",
      confirmedFinding!,
    );
    expect(inspected.code).toBe(0);
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      status: "runtime-confirmed",
      ref: { findingId: confirmedFinding },
      view: { verificationStatus: "runtime-confirmed" },
    });
    expect(ledger().read({ type: "review-item-opened" })).toMatchObject([
      {
        event: {
          type: "review-item-opened",
          findingId: confirmedFinding,
        },
      },
    ]);
    const missingOpen = await run(
      "review",
      "inspect",
      "--campaign",
      "campaign-1",
      "--finding",
      "unknown-finding",
    );
    expect(missingOpen.code).not.toBe(0);
    expect(ledger().read({ type: "review-item-opened" })).toHaveLength(1);

    const decided = await run(
      "review",
      "decide",
      "--campaign",
      "campaign-1",
      "--finding",
      confirmedFinding!,
      "--decision",
      "accept",
      "--reason",
      "reproduced-by-hand",
      "--duplicate",
      "no-match",
    );
    expect(decided.stderr).toBe("");
    expect(decided.stdout).toContain("recorded accept (reproduced-by-hand)");

    const funnel = await run("ledger", "funnel", "--campaign", "campaign-1");
    expect(funnel.stdout).toContain(
      "raw 2 → verifier通過 2 → confirmed 1 / reproduced 0 / contradicted 0 / incomplete 1 → reviewed 1 → in-scope 0 → submitted 0 → outcome 0",
    );
    expect(funnel.stdout).toContain("runs 3 (discovery attempts 3)");
    expect(funnel.stdout).toContain("cost unavailable");
    expect(funnel.stdout).toContain("confirmed / 1M tokens 370.37");
    expect(funnel.stdout).toMatch(/account-takeover: .*raw 1 .* confirmed 1/);

    const score = await run(
      "eval",
      "score",
      "--campaign",
      "campaign-1",
      "--keys",
      keysPath,
      "--case",
      "synthetic-case",
    );
    expect(score.stdout).toContain(
      "location-overlap  case synthetic-case  campaign campaign-1  findings 2  overlapping 1  unreadable 0  hit yes",
    );
    expect(score.stdout).not.toContain("includes/synthetic.php");
  });

  it("caps a target's runs at its selection run budget below the campaign ceiling", async () => {
    const { run, configPath, prompts } = await harness({
      runBudget: { default: 1, highThreat: 1 },
    });
    const campaign = await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-1",
      "--config",
      configPath,
    );
    expect(campaign.code).toBe(0);
    expect(campaign.stdout).toContain("stopped by max-runs");
    expect(prompts).toHaveLength(1);
  });

  it("assigns connected source scopes and records index and component digests", async () => {
    const { run, configPath, prompts, ledger } = await harness({
      entryPoints: true,
      config: {
        stopRules: { maxRuns: 2, noFindingRuns: 2 },
        assignment: { unit: "entry-point", entriesPerRun: 2 },
      },
    });
    const campaign = await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-entry",
      "--config",
      configPath,
    );
    expect(campaign.code).toBe(0);
    expect(
      prompts.some((prompt) => prompt.includes("## Assigned entry points")),
    ).toBe(true);
    expect(
      prompts.some((prompt) =>
        prompt.includes("option `synthetic_plugin_shared`"),
      ),
    ).toBe(true);
    expect(
      prompts.some(
        (prompt) => prompt.includes("written by") && prompt.includes("read by"),
      ),
    ).toBe(true);
    const started = ledger().read({
      campaignId: "campaign-entry",
      type: "discovery-run-started",
    });
    expect(started).toHaveLength(prompts.length);
    for (const { event } of started) {
      if (event.type !== "discovery-run-started")
        throw new Error("Unexpected event");
      expect(event.configuration.assignmentUnit).toBe("entry-point");
      expect(event.configuration.assignment?.indexDigest).toMatch(/^sha256:/);
      expect(event.configuration.assignment?.componentDigest).toMatch(
        /^sha256:/,
      );
      expect(JSON.stringify(event)).not.toContain("synthetic_plugin_shared");
    }
  });

  it("sends the full entry catalogue by default and pins its digest in input and ledger", async () => {
    const { run, configPath, prompts, entryIndexes, ledger, root } =
      await harness({
        entryPoints: true,
        config: { stopRules: { maxRuns: 1, noFindingRuns: 1 } },
      });
    const expected = await buildWordPressSourceIndex(
      join(root, "source"),
      "synthetic-plugin",
    );
    const campaign = await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-index-default",
      "--config",
      configPath,
    );
    expect(campaign.code).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("## Entry points");
    expect(prompts[0]).toContain(`Index digest: ${expected.digest}`);
    expect(prompts[0]).toContain("wp_ajax_nopriv_synthetic_save");
    expect(prompts[0]).not.toContain("partition");
    expect(entryIndexes).toEqual([{ enabled: true, digest: expected.digest }]);
    const started = ledger().read({
      campaignId: "campaign-index-default",
      type: "discovery-run-started",
    });
    expect(started[0]?.event).toMatchObject({
      configuration: { entryIndex: { enabled: true, digest: expected.digest } },
    });
  });

  it("runs one indexed WP2Shell Trial by default and records a zero-candidate conclusion", async () => {
    const { run, configPath, prompts, coordinations, expirations, ledger } =
      await harness({
        entryPoints: true,
        zeroFindings: true,
        config: {
          promptId: undefined,
          stopRules: { maxRuns: 1, noFindingRuns: 1 },
        },
      });
    const campaign = await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-wp2shell-default",
      "--config",
      configPath,
    );
    expect(campaign.code).toBe(0);
    expect(campaign.stdout).toContain("stopped by no-new-finding");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("WordPress discovery: WP2Shell bounty v4");
    expect(prompts[0]).toContain("## Entry points");
    expect(coordinations).toEqual(["cooperative"]);
    expect(expirations).toEqual(["2026-10-08T01:00:00.000Z"]);
    const started = ledger().read({
      campaignId: "campaign-wp2shell-default",
      type: "discovery-run-started",
    })[0]?.event;
    expect(started).toMatchObject({ runKind: "explore", trialOrdinal: 0 });
    expect(started).not.toHaveProperty("stage");
    expect(started).not.toHaveProperty("continuationOf");
    expect(
      ledger().read({
        campaignId: "campaign-wp2shell-default",
        type: "campaign-stopped",
      }),
    ).toHaveLength(0);
    expect(
      ledger().read({
        campaignId: "campaign-wp2shell-default",
        type: "verification-finished",
      }),
    ).toHaveLength(0);
    const resumed = await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-wp2shell-default",
      "--config",
      configPath,
    );
    expect(resumed.code).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(
      ledger().read({
        campaignId: "campaign-wp2shell-default",
        type: "discovery-concluded",
      }),
    ).toHaveLength(1);
  });

  it("reads historical stage and continuation references without writing them on new Trials", async () => {
    const { run, configPath, ledger } = await harness();
    expect((await run("select", "--config", configPath)).code).toBe(0);
    await ledger().append({
      schemaVersion: 1,
      identity: "historical-discovery-start",
      campaignId: "historical-campaign",
      snapshotDigest: sha("a"),
      occurredAt: now,
      type: "discovery-run-started",
      runId: "historical-run",
      trialId: "historical-trial",
      trialOrdinal: 0,
      stage: "screening",
      runKind: "continue",
      continuationOf: "historical-lead",
      labId: "historical-lab",
      history: { mode: "none" },
      configuration: {
        promptVariant: "screening-v1",
        assignmentUnit: "plugin",
      },
    });
    expect(
      ledger().read({
        campaignId: "historical-campaign",
        type: "discovery-run-started",
      })[0]?.event,
    ).toMatchObject({ stage: "screening", continuationOf: "historical-lead" });
  });

  it("records the entry-index control when one config field disables the catalogue", async () => {
    const { run, configPath, prompts, entryIndexes, ledger } = await harness({
      entryPoints: true,
      config: {
        promptId: undefined,
        entryIndex: false,
        stopRules: { maxRuns: 1, noFindingRuns: 1 },
      },
    });
    const campaign = await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-index-off",
      "--config",
      configPath,
    );
    expect(campaign.code).toBe(0);
    expect(prompts[0]).not.toContain("## Entry points");
    expect(entryIndexes).toEqual([{ enabled: false }]);
    expect(
      ledger().read({
        campaignId: "campaign-index-off",
        type: "discovery-run-started",
      })[0]?.event,
    ).toMatchObject({ configuration: { entryIndex: { enabled: false } } });
  });

  it("splits runs into history arms and reads runs and Findings per arm from the ledger", async () => {
    const { run, configPath, histories } = await harness({
      ablation: 0.5,
      pinned: false,
      history: true,
    });
    const campaign = await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-1",
      "--config",
      configPath,
    );
    expect(campaign.code).toBe(0);
    expect(histories).toEqual(["none", "catalog", "none"]);
    const funnel = await run("ledger", "funnel", "--campaign", "campaign-1");
    expect(funnel.stdout).toContain(
      "  history:a: runs 2  findings 2  confirmed 1",
    );
    expect(funnel.stdout).toContain(
      "  history:b: runs 1  findings 0  confirmed 0",
    );
    const comparison = await run("eval", "compare", "--axis", "history");
    expect(comparison.code).toBe(0);
    expect(comparison.stdout.split("\n")).toEqual([
      "compare history  paired targets 1  unpaired 0",
      "  arm a: hits 1/2 (50.0%, 95% CI 1.3–98.7%)  findings 2  cost $0.00 known, 2 run(s) unavailable",
      "  arm b: hits 0/1 (0.0%, 95% CI 0.0–97.5%)  findings 0  cost $0.00 known, 1 run(s) unavailable",
      "  verdict: 判定不能（区間が重なる）",
      "  target wporg:synthetic-plugin@9.9.9  a 1/2  b 0/1",
    ]);
  });

  it("uses disjoint campaign modes and retains the short objective comparison arm", () => {
    const base = {
      schemaVersion: 1 as const,
      programmeBoundary: { version: "v1", text: "Synthetic" },
      wordpressVersion: "6.8",
      lab: { siteTitle: "Synthetic", initialPosts: [], customerRole: false },
    };
    const production = wordpressCampaignConfigSchema.parse({
      ...base,
      mode: "wp2shell",
    });
    expect(production).toMatchObject({
      mode: "wp2shell",
      promptId: "wp2shell-bounty-v4",
      entryIndex: true,
      runWallTimeMinutes: 60,
      stopRules: { maxRuns: 1, noFindingRuns: 1 },
    });
    expect(
      wordpressCampaignConfigSchema.parse({
        ...base,
        promptId: "wp2shell-whitebox-v1.7",
      }),
    ).toMatchObject({
      mode: "wp2shell",
      promptId: "wp2shell-whitebox-v1.7",
    });
    expect(
      wordpressCampaignConfigSchema.parse({
        ...base,
        promptId: "wp2shell-whitebox-v1.7",
        entryIndex: false,
      }),
    ).toMatchObject({
      mode: "entry-index-control",
      promptId: "wp2shell-whitebox-v1.7",
    });
    for (const forbidden of [
      { assignment: { unit: "entry-point" } },
      { ablation: { axis: "history", armBFraction: 0.5 } },
      { continuation: {} },
    ])
      expect(
        wordpressCampaignConfigSchema.safeParse({
          ...base,
          mode: "wp2shell",
          ...forbidden,
        }).success,
      ).toBe(false);
    const comparison = wordpressCampaignConfigSchema.parse({
      ...base,
      mode: "comparison",
      promptId: "short-objective-managed-v4",
      stopRules: { maxRuns: 3, noFindingRuns: 3 },
    });
    expect(comparison).toMatchObject({
      mode: "comparison",
      promptId: "short-objective-managed-v4",
      stopRules: { maxRuns: 3, noFindingRuns: 3 },
    });
  });

  it("normalizes old history configuration, rejects continuation, and records prompt-history cells", async () => {
    const base = {
      schemaVersion: 1 as const,
      programmeBoundary: { version: "v1", text: "Synthetic" },
      wordpressVersion: "6.8",
      lab: { siteTitle: "Synthetic", initialPosts: [], customerRole: false },
    };
    const normalized = wordpressCampaignConfigSchema.parse({
      ...base,
      ablation: { axis: "history", armBFraction: 0.5 },
    });
    if (normalized.mode !== "ablation") throw new Error("Expected ablation");
    expect(normalized.ablation.axes).toEqual([
      { axis: "history", armBFraction: 0.5 },
    ]);
    expect(() =>
      wordpressCampaignConfigSchema.parse({
        ...base,
        ablation: { axes: [{ axis: "continuation", armBFraction: 0.5 }] },
      }),
    ).toThrow();
    expect(
      wordpressCampaignConfigSchema.safeParse({ ...base, continuation: {} })
        .success,
    ).toBe(false);
    expect(
      wordpressCampaignConfigSchema.safeParse({
        ...base,
        mode: "ablation",
        ablation: {
          axes: [
            {
              axis: "prompt",
              armBFraction: 0.5,
              armBPromptId: "screening-v1",
            },
          ],
        },
      }).success,
    ).toBe(false);
    const { run, configPath, prompts, promptDigests, ledger } = await harness({
      history: true,
      pinned: false,
      config: {
        promptId: "short-objective-v2",
        stopRules: { maxRuns: 4, noFindingRuns: 4 },
        ablation: {
          axes: [
            {
              axis: "prompt",
              armBFraction: 0.5,
              armBPromptId: "wp2shell-single-http-v2",
            },
            { axis: "history", armBFraction: 0.5 },
          ],
        },
      },
    });
    const result = await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-multi-axis",
      "--config",
      configPath,
    );
    expect(result.code).toBe(0);
    expect(prompts).toHaveLength(4);
    expect(prompts[0]).not.toContain("Maintain a private registry");
    expect(prompts[1]).toContain("Maintain a private registry");
    expect(new Set(promptDigests).size).toBe(2);
    const started = ledger()
      .read({
        campaignId: "campaign-multi-axis",
        type: "discovery-run-started",
      })
      .map(({ event }) => event);
    expect(
      started.map((event) =>
        event.type === "discovery-run-started"
          ? event.configuration.arms
          : null,
      ),
    ).toEqual([
      { prompt: "a", history: "a" },
      { prompt: "b", history: "a" },
      { prompt: "a", history: "b" },
      { prompt: "b", history: "b" },
    ]);
    expect(
      started.map((event) =>
        event.type === "discovery-run-started"
          ? event.configuration.promptDigest
          : null,
      ),
    ).toEqual(promptDigests);
    const funnel = ledger().funnel("campaign-multi-axis");
    expect(funnel.byArm["history:a+prompt:b"]?.runs).toBe(1);
    expect(funnel.byArm["history:b+prompt:a"]?.runs).toBe(1);
    const comparison = await run(
      "eval",
      "compare",
      "--axis",
      "prompt",
      "--campaign",
      "campaign-multi-axis",
    );
    expect(comparison.code).toBe(0);
    expect(comparison.stdout).toContain("compare prompt");
  });

  it("records Leads and source-index facts without starting a Harness continuation", async () => {
    const makeLead = (summary: string, missingEdge: string) => ({
      summary,
      attackerPosition: "subscriber",
      primitive: "write",
      storage: { kind: "option", key: "synthetic_plugin_shared" },
      missingEdge,
      sourceTrace: [
        { file: "includes/synthetic.php", function: "synthetic_save", line: 4 },
      ],
      labObservations: "Synthetic partial observation",
    });
    const { run, configPath, keysPath, prompts, ledger } = await harness({
      entryPoints: true,
      leadsOnCalls: {
        1: [
          makeLead("Selected Lead", "auth-use"),
          makeLead("Other Lead", "precondition"),
        ],
      },
      config: {
        stopRules: { maxRuns: 1, noFindingRuns: 1 },
      },
    });
    const result = await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-lead",
      "--config",
      configPath,
    );
    expect(result.code).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("## Entry points");
    expect(prompts[0]).not.toContain("## Lead");
    expect(prompts[0]).not.toContain("Selected Lead");
    const started = ledger()
      .read({ campaignId: "campaign-lead", type: "discovery-run-started" })
      .map(({ event }) => event);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      type: "discovery-run-started",
      runKind: "explore",
    });
    expect(started[0]).not.toHaveProperty("continuationOf");
    expect(
      ledger().read({ campaignId: "campaign-lead", type: "lead-recorded" }),
    ).toHaveLength(2);
    const scored = await run(
      "eval",
      "score",
      "--campaign",
      "campaign-lead",
      "--keys",
      keysPath,
      "--case",
      "synthetic-case",
    );
    expect(scored.code).toBe(0);
    expect(scored.stdout).toContain(
      "source candidates 2  overlapping 2  unreadable 0  hit yes",
    );
  });

  it("scores the campaign against later public advisories and lists blind rubric pairs", async () => {
    const { run, configPath, root } = await harness();
    await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-1",
      "--config",
      configPath,
    );
    const advisoriesPath = join(root, "advisories.json");
    const advisory = (advisoryId: string, file: string) => ({
      schemaVersion: 1,
      advisoryId,
      slug: "synthetic-plugin",
      affectedVersions: [
        {
          fromVersion: "*",
          fromInclusive: true,
          toVersion: "3.4.0",
          toInclusive: false,
        },
      ],
      publishedAt: "2026-11-01",
      impact: "account-takeover",
      allowedLocations: [{ file }],
    });
    await writeFile(
      advisoriesPath,
      JSON.stringify([
        advisory("adv-1", "includes/synthetic.php"),
        advisory("adv-2", "includes/unrelated.php"),
      ]),
    );
    const scored = await run(
      "eval",
      "prospective",
      "--advisories",
      advisoriesPath,
    );
    expect(scored.code).toBe(0);
    const lines = scored.stdout.split("\n");
    expect(lines.slice(0, 3)).toEqual([
      "prospective location-overlap  advisories 2  found 1  missed 1  unscorable 0  predates-run 0  not-searched 0",
      "  found adv-1  overlapping 1  unreadable 0",
      "  missed adv-2  overlapping 0  unreadable 0",
    ]);
    expect(lines[3]).toBe("blind rubric pairs:");
    expect(lines[4]).toMatch(/^  adv-1  finding \S+$/);
    // Key locations stay in the advisory file.
    expect(scored.stdout).not.toContain("includes/");
  });

  it("keeps every run in arm a when the pinned version has no history cutoff", async () => {
    const { run, configPath, histories } = await harness({
      ablation: 0.5,
      history: true,
    });
    await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-1",
      "--config",
      configPath,
    );
    expect(histories).toEqual(["none", "none", "none"]);
    const funnel = await run("ledger", "funnel", "--campaign", "campaign-1");
    expect(funnel.stdout).toContain("  history:a: runs 3");
    expect(funnel.stdout).not.toContain("history:b");
  });

  it("stops the campaign on a provider limit and resumes it with the same command", async () => {
    const { run, configPath } = await harness({
      limitOnCalls: [2],
      config: { stopRules: { maxRuns: 4, noFindingRuns: 2 } },
    });
    const command = [
      "campaign",
      "run",
      "--all",
      "--campaign",
      "campaign-1",
      "--config",
      configPath,
    ];
    const stopped = await run(...command);
    expect(stopped.code).toBe(3);
    expect(stopped.stdout).toContain("runs 2  stopped by provider-limit");
    expect(stopped.stdout).not.toContain("  finding ");
    expect(stopped.stdout).toContain(
      "campaign stopped by provider-limit; run the same command again to resume",
    );
    expect(stopped.stdout).toContain("raw 2 → verifier通過 0");

    const resumed = await run(...command);
    expect(resumed.code).toBe(3);
    // The limited Trial spent its ordinal; later completed Trials do not
    // change its recorded provider-limit outcome.
    expect(resumed.stdout).toContain("runs 2  stopped by provider-limit");
    expect(resumed.stdout).not.toContain("  finding ");

    const again = await run(...command);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("runs 0  stopped by provider-limit");
    expect(again.stdout.match(/^  finding /gm)).toHaveLength(2);
    expect(again.stdout).toContain("raw 2 → verifier通過 2 → confirmed 1");
  });

  it("finishes in-flight targets after a provider limit, then resumes only unfinished targets", async () => {
    const { run, configPath, prompts, ledger, maxInFlight, live, docker } =
      await harness({
        candidates: ["synthetic-plugin", "second-plugin", "third-plugin"],
        limitOnCalls: [1],
        zeroFindings: true,
        config: {
          promptId: undefined,
          stopRules: { maxRuns: 1, noFindingRuns: 1 },
          resources: {
            maxConcurrentRuns: 1,
            maxConcurrentTargets: 2,
            memoryBudgetMiB: 10_240,
          },
        },
      });
    const command = [
      "campaign",
      "run",
      "--all",
      "--campaign",
      "campaign-parallel-stop",
      "--config",
      configPath,
    ];

    const stopped = await run(...command);
    expect(stopped.code).toBe(3);
    expect(prompts).toHaveLength(2);
    expect(maxInFlight()).toBe(2);
    expect(
      ledger().read({
        campaignId: "campaign-parallel-stop",
        type: "discovery-run-started",
      }),
    ).toHaveLength(2);
    expect(live.containers.size).toBe(0);
    expect(live.networks.size).toBe(0);
    expect(live.volumes.size).toBe(0);
    expect(docker.some(({ args }) => args[0] === "ps")).toBe(false);

    const resumed = await run(...command);
    expect(resumed.code).toBe(0);
    expect(prompts).toHaveLength(3);
    expect(
      ledger().read({
        campaignId: "campaign-parallel-stop",
        type: "discovery-run-started",
      }),
    ).toHaveLength(3);
    // Two Labs on the first invocation, then the provider-limited target and
    // the never-started target. The completed in-flight target is skipped.
    expect(
      ledger()
        .read({
          campaignId: "campaign-parallel-stop",
          type: "lab-provisioned",
        })
        .filter(
          ({ event }) =>
            event.type === "lab-provisioned" && event.purpose === "discovery",
        ),
    ).toHaveLength(4);
    expect(live.containers.size).toBe(0);
    expect(live.networks.size).toBe(0);
    expect(live.volumes.size).toBe(0);
  });

  it("tears down each parallel target Lab when setup throws without global cleanup", async () => {
    const { run, configPath, live, docker, ledger } = await harness({
      candidates: ["synthetic-plugin", "second-plugin"],
      labSeedThrows: true,
      config: {
        promptId: undefined,
        stopRules: { maxRuns: 1, noFindingRuns: 1 },
        resources: {
          maxConcurrentRuns: 1,
          maxConcurrentTargets: 2,
          memoryBudgetMiB: 10_240,
        },
      },
    });
    const result = await run(
      "campaign",
      "run",
      "--all",
      "--campaign",
      "campaign-parallel-cleanup",
      "--config",
      configPath,
    );
    expect(result.code).toBe(0);
    expect(
      ledger().read({
        campaignId: "campaign-parallel-cleanup",
        type: "target-skipped",
      }),
    ).toHaveLength(2);
    expect(live.containers.size).toBe(0);
    expect(live.networks.size).toBe(0);
    expect(live.volumes.size).toBe(0);
    expect(docker.some(({ args }) => args[0] === "ps")).toBe(false);
    const targetRemovals = docker
      .map(({ args }) => args)
      .filter(
        (args) =>
          args[0] === "rm" &&
          args.slice(2).some((name) => name.startsWith("wbh-")),
      );
    expect(targetRemovals).toHaveLength(8);
    const removedTargetIds = new Set<string>();
    for (const removal of targetRemovals) {
      expect(removal).toHaveLength(3);
      const ids = new Set(
        removal.slice(2).map((name) => /^wbh-([0-9a-f-]{36})-/.exec(name)?.[1]),
      );
      expect(ids.size).toBe(1);
      expect(ids.has(undefined)).toBe(false);
      removedTargetIds.add([...ids][0]!);
    }
    expect(removedTargetIds.size).toBe(2);
  });

  it("keeps a target Lab until its verification finishes, then removes it", async () => {
    const { run, configPath, labIdsDuringVerification, live, docker } =
      await harness({
        config: { stopRules: { maxRuns: 1, noFindingRuns: 1 } },
      });
    const result = await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-target-lifecycle",
      "--config",
      configPath,
    );
    expect(result.code).toBe(0);
    expect(labIdsDuringVerification[0]).toHaveLength(2);
    expect(new Set(labIdsDuringVerification[0]).size).toBe(2);
    expect(live.containers.size).toBe(0);
    expect(live.networks.size).toBe(0);
    expect(live.volumes.size).toBe(0);
    expect(docker.some(({ args }) => args[0] === "ps")).toBe(false);
  });

  it("does not replace an incomplete Trial when the campaign resumes", async () => {
    const { run, configPath, ledger } = await harness({
      failOnCalls: [1],
      config: { stopRules: { maxRuns: 1, noFindingRuns: 1 } },
    });
    const command = [
      "campaign",
      "run",
      "--all",
      "--campaign",
      "campaign-1",
      "--config",
      configPath,
    ];
    const failed = await run(...command);
    expect(failed.code).toBe(3);
    expect(failed.stdout).toContain("runs 1  stopped by incomplete");
    expect(ledger().read({ type: "discovery-concluded" })).toHaveLength(0);

    const retried = await run(...command);
    expect(retried.code).toBe(0);
    expect(retried.stdout).toContain("runs 0  stopped by incomplete");
    expect(ledger().read({ type: "discovery-run-started" })).toHaveLength(1);
    expect(ledger().read({ type: "discovery-concluded" })).toHaveLength(0);
  });

  it("continues to an unspent target after an earlier target failed", async () => {
    const { run, configPath, prompts, ledger } = await harness({
      candidates: ["synthetic-plugin", "zz-next-plugin"],
      failOnCalls: [1],
      config: {
        promptId: undefined,
        stopRules: { maxRuns: 1, noFindingRuns: 1 },
      },
    });
    const command = [
      "campaign",
      "run",
      "--all",
      "--campaign",
      "campaign-two-targets",
      "--config",
      configPath,
    ];
    const stopped = await run(...command);
    expect(stopped.code).toBe(3);
    expect(prompts).toHaveLength(1);
    const resumed = await run(...command);
    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toContain("runs 0  stopped by incomplete");
    expect(resumed.stdout).toMatch(
      /^wporg:zz-next-plugin 9\.9\.9 .*runs 1  stopped by /m,
    );
    expect(prompts).toHaveLength(2);
    expect(
      ledger()
        .read({ type: "discovery-run-started" })
        .filter(
          ({ event }) =>
            event.type === "discovery-run-started" &&
            event.runKind === "explore",
        ),
    ).toHaveLength(2);
  });

  it("lists parked Findings by one-line property and says when there are none (#185)", async () => {
    const { run, ledger, store, configPath } = await harness();
    // Opening the state needs one real command; the campaign records only in-scope Findings.
    const warm = await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-warm",
      "--config",
      configPath,
    );
    expect(warm.code).toBe(0);
    const empty = await run(
      "review",
      "parked",
      "--campaign",
      "campaign-parked",
    );
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("no parked findings");
    const snapshot = `sha256:${"b".repeat(64)}`;
    const digest = await store().putFiles({
      "finding.json": Buffer.from(
        JSON.stringify({
          brokenProperty: "Throttle trusts a forwarded header",
        }),
      ),
    });
    await ledger().append({
      schemaVersion: 1,
      identity: "parked-1",
      campaignId: "campaign-parked",
      snapshotDigest: snapshot,
      occurredAt: "2026-10-13T00:00:00Z",
      type: "finding-parked",
      findingId: "finding-parked-1",
      runId: "run-1",
      category: "other",
      reason: "outside-programme-boundary",
      artifacts: [{ kind: "finding", digest }],
    });
    const listed = await run(
      "review",
      "parked",
      "--campaign",
      "campaign-parked",
    );
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(
      "parked  other  finding-parked-1  Throttle trusts a forwarded header",
    );
    expect(
      ledger().read({
        campaignId: "campaign-parked",
        type: "finding-recorded",
      }),
    ).toHaveLength(0);
  });

  it("verifies a child Finding on resume without starting a replacement Trial", async () => {
    const { run, configPath, prompts, ledger } = await harness({
      limitOnCalls: [1],
      childFindingOnLimitedCall: true,
      config: { stopRules: { maxRuns: 1, noFindingRuns: 1 } },
    });
    const command = [
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-child-resume",
      "--config",
      configPath,
    ];
    const limited = await run(...command);
    expect(limited.code).toBe(3);
    expect(prompts).toHaveLength(1);
    expect(ledger().read({ type: "finding-recorded" })).toHaveLength(1);
    expect(ledger().read({ type: "verification-finished" })).toHaveLength(0);

    const resumed = await run(...command);
    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toContain("runs 0  stopped by provider-limit");
    expect(prompts).toHaveLength(1);
    expect(ledger().read({ type: "finding-recorded" })).toHaveLength(1);
    expect(ledger().read({ type: "verification-finished" })).toHaveLength(1);
    expect(ledger().read({ type: "discovery-concluded" })).toHaveLength(0);
  });

  it("runs independent Trials on one plugin sequentially even with spare memory", async () => {
    const { run, configPath, maxInFlight } = await harness({
      config: {
        stopRules: { maxRuns: 4, noFindingRuns: 4 },
        // Room for two runs of a Codex sandbox and its broker (2,560 MiB each).
        resources: { maxConcurrentRuns: 4, memoryBudgetMiB: 6000 },
      },
    });
    const campaign = await run(
      "campaign",
      "run",
      "--all",
      "--campaign",
      "campaign-1",
      "--config",
      configPath,
    );
    expect(campaign.code).toBe(0);
    expect(campaign.stdout).toContain("runs 4  stopped by max-runs");
    expect(maxInFlight()).toBe(1);
  });

  it("refuses a memory budget below one run", async () => {
    const small = await harness({
      config: { resources: { maxConcurrentRuns: 1, memoryBudgetMiB: 1024 } },
    });
    const refused = await small.run(
      "campaign",
      "run",
      "--all",
      "--campaign",
      "campaign-1",
      "--config",
      small.configPath,
    );
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      "memory budget is below one discovery run",
    );
    expect(small.prompts).toHaveLength(0);
  });

  it("totals provider-reported usage per target and UTC day", async () => {
    const { run, configPath } = await harness({ limitOnCalls: [3] });
    await run(
      "campaign",
      "run",
      "--all",
      "--campaign",
      "campaign-1",
      "--config",
      configPath,
    );
    const runtimes = await run("ledger", "runtime", "--campaign", "campaign-1");
    expect(runtimes.code).toBe(0);
    expect(runtimes.stdout.split("\n")).toEqual([
      "recorded runtimes (oldest first)",
      `  gpt-6.1-sol effort high  codex-cli 0.161.0  catalog ${sha("e")}  tier priority  access standard  auth host-private-bearer  runs 3  2026-10-08..2026-10-08`,
    ]);
    const usage = await run("ledger", "usage");
    expect(usage.code).toBe(0);
    // The refused third run reported nothing, so every field shows it as unavailable.
    expect(usage.stdout.split("\n")).toEqual([
      "usage by target and UTC day",
      "  2026-10-08  wporg:synthetic-plugin@3.3.1  runs 3  input 2000  cached 200  output 40  reasoning 0  unavailable: input 1, cached 1, output 1, reasoning 3",
    ]);
  });

  it("shows the history mirror freshness by the same rule as the duplicate lookup", async () => {
    const { run, root } = await harness({ history: true });
    const stale = await run("history", "status");
    expect(stale.code).toBe(1);
    expect(stale.stdout).toBe(
      "history mirror stale  last success 2026-10-01T00:00:00Z (168.0 h ago, limit 24 h)  records 1",
    );
    await writeFile(
      join(root, "wordfence-state.json"),
      JSON.stringify({
        schema_version: "wordfence-cache/v1",
        content_sha256: "synthetic-digest",
        record_count: 1,
        last_successful_at: "2026-10-07T12:00:00Z",
        stale_fallback: false,
      }),
    );
    const fresh = await run("history", "status");
    expect(fresh.code).toBe(0);
    expect(fresh.stdout).toBe(
      "history mirror fresh  last success 2026-10-07T12:00:00Z (12.0 h ago, limit 24 h)  records 1",
    );
    await writeFile(
      join(root, "wordfence-state.json"),
      JSON.stringify({
        schema_version: "wordfence-cache/v1",
        content_sha256: "other-digest",
        record_count: 1,
        last_successful_at: "2026-10-07T12:00:00Z",
      }),
    );
    const mismatched = await run("history", "status");
    expect(mismatched.code).toBe(1);
    expect(mismatched.stdout).toBe(
      "history mirror unavailable  database and state disagree",
    );
    const unconfigured = await (await harness()).run("history", "status");
    expect(unconfigured.code).toBe(1);
    expect(unconfigured.stdout).toBe("history mirror not configured");
  });

  it("checks the Codex image against the runtime profile before a campaign", async () => {
    const same = await harness();
    const ok = await same.run("runtime", "check", "--config", same.configPath);
    expect(ok.code).toBe(0);
    expect(ok.stdout.split("\n")).toEqual([
      "codex-cli  profile 0.161.0  image 0.161.0  ok",
      `catalog  profile ${sha("e")}  image ${sha("e")}  ok`,
    ]);

    const updated = await harness({
      probe: { cliVersion: "0.162.0", bundledCatalogDigest: sha("f") },
    });
    const differs = await updated.run(
      "runtime",
      "check",
      "--config",
      updated.configPath,
    );
    expect(differs.code).toBe(1);
    expect(differs.stdout.split("\n")).toEqual([
      "codex-cli  profile 0.161.0  image 0.162.0  differs",
      `catalog  profile ${sha("e")}  image ${sha("f")}  differs`,
      "The image differs from the runtime profile; runs would end incomplete(policy). Update the runtime profile, then confirm the new values with ledger runtime after the next campaign.",
    ]);
  });

  it("lists leftover Lab and broker resources and removes only them on request", async () => {
    const { run, configPath, docker } = await harness();
    const listed = await run("lab", "cleanup", "--config", configPath);
    expect(listed.code).toBe(0);
    expect(listed.stdout.split("\n")).toEqual([
      `leftover containers 5: wbh-${uuid}-db, wbh-${uuid}-wp, wbh-${uuid}-proxy, provider-egress-broker-${uuid}, codex-agent-${uuid}`,
      `leftover networks 2: wbh-${uuid}-net, provider-egress-${uuid}`,
      `leftover volumes 1: wbh-${uuid}-site`,
      "nothing removed; run again with --remove when no campaign is running",
    ]);
    expect(
      docker.some(
        ({ args }) =>
          args[0] === "ps" && args[1] === "-a" && args.includes("{{.Names}}"),
      ),
    ).toBe(true);
    expect(docker.some(({ args }) => args[0] === "rm")).toBe(false);

    const removed = await run(
      "lab",
      "cleanup",
      "--config",
      configPath,
      "--remove",
    );
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain(
      "removed 5 containers, 2 networks, 1 volumes",
    );
    const removals = docker
      .map(({ args }) => args)
      .filter(
        (args) =>
          args[0] === "rm" ||
          ((args[0] === "network" || args[0] === "volume") && args[1] === "rm"),
      );
    expect(removals).toEqual([
      [
        "rm",
        "-f",
        `wbh-${uuid}-db`,
        `wbh-${uuid}-wp`,
        `wbh-${uuid}-proxy`,
        `provider-egress-broker-${uuid}`,
        `codex-agent-${uuid}`,
      ],
      ["network", "rm", `wbh-${uuid}-net`, `provider-egress-${uuid}`],
      ["volume", "rm", `wbh-${uuid}-site`],
    ]);
  });

  it("skips a target that fails, records the stage and continues with the rest", async () => {
    const { run, configPath, ledger } = await harness({
      candidates: ["broken-plugin", "synthetic-plugin"],
      failFreeze: "broken-plugin",
    });
    const campaign = await run(
      "campaign",
      "run",
      "--all",
      "--campaign",
      "campaign-1",
      "--config",
      configPath,
    );
    expect(campaign.code).toBe(0);
    expect(campaign.stderr).toContain(
      "skipped wporg:broken-plugin 9.9.9 at freeze: Synthetic download failure",
    );
    expect(campaign.stdout).toMatch(
      /^wporg:synthetic-plugin 3\.3\.1 .*stopped by no-new-finding$/m,
    );
    const skipped = ledger()
      .read({ type: "target-skipped" })
      .map(({ event }) => event);
    expect(skipped).toMatchObject([
      {
        type: "target-skipped",
        selectionId: "wporg:broken-plugin@9.9.9",
        stage: "freeze",
      },
    ]);
    // The failure text stays out of the ledger.
    expect(JSON.stringify(skipped)).not.toContain("Synthetic download failure");
  });

  it("lists the policy selection and runs only the named target or --all", async () => {
    const { run, configPath, prompts } = await harness();
    const selected = await run("select", "--config", configPath);
    expect(selected.code).toBe(0);
    expect(selected.stdout).toMatch(/^wporg:synthetic-plugin 3\.3\.1 score /m);

    const unmatched = await run(
      "campaign",
      "run",
      "another-plugin",
      "--campaign",
      "campaign-x",
      "--config",
      configPath,
    );
    expect(unmatched.code).toBe(0);
    expect(unmatched.stdout).toContain(
      "no selected target matched another-plugin",
    );
    expect(prompts).toHaveLength(0);

    const missing = await run(
      "campaign",
      "run",
      "--campaign",
      "campaign-x",
      "--config",
      configPath,
    );
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("<slug> or --all");

    const all = await run(
      "campaign",
      "run",
      "--all",
      "--campaign",
      "campaign-all",
      "--config",
      configPath,
    );
    expect(all.code).toBe(0);
    expect(all.stdout).toContain("wporg:synthetic-plugin 3.3.1");
  });

  it("collects resumable inventory pages without reserving targets or running Trials", async () => {
    let listingFetches = 0;
    let listingFails = false;
    let observationFails = false;
    const inventoryFetch: typeof fetch = async () => {
      listingFetches++;
      if (listingFails) return new Response("", { status: 503 });
      return new Response(
        JSON.stringify({
          info: { page: 1 },
          plugins: [
            "item-a",
            "item-b",
            "item-c",
            "item-d",
            "item-e",
            "item-f",
            "item-g",
            "item-h",
            "item-i",
            "item-j",
            "item-k",
          ].map((slug) => ({ slug })),
        }),
        { status: 200, headers: { Date: new Date(now).toUTCString() } },
      );
    };
    const { run, root, store, ledger, prompts } = await harness({
      inventoryFetch,
      inventoryObservationFails: (slug) =>
        observationFails && slug === "item-a",
    });
    const policyPath = join(root, "selection.json");
    const manual = JSON.parse(await readFile(policyPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete manual.candidateSlugs;
    delete manual.pinnedVersions;
    const automatic = {
      ...manual,
      promptVariant: "short-objective-managed-v4",
      revisitPolicy: { kind: "never" },
      wordpressVersion: "6.8",
      maximumTargets: 3,
      excludedSlugs: ["item-e"],
      candidateSource: {
        kind: "wordpress-org",
        popularPages: 1,
        tags: [],
        pagesPerTag: 1,
        perPage: 11,
        maxCandidates: 5,
        maxAgeDays: 1,
      },
    };
    await writeFile(policyPath, JSON.stringify(automatic));

    const first = await run("inventory", "collect", "--config", policyPath);
    expect(first.code).toBe(0);
    const firstReport = JSON.parse(first.stdout) as {
      inventoryDigest: string;
      candidates: number;
      observedCandidates: number;
      sourceCoverageVerified: boolean;
      sourcePoolSealed: boolean;
      ineligibleByReason: Record<string, number>;
      source: { status: string; requestedListingCoverage: string };
      traversal: {
        offset: number;
        observedUniqueCandidates: number;
        complete: boolean;
        nextPageAvailable: boolean;
      };
    };
    expect(firstReport).toMatchObject({
      inventoryDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      candidates: 4,
      observedCandidates: 5,
      sourceCoverageVerified: false,
      sourcePoolSealed: true,
      ineligibleByReason: { "excluded-slug": 1 },
      source: { status: "available", requestedListingCoverage: "all-observed" },
      traversal: {
        offset: 0,
        observedUniqueCandidates: 11,
        complete: false,
        nextPageAvailable: true,
      },
    });
    const file = await store().readFile(
      firstReport.inventoryDigest,
      "candidate-inventory.json",
      2 * 1024 * 1024,
    );
    expect(file.status).toBe("resolved");

    const second = await run(
      "inventory",
      "collect",
      "--config",
      policyPath,
      "--after",
      firstReport.inventoryDigest,
    );
    expect(second.code).toBe(0);
    const secondReport = JSON.parse(second.stdout) as typeof firstReport;
    expect(secondReport).toMatchObject({
      candidates: 5,
      observedCandidates: 5,
      sourceCoverageVerified: false,
      ineligibleByReason: {},
      traversal: {
        offset: 5,
        observedUniqueCandidates: 11,
        complete: false,
        nextPageAvailable: true,
      },
    });
    const third = await run(
      "inventory",
      "collect",
      "--config",
      policyPath,
      "--after",
      secondReport.inventoryDigest,
    );
    expect(third.code).toBe(0);
    const thirdReport = JSON.parse(third.stdout) as typeof firstReport;
    expect(thirdReport).toMatchObject({
      candidates: 1,
      observedCandidates: 1,
      sourceCoverageVerified: true,
      sourcePoolSealed: true,
      traversal: {
        offset: 10,
        observedUniqueCandidates: 11,
        complete: true,
        nextPageAvailable: false,
      },
    });
    expect(listingFetches).toBe(1);
    expect(prompts).toHaveLength(0);
    expect(ledger().read({ type: "target-selected", limit: 100 })).toHaveLength(
      0,
    );

    const exhausted = await run(
      "inventory",
      "collect",
      "--config",
      policyPath,
      "--after",
      thirdReport.inventoryDigest,
    );
    expect(exhausted.code).toBe(1);
    expect(exhausted.stderr).toContain("no verified next page");
    await writeFile(
      policyPath,
      JSON.stringify({ ...automatic, minimumActiveInstallations: 10_000 }),
    );
    const changedPolicy = await run(
      "inventory",
      "collect",
      "--config",
      policyPath,
      "--after",
      firstReport.inventoryDigest,
    );
    expect(changedPolicy.code).toBe(1);
    expect(changedPolicy.stderr).toContain(
      "does not match its selection policy",
    );
    await writeFile(
      policyPath,
      JSON.stringify({
        ...automatic,
        candidateSource: { ...automatic.candidateSource, maxCandidates: 11 },
      }),
    );
    const singlePage = await run(
      "inventory",
      "collect",
      "--config",
      policyPath,
    );
    expect(singlePage.code).toBe(0);
    expect(JSON.parse(singlePage.stdout)).toMatchObject({
      sourceCoverageVerified: true,
      traversal: { offset: 0, complete: true },
    });
    observationFails = true;
    const uncertain = await run("inventory", "collect", "--config", policyPath);
    expect(uncertain.code).toBe(0);
    expect(JSON.parse(uncertain.stdout)).toMatchObject({
      ineligibleByReason: { "observation-unavailable": 1 },
      sourceCoverageVerified: false,
      source: { status: "available", requestedListingCoverage: "all-observed" },
      traversal: { offset: 0, complete: true },
    });
    listingFails = true;
    await writeFile(policyPath, JSON.stringify(automatic));
    const unavailable = await run(
      "inventory",
      "collect",
      "--config",
      policyPath,
    );
    expect(unavailable.code).toBe(0);
    expect(JSON.parse(unavailable.stdout)).toMatchObject({
      candidates: 0,
      sourceCoverageVerified: false,
      source: {
        status: "unavailable",
        requestedListingCoverage: "none-observed",
      },
      traversal: { complete: true },
    });
  });

  it("prepares a continuous child through the host trial gate without starting a Trial", async () => {
    const slugs = ["item-a", "item-b", "item-c", "item-d"];
    let holdOne = true;
    const gateChecks: string[] = [];
    const readyDirectories: string[] = [];
    const gate: RepeatTrialGate = {
      ...syntheticTrialGate,
      ensureReady: (directory) => readyDirectories.push(directory),
      inspectInitialSlug: (slug) => {
        gateChecks.push(slug);
        return slug === "item-a"
          ? { status: "prior-start", startedTrials: 1 }
          : slug === "item-b" && holdOne
            ? {
                status: "coverage-incomplete",
                reason: "legacy-history-unverified",
              }
            : { status: "eligible", coverageDigest: sha("f") };
      },
    };
    const { configPath, root, run, state, profile, ledger, prompts, docker } =
      await harness({
        candidates: slugs,
        repeatTrialGate: gate,
        inventoryFetch: async () =>
          new Response(
            JSON.stringify({
              info: { page: 1 },
              plugins: slugs.map((slug) => ({ slug })),
            }),
            {
              status: 200,
              headers: { Date: new Date(now).toUTCString() },
            },
          ),
      });
    const policyPath = join(root, "selection.json");
    const manual = JSON.parse(await readFile(policyPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete manual.candidateSlugs;
    delete manual.pinnedVersions;
    await writeFile(
      policyPath,
      JSON.stringify({
        ...manual,
        promptVariant: "short-objective-managed-v4",
        revisitPolicy: { kind: "never" },
        wordpressVersion: "6.8",
        maximumTargets: 3,
        candidateSource: {
          kind: "wordpress-org",
          popularPages: 1,
          tags: [],
          pagesPerTag: 1,
          perPage: 4,
          maxCandidates: 5,
          maxAgeDays: 1,
        },
      }),
    );
    await expect(
      profile.continuousPolicyDigest!(state(), { configPath: policyPath }),
    ).rejects.toThrow("campaign config");
    const policyDigest = await profile.continuousPolicyDigest!(state(), {
      configPath,
    });
    const inventoryResult = await run(
      "inventory",
      "collect",
      "--config",
      configPath,
    );
    expect(inventoryResult.code).toBe(0);
    const inventory = JSON.parse(inventoryResult.stdout) as {
      inventoryDigest: string;
      sourceCoverageVerified: boolean;
    };
    expect(inventory.sourceCoverageVerified).toBe(true);
    const journal = new SqliteContinuousRunJournal(
      join(root, "continuous-adapter.sqlite"),
      () => new Date(now),
    );
    try {
      const created = journal.create({
        parentRunId: "adapter-parent",
        stateDirectory: state().stateDirectory,
        configDigest: sha("e"),
        policyDigest,
        inventoryDigest: inventory.inventoryDigest,
      });
      const parent = journal.reserveChild(
        created.parentRunId,
        created.revision,
      );
      const preparation = {
        parent,
        owner: { assertReady: () => {} },
        ownerHandle: {
          parentRunId: parent.parentRunId,
          token: "a".repeat(64),
        },
        configPath,
      };
      const final = await profile.prepareContinuousBatch!(state(), preparation);
      expect(final).toMatchObject({ status: "ready" });
      if (final.status !== "ready") throw new Error("Expected final batch");
      expect(final.snapshotDigests).toHaveLength(2);
      expect(ledger().read({ type: "target-selected" })).toHaveLength(2);
      holdOne = false;
      const result = await profile.prepareContinuousBatch!(
        state(),
        preparation,
      );
      expect(result).toEqual(final);
      expect(ledger().read({ type: "target-selected" })).toHaveLength(2);
      expect(gateChecks).toContain("item-a");
      expect(gateChecks).toContain("item-b");
      expect(readyDirectories).toHaveLength(gateChecks.length);
      expect(readyDirectories).toEqual(
        Array(gateChecks.length).fill(state().stateDirectory),
      );
      expect(prompts).toHaveLength(0);
      expect(docker).toHaveLength(0);
    } finally {
      journal.close();
    }
  });

  it("enumerates without nominated slugs, reserves the next ranked batch, and runs that batch", async () => {
    const candidates = [
      "item-a",
      "item-b",
      "item-c",
      "item-d",
      "item-e",
      "item-f",
      "item-g",
      "item-h",
      "item-i",
    ];
    const listingObservations = [
      {
        kind: "popular" as const,
        page: 1,
        sourceUrl:
          "https://api.wordpress.org/plugins/info/1.2/?request%5Bbrowse%5D=popular",
        checkedAt: now,
        status: "available" as const,
        observedAt: now,
        contentDigest: sha("b"),
      },
      {
        kind: "tag" as const,
        tag: "login",
        page: 1,
        sourceUrl:
          "https://api.wordpress.org/plugins/info/1.2/?request%5Btag%5D=login",
        checkedAt: now,
        status: "unavailable" as const,
        reason: "http-error" as const,
      },
    ];
    const {
      run,
      configPath,
      root,
      ledger,
      store,
      profile,
      state,
      docker,
      prompts,
    } = await harness({
      candidates,
      listingObservations,
    });
    const policyPath = join(root, "selection.json");
    const manual = JSON.parse(await readFile(policyPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete manual.candidateSlugs;
    delete manual.pinnedVersions;
    await writeFile(
      policyPath,
      JSON.stringify({
        ...manual,
        promptVariant: "short-objective-managed-v4",
        revisitPolicy: { kind: "never" },
        wordpressVersion: "6.8",
        maximumTargets: 3,
        candidateSource: {
          kind: "wordpress-org",
          popularPages: 1,
          tags: [],
          pagesPerTag: 1,
          perPage: 20,
          maxCandidates: 20,
          maxAgeDays: 1,
        },
      }),
    );
    const first = await run("select", "--config", policyPath);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("wporg:item-a 9.9.9 score");
    expect(first.stdout).toContain("wporg:item-c 9.9.9 score");
    expect(first.stdout).toContain("breakdown installations=");
    expect(first.stdout).toContain(
      "excluded wporg:item-d  reasons below-rank-cutoff",
    );
    const second = await run("select", "--config", policyPath);
    expect(second.code).toBe(0);
    expect(second.stdout).not.toContain("wporg:item-a 9.9.9 score");
    expect(second.stdout).toContain(
      "excluded wporg:item-a  reasons previously-selected",
    );
    expect(second.stdout).toContain("wporg:item-d 9.9.9 score");
    expect(second.stdout).toContain("wporg:item-f 9.9.9 score");
    const reservations = ledger()
      .read({ type: "target-selected", limit: 100 })
      .filter(({ event }) => event.campaignId.startsWith("selection-"));
    expect(reservations).toHaveLength(6);
    const firstBatchId = reservations[0]!.event.campaignId;
    const firstDigests = reservations
      .slice(0, 3)
      .map(({ event }) => event.snapshotDigest);
    const secondDigests = reservations
      .slice(3)
      .map(({ event }) => event.snapshotDigest);
    const dockerBeforeRejectedPin = docker.length;
    await expect(
      profile.runCampaign(state(), {
        campaignId: "campaign-wrong-pin",
        configPath,
        target: "item-a",
        selectionBatchId: firstBatchId,
        snapshotDigests: secondDigests,
      }),
    ).rejects.toThrow("Snapshots differ from requested pin");
    expect(docker).toHaveLength(dockerBeforeRejectedPin);
    expect(prompts).toHaveLength(0);
    expect(
      ledger().read({ campaignId: "campaign-wrong-pin", limit: 10 }),
    ).toHaveLength(0);
    expect(new Set(firstDigests).size).toBe(3);
    await expect(
      profile.runCampaign(state(), {
        campaignId: "campaign-wrong-order",
        configPath,
        target: "item-a",
        selectionBatchId: firstBatchId,
        snapshotDigests: [...firstDigests].reverse(),
      }),
    ).rejects.toThrow("Snapshots differ from requested pin");
    expect(docker).toHaveLength(dockerBeforeRejectedPin);

    expect(
      reservations.every(({ event }) =>
        event.artifacts.some(
          (artifact) => artifact.kind === "selection-report",
        ),
      ),
    ).toBe(true);
    const reportRef = reservations[0]?.event.artifacts.find(
      (artifact) => artifact.kind === "selection-report",
    );
    expect(reportRef).toBeDefined();
    const reportFile = await store().readFile(
      reportRef!.digest,
      "selection-report.json",
      2 * 1024 * 1024,
    );
    expect(reportFile.status).toBe("resolved");
    if (reportFile.status !== "resolved") return;
    expect(JSON.parse(reportFile.bytes.toString("utf8"))).toMatchObject({
      sourceStatus: "available",
      sourceListings: listingObservations,
    });
    const campaignConfig = JSON.parse(
      await readFile(configPath, "utf8"),
    ) as Record<string, unknown>;
    await writeFile(
      configPath,
      JSON.stringify({ ...campaignConfig, promptId: "short-objective-v2" }),
    );
    const mismatched = await run(
      "campaign",
      "run",
      "item-d",
      "--campaign",
      "campaign-mismatched",
      "--config",
      configPath,
    );
    expect(mismatched.code).toBe(1);
    expect(mismatched.stderr).toContain("prompt variants differ");
    await writeFile(configPath, JSON.stringify(campaignConfig));
    const campaign = await run(
      "campaign",
      "run",
      "item-d",
      "--campaign",
      "campaign-reserved",
      "--config",
      configPath,
    );
    expect(campaign.code).toBe(0);
    expect(campaign.stdout).toContain("wporg:item-d 9.9.9");
    const bound = ledger().read({
      campaignId: "campaign-reserved",
      type: "selection-batch-bound",
    });
    expect(bound).toHaveLength(1);
    expect(bound[0]?.event).toMatchObject({
      type: "selection-batch-bound",
      selectionBatchId: reservations[3]?.event.campaignId,
      selectionIds: ["wporg:item-d@9.9.9"],
    });
    const dockerBeforeConflictingPin = docker.length;
    await expect(
      profile.runCampaign(state(), {
        campaignId: "campaign-reserved",
        configPath,
        target: "item-d",
        selectionBatchId: firstBatchId,
        snapshotDigests: firstDigests,
      }),
    ).rejects.toThrow("selection batch differs from its requested pin");
    expect(docker).toHaveLength(dockerBeforeConflictingPin);

    const third = await run("select", "--config", policyPath);
    expect(third.code).toBe(0);
    expect(third.stdout).toContain("wporg:item-g 9.9.9 score");
    const resumed = await run(
      "campaign",
      "run",
      "item-d",
      "--campaign",
      "campaign-reserved",
      "--config",
      configPath,
    );
    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toContain("wporg:item-d 9.9.9");
    expect(
      ledger().read({
        campaignId: "campaign-reserved",
        type: "selection-batch-bound",
      }),
    ).toHaveLength(1);
    const changedTarget = await run(
      "campaign",
      "run",
      "item-g",
      "--campaign",
      "campaign-reserved",
      "--config",
      configPath,
    );
    expect(changedTarget.code).toBe(1);
    expect(changedTarget.stderr).toContain("target set differs");

    const pinned = await profile.runCampaign(state(), {
      campaignId: "campaign-pinned-first",
      configPath,
      target: "item-a",
      selectionBatchId: firstBatchId,
      snapshotDigests: firstDigests,
    });
    expect(pinned.targets.map(({ targetId }) => targetId)).toEqual([
      "wporg:item-a",
    ]);
    expect(
      ledger().read({
        campaignId: "campaign-pinned-first",
        type: "selection-batch-bound",
      })[0]?.event,
    ).toMatchObject({
      selectionBatchId: firstBatchId,
      selectionIds: ["wporg:item-a@9.9.9"],
    });
  });

  it("records scope, a draft, its authorization, the human submission and the outcome as ledger events", async () => {
    const { run, configPath, root } = await harness({
      scopeFacts: {
        // Synthetic facts standing in for judge evidence and target observations.
        load: async () => ({
          category: "account-takeover",
          attacker: "subscriber",
          activeInstalls: 5000,
          wordpressOrgListed: true,
          premium: false,
          latestVersionVerified: true,
          defaultOrCommonSettings: true,
          observations: ["admin-session-reached", "other-session-reached"],
        }),
      },
    });
    const campaign = ["--campaign", "campaign-1"];
    await run("campaign", "run", "--all", ...campaign, "--config", configPath);
    const queue = await run("review", ...campaign);
    const finding = /^runtime-confirmed\s+\S+\s+finding (\S+)/m.exec(
      queue.stdout,
    )![1]!;
    const target = [...campaign, "--finding", finding];

    const dedupe = await run("review", "dedupe", ...target);
    expect(dedupe.code).toBe(0);
    // No local Wordfence mirror is configured, so no duplicate verdict is inferred.
    expect(dedupe.stdout).toBe("duplicate: unavailable");

    const scoped = await run("review", "scope", ...target);
    expect(scoped.stderr).toBe("");
    expect(scoped.stdout).toMatch(/^wordfence in-scope /m);
    expect(scoped.stdout).toMatch(/^patchstack \S+ /m);

    await run(
      "review",
      "decide",
      ...target,
      "--decision",
      "accept",
      "--reason",
      "reproduced-by-hand",
    );
    const draftPath = join(root, "draft.md");
    await writeFile(draftPath, "Synthetic private draft text\n");
    const drafted = await run(
      "review",
      "draft",
      ...target,
      "--programme",
      "wordfence",
      "--file",
      draftPath,
    );
    expect(drafted.stderr).toBe("");
    expect(drafted.stdout).not.toContain("Synthetic private draft text");
    const [, candidate, draft] =
      /candidate (\S+)\s+draft (\S+)\s+revision 1/.exec(drafted.stdout)!;
    const exact = [
      "--candidate",
      candidate!,
      "--draft",
      draft!,
      "--to",
      "wordfence",
    ];

    const early = await run("review", "submitted", ...exact);
    expect(early.code).toBe(1);
    expect(early.stderr).toContain("not authorized");
    expect(
      (await run("review", "authorize", ...exact, "--by", "operator")).code,
    ).toBe(0);
    expect((await run("review", "submitted", ...exact)).code).toBe(0);
    expect(
      (
        await run(
          "review",
          "outcome",
          "--candidate",
          candidate!,
          "--outcome",
          "triaged",
        )
      ).code,
    ).toBe(0);
    const resolved = await run(
      "review",
      "outcome",
      "--candidate",
      candidate!,
      "--outcome",
      "resolved",
      "--reward",
      "250",
    );
    expect(resolved.stderr).toBe("");
    expect(resolved.stdout).toBe("outcome resolved recorded (reward $250.00)");
    expect(
      (
        await run(
          "review",
          "outcome",
          "--candidate",
          candidate!,
          "--outcome",
          "resolved",
          "--reward",
          "-1",
        )
      ).code,
    ).toBe(2);

    const funnel = await run("ledger", "funnel", ...campaign);
    expect(funnel.stdout).toContain(
      "reviewed 1 → in-scope 1 → submitted 1 → outcome 1",
    );
    // Each candidate counts once, under its latest outcome.
    expect(funnel.stdout).toContain("outcomes: resolved 1  reward $250.00");
    expect(funnel.stdout).toContain("in-scope by programme: patchstack");
    expect(funnel.stdout).toMatch(/wordfence 1/);
  });

  it("assesses scope from the judge's evidence and the selection record without injected facts", async () => {
    const { run, configPath } = await harness();
    const campaign = ["--campaign", "campaign-1"];
    await run("campaign", "run", "--all", ...campaign, "--config", configPath);
    const queue = await run("review", ...campaign);
    const finding = /^runtime-confirmed\s+\S+\s+finding (\S+)/m.exec(
      queue.stdout,
    )![1]!;
    const scoped = await run(
      "review",
      "scope",
      ...campaign,
      "--finding",
      finding,
    );
    expect(scoped.stderr).toBe("");
    // Facts are read; only the unverified latest version keeps scope open.
    expect(scoped.stdout).toMatch(
      /^wordfence ambiguous \(version-or-configuration-unknown;/m,
    );
    expect(scoped.stdout).toMatch(
      /^patchstack ambiguous \(version-or-configuration-unknown;/m,
    );
  });

  it("re-verifies a finding on the target's latest version and only then treats the version as verified", async () => {
    const { run, configPath } = await harness();
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      lab: Record<string, unknown>;
    };
    config.lab.scenarioId = "approved-comment-v1";
    await writeFile(configPath, JSON.stringify(config));
    const campaign = ["--campaign", "campaign-1"];
    await run("campaign", "run", "--all", ...campaign, "--config", configPath);
    const queue = await run("review", ...campaign);
    const finding = /^runtime-confirmed\s+\S+\s+finding (\S+)/m.exec(
      queue.stdout,
    )![1]!;
    const original = /verification (\S+)\s+snapshot (\S+)/.exec(queue.stdout)!;

    const reverified = await run(
      "review",
      "reverify",
      ...campaign,
      "--finding",
      finding,
      "--config",
      configPath,
    );
    expect(reverified.stderr).toBe("");
    expect(reverified.code).toBe(0);
    expect(reverified.stdout).toMatch(
      /^reverified finding \S+ as \S+ on wporg:synthetic-plugin 9\.9\.9  snapshot sha256:[a-f0-9]{64}  verification \S+: runtime-confirmed$/m,
    );
    const derived = /^reverified finding \S+ as (\S+) on/m.exec(
      reverified.stdout,
    )![1]!;
    expect(derived).not.toBe(finding);

    const after = await run("review", ...campaign);
    const derivedAt = after.stdout.indexOf(`finding ${derived}`);
    expect(derivedAt).toBeGreaterThanOrEqual(0);
    const latest = /verification (\S+)\s+snapshot (\S+)/.exec(
      after.stdout.slice(derivedAt),
    )!;
    // A fresh verification on a fresh snapshot; the old digest is not reused.
    expect(latest[1]).not.toBe(original[1]);
    expect(latest[2]).not.toBe(original[2]);
    const scoped = await run(
      "review",
      "scope",
      ...campaign,
      "--finding",
      derived,
    );
    expect(scoped.stdout).toMatch(/^wordfence in-scope /m);
    expect(scoped.stdout).toMatch(/^patchstack in-scope /m);
  });

  it("retries an incomplete Finding on its original Snapshot with a fresh scenario and verification event", async () => {
    const { run, configPath, ledger, verifierReferenceRoutes } = await harness({
      pinned: false,
      firstVerifierIncomplete: true,
    });
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      lab: Record<string, unknown>;
    };
    config.lab.scenarioId = "approved-comment-v1";
    await writeFile(configPath, JSON.stringify(config));
    const campaign = ["--campaign", "campaign-1"];
    expect(
      (
        await run(
          "campaign",
          "run",
          "--all",
          ...campaign,
          "--config",
          configPath,
        )
      ).code,
    ).toBe(0);
    const finding = ledger()
      .read({ campaignId: "campaign-1", type: "finding-recorded" })
      .map(({ event }) => event)
      .find(
        (event) =>
          event.type === "finding-recorded" &&
          event.category === "account-takeover",
      );
    expect(finding?.type).toBe("finding-recorded");
    if (finding?.type !== "finding-recorded") return;
    const before = ledger()
      .read({
        campaignId: "campaign-1",
        findingId: finding.findingId,
        type: "verification-finished",
      })
      .map(({ event }) => event);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      result: { status: "incomplete", reason: "precondition" },
    });
    const beforeRetryEvents = ledger().read({
      campaignId: "campaign-1",
    }).length;
    const repeated = await run(
      "review",
      "reverify",
      ...campaign,
      "--finding",
      finding.findingId,
      "--config",
      configPath,
    );
    expect(repeated.code).not.toBe(0);
    expect(repeated.stderr).toContain("different Lab scenario");
    expect(ledger().read({ campaignId: "campaign-1" })).toHaveLength(
      beforeRetryEvents,
    );

    config.lab.scenarioId = "private-page-v1";
    await writeFile(configPath, JSON.stringify(config));
    const retried = await run(
      "review",
      "reverify",
      ...campaign,
      "--finding",
      finding.findingId,
      "--config",
      configPath,
    );
    expect(retried.code).toBe(0);
    expect(retried.stdout).toContain(
      `reverified finding ${finding.findingId} as ${finding.findingId}`,
    );
    expect(retried.stdout).toContain(": runtime-confirmed");
    expect(verifierReferenceRoutes.at(-1)).toBeUndefined();
    const after = ledger()
      .read({
        campaignId: "campaign-1",
        findingId: finding.findingId,
        type: "verification-finished",
      })
      .map(({ event }) => event);
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toMatchObject({
      findingId: finding.findingId,
      snapshotDigest: finding.snapshotDigest,
      result: { status: "runtime-confirmed" },
      basis: {
        kind: "latest-version",
        findingSnapshotDigest: finding.snapshotDigest,
      },
    });
    if (
      after[0]?.type !== "verification-finished" ||
      after[1]?.type !== "verification-finished"
    )
      return;
    expect(after[1].verificationId).not.toBe(after[0].verificationId);
    expect(after[1].labSetupDigest).not.toBe(after[0].labSetupDigest);
    const retryVerificationId = after[1].verificationId;
    expect(
      ledger()
        .read({ campaignId: "campaign-1", type: "lab-provisioned" })
        .map(({ event }) => event)
        .find(
          (event) =>
            event.type === "lab-provisioned" &&
            event.identity === `verification-lab-${retryVerificationId}`,
        ),
    ).toMatchObject({ scenario: { id: "private-page-v1" } });
  });

  it("retries a pinned older Snapshot after a scenario change without creating a fixed-version control", async () => {
    const { run, configPath, ledger, verifierReferenceRoutes } = await harness({
      firstVerifierIncomplete: true,
    });
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      lab: Record<string, unknown>;
    };
    config.lab.scenarioId = "approved-comment-v1";
    await writeFile(configPath, JSON.stringify(config));
    const campaign = ["--campaign", "campaign-1"];
    expect(
      (
        await run(
          "campaign",
          "run",
          "--all",
          ...campaign,
          "--config",
          configPath,
        )
      ).code,
    ).toBe(0);
    const finding = ledger()
      .read({ campaignId: "campaign-1", type: "finding-recorded" })
      .map(({ event }) => event)
      .find(
        (event) =>
          event.type === "finding-recorded" &&
          event.category === "account-takeover",
      );
    expect(finding?.type).toBe("finding-recorded");
    if (finding?.type !== "finding-recorded") return;
    const before = ledger()
      .read({
        campaignId: "campaign-1",
        findingId: finding.findingId,
        type: "verification-finished",
      })
      .map(({ event }) => event);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      result: { status: "incomplete", reason: "precondition" },
    });
    const findingsBefore = ledger().read({
      campaignId: "campaign-1",
      type: "finding-recorded",
    });

    config.lab.scenarioId = "private-page-v1";
    await writeFile(configPath, JSON.stringify(config));
    const retried = await run(
      "review",
      "reverify",
      ...campaign,
      "--finding",
      finding.findingId,
      "--config",
      configPath,
      "--version",
      "3.3.1",
    );
    expect(retried.code).toBe(0);
    expect(retried.stdout).toContain(
      `reverified finding ${finding.findingId} as ${finding.findingId} on wporg:synthetic-plugin 3.3.1`,
    );
    expect(verifierReferenceRoutes.at(-1)).toBeUndefined();
    const after = ledger()
      .read({
        campaignId: "campaign-1",
        findingId: finding.findingId,
        type: "verification-finished",
      })
      .map(({ event }) => event);
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toMatchObject({
      findingId: finding.findingId,
      snapshotDigest: finding.snapshotDigest,
      result: { status: "runtime-confirmed" },
    });
    expect(after[1]).not.toHaveProperty("basis");
    expect(
      ledger().read({ campaignId: "campaign-1", type: "finding-recorded" }),
    ).toEqual(findingsBefore);
  });

  it("rejects unconfirmed version changes and fixed-version controls before starting a Lab", async () => {
    const { run, configPath, ledger, docker } = await harness({
      firstVerifierIncomplete: true,
    });
    const campaign = ["--campaign", "campaign-1"];
    expect(
      (
        await run(
          "campaign",
          "run",
          "--all",
          ...campaign,
          "--config",
          configPath,
        )
      ).code,
    ).toBe(0);
    const finding = ledger()
      .read({ campaignId: "campaign-1", type: "finding-recorded" })
      .map(({ event }) => event)
      .find(
        (event) =>
          event.type === "finding-recorded" &&
          event.category === "account-takeover",
      );
    expect(finding?.type).toBe("finding-recorded");
    if (finding?.type !== "finding-recorded") return;
    const labStarts = () =>
      docker.filter(
        (request) =>
          request.args[0] === "network" && request.args[1] === "create",
      ).length;
    const beforeLabStarts = labStarts();
    const beforeEvents = ledger().read({ campaignId: "campaign-1" }).length;
    const changedSnapshot = await run(
      "review",
      "reverify",
      ...campaign,
      "--finding",
      finding.findingId,
      "--config",
      configPath,
    );
    expect(changedSnapshot.code).not.toBe(0);
    expect(changedSnapshot.stderr).toContain("original Snapshot");
    const fixedVersion = await run(
      "review",
      "reverify",
      ...campaign,
      "--finding",
      finding.findingId,
      "--config",
      configPath,
      "--version",
      "3.3",
    );
    expect(fixedVersion.code).not.toBe(0);
    expect(fixedVersion.stderr).toContain(
      "An evidence-backed route is required for fixed-version comparison",
    );
    expect(labStarts()).toBe(beforeLabStarts);
    expect(ledger().read({ campaignId: "campaign-1" })).toHaveLength(
      beforeEvents,
    );
  });

  it("reconfirms a legacy route on the same Snapshot before a fixed-version control", async () => {
    const { run, configPath, ledger } = await harness();
    const campaign = ["--campaign", "campaign-1"];
    await run("campaign", "run", "--all", ...campaign, "--config", configPath);
    const finding = /^runtime-confirmed\s+\S+\s+finding (\S+)/m.exec(
      (await run("review", ...campaign)).stdout,
    )![1]!;

    const sameVersion = await run(
      "review",
      "reverify",
      ...campaign,
      "--finding",
      finding,
      "--config",
      configPath,
      "--version",
      "3.3.1",
    );
    expect(sameVersion.code).toBe(0);
    expect(sameVersion.stdout).toContain(
      `reverified finding ${finding} as ${finding} on wporg:synthetic-plugin 3.3.1`,
    );
    expect(
      ledger()
        .read({ campaignId: "campaign-1", type: "verification-finished" })
        .at(-1)?.event,
    ).not.toHaveProperty("basis");

    const controlled = await run(
      "review",
      "reverify",
      ...campaign,
      "--finding",
      finding,
      "--config",
      configPath,
      "--version",
      "3.3",
    );
    expect(controlled.code).toBe(0);
    expect(controlled.stdout).toContain("wporg:synthetic-plugin 3.3 ");
    expect(
      ledger()
        .read({ campaignId: "campaign-1", type: "verification-finished" })
        .at(-1)?.event,
    ).toMatchObject({ basis: { kind: "fixed-version" } });
    const scoped = await run(
      "review",
      "scope",
      ...campaign,
      "--finding",
      finding,
    );
    expect(scoped.stdout).toMatch(/^wordfence ambiguous /m);
  });

  it("rechecks a confirmed Finding on its original Snapshot after the Lab scenario changes", async () => {
    const { run, configPath, ledger, verifierReferenceRoutes } =
      await harness();
    const campaign = ["--campaign", "campaign-1"];
    expect(
      (
        await run(
          "campaign",
          "run",
          "--all",
          ...campaign,
          "--config",
          configPath,
        )
      ).code,
    ).toBe(0);
    const finding = /^runtime-confirmed\s+\S+\s+finding (\S+)/m.exec(
      (await run("review", ...campaign)).stdout,
    )![1]!;
    const before = ledger().read({
      campaignId: "campaign-1",
      findingId: finding,
      type: "verification-finished",
    });
    const findingsBefore = ledger().read({
      campaignId: "campaign-1",
      type: "finding-recorded",
    });
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      lab: Record<string, unknown>;
    };
    config.lab.scenarioId = "approved-comment-v1";
    await writeFile(configPath, JSON.stringify(config));

    const beforeMismatchEvents = ledger().read({
      campaignId: "campaign-1",
    }).length;
    const mismatchedControl = await run(
      "review",
      "reverify",
      ...campaign,
      "--finding",
      finding,
      "--config",
      configPath,
      "--version",
      "3.3",
    );
    expect(mismatchedControl.code).not.toBe(0);
    expect(mismatchedControl.stderr).toContain(
      "requires the confirmed Finding's Lab scenario",
    );
    expect(ledger().read({ campaignId: "campaign-1" })).toHaveLength(
      beforeMismatchEvents,
    );

    const retried = await run(
      "review",
      "reverify",
      ...campaign,
      "--finding",
      finding,
      "--config",
      configPath,
      "--version",
      "3.3.1",
    );
    expect(retried.code).toBe(0);
    expect(retried.stdout).toContain(
      `reverified finding ${finding} as ${finding} on wporg:synthetic-plugin 3.3.1`,
    );
    expect(retried.stdout).toContain(": runtime-confirmed");
    expect(verifierReferenceRoutes.at(-1)).toBeUndefined();
    expect(
      ledger().read({ campaignId: "campaign-1", type: "finding-recorded" }),
    ).toEqual(findingsBefore);
    const after = ledger().read({
      campaignId: "campaign-1",
      findingId: finding,
      type: "verification-finished",
    });
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)?.event).toMatchObject({
      findingId: finding,
      result: { status: "runtime-confirmed" },
    });
    expect(after.at(-1)?.event).not.toHaveProperty("basis");
    const latest = after.at(-1)?.event;
    expect(latest?.type).toBe("verification-finished");
    if (latest?.type !== "verification-finished") return;
    expect(
      ledger()
        .read({ campaignId: "campaign-1", type: "lab-provisioned" })
        .map(({ event }) => event)
        .find(
          (event) =>
            event.type === "lab-provisioned" &&
            event.identity === `verification-lab-${latest.verificationId}`,
        ),
    ).toMatchObject({ scenario: { id: "approved-comment-v1" } });

    const controlled = await run(
      "review",
      "reverify",
      ...campaign,
      "--finding",
      finding,
      "--config",
      configPath,
      "--version",
      "3.3",
    );
    expect(controlled.code).toBe(0);
    expect(verifierReferenceRoutes.at(-1)).toBeDefined();
    expect(
      ledger()
        .read({ campaignId: "campaign-1", type: "verification-finished" })
        .at(-1)?.event,
    ).toMatchObject({ basis: { kind: "fixed-version" } });
  });

  it("replays a confirmed route into a separate campaign without adding a verdict to the source campaign", async () => {
    const { run, configPath, ledger, state, profile } = await harness();
    await run(
      "campaign",
      "run",
      "--all",
      "--campaign",
      "source-campaign",
      "--config",
      configPath,
    );
    const source = ledger().read({
      campaignId: "source-campaign",
      limit: 1000,
    });
    const finding = source.find(
      ({ event }) =>
        event.type === "finding-recorded" &&
        event.category === "account-takeover",
    )?.event;
    if (finding?.type !== "finding-recorded")
      throw new Error("Missing synthetic confirmed Finding");
    const seed = source
      .map(({ event }) => event)
      .filter(
        (event) =>
          event.snapshotDigest === finding.snapshotDigest &&
          (event.type === "target-selected" ||
            event.type === "snapshot-frozen" ||
            (event.type === "finding-recorded" &&
              event.findingId === finding.findingId)),
      );
    for (const event of seed)
      expect(
        await ledger().append({
          ...event,
          identity: `smoke-seed-${event.type}`,
          campaignId: "smoke-campaign",
        }),
      ).toMatchObject({ status: "appended" });

    const replayed = await profile.reverify(state(), {
      campaignId: "smoke-campaign",
      findingId: finding.findingId,
      referenceCampaignId: "source-campaign",
      snapshotCampaignId: "source-campaign",
      configPath,
    });
    expect(replayed.status).toBe("runtime-confirmed");
    expect(
      ledger().read({ campaignId: "source-campaign", limit: 1000 }),
    ).toHaveLength(source.length);
    const verification = ledger()
      .read({ campaignId: "smoke-campaign", type: "verification-finished" })
      .at(-1)?.event;
    expect(verification).toMatchObject({
      result: { status: "runtime-confirmed" },
    });
    expect(verification).not.toHaveProperty("basis");

    await expect(
      profile.reverify(state(), {
        campaignId: "smoke-campaign",
        findingId: finding.findingId,
        referenceCampaignId: "absent-campaign",
        configPath,
      }),
    ).rejects.toThrow("reference route belongs to a different Finding");
  });

  it("refuses to record a decision for a finding outside the review queue", async () => {
    const { run } = await harness();
    const result = await run(
      "review",
      "decide",
      "--campaign",
      "campaign-1",
      "--finding",
      "absent",
      "--decision",
      "accept",
      "--reason",
      "manual",
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("not in the review queue");
  });

  it("exports one-screen review material with Private Evidence paths and brings the verification Lab up and down (#186)", async () => {
    const { run, configPath, docker, live, ledger, root } = await harness();
    const campaign = await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-1",
      "--config",
      configPath,
    );
    expect(campaign.code).toBe(0);
    const queue = await run("review", "--campaign", "campaign-1");
    const confirmedFinding = /^runtime-confirmed\s+\S+\s+finding (\S+)/m.exec(
      queue.stdout,
    )?.[1];
    expect(confirmedFinding).toBeDefined();

    // The observer captured the option the Verifier wrote; the verdict is the judge's alone.
    const verification = ledger().read({
      campaignId: "campaign-1",
      findingId: confirmedFinding!,
      type: "verification-finished",
    })[0]?.event;
    expect(verification).toMatchObject({
      result: { status: "runtime-confirmed" },
      labStateDiff: { status: "captured" },
    });

    const exported = await run(
      "review",
      "export",
      "--campaign",
      "campaign-1",
      "--finding",
      confirmedFinding!,
    );
    expect(exported.stderr).toBe("");
    expect(exported.code).toBe(0);
    const bundle = reviewExportV1Schema.parse(JSON.parse(exported.stdout));
    expect(bundle.schema).toBe("review-export/v1");
    expect(bundle.finding).toMatchObject({
      claim: "Synthetic account-takeover claim",
      attackerPosition: "subscriber",
      impact: "account-takeover",
      brokenProperty: "Synthetic property",
      promptVariant: "short-objective-managed-v4",
      promptDigest: expect.stringMatching(/^sha256:/),
    });
    expect(bundle.target).toMatchObject({
      selectionId: "wporg:synthetic-plugin@3.3.1",
      activeInstallations: 5000,
      versions: {
        explored: "3.3.1",
        latestKnown: "3.3.1",
        sameAsExplored: true,
      },
    });
    expect(bundle.verification).toMatchObject({
      status: "runtime-confirmed",
      evidenceCapture: "agent-authored",
    });
    // The fixture Verifier's http.json is not in the exchanges shape, so no rows are summarized.
    expect(bundle.http).toEqual({
      source: "unavailable",
      path: null,
      exchanges: [],
      truncated: false,
    });
    expect(bundle.labStateDiff).toMatchObject({
      status: "captured",
      summary: {
        settings: { changed: [{ key: "synthetic_plugin_shared" }] },
        principals: { added: [], removed: [], changed: [] },
      },
    });
    // Values stay in Private Evidence; the bundle carries names, digests and paths.
    expect(exported.stdout).not.toContain("untouched");
    expect(exported.stdout).not.toContain("written-");
    expect(exported.stdout).not.toContain("synthetic-victim-session");
    expect(exported.stdout).not.toContain("labObservations");
    expect(exported.stdout).not.toContain("admin@lab.invalid");
    const evidenceDirectory = join(root, "state", "private-evidence");
    expect(bundle.privateEvidence.directory).toBe(evidenceDirectory);
    expect(bundle.privateEvidence.artifacts.length).toBeGreaterThan(3);
    for (const artifact of bundle.privateEvidence.artifacts)
      expect(artifact.path).toBe(
        join(evidenceDirectory, artifact.digest, "content"),
      );
    if (bundle.labStateDiff.status !== "captured")
      throw new Error("unreachable");
    expect(
      JSON.parse(
        await readFile(
          join(bundle.labStateDiff.path, "lab-state-diff.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      schema: "wordpress-lab-state-diff/v1",
      summary: { optionsChanged: 1, usersChanged: 0 },
    });

    const decided = await run(
      "review",
      "decide",
      "--campaign",
      "campaign-1",
      "--finding",
      confirmedFinding!,
      "--decision",
      "accept",
      "--reason",
      "reproduced-by-hand",
      "--minutes",
      "5",
    );
    expect(decided.stderr).toBe("");
    expect(decided.code).toBe(0);
    expect(
      ledger().read({
        campaignId: "campaign-1",
        findingId: confirmedFinding!,
        type: "review-decided",
      })[0]?.event,
    ).toMatchObject({
      humanElapsedSeconds: 300,
      verificationId: expect.any(String),
      runId: expect.any(String),
      promptDigest: bundle.finding.promptDigest,
    });

    // lab up re-creates the verification Lab and publishes it on loopback; no ledger event is written.
    const dockerBefore = docker.length;
    const eventsBefore = ledger().read({ type: "lab-provisioned" }).length;
    const up = await run(
      "lab",
      "up",
      "--campaign",
      "campaign-1",
      "--finding",
      confirmedFinding!,
      "--config",
      configPath,
    );
    expect(up.stderr).toBe("");
    expect(up.code).toBe(0);
    const labId = /^lab ([0-9a-f-]{36}) up for finding /.exec(up.stdout)?.[1];
    expect(labId).toBeDefined();
    expect(up.stdout).toContain(`snapshot ${bundle.snapshotDigest}`);
    expect(up.stdout).toMatch(/same as verification \S+/);
    expect(up.stdout).toContain("http: http://127.0.0.1:8080/");
    expect(up.stdout).toMatch(
      /attacker subscriber: wbh-subscriber-\S+ \/ \S+ \(Lab only\)/,
    );
    expect(up.stdout).toContain(
      "database (read-only): mysql -h 127.0.0.1 -P 3307 -u wbh_reader",
    );
    expect(ledger().read({ type: "lab-provisioned" })).toHaveLength(
      eventsBefore,
    );
    const since = docker.slice(dockerBefore).map(({ args }) => args);
    expect(
      since.every(
        (args) =>
          (args[0] !== "run" && args[0] !== "create") ||
          args.includes("--runtime=runsc"),
      ),
    ).toBe(true);
    const gateway = since.find(
      (args) =>
        args[0] === "create" &&
        args[args.indexOf("--name") + 1] === `wbh-${labId}-host`,
    );
    expect(since).toContainEqual(["start", `wbh-${labId}-host`]);
    expect(gateway).toContain("127.0.0.1:8080:80");
    expect(gateway).toContain("127.0.0.1:3307:3306");
    expect(
      since.some(
        (args) =>
          args[0] === "network" &&
          args[1] === "connect" &&
          args[2] === `wbh-${labId}-net`,
      ),
    ).toBe(true);
    expect(
      [...live.containers].filter((name) => name.includes(labId!)),
    ).toEqual(
      expect.arrayContaining([
        `wbh-${labId}-db`,
        `wbh-${labId}-wp`,
        `wbh-${labId}-host`,
      ]),
    );
    const again = await run(
      "lab",
      "up",
      "--campaign",
      "campaign-1",
      "--finding",
      confirmedFinding!,
      "--config",
      configPath,
    );
    expect(again.code).not.toBe(0);
    expect(again.stderr).toContain("already up");

    // lab down removes exactly this Lab's containers, network and volume; nothing of it remains.
    const removalsBefore = docker.length;
    const down = await run("lab", "down");
    expect(down.stderr).toBe("");
    expect(down.code).toBe(0);
    expect(down.stdout.split("\n")[0]).toBe(`lab ${labId} down`);
    expect(down.stdout).toMatch(/containers [1-9]\d* removed, 0 remaining$/m);
    expect(down.stdout).toMatch(/networks 1 removed, 0 remaining$/m);
    expect(down.stdout).toMatch(/volumes 1 removed, 0 remaining$/m);
    // Listing thousands of host volumes must not hit the 64 KiB default output cap.
    expect(
      docker
        .slice(removalsBefore)
        .filter(({ args }) => args[0] === "ps" || args[1] === "ls")
        .every((request) => request.maxOutputBytes >= 8 * 1024 * 1024),
    ).toBe(true);
    const removed = docker
      .slice(removalsBefore)
      .map(({ args }) => args)
      .filter(
        (args) =>
          args[0] === "rm" ||
          ((args[0] === "network" || args[0] === "volume") && args[1] === "rm"),
      )
      .flatMap((args) =>
        args
          .slice(args.indexOf("rm") + 1)
          .filter((arg) => !arg.startsWith("-")),
      );
    expect(removed.length).toBeGreaterThanOrEqual(4);
    expect(removed.every((name) => name.includes(labId!))).toBe(true);
    for (const names of Object.values(live))
      expect([...names].filter((name) => name.includes(labId!))).toEqual([]);
    const nothing = await run("lab", "down");
    expect(nothing.code).toBe(0);
    expect(nothing.stdout).toContain("no lab recorded by lab up");
  });
});
