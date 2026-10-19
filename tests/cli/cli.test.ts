import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
import { canonicalDigest } from "../../src/infrastructure/canonical-json.js";
import type { WordPressOrgTargetSource } from "../../src/profiles/wordpress/acquisition/index.js";
import { wordPressDiscoveryOutputContractV4 } from "../../src/profiles/wordpress/discovery/output-contract.js";
import {
  openWordPressLab,
  type DockerRequest,
} from "../../src/profiles/wordpress/lab/index.js";
import type { ProgrammeIntelligence } from "../../src/profiles/wordpress/programme-intelligence/index.js";
import { loadWordpressScopePolicy } from "../../src/profiles/wordpress/scope-policy.js";
import { loadWordPressDiscoveryAsset } from "../../src/profiles/wordpress/prompts/index.js";
import { createWordPressSelection } from "../../src/profiles/wordpress/selection/index.js";
import type { WordPressOrgListingObservation } from "../../src/profiles/wordpress/selection/wordpress-org-candidate-enumerator.js";
import {
  openSnapshot,
  SourceAcquisitionError,
} from "../../src/snapshot/index.js";
import { VerifierTransportIncompleteError } from "../../src/verification/index.js";

const sha = (value: string) => `sha256:${value.repeat(64)}`;
const uuid = "0f1e2d3c-4b5a-4987-a654-3210fedcba98";
const now = "2026-10-08T00:00:00.000Z";
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

/** The Root thread a refused cooperative run leaves behind (ADR 0036 tests). */
const REFUSED_ROOT_THREAD = "0f1e2d3c-4b5a-4987-a654-3210fedcba98";

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
    /** False selects the observed stable version instead of the 3.3.1 pin. */
    readonly pinned?: boolean;
    /** Opens a synthetic local Wordfence mirror holding one public record. */
    readonly history?: boolean;
    /** Provider calls (1-based) that the subscription refuses with a quota limit. */
    readonly limitOnCalls?: readonly number[];
    /** A completed child report survives a provider-limited Root Trial. */
    readonly childFindingOnLimitedCall?: boolean;
    readonly failOnCalls?: readonly number[];
    /** Provider calls (1-based) the provider refuses without a usage limit. */
    readonly refuseOnCalls?: readonly number[];
    /** A refused receipt names its Root thread and session file, as a cooperative run's does (ADR 0036). */
    readonly refusalSession?: boolean;
    /** Verifier attempts (1-based) that end on a provider quota. */
    readonly verifierQuotaOnAttempts?: readonly number[];
    readonly leadsOnCalls?: Readonly<Record<number, readonly unknown[]>>;
    readonly zeroFindings?: boolean;
    /** Candidate slugs; the first is not pinned. */
    readonly candidates?: readonly string[];
    readonly listingObservations?: readonly WordPressOrgListingObservation[];
    /** A slug whose snapshot cannot be frozen. */
    readonly failFreeze?: string;
    /** A slug whose acquired bytes disagree with its manifest. */
    readonly corruptSourceManifest?: string;
    /** Simulates an archive connection failing after the selection freeze succeeded. */
    readonly failRepeatedFreeze?: boolean;
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
    readonly labTeardownFails?: boolean;
    readonly verifierLabTeardownFails?: boolean;
    /** The first Finding lacks a runnable recipe until a new Lab scenario is selected. */
    readonly firstVerifierIncomplete?: boolean;
    readonly verifierRecipeFailures?: number;
    readonly verifierLabProvisionFailures?: number;
    readonly coreSource?: boolean;
    readonly dependencySources?: boolean;
    /** Plugin sources sealed in the original and control Snapshots. */
    readonly snapshotPluginDependencies?: Readonly<Record<string, string>>;
    readonly databaseAccess?: "read-only" | "none";
    readonly legacyHistoryUnavailable?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "wbh-cli-"));
  directories.push(root);
  const legacyHistoryFile = join(root, "legacy-history.json");
  if (!options.legacyHistoryUnavailable)
    await writeFile(
      legacyHistoryFile,
      JSON.stringify({
        schemaVersion: 1,
        sourceDigest: sha("a"),
        exportedAt: now,
        sources: ["synthetic"],
        started: [],
        ambiguous: [],
        reconsider: [],
      }),
    );
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
      resolve: async (snapshot) => ({
        target: {
          kind: "plugin",
          pluginSlug: "synthetic-plugin",
          sourceDirectory,
          sourceTree: tree,
        },
        dependencies: snapshot.dependencies.map((dependency) => ({
          kind: "plugin" as const,
          pluginSlug: dependency.identity.slice("wporg:".length),
          sourceDirectory,
          sourceTree: tree,
        })),
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
  });

  const selection = createWordPressSelection({
    targetSource: {
      observe: async ({ slug }: { slug: string }) => ({
        status: "observed",
        observation: {
          kind: "wordpress-org-target-observation",
          schemaVersion: 1,
          pluginIdentity: `wporg:${slug}`,
          officialSlug: slug,
          displayName: slug,
          stableVersion: "9.9.9",
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
            sourceUrl: `https://downloads.wordpress.org/plugin/${slug}.9.9.9.zip`,
          },
        },
        observationRef: {
          kind: "wordpress-org-target-observation-ref",
          schemaVersion: 1,
          id: `observation-${slug}`,
          digest: sha("c"),
        },
      }),
    } as unknown as WordPressOrgTargetSource,
    programme: {
      inspect: async () => ({
        status: "current",
        snapshotRef: programmeRef,
        snapshot: {
          programmeIdentity: "programme:wordfence",
          policy: {
            programmeOpportunityBand: "high-impact-only",
            eligibility: {
              assets: [
                { kind: "wordpress-plugin", scope: "publicly-distributed" },
              ],
            },
          },
        },
      }),
    } as unknown as ProgrammeIntelligence,
    programmeRef,
    clock: () => new Date(now),
    enumerateCandidates: async () => ({
      status: "available",
      candidates: (options.candidates ?? ["synthetic-plugin"]).map((slug) => ({
        slug,
        sourceKind: "popular" as const,
        sourcePage: 1,
        sourceUrl: "https://api.wordpress.org/plugins/info/1.2/",
        observedAt: now,
        contentDigest: sha("b"),
      })),
      listings: options.listingObservations ?? [],
    }),
  });
  const snapshots = openSnapshot({
    storageDirectory: join(root, "snapshots"),
    source: {
      acquire: async (target: { targetId: string; version: string }) => ({
        target: {
          identity: target.targetId,
          version: target.version,
          manifest:
            target.targetId === `wporg:${options.corruptSourceManifest}`
              ? {
                  ...manifest,
                  entries: manifest.entries.map((entry, index) =>
                    index === 0 ? { ...entry, size: entry.size + 1 } : entry,
                  ),
                }
              : manifest,
          readFile: (path: string) => readFile(join(sourceDirectory, path)),
        },
        dependencies: Object.entries(
          options.snapshotPluginDependencies ?? {},
        ).map(([slug, version]) => ({
          identity: `wporg:${slug}`,
          version,
          manifest,
          readFile: (path: string) => readFile(join(sourceDirectory, path)),
        })),
      }),
    },
  });
  await mkdir(join(root, "snapshots"));
  const frozen = new Map<
    string,
    Awaited<ReturnType<typeof snapshots.freeze>>
  >();
  const freezeCounts = new Map<string, number>();
  const frozenSelections: Parameters<
    WordPressCampaignBoundaries["freeze"]
  >[0][] = [];

  const attachments = new ProviderAttachmentStore(join(root, "provider"));
  const prompts: string[] = [];
  const transportRuns: DiscoveryTransportRun[] = [];
  const promptDigests: string[] = [];
  const histories: string[] = [];
  const coordinations: (DiscoveryTransportRun["coordination"] | undefined)[] =
    [];
  const expirations: string[] = [];
  const verifierReferenceRoutes: unknown[] = [];
  const labIdsDuringVerification: string[][] = [];
  const handoffs: NonNullable<
    Parameters<NonNullable<WordPressCampaignBoundaries["handoffVerifier"]>>[0]
  >[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let verificationProvisionAttempts = 0;
  let teardownCalls = 0;
  const verificationLabIds = new Set<string>();
  const boundaries: WordPressCampaignBoundaries = {
    selection,
    freeze: async (target) => {
      frozenSelections.push(target);
      if (target.slug === options.failFreeze)
        throw new SourceAcquisitionError("connect-timeout", {
          code: "ETIMEDOUT",
          detail: "Synthetic download failure",
        });
      const attempts = freezeCounts.get(target.slug) ?? 0;
      freezeCounts.set(target.slug, attempts + 1);
      if (options.failRepeatedFreeze === true && attempts > 0)
        throw new Error("Synthetic second archive connection timed out");
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
      teardown: async (...args: Parameters<typeof lab.teardown>) => {
        teardownCalls++;
        if (
          options.labTeardownFails === true ||
          (options.verifierLabTeardownFails === true &&
            verificationLabIds.has(args[0].id))
        )
          return {
            status: "incomplete" as const,
            reason: "cleanup" as const,
            nextStep: "Synthetic Lab cleanup needs operator repair",
          };
        return lab.teardown(...args);
      },
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
        const provisioned = await lab.provision(...args);
        if (
          args[2]?.purpose === "verification" &&
          provisioned.status === "ready"
        )
          verificationLabIds.add(provisioned.handle.id);
        return provisioned;
      },
    },
    sourceFor: async () => ({
      directory: sourceDirectory,
      tree,
      ...(options.coreSource === true
        ? {
            dependency: {
              path: "/workspace/wordpress",
              directory: sourceDirectory,
              tree,
            },
          }
        : {}),
      ...(options.dependencySources === true
        ? {
            dependencySources: [
              {
                path: "/workspace/php",
                directory: sourceDirectory,
                tree,
              },
              {
                path: "/workspace/dependencies/elementor",
                directory: sourceDirectory,
                tree,
              },
            ],
          }
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
        transportRuns.push(run);
        const call = prompts.push(run.prompt);
        promptDigests.push(run.campaignInput.promptDigest);
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
        if (options.refuseOnCalls?.includes(call) === true) {
          const rootRollout =
            options.refusalSession === true
              ? await attachments.put(
                  "diagnostic",
                  Buffer.from(
                    `${JSON.stringify({
                      timestamp: now,
                      type: "session_meta",
                      payload: { id: REFUSED_ROOT_THREAD, source: "exec" },
                    })}\n`,
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
              reasonDetail: "provider-cyber-policy",
              startedAt: now,
              completedAt: "2026-10-08T00:10:00.000Z",
              ...(rootRollout === undefined
                ? {}
                : {
                    diagnosticArtifactDigest: rootRollout.digest,
                    session: {
                      rootThreadId: REFUSED_ROOT_THREAD,
                      rootTurns: 1,
                      segment: run.resume?.segment ?? 0,
                      files: [
                        {
                          path: "2026/10/08/rollout-2026-10-08T00-00-00-root.jsonl",
                          threadId: REFUSED_ROOT_THREAD,
                          kind: "root",
                          diagnosticArtifactDigest: rootRollout.digest,
                        },
                      ],
                    },
                  }),
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
                  claim("sqli", "synthetic-plugin.php"),
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
    // `verify next --handoff`: the same synthetic Verifier, recording the handoff it was asked for.
    handoffVerifier: (handoff) => {
      handoffs.push(handoff);
      return boundaries.verifier;
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
        if (options.verifierQuotaOnAttempts?.includes(attempt) === true) {
          // As the Codex Verifier does: record the limited run, then fail transport.
          await state.ledger.append({
            schemaVersion: 1,
            identity: `verifier-quota-${attempt}`,
            campaignId: input.campaignId,
            snapshotDigest: input.finding.snapshotDigest,
            occurredAt: now,
            type: "verifier-run-finished",
            findingId: input.finding.findingId,
            runId: `verifier-run-${attempt}`,
            promptDigest: `sha256:${"e".repeat(64)}`,
            receiptDigest: `sha256:${"e".repeat(64)}`,
            terminal: "incomplete",
            providerLimit: "quota",
          });
          throw new VerifierTransportIncompleteError("provider");
        }
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
  const environment = {
    stateDirectory: join(root, "state"),
    clock: () => new Date(now),
    newId: () => `id-${++ids}`,
    profile: createWordPressCliProfile({
      scopePolicy: await loadWordpressScopePolicy(),
      legacyHistoryFile,
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
      scoreWeights: { installations: 1, recency: 1 },
    }),
  );
  const configPath = join(root, "campaign.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      selectionPolicyPath: policyPath,
      // The policy default is "none" (owner decision 2026-10-18); these tests
      // exercise the attached-Lab path unless a test overrides it.
      discovery: { lab: "attached" },
      promptId: "wp2shell-bounty-v8",
      programmeBoundary: {
        version: "v1",
        text: "Synthetic programme boundary",
      },
      // Sequential by default so the call order is deterministic.
      resources: { maxConcurrentRuns: 1, memoryBudgetMiB: 10_752 },
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
    prompts,
    transportRuns,
    promptDigests,
    histories,
    coordinations,
    expirations,
    verifierReferenceRoutes,
    labIdsDuringVerification,
    handoffs,
    docker,
    live,
    root,
    legacyHistoryFile,
    ledger: () => state.ledger,
    state: () => state,
    profile: environment.profile,
    store: () => state.store,
    maxInFlight: () => maxInFlight,
    verificationProvisionAttempts: () => verificationProvisionAttempts,
    teardownCalls: () => teardownCalls,
    frozenSelections,
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
    expect(prompts[0]).toContain("## Finding and Lead output contract");
    const started = ledger()
      .read({ type: "discovery-run-started" })
      .at(0)?.event;
    expect(started).toMatchObject({
      configuration: { labAccess: { database: "read-only" } },
    });
    if (started?.type === "discovery-run-started")
      expect(started.configuration.contractDigest).toMatch(/^sha256:/);
    expect(JSON.stringify(started)).not.toContain("wbh_reader");
  });

  it("adds the generated v4 contract to the sole runnable prompt and records separate digests", async () => {
    const { run, configPath, prompts, ledger } = await harness();
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
    const objective = await loadWordPressDiscoveryAsset("wp2shell-bounty-v8");
    const contract = wordPressDiscoveryOutputContractV4();
    expect(prompts[0]).toContain(objective.text.trim());
    expect(prompts[0]).toContain(contract.text);
    expect(prompts[0]?.split(contract.text)).toHaveLength(2);
    const started = ledger()
      .read({ campaignId: "campaign-contract", type: "discovery-run-started" })
      .at(0)?.event;
    expect(started).toMatchObject({
      configuration: {
        promptVariant: objective.id,
        promptDigest: objective.digest,
        objectiveDigest: objective.digest,
        contractDigest: contract.digest,
      },
    });
  });

  it("keeps old objective bytes readable but rejects them for new campaigns", async () => {
    const archived = await loadWordPressDiscoveryAsset("wp2shell-bounty-v2");
    expect(archived.digest).toBe(
      "sha256:efeaefbd1775e2a4fd3984e19672e7e5cf8cfdbe0b16b84cededa23587b239c5",
    );
    const base = {
      schemaVersion: 1 as const,
      programmeBoundary: { version: "v1", text: "Synthetic" },
      wordpressVersion: "6.8",
      lab: { siteTitle: "Synthetic", initialPosts: [], customerRole: false },
    };
    expect(
      wordpressCampaignConfigSchema.safeParse({
        ...base,
        promptId: "wp2shell-bounty-v2",
      }).success,
    ).toBe(false);
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

  it("passes pinned PHP and plugin sources to the discovery transport", async () => {
    const { run, configPath, prompts, transportRuns } = await harness({
      coreSource: true,
      dependencySources: true,
    });
    await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-dependency-sources",
      "--config",
      configPath,
    );
    expect(prompts[0]).toContain(
      "Dependency source (read-only): /workspace/php.",
    );
    expect(prompts[0]).toContain(
      "Dependency source (read-only): /workspace/dependencies/elementor.",
    );
    expect(
      transportRuns[0]?.dependencySources?.map((source) => source.path),
    ).toEqual(["/workspace/php", "/workspace/dependencies/elementor"]);
    expect(transportRuns[0]?.minimumActiveMs).toBe(60 * 60_000);
    expect(transportRuns[0]?.resumePrompt).toBeTruthy();
    expect(prompts[0]).toContain(transportRuns[0]?.resumePrompt);
  });

  it("mentions the writable research directory for the runnable objective", async () => {
    const trial = await harness();
    await trial.run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-research-notes",
      "--config",
      trial.configPath,
    );
    expect(trial.prompts[0]).toContain(
      "Writable notes directory: /workspace/research.",
    );
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
      Array.from({ length: 3 }, () => "verifier-v8"),
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
    const labsBeforeExhaustedRecipeResume = ledger().read({
      campaignId: "retry-campaign",
      type: "lab-provisioned",
    }).length;
    expect((await run(...args)).code).toBe(0);
    expect(
      ledger().read({ campaignId: "retry-campaign", type: "lab-provisioned" }),
    ).toHaveLength(labsBeforeExhaustedRecipeResume);
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
    const labsBeforeUnchangedResume = ledger().read({
      campaignId: "scenario-retry",
      type: "lab-provisioned",
    }).length;
    expect((await run(...args)).code).toBe(0);
    expect(
      ledger().read({ campaignId: "scenario-retry", type: "lab-provisioned" }),
    ).toHaveLength(labsBeforeUnchangedResume);
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
    ).toBe(labsBefore);
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

  it("runs a pinned campaign end to end and exposes review and funnel", async () => {
    const { run, configPath, prompts, docker } = await harness();

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
    expect(campaign.stdout).toContain("stopped by max-runs");
    expect(campaign.stdout).toContain(": runtime-confirmed");
    expect(campaign.stdout).toContain(": incomplete");
    expect(prompts).toHaveLength(1);
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
      /reproduction package: sha256:[a-f0-9]{64} \(\S+private-evidence\/sha256:[a-f0-9]{64}\/content\)/,
    );
    expect(queue.stdout).toContain(
      "observed: attackerRole=subscriber defaultSettings=true observedVia=session reachedRole=administrator",
    );
    expect(queue.stdout).toMatch(/evidence: sha256:[a-f0-9]{64}/);
    expect(queue.stdout).toMatch(/^incomplete .* sqli$/m);
    expect(queue.stdout).toContain("reason: evidence");
    expect(queue.stdout).toMatch(/next: .+/);
    const confirmedFinding = /^runtime-confirmed\s+\S+\s+finding (\S+)/m.exec(
      queue.stdout,
    )?.[1];
    expect(confirmedFinding).toBeDefined();
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
    expect(funnel.stdout).toContain("runs 1 (discovery attempts 1)");
    expect(funnel.stdout).toContain("cost unavailable");
    expect(funnel.stdout).toContain("confirmed / 1M tokens 1111.11");
    expect(funnel.stdout).toMatch(/account-takeover: .*raw 1 .* confirmed 1/);
  });

  it("rejects partitioned assignment for new campaigns", () => {
    const base = {
      schemaVersion: 1 as const,
      programmeBoundary: { version: "v1", text: "Synthetic" },
      wordpressVersion: "6.8",
      lab: { siteTitle: "Synthetic", initialPosts: [], customerRole: false },
      promptId: "wp2shell-bounty-v8",
    };
    expect(
      wordpressCampaignConfigSchema.safeParse({
        ...base,
        mode: "assignment",
        assignment: { unit: "entry-point", entriesPerRun: 2 },
      }).success,
    ).toBe(false);
  });

  it("runs source-first and records no entry index on the run (ADR 0034)", async () => {
    const { run, configPath, prompts, ledger } = await harness({
      entryPoints: true,
    });
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
    expect(prompts[0]).not.toContain("## Entry points");
    expect(prompts[0]).toContain("All files under /workspace/main.");
    const started = ledger().read({
      campaignId: "campaign-index-default",
      type: "discovery-run-started",
    });
    expect(started[0]?.event.type).toBe("discovery-run-started");
    if (started[0]?.event.type === "discovery-run-started")
      expect(started[0].event.configuration).not.toHaveProperty("entryIndex");
  });

  it("runs one source-first WP2Shell Trial by default and records a zero-candidate conclusion", async () => {
    const { run, configPath, prompts, coordinations, expirations, ledger } =
      await harness({
        entryPoints: true,
        zeroFindings: true,
        config: {
          promptId: undefined,
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
    expect(prompts[0]).toContain("Use multiagents aggressively");
    expect(prompts[0]).not.toContain("## Entry points");
    expect(coordinations).toEqual(["cooperative"]);
    expect(expirations).toEqual(["2026-10-08T02:00:00.000Z"]);
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

  it("runs without a discovery Lab, then verifies one Finding in a fresh Lab", async () => {
    const { run, configPath, prompts, ledger, live, labIdsDuringVerification } =
      await harness({
        entryPoints: true,
        config: {
          promptId: undefined,
          discovery: { lab: "none" },
        },
      });
    const campaignId = "campaign-explore-only";
    const discovered = await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      campaignId,
      "--config",
      configPath,
    );
    if (discovered.stderr) throw new Error(discovered.stderr);
    expect(discovered.code).toBe(0);
    expect(discovered.stdout).toContain("lab none");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(
      "This Trial has no Lab. Runtime confirmation happens during verification.",
    );
    expect(prompts[0]).not.toContain("## Lab\n\nEndpoint:");
    expect(ledger().read({ campaignId, type: "lab-provisioned" })).toHaveLength(
      0,
    );
    expect(
      ledger().read({ campaignId, type: "verification-finished" }),
    ).toHaveLength(0);
    expect(
      ledger().read({ campaignId, type: "discovery-run-started" })[0]?.event,
    ).toMatchObject({ labAttached: false });
    expect(
      ledger().read({ campaignId, type: "discovery-run-finished" })[0]?.event,
    ).toMatchObject({ outcome: "completed" });
    const verified = await run(
      "verify",
      "next",
      "--campaign",
      campaignId,
      "--config",
      configPath,
    );
    expect(verified.code).toBe(0);
    expect(verified.stdout).toContain("verified finding");
    expect(verified.stdout).toContain("runtime-confirmed");
    expect(
      ledger().read({ campaignId, type: "verification-finished" }),
    ).toHaveLength(1);
    expect(
      ledger()
        .read({ campaignId, type: "lab-provisioned" })
        .filter(
          ({ event }) =>
            event.type === "lab-provisioned" &&
            event.purpose === "verification",
        ),
    ).toHaveLength(1);
    expect(labIdsDuringVerification).toHaveLength(1);
    expect(live.containers.size).toBe(0);
    expect(live.networks.size).toBe(0);
    expect(live.volumes.size).toBe(0);
    expect(ledger().funnel(campaignId).byLab.none).toMatchObject({
      runs: 1,
      findings: 2,
    });
  });

  it("--repeat 3 records three independent Trial IDs on the same Snapshot", async () => {
    const { run, configPath, ledger, prompts } = await harness({
      zeroFindings: true,
      config: {
        promptId: undefined,
        discovery: { lab: "none" },
      },
    });
    const campaignId = "campaign-repeat-three";
    const result = await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      campaignId,
      "--config",
      configPath,
      "--repeat",
      "3",
    );
    if (result.stderr) throw new Error(result.stderr);
    expect(result.code).toBe(0);
    expect(prompts).toHaveLength(3);
    const starts = ledger()
      .read({ campaignId, type: "discovery-run-started" })
      .map(({ event }) => event);
    expect(starts).toHaveLength(3);
    expect(
      new Set(
        starts.map((event) =>
          event.type === "discovery-run-started" ? event.trialId : null,
        ),
      ).size,
    ).toBe(3);
    expect(new Set(starts.map((event) => event.snapshotDigest)).size).toBe(1);
    expect(ledger().funnel(campaignId).byLab.none.runs).toBe(3);
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

  it("does not label a new manual selection with an archived prompt", async () => {
    const { run, root, configPath, prompts } = await harness();
    const policyPath = join(root, "selection.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      policyPath,
      JSON.stringify({
        ...policy,
        wordpressVersion: "6.8",
        promptVariant: "wp2shell-bounty-v6",
      }),
    );
    const direct = await run("select", "--config", policyPath);
    expect(direct.code).toBe(1);
    expect(direct.stderr).toContain(
      "New selections use the current prompt variant only",
    );
    const fromCampaign = await run("select", "--config", configPath);
    expect(fromCampaign.code).toBe(1);
    expect(fromCampaign.stderr).toContain(
      "Selection and campaign prompt variants differ",
    );
    const campaign = await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "old-label-rejected",
      "--config",
      configPath,
    );
    expect(campaign.code).toBe(1);
    expect(campaign.stderr).toContain(
      "Selection and campaign prompt variants differ",
    );
    expect(prompts).toHaveLength(0);
  });

  it("rejects the deleted entryIndex and coverage keys and the old control mode (ADR 0034)", () => {
    const base = {
      schemaVersion: 1 as const,
      programmeBoundary: { version: "v1", text: "Synthetic" },
      wordpressVersion: "6.8",
      lab: { siteTitle: "Synthetic", initialPosts: [], customerRole: false },
    };
    expect(
      wordpressCampaignConfigSchema.safeParse({ ...base, entryIndex: false })
        .success,
    ).toBe(false);
    expect(
      wordpressCampaignConfigSchema.safeParse({
        ...base,
        coverage: { maxUnvisitedRatio: 0.2 },
      }).success,
    ).toBe(false);
    // Owner decision 2026-10-18: the normal mode explores without a Lab.
    expect(wordpressCampaignConfigSchema.parse(base).discovery).toEqual({
      lab: "none",
    });
    expect(
      wordpressCampaignConfigSchema.safeParse({
        ...base,
        mode: "entry-index-control",
        entryIndex: false,
      }).success,
    ).toBe(false);
    expect(
      wordpressCampaignConfigSchema.safeParse({
        ...base,
        entryIndex: true,
      }).success,
    ).toBe(false);
  });

  it("does not expose public history to the article-faithful discovery run", async () => {
    const { run, configPath, histories } = await harness({
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
    expect(histories).toEqual(["none"]);
  });

  it("accepts only the single-Trial WP2Shell campaign", () => {
    const base = {
      schemaVersion: 1 as const,
      programmeBoundary: { version: "v1", text: "Synthetic" },
      wordpressVersion: "6.8",
      lab: { siteTitle: "Synthetic", initialPosts: [], customerRole: false },
    };
    const production = wordpressCampaignConfigSchema.parse(base);
    expect(production).toMatchObject({
      promptId: "wp2shell-bounty-v8",
      runWallTimeMinutes: 120,
    });
    for (const forbidden of [
      { promptId: "wp2shell-whitebox-v1.7" },
      { promptId: "wp2shell-bounty-v6" },
      { entryIndex: true },
      { assignment: { unit: "entry-point" } },
      { ablation: { axis: "history", armBFraction: 0.5 } },
      { continuation: {} },
    ])
      expect(
        wordpressCampaignConfigSchema.safeParse({
          ...base,
          ...forbidden,
        }).success,
      ).toBe(false);
    for (const mode of [
      "wp2shell",
      "comparison",
      "ablation",
      "assignment",
      "entry-index-control",
    ])
      expect(
        wordpressCampaignConfigSchema.safeParse({
          ...base,
          mode,
          promptId: "wp2shell-bounty-v8",
        }).success,
      ).toBe(false);
  });

  it("rejects historical prompt and history ablation configs at the new-run boundary", () => {
    const base = {
      schemaVersion: 1 as const,
      programmeBoundary: { version: "v1", text: "Synthetic" },
      wordpressVersion: "6.8",
      lab: { siteTitle: "Synthetic", initialPosts: [], customerRole: false },
    };
    for (const config of [
      { promptId: "short-objective-v2" },
      { ablation: { axis: "history", armBFraction: 0.5 } },
      {
        mode: "ablation",
        ablation: {
          axes: [
            {
              axis: "prompt",
              armBFraction: 0.5,
              armBPromptId: "wp2shell-single-http-v2",
            },
          ],
        },
      },
      { continuation: {} },
    ])
      expect(
        wordpressCampaignConfigSchema.safeParse({ ...base, ...config }).success,
      ).toBe(false);
  });

  it("records Leads without starting a Harness continuation", async () => {
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
    const { run, configPath, prompts, ledger } = await harness({
      entryPoints: true,
      leadsOnCalls: {
        1: [
          makeLead("Selected Lead", "auth-use"),
          makeLead("Other Lead", "precondition"),
        ],
      },
      config: {},
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
    expect(prompts[0]).not.toContain("## Entry points");
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
  });

  it("stops the campaign on a provider limit and resumes it with the same command", async () => {
    const { run, configPath } = await harness({
      limitOnCalls: [2],
    });
    const command = [
      "campaign",
      "run",
      "--all",
      "--campaign",
      "campaign-1",
      "--config",
      configPath,
      "--repeat",
      "4",
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
    expect(resumed.code).toBe(0);
    // The limited run is not a Trial (owner decision 2026-10-19): its ordinal
    // runs again and the campaign reaches its run limit.
    expect(resumed.stdout).toContain("stopped by max-runs");
    expect(resumed.stdout.match(/^  finding /gm)).toHaveLength(2);
    expect(resumed.stdout).toContain("raw 2 → verifier通過 2 → confirmed 1");
  });

  it("finishes in-flight targets after a provider limit, then resumes only unfinished targets", async () => {
    const { run, configPath, prompts, ledger, maxInFlight, live, docker } =
      await harness({
        candidates: ["synthetic-plugin", "second-plugin", "third-plugin"],
        limitOnCalls: [1],
        zeroFindings: true,
        config: {
          promptId: undefined,
          resources: {
            maxConcurrentRuns: 1,
            maxConcurrentTargets: 2,
            memoryBudgetMiB: 10_752,
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
    // The provider-limited target runs its Trial again (owner decision
    // 2026-10-19) and the never-started target runs for the first time.
    expect(prompts).toHaveLength(4);
    expect(
      ledger().read({
        campaignId: "campaign-parallel-stop",
        type: "discovery-run-started",
      }),
    ).toHaveLength(4);
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
        resources: {
          maxConcurrentRuns: 1,
          maxConcurrentTargets: 2,
          memoryBudgetMiB: 10_752,
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
    expect(targetRemovals).toHaveLength(2);
    for (const removal of targetRemovals) {
      const ids = new Set(
        removal.slice(2).map((name) => /^wbh-([0-9a-f-]{36})-/.exec(name)?.[1]),
      );
      expect(ids.size).toBe(1);
      expect(ids.has(undefined)).toBe(false);
    }
  });

  it("stops after a discovery Lab cleanup failure and gates same-campaign resume", async () => {
    const { run, configPath, prompts, ledger } = await harness({
      candidates: ["synthetic-plugin", "zz-next-plugin"],
      zeroFindings: true,
      labTeardownFails: true,
      config: {
        promptId: undefined,
      },
    });
    const command = [
      "campaign",
      "run",
      "--all",
      "--campaign",
      "campaign-cleanup-incomplete",
      "--config",
      configPath,
    ];
    const first = await run(...command);
    expect(first.code).toBe(1);
    expect(first.stderr).toContain(
      "Synthetic Lab cleanup needs operator repair",
    );
    expect(prompts).toHaveLength(1);
    expect(ledger().read({ type: "target-skipped" })).toHaveLength(1);
    expect(ledger().read({ type: "campaign-stopped" })).toMatchObject([
      { event: { reason: "incomplete", cleanupLabIds: [expect.any(String)] } },
    ]);
    const second = await run(...command);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("cleanup is incomplete");
    expect(prompts).toHaveLength(1);
  });

  it("drains in-flight Labs before returning a cleanup failure", async () => {
    const { run, configPath, prompts, teardownCalls } = await harness({
      candidates: ["synthetic-plugin", "second-plugin", "zz-next-plugin"],
      zeroFindings: true,
      labTeardownFails: true,
      config: {
        promptId: undefined,
        resources: {
          maxConcurrentRuns: 1,
          maxConcurrentTargets: 2,
          memoryBudgetMiB: 10_752,
        },
      },
    });
    const result = await run(
      "campaign",
      "run",
      "--all",
      "--campaign",
      "campaign-drain",
      "--config",
      configPath,
    );
    expect(result.code).toBe(1);
    expect(prompts).toHaveLength(2);
    expect(teardownCalls()).toBe(2);
  });

  it("stops on Verifier Lab cleanup failure without losing its review item", async () => {
    const { run, configPath, prompts, ledger } = await harness({
      candidates: ["synthetic-plugin", "zz-next-plugin"],
      verifierLabTeardownFails: true,
      config: {
        promptId: undefined,
      },
    });
    const command = [
      "campaign",
      "run",
      "--all",
      "--campaign",
      "campaign-verifier-cleanup",
      "--config",
      configPath,
    ];
    const first = await run(...command);
    expect(first.code).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(ledger().read({ type: "verification-finished" })).toMatchObject([
      { event: { result: { status: "incomplete", reason: "cleanup" } } },
    ]);
    expect(ledger().read({ type: "campaign-stopped" })).toMatchObject([
      { event: { reason: "incomplete", cleanupLabIds: [expect.any(String)] } },
    ]);
    const review = await run(
      "review",
      "--campaign",
      "campaign-verifier-cleanup",
    );
    expect(review.stdout).toContain("incomplete");
    expect(review.stdout).toContain("reason: cleanup");
    const second = await run(...command);
    expect(second.code).toBe(1);
    expect(prompts).toHaveLength(1);
  });

  it("checks every recorded cleanup Lab id before resuming", async () => {
    const { run, configPath, prompts, ledger } = await harness();
    expect((await run("select", "--config", configPath)).code).toBe(0);
    await ledger().append({
      schemaVersion: 1,
      identity: "replay-cleanup-stop",
      campaignId: "campaign-replay-cleanup",
      snapshotDigest: sha("a"),
      occurredAt: now,
      type: "campaign-stopped",
      reason: "incomplete",
      cleanupLabIds: ["11111111-1111-4111-8111-111111111111", uuid],
    });
    const result = await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      "campaign-replay-cleanup",
      "--config",
      configPath,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`Lab ${uuid} cleanup is incomplete`);
    expect(prompts).toHaveLength(0);
  });

  it("keeps a target Lab until its verification finishes, then removes it", async () => {
    const { run, configPath, labIdsDuringVerification, live, docker } =
      await harness({});
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

  it("verify next --handoff names the skill as prompt version and re-verifies the named Finding (#352)", async () => {
    // Source-only discovery leaves every Finding for `verify next`.
    const { run, configPath, ledger, handoffs, root } = await harness({
      entryPoints: true,
      config: { discovery: { lab: "none" } },
    });
    const campaign = "campaign-handoff";
    const discovered = await run(
      "campaign",
      "run",
      "synthetic-plugin",
      "--campaign",
      campaign,
      "--config",
      configPath,
    );
    expect(discovered.code).toBe(0);
    const recorded = ledger()
      .read({ campaignId: campaign, type: "finding-recorded" })
      .map(({ event }) =>
        event.type === "finding-recorded" ? event.findingId : "",
      );
    expect(recorded.length).toBeGreaterThan(0);
    const findingId = recorded[0]!;

    const refused = await run(
      "verify",
      "next",
      "--campaign",
      campaign,
      "--config",
      configPath,
      "--finding",
      findingId,
    );
    expect(refused.code).not.toBe(0);
    expect(handoffs).toHaveLength(0);

    const handoff = [
      "verify",
      "next",
      "--campaign",
      campaign,
      "--config",
      configPath,
      "--handoff",
      join(root, "handoff"),
      "--finding",
      findingId,
      "--port",
      "18080",
    ];
    const first = await run(...handoff);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain(`verified finding ${findingId}`);
    expect(handoffs).toEqual([
      { directory: join(root, "handoff"), httpPort: 18080, databasePort: 3307 },
    ]);
    const finished = () =>
      ledger()
        .read({ campaignId: campaign, type: "verification-finished" })
        .map(({ event }) => event)
        .filter(
          (event) =>
            event.type === "verification-finished" &&
            event.findingId === findingId,
        );
    expect(finished()).toMatchObject([{ promptVersion: "wbh-verify/v1" }]);

    // The operator named the Finding again: the retry rules of the automatic queue do not apply.
    const second = await run(...handoff);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain(`verified finding ${findingId}`);
    expect(finished()).toHaveLength(2);
    expect(finished()[1]).toMatchObject({
      promptVersion: "wbh-verify/v1",
      attempt: 2,
    });
  });

  it.each([
    { failure: "refuseOnCalls", reason: "provider-refused" },
    { failure: "failOnCalls", reason: "run-failed" },
  ] as const)(
    "skips a target whose Trial hits $reason and starts the next target",
    async ({ failure, reason }) => {
      const { run, configPath, prompts, ledger } = await harness({
        candidates: ["synthetic-plugin", "zz-next-plugin"],
        [failure]: [1],
        config: {
          promptId: undefined,
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
      const first = await run(...command);
      expect(first.code).toBe(0);
      expect(first.stdout).not.toContain("campaign stopped by");
      expect(first.stdout).toMatch(
        /^wporg:zz-next-plugin 9\.9\.9 .*runs 1  stopped by /m,
      );
      expect(prompts).toHaveLength(2);
      expect(
        ledger()
          .read({ type: "target-skipped" })
          .map(({ event }) => event),
      ).toMatchObject([
        {
          selectionId: "wporg:synthetic-plugin@3.3.1",
          stage: "discovery",
          reason,
        },
      ]);
      expect(ledger().read({ type: "campaign-stopped" })).toHaveLength(0);
      // The skipped target is not resumed and its Trial is not replaced.
      const again = await run(...command);
      expect(again.code).toBe(0);
      expect(prompts).toHaveLength(2);
      expect(ledger().read({ type: "discovery-run-started" })).toHaveLength(2);
    },
  );

  it("resumes a provider-refused Root thread once in a new run of the same Trial, and refuses everything else with a reason (ADR 0036)", async () => {
    const { run, configPath, transportRuns, ledger } = await harness({
      refuseOnCalls: [1],
      refusalSession: true,
      zeroFindings: true,
      config: {
        promptId: undefined,
        discovery: { lab: "none" },
      },
    });
    const campaign = "campaign-resume";
    const first = await run(
      "campaign",
      "run",
      "--all",
      "--campaign",
      campaign,
      "--config",
      configPath,
    );
    expect(first.code).toBe(0);
    const refusedRunId = transportRuns[0]!.runId;
    expect(
      ledger()
        .read({ campaignId: campaign, type: "target-skipped" })
        .map(({ event }) => event),
    ).toMatchObject([{ reason: "provider-refused" }]);

    const unknown = await run(
      "campaign",
      "resume",
      "--campaign",
      campaign,
      "--run",
      "no-such-run",
      "--config",
      configPath,
    );
    expect(unknown.code).toBe(3);
    expect(unknown.stderr).toBe("not resumable: run-unknown");
    expect(transportRuns).toHaveLength(1);

    const resumed = await run(
      "campaign",
      "resume",
      "--campaign",
      campaign,
      "--run",
      refusedRunId,
      "--config",
      configPath,
    );
    expect(resumed.code).toBe(0);
    expect(transportRuns).toHaveLength(2);
    const segment = transportRuns[1]!;
    expect(segment.runId).not.toBe(refusedRunId);
    expect(segment).toMatchObject({
      coordination: "cooperative",
      // 60 min minimum less the 10 min the refused segment consumed.
      minimumActiveMs: 50 * 60_000,
      resume: {
        threadId: REFUSED_ROOT_THREAD,
        segment: 1,
        sessions: [{ kind: "root", threadId: REFUSED_ROOT_THREAD }],
      },
    });
    expect(segment.prompt).toContain(segment.resumePrompt!);
    expect(segment.prompt).toBe(transportRuns[0]!.prompt);
    expect(resumed.stdout).toContain(
      `resumed ${refusedRunId} as ${segment.runId}  trial ${refusedRunId}  segment 1  remaining wall 110 min`,
    );
    expect(resumed.stdout).toContain("outcome completed");
    const starts = ledger()
      .read({ campaignId: campaign, type: "discovery-run-started" })
      .map(({ event }) => event);
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatchObject({
      runId: segment.runId,
      trialId: refusedRunId,
      trialOrdinal: 0,
      resumesRun: refusedRunId,
      resumeSegment: 1,
      labAttached: false,
    });
    // The original failure and skip stay; the Trial is counted once.
    expect(
      ledger()
        .read({ campaignId: campaign, type: "discovery-run-finished" })
        .map(({ event }) =>
          event.type === "discovery-run-finished" ? event.outcome : "",
        ),
    ).toEqual(["failed", "completed"]);
    expect(ledger().funnel(campaign)).toMatchObject({
      discoveryAttempts: 1,
      byLab: { none: { runs: 1 } },
    });

    const again = await run(
      "campaign",
      "resume",
      "--campaign",
      campaign,
      "--run",
      refusedRunId,
      "--config",
      configPath,
    );
    expect(again.code).toBe(3);
    expect(again.stderr).toBe(
      `not resumable: already-resumed (${segment.runId})`,
    );
    const completed = await run(
      "campaign",
      "resume",
      "--campaign",
      campaign,
      "--run",
      segment.runId,
      "--config",
      configPath,
    );
    expect(completed.code).toBe(3);
    expect(completed.stderr).toBe(
      "not resumable: not-a-provider-refusal (completed)",
    );
    expect(transportRuns).toHaveLength(2);
  });

  it("does not resume a refused run whose receipt predates session records or whose campaign attaches a Lab", async () => {
    const legacy = await harness({
      refuseOnCalls: [1],
      zeroFindings: true,
      config: {
        promptId: undefined,
        discovery: { lab: "none" },
      },
    });
    const command = (configPath: string, campaign: string) => [
      "--campaign",
      campaign,
      "--config",
      configPath,
    ];
    expect(
      (
        await legacy.run(
          "campaign",
          "run",
          "--all",
          ...command(legacy.configPath, "campaign-legacy"),
        )
      ).code,
    ).toBe(0);
    const legacyResume = await legacy.run(
      "campaign",
      "resume",
      "--run",
      legacy.transportRuns[0]!.runId,
      ...command(legacy.configPath, "campaign-legacy"),
    );
    expect(legacyResume.code).toBe(3);
    expect(legacyResume.stderr).toBe("not resumable: session-unrecorded");
    expect(legacy.transportRuns).toHaveLength(1);

    const attached = await harness({
      refuseOnCalls: [1],
      refusalSession: true,
      zeroFindings: true,
      config: {
        promptId: undefined,
      },
    });
    expect(
      (
        await attached.run(
          "campaign",
          "run",
          "--all",
          ...command(attached.configPath, "campaign-attached"),
        )
      ).code,
    ).toBe(0);
    const attachedResume = await attached.run(
      "campaign",
      "resume",
      "--run",
      attached.transportRuns[0]!.runId,
      ...command(attached.configPath, "campaign-attached"),
    );
    expect(attachedResume.code).toBe(3);
    expect(attachedResume.stderr).toContain("not resumable: lab-attached");
    expect(attached.transportRuns).toHaveLength(1);
  });

  it("drains at the next target boundary when the operator stops, then resumes", async () => {
    const { run, profile, state, configPath, prompts, ledger } = await harness({
      candidates: ["synthetic-plugin", "second-plugin", "third-plugin"],
      zeroFindings: true,
      config: {
        promptId: undefined,
      },
    });
    const command = ["--campaign", "campaign-operator", "--config", configPath];
    // One target first, so the state the profile uses exists.
    expect(
      (await run("campaign", "run", "synthetic-plugin", ...command)).code,
    ).toBe(0);
    let checks = 0;
    const stopped = await profile.runCampaign(state(), {
      campaignId: "campaign-operator",
      configPath,
      target: null,
      stop: () => ++checks > 1,
    });
    expect(stopped.stopped).toBe("operator");
    expect(prompts).toHaveLength(2);
    expect(
      ledger()
        .read({ campaignId: "campaign-operator", type: "campaign-stopped" })
        .map(({ event }) => event),
    ).toMatchObject([{ reason: "operator" }]);
    const resumed = await run("campaign", "run", "--all", ...command);
    expect(resumed.code).toBe(0);
    expect(prompts).toHaveLength(3);
    expect(ledger().read({ type: "discovery-run-started" })).toHaveLength(3);
  });

  it("stops the campaign on a Verifier quota and retries that verification once on resume", async () => {
    const { run, configPath, ledger } = await harness({
      verifierQuotaOnAttempts: [1],
    });
    const command = [
      "campaign",
      "run",
      "--all",
      "--campaign",
      "campaign-verifier-quota",
      "--config",
      configPath,
    ];
    const stopped = await run(...command);
    expect(stopped.code).toBe(3);
    expect(stopped.stdout).toContain(
      "campaign stopped by provider-limit; run the same command again to resume",
    );
    const verified = () =>
      ledger()
        .read({ type: "verification-finished" })
        .map(({ event }) =>
          event.type === "verification-finished" ? event.result : null,
        );
    // The second Finding is not verified after the limit.
    expect(verified()).toMatchObject([
      { status: "incomplete", reason: "provider" },
    ]);
    const resumed = await run(...command);
    expect(resumed.code).toBe(0);
    expect(verified()).toHaveLength(3);
    expect(verified().slice(1)).not.toContainEqual(
      expect.objectContaining({ reason: "provider" }),
    );
    expect(ledger().read({ type: "discovery-run-started" })).toHaveLength(1);
  });

  it("does not provision a Lab after the Verifier quota retry is exhausted", async () => {
    const { run, configPath, ledger, prompts } = await harness({
      verifierQuotaOnAttempts: [1, 2],
    });
    const command = [
      "campaign",
      "run",
      "--all",
      "--campaign",
      "campaign-quota-exhausted",
      "--config",
      configPath,
    ];
    expect((await run(...command)).code).toBe(3);
    expect((await run(...command)).code).toBe(3);
    const first = ledger().read({
      campaignId: "campaign-quota-exhausted",
      type: "verification-finished",
    })[0]?.event;
    if (first?.type !== "verification-finished")
      throw new Error("Missing quota verification");
    // One other Finding was pending when quota stopped the first two runs.
    expect((await run(...command)).code).toBe(0);
    const labsAfterPendingFinding = ledger().read({
      campaignId: "campaign-quota-exhausted",
      type: "lab-provisioned",
    }).length;
    expect((await run(...command)).code).toBe(0);
    expect(
      ledger().read({
        campaignId: "campaign-quota-exhausted",
        type: "lab-provisioned",
      }),
    ).toHaveLength(labsAfterPendingFinding);
    expect(prompts).toHaveLength(1);
    const review = await run(
      "review",
      "--campaign",
      "campaign-quota-exhausted",
    );
    expect(review.code).toBe(0);
    expect(review.stdout).toContain(`finding ${first.findingId}`);
    expect(review.stdout).toContain("incomplete");
    expect((await run(...command, "--retry-incomplete")).code).toBe(0);
    expect(
      ledger().read({
        campaignId: "campaign-quota-exhausted",
        findingId: first.findingId,
        type: "verification-finished",
      }),
    ).toHaveLength(3);
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
    expect(listed.stdout).toContain("reason: outside-programme-boundary");
    expect(
      ledger().read({
        campaignId: "campaign-parked",
        type: "finding-recorded",
      }),
    ).toHaveLength(0);
    const other = await run("review", "parked", "--campaign", "campaign-1");
    expect(other.stdout).toContain("no parked findings");
    const neither = await run("review", "parked");
    expect(neither.code).not.toBe(0);
    const badSince = await run("ledger", "stops", "--since", "yesterday");
    expect(badSince.code).not.toBe(0);
    const stops = await run("ledger", "stops", "--campaign", "campaign-parked");
    expect(stops.code).toBe(0);
    expect(stops.stdout).toContain("no stops recorded");
    const funnel = await run(
      "ledger",
      "funnel",
      "--since",
      "2026-10-12T00:00:00Z",
    );
    expect(funnel.code).toBe(0);
    expect(funnel.stdout).toContain("campaign *");
  });

  it("verifies a child Finding on resume and runs the provider-limited Trial again", async () => {
    const { run, configPath, prompts, ledger } = await harness({
      limitOnCalls: [1],
      childFindingOnLimitedCall: true,
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
    // The limited run is not a Trial (owner decision 2026-10-19): a
    // replacement Trial runs, and the child's Finding is still verified once.
    expect(resumed.stdout).toContain("runs 1  stopped by no-new-finding");
    expect(prompts).toHaveLength(2);
    expect(ledger().read({ type: "finding-recorded" })).toHaveLength(1);
    expect(ledger().read({ type: "verification-finished" })).toHaveLength(1);
    expect(ledger().read({ type: "discovery-concluded" })).toHaveLength(1);
  });

  it("runs discovery concurrently within the configured count and memory budget", async () => {
    const { run, configPath, maxInFlight } = await harness({
      candidates: [
        "synthetic-plugin",
        "second-plugin",
        "third-plugin",
        "fourth-plugin",
      ],
      config: {
        // Two targets may execute independently; each Trial fits the budget.
        resources: {
          maxConcurrentRuns: 1,
          maxConcurrentTargets: 2,
          memoryBudgetMiB: 10_752,
        },
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
    expect(campaign.stdout).toContain("fourth-plugin");
    expect(maxInFlight()).toBe(2);
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
      "--repeat",
      "3",
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
    const { run, configPath, ledger, store } = await harness({
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
      "skipped wporg:broken-plugin 9.9.9 at freeze: Source acquisition did not complete: connect-timeout",
    );
    expect(campaign.stdout).toMatch(
      /^wporg:synthetic-plugin 3\.3\.1 .*stopped by max-runs$/m,
    );
    const skipped = ledger()
      .read({ type: "target-skipped" })
      .map(({ event }) => event);
    expect(skipped).toMatchObject([
      {
        type: "target-skipped",
        selectionId: "wporg:broken-plugin@9.9.9",
        stage: "freeze",
        reason: "connect-timeout",
      },
    ]);
    // Only a digest appears in the ledger; the diagnostic is private.
    expect(JSON.stringify(skipped)).not.toContain("Synthetic download failure");
    const diagnosticRef = skipped[0]?.artifacts.find(
      (artifact) => artifact.kind === "target-skip-diagnostic",
    );
    expect(diagnosticRef).toBeDefined();
    const diagnosticFile = await store().readFile(
      diagnosticRef!.digest,
      "target-skip-diagnostic.json",
      10_000,
    );
    expect(diagnosticFile.status).toBe("resolved");
    if (diagnosticFile.status === "resolved")
      expect(diagnosticFile.bytes.toString("utf8")).toContain(
        "Synthetic download failure",
      );
  });

  it("records a source freeze failure during selection without leaking diagnostics", async () => {
    const { run, configPath, ledger, store } = await harness({
      candidates: ["broken-plugin", "synthetic-plugin"],
      failFreeze: "broken-plugin",
    });
    const selected = await run("select", "--config", configPath);
    expect(selected.code).toBe(0);
    expect(selected.stdout).toContain(
      "excluded wporg:broken-plugin  reasons snapshot-unavailable",
    );
    expect(selected.stdout).toContain("wporg:synthetic-plugin 3.3.1 score");
    const skips = ledger()
      .read({ type: "target-skipped" })
      .map(({ event }) => event);
    expect(skips).toMatchObject([
      {
        type: "target-skipped",
        selectionId: "wporg:broken-plugin@9.9.9",
        stage: "freeze",
        reason: "connect-timeout",
      },
    ]);
    expect(skips[0]?.campaignId).toMatch(/^selection-/);
    expect(JSON.stringify(skips)).not.toContain("Synthetic download failure");
    const diagnosticRef = skips[0]?.artifacts.find(
      (artifact) => artifact.kind === "target-skip-diagnostic",
    );
    expect(diagnosticRef).toBeDefined();
    const diagnosticFile = await store().readFile(
      diagnosticRef!.digest,
      "target-skip-diagnostic.json",
      10_000,
    );
    expect(diagnosticFile.status).toBe("resolved");
    if (diagnosticFile.status === "resolved")
      expect(diagnosticFile.bytes.toString("utf8")).toContain(
        "Synthetic download failure",
      );
    const selectionRef = skips[0]?.artifacts.find(
      (artifact) => artifact.kind === "target-selection",
    );
    expect(selectionRef).toBeDefined();
    const selectionFile = await store().readFile(
      selectionRef!.digest,
      "target-selection.json",
      10_000,
    );
    expect(selectionFile.status).toBe("resolved");
    if (selectionFile.status === "resolved")
      expect(
        canonicalDigest(JSON.parse(selectionFile.bytes.toString("utf8"))),
      ).toBe(skips[0]?.snapshotDigest);
    const selectedRecord = ledger().read({ type: "target-selected" })[0];
    const reportRef = selectedRecord?.event.artifacts.find(
      (artifact) => artifact.kind === "selection-report",
    );
    expect(reportRef).toBeDefined();
    expect(skips[0]?.artifacts).toContainEqual(reportRef);
    const reportFile = await store().readFile(
      reportRef!.digest,
      "selection-report.json",
      10_000,
    );
    expect(reportFile.status).toBe("resolved");
    if (reportFile.status === "resolved")
      expect(JSON.parse(reportFile.bytes.toString("utf8"))).toMatchObject({
        freezeFailures: [
          {
            selectionId: "wporg:broken-plugin@9.9.9",
            reason: "connect-timeout",
            diagnosticDigest: diagnosticRef!.digest,
          },
        ],
      });
  });

  it("returns an empty selection with reasons below the floor, and a batch at --minimum 1", async () => {
    const { run, root, ledger, store, configPath } = await harness({
      candidates: ["broken-plugin", "item-b"],
      failFreeze: "broken-plugin",
      legacyHistoryUnavailable: true,
    });
    const policyPath = join(root, "selection.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete policy.candidateSlugs;
    delete policy.pinnedVersions;
    await writeFile(
      policyPath,
      JSON.stringify({
        ...policy,
        promptVariant: "wp2shell-bounty-v8",
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
    const selected = await run("select", "--config", policyPath);
    // Below the floor of 3: no batch, a reason per target, and no throw.
    expect(selected.code).toBe(0);
    expect(selected.stdout).toContain("legacy history unavailable");
    expect(selected.stdout).toContain("no targets selected");
    expect(selected.stdout).toContain(
      "excluded wporg:item-b  reasons below-minimum",
    );
    expect(ledger().read({ type: "target-selected" })).toHaveLength(0);
    const skipped = ledger().read({ type: "target-skipped" })[0]?.event;
    const reportRef = skipped?.artifacts.find(
      (artifact) => artifact.kind === "selection-report",
    );
    expect(reportRef).toBeDefined();
    const report = await store().readFile(
      reportRef!.digest,
      "selection-report.json",
      2 * 1024 * 1024,
    );
    expect(report.status).toBe("resolved");
    if (report.status === "resolved")
      expect(JSON.parse(report.bytes.toString("utf8"))).toMatchObject({
        freezeFailures: [{ selectionId: "wporg:broken-plugin@9.9.9" }],
        legacyHistory: { status: "unavailable" },
        minimum: 3,
      });
    // The runner's floor of 1 makes a batch of the one eligible target.
    const one = await run("select", "--config", policyPath, "--minimum", "1");
    expect(one.code).toBe(0);
    expect(one.stdout).toMatch(/^selection batch selection-/m);
    expect(ledger().read({ type: "target-selected" })).toHaveLength(1);
    const automatic = await run(
      "campaign",
      "run",
      "--all",
      "--campaign",
      "campaign-no-legacy",
      "--config",
      configPath,
    );
    expect(automatic.code).toBe(1);
    expect(automatic.stderr).toContain("legacy-history-missing");
    expect(ledger().read({ campaignId: "campaign-no-legacy" })).toHaveLength(0);
    expect(
      (await run("select", "--config", policyPath, "--minimum", "0")).code,
    ).toBe(2);
  });

  it("classifies a source mismatch in the ledger and keeps its detail private", async () => {
    const { run, configPath, ledger, store } = await harness({
      candidates: ["broken-plugin", "synthetic-plugin"],
      corruptSourceManifest: "broken-plugin",
    });
    const campaign = await run(
      "campaign",
      "run",
      "--all",
      "--campaign",
      "campaign-mismatch",
      "--config",
      configPath,
    );
    expect(campaign.code).toBe(0);
    const skipped = ledger().read({
      campaignId: "campaign-mismatch",
      type: "target-skipped",
    })[0]?.event;
    expect(skipped).toMatchObject({
      reason: "source-mismatch",
      stage: "freeze",
    });
    expect(JSON.stringify(skipped)).not.toContain("manifest-content");
    const diagnosticRef = skipped?.artifacts.find(
      (artifact) => artifact.kind === "target-skip-diagnostic",
    );
    expect(diagnosticRef).toBeDefined();
    const diagnostic = await store().readFile(
      diagnosticRef!.digest,
      "target-skip-diagnostic.json",
      10_000,
    );
    expect(diagnostic.status).toBe("resolved");
    if (diagnostic.status === "resolved")
      expect(diagnostic.bytes.toString("utf8")).toContain("manifest-content");
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

  it("enumerates without nominated slugs, skips started slugs in the next batch, and runs that batch", async () => {
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
    const { run, configPath, root, ledger, store } = await harness({
      candidates,
      listingObservations,
      failRepeatedFreeze: true,
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
        promptVariant: "wp2shell-bounty-v8",
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
    // A reservation alone excludes nothing; the started Trials do.
    const firstBatch = await run(
      "campaign",
      "run",
      "--all",
      "--campaign",
      "campaign-first",
      "--config",
      configPath,
    );
    expect(firstBatch.code).toBe(0);
    const second = await run("select", "--config", policyPath);
    expect(second.code).toBe(0);
    expect(second.stdout).not.toContain("wporg:item-a 9.9.9 score");
    expect(second.stdout).toContain(
      "excluded wporg:item-b  reasons previously-selected",
    );
    expect(second.stdout).toContain("wporg:item-d 9.9.9 score");
    expect(second.stdout).toContain("wporg:item-f 9.9.9 score");
    const reservations = ledger()
      .read({ type: "target-selected", limit: 100 })
      .filter(({ event }) => event.campaignId.startsWith("selection-"));
    expect(reservations).toHaveLength(6);
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
    expect(mismatched.stderr).toContain("wp2shell-bounty-v8");
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
    expect(campaign.stderr).not.toContain("skipped");
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

    const third = await run("select", "--config", policyPath);
    expect(third.code).toBe(0);
    expect(third.stdout).toContain("wporg:item-g 9.9.9 score");
    const labsBeforeCompletedResume = ledger().read({
      campaignId: "campaign-reserved",
      type: "lab-provisioned",
    }).length;
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
    // item-d already finished; the resume stays on its bound batch.
    expect(resumed.stdout).not.toContain("item-g");
    expect(resumed.stdout).toContain("no selected target matched item-d");
    expect(
      ledger().read({
        campaignId: "campaign-reserved",
        type: "lab-provisioned",
      }),
    ).toHaveLength(labsBeforeCompletedResume);
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
    const replayPolicy = JSON.parse(await readFile(policyPath, "utf8"));
    await writeFile(
      policyPath,
      JSON.stringify({
        ...replayPolicy,
        revisitPolicy: { kind: "version-or-prompt-changed" },
      }),
    );
    const replay = await run(
      "campaign",
      "run",
      "--all",
      "--campaign",
      "campaign-replay",
      "--config",
      configPath,
    );
    // A changed revisit rule is a changed policy digest: no batch matches it
    // (the former `revisitPolicy: never` guard went with the ADR 0037 addendum).
    expect(replay.code).toBe(1);
    expect(replay.stderr).toContain(
      "No reserved selection batch matches this policy",
    );

    // A batch bound before legacy digests were recorded parses as null. The
    // resumed campaign stops before writing another event until reselected.
    await writeFile(
      policyPath,
      JSON.stringify({ ...replayPolicy, revisitPolicy: { kind: "never" } }),
    );
    const oldSelection = reservations[0]?.event;
    if (oldSelection?.type !== "target-selected")
      throw new Error("Expected a reserved target");
    const oldReport = JSON.parse(reportFile.bytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    delete oldReport.legacyHistory;
    oldReport.selectedSnapshotDigests = [oldSelection.snapshotDigest];
    const oldReportDigest = await store().putFiles({
      "selection-report.json": JSON.stringify(oldReport),
    });
    const oldBatchId = "selection-legacy-null";
    expect(
      await ledger().append({
        ...oldSelection,
        identity: "old-selection-without-legacy-digest",
        campaignId: oldBatchId,
        artifacts: oldSelection.artifacts.map((artifact) =>
          artifact.kind === "selection-report"
            ? { kind: "selection-report" as const, digest: oldReportDigest }
            : artifact,
        ),
      }),
    ).toMatchObject({ status: "appended" });
    expect(
      await ledger().append({
        schemaVersion: 1,
        identity: "old-bound-batch",
        campaignId: "campaign-old-bound",
        snapshotDigest: oldSelection.snapshotDigest,
        occurredAt: now,
        type: "selection-batch-bound",
        selectionBatchId: oldBatchId,
        policyDigest: oldReport.policyDigest as string,
        selectionIds: [oldSelection.selectionId],
        artifacts: [{ kind: "selection-report", digest: oldReportDigest }],
      }),
    ).toMatchObject({ status: "appended" });
    const oldResume = await run(
      "campaign",
      "run",
      "item-a",
      "--campaign",
      "campaign-old-bound",
      "--config",
      configPath,
    );
    expect(oldResume.code).toBe(1);
    expect(oldResume.stderr).toContain("legacy-history-changed");
    expect(ledger().read({ campaignId: "campaign-old-bound" })).toHaveLength(1);
  });

  it("runs the continuous runner on the host status, stops it, and reports it", async () => {
    const { run, root, profile, configPath, ledger } = await harness();
    const state = join(root, "state");
    const { wordpressVersion } = JSON.parse(
      await readFile(configPath, "utf8"),
    ) as { wordpressVersion: string };
    const policy = JSON.parse(
      await readFile(join(root, "selection.json"), "utf8"),
    ) as object;
    await mkdir(join(root, "policies"));
    await writeFile(
      join(root, "policies", "selection.json"),
      JSON.stringify({ ...policy, wordpressVersion }),
    );
    const host = {
      loginExpiresAt: new Date("2027-01-01T00:00:00Z"),
      programmeObservedAt: new Date(now),
      freeBytes: 100 * 1024 ** 3,
      legacyHistoryAvailable: true,
      loginMarginMinutes: 60,
    };
    (profile as { hostStatus?: unknown }).hostStatus = async () => host;
    const command = [
      "--config",
      configPath,
      "--selection",
      join(root, "policies", "selection.json"),
    ];
    // The first state change asks the runner to stop before any target.
    const stopped = await run(
      "continuous",
      "run",
      ...command,
      "--notify",
      `touch '${join(state, "continuous.stop")}'`,
    );
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toMatch(/ running campaignId=prod-\d{8}-1/);
    expect(stopped.stdout).toMatch(/ stopped reason=operator$/m);
    expect(
      ledger()
        .read({ type: "campaign-stopped" })
        .map(({ event }) => event),
    ).toHaveLength(0); // The stop arrived before campaign run started.
    const status = await run("continuous", "status");
    expect(status.code).toBe(1);
    expect(status.stdout).toContain("state stopped  reason operator");
    expect(status.stdout).toMatch(/^week  trials 0  completed 0 /m);
    expect((await run("continuous", "stop")).code).toBe(0);
    await expect(stat(join(state, "continuous.stop"))).resolves.toBeDefined();

    host.legacyHistoryAvailable = false;
    const blocked = await run("continuous", "run", ...command);
    expect(blocked.code).toBe(0);
    expect((await run("continuous", "status")).stdout).toContain(
      "state stopped  reason operator",
    );
    await expect(stat(join(state, "continuous.stop"))).resolves.toBeDefined();
    expect((await run("continuous", "run", ...command, "--resume")).code).toBe(
      0,
    );
    expect((await run("continuous", "status")).stdout).toContain(
      "reason legacy-history-missing",
    );
    expect((await run("continuous", "run", ...command)).code).toBe(0);
    expect((await run("continuous", "status")).stdout).toContain(
      "reason legacy-history-missing",
    );
    expect((await run("continuous", "resume")).code).toBe(0);
    await writeFile(
      join(state, "continuous.json"),
      JSON.stringify({ state: "running", detail: { campaignId: "crashed" } }),
    );
    const stale = await run("continuous", "status");
    expect(stale.code).toBe(1);
    expect(stale.stdout).toContain("state stale");
    await run("continuous", "stop");
    const stoppedAfterCrash = await run("continuous", "status");
    expect(stoppedAfterCrash.code).toBe(1);
    expect(stoppedAfterCrash.stdout).toContain(
      "state stopped  reason operator",
    );
    await writeFile(join(state, "continuous.pid"), String(process.pid));
    const stopping = await run("continuous", "status");
    expect(stopping.code).toBe(1);
    expect(stopping.stdout).toContain("state stopping  reason operator");
    const liveResume = await run("continuous", "resume");
    expect(liveResume.code).toBe(1);
    expect(liveResume.stderr).toContain("still running as pid");
    await rm(join(state, "continuous.pid"));
    expect((await run("continuous", "resume")).code).toBe(0);
    await expect(stat(join(state, "continuous.stop"))).rejects.toThrow();
    expect(
      (
        await run(
          "continuous",
          "run",
          ...command,
          "--campaign-prefix",
          "selection-x",
        )
      ).code,
    ).not.toBe(0);
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
    expect((await run("review", "authorize", ...exact)).code).toBe(0);
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

  it("records only the decision when review decide has no --reproduced", async () => {
    const { run, configPath, ledger } = await harness();
    const campaign = ["--campaign", "campaign-1"];
    await run("campaign", "run", "--all", ...campaign, "--config", configPath);
    const queue = await run("review", ...campaign);
    const finding = /^runtime-confirmed\s+\S+\s+finding (\S+)/m.exec(
      queue.stdout,
    )![1]!;
    const decided = await run(
      "review",
      "decide",
      ...campaign,
      "--finding",
      finding,
      "--decision",
      "defer",
      "--reason",
      "needs-reading",
      "--minutes",
      "5",
    );
    expect(decided.stderr).toBe("");
    expect(decided.code).toBe(0);
    expect(decided.stdout).toMatch(
      new RegExp(`^recorded defer \\(needs-reading\\) for finding ${finding} `),
    );
    expect(decided.stdout).not.toContain("manual reproduction");
    const events = ledger()
      .readAll({ campaignId: "campaign-1", findingId: finding })
      .map(({ event }) => event);
    expect(
      events.filter((event) => event.type === "human-reproduction-recorded"),
    ).toHaveLength(0);
    expect(
      events.filter((event) => event.type === "review-decided"),
    ).toHaveLength(1);
    expect(
      events.flatMap((event) =>
        event.type === "human-effort-recorded"
          ? [[event.action, event.minutes]]
          : [],
      ),
    ).toEqual([["read", 5]]);
  });

  it("records the human reproduction before the decision when review decide has --reproduced", async () => {
    const { run, configPath, ledger } = await harness();
    const campaign = ["--campaign", "campaign-1"];
    await run("campaign", "run", "--all", ...campaign, "--config", configPath);
    const queue = await run("review", ...campaign);
    const finding = /^runtime-confirmed\s+\S+\s+finding (\S+)/m.exec(
      queue.stdout,
    )![1]!;
    const decide = (...extra: string[]) =>
      run(
        "review",
        "decide",
        ...campaign,
        "--finding",
        finding,
        "--decision",
        "accept",
        "--reason",
        "reproduced-by-hand",
        ...extra,
      );
    const recorded = () =>
      ledger()
        .readAll({ campaignId: "campaign-1", findingId: finding })
        .map(({ event }) => event)
        .filter(
          (event) =>
            event.type === "human-reproduction-recorded" ||
            event.type === "review-decided" ||
            event.type === "human-effort-recorded",
        );

    // A bad value or a stray minutes flag is a usage error that writes nothing.
    expect((await decide("--reproduced", "yes")).code).toBe(2);
    expect((await decide("--reproduce-minutes", "40")).code).toBe(2);
    expect(
      (await decide("--reproduced", "match", "--reproduce-minutes", "-1")).code,
    ).toBe(2);
    expect(recorded()).toHaveLength(0);

    const decided = await decide(
      "--reproduced",
      "match",
      "--reproduce-minutes",
      "40",
      "--minutes",
      "5",
    );
    expect(decided.stderr).toBe("");
    expect(decided.code).toBe(0);
    expect(decided.stdout.split("\n")[0]).toBe(
      `manual reproduction match recorded for finding ${finding}`,
    );
    expect(decided.stdout.split("\n")[1]).toMatch(
      /^recorded accept \(reproduced-by-hand\) /,
    );
    expect(
      recorded().map((event) =>
        event.type === "human-effort-recorded"
          ? `${event.type}:${event.action}:${event.minutes}`
          : event.type === "human-reproduction-recorded"
            ? `${event.type}:${event.result}`
            : event.type,
      ),
    ).toEqual([
      "human-reproduction-recorded:match",
      "human-effort-recorded:reproduce:40",
      "review-decided",
      "human-effort-recorded:read:5",
    ]);

    // The export reads the same event as before the fold.
    const exported = reviewExportV1Schema.parse(
      JSON.parse(
        (await run("review", "export", ...campaign, "--finding", finding))
          .stdout,
      ),
    );
    expect(exported.review.humanReproduction).toMatchObject({
      result: "match",
      minutes: 40,
    });
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

  it("pins the original plugin sources when an automatic policy re-verifies a fixed version", async () => {
    const { run, configPath, root, ledger, frozenSelections } = await harness({
      snapshotPluginDependencies: {
        elementor: "3.34.4",
        "header-helper": "1.2.3",
      },
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
      .find((event) => event.type === "finding-recorded");
    expect(finding?.type).toBe("finding-recorded");
    if (finding?.type !== "finding-recorded") return;

    const policyPath = join(root, "selection.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete policy.candidateSlugs;
    delete policy.pinnedVersions;
    await writeFile(
      policyPath,
      JSON.stringify({
        ...policy,
        promptVariant: "wp2shell-bounty-v8",
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
        pluginDependencySlugs: { "synthetic-plugin": ["elementor"] },
      }),
    );
    const reverified = await run(
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
    expect(reverified.code).toBe(0);
    expect(reverified.stderr).toBe("");
    expect(frozenSelections.at(-1)).toMatchObject({
      version: "3.3",
      dependencyVersionPolicy: "pinned-only",
      pluginDependencyPins: {
        elementor: "3.34.4",
        "header-helper": "1.2.3",
      },
    });
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

  it("reuses the recorded SVN source pin for same-version re-verification", async () => {
    const { run, configPath, ledger, frozenSelections, root } = await harness();
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      selectionPolicyPath: string;
    };
    const policy = JSON.parse(
      await readFile(config.selectionPolicyPath, "utf8"),
    ) as Record<string, unknown>;
    const sourcePin = {
      kind: "captured-wordpress-org-svn-export" as const,
      storageDirectory: join(root, "svn-capture"),
      packetDigest: sha("a"),
      sourceTreeDigest: sha("b"),
      revision: 3628543,
    };
    policy.targetSourcePins = { "synthetic-plugin": sourcePin };
    await writeFile(config.selectionPolicyPath, JSON.stringify(policy));
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
    if (finding?.type !== "finding-recorded")
      throw new Error("Expected a synthetic Finding");

    delete policy.targetSourcePins;
    await writeFile(config.selectionPolicyPath, JSON.stringify(policy));
    const sameVersion = await run(
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
    expect(sameVersion.code).toBe(0);
    expect(frozenSelections.at(-1)?.targetSourcePin).toEqual(sourcePin);

    policy.targetSourcePins = {
      "synthetic-plugin": { ...sourcePin, revision: sourcePin.revision + 1 },
    };
    await writeFile(config.selectionPolicyPath, JSON.stringify(policy));
    const conflicting = await run(
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
    expect(conflicting.code).not.toBe(0);
    expect(conflicting.stderr).toContain("source-mismatch");
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

  it("exports one-screen review material with Private Evidence paths and removes a recorded Lab (#186)", async () => {
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
      promptVariant: "wp2shell-bounty-v8",
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

    // A Lab recorded by an earlier `lab up` (the command is gone); `lab down` still removes it.
    const labId = "0f0e0d0c-0b0a-4908-8706-050403020100";
    for (const role of ["db", "wp", "host"])
      live.containers.add(`wbh-${labId}-${role}`);
    live.networks.add(`wbh-${labId}-net`);
    live.volumes.add(`wbh-${labId}-site`);
    await writeFile(
      join(root, "state", "lab-up.json"),
      JSON.stringify({
        schemaVersion: 1,
        labId,
        campaignId: "campaign-1",
        findingId: confirmedFinding!,
        configPath,
        startedAt: "2026-10-08T00:00:00.000Z",
      }),
    );

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
