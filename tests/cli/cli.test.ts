import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/index.js";
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
import type { WordPressOrgTargetSource } from "../../src/profiles/wordpress/acquisition/index.js";
import {
  openWordPressLab,
  type DockerRequest,
} from "../../src/profiles/wordpress/lab/index.js";
import type { ProgrammeIntelligence } from "../../src/profiles/wordpress/programme-intelligence/index.js";
import { loadWordpressScopePolicy } from "../../src/profiles/wordpress/scope-policy.js";
import { createWordPressSelection } from "../../src/profiles/wordpress/selection/index.js";
import { openSnapshot } from "../../src/snapshot/index.js";

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
    readonly failOnCalls?: readonly number[];
    readonly leadsOnCalls?: Readonly<Record<number, readonly unknown[]>>;
    /** Candidate slugs; the first is not pinned. */
    readonly candidates?: readonly string[];
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
    readonly labSeedFailure?: boolean;
    readonly coreSource?: boolean;
    readonly databaseAccess?: "read-only" | "none";
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "wbh-cli-"));
  directories.push(root);
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
        if (request.args[0] === "ps")
          return {
            exitCode: 0,
            stdout: [
              `wbh-${uuid}-db`,
              `wbh-${uuid}-wp`,
              `wbh-${uuid}-proxy`,
              `provider-egress-broker-${uuid}`,
              "operator-postgres",
              "wbh-notes",
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
            ].join("\n"),
            stderr: "",
          };
        if (request.args[0] === "volume" && request.args[1] === "ls")
          return {
            exitCode: 0,
            stdout: [`wbh-${uuid}-site`, "operator-data"].join("\n"),
            stderr: "",
          };
        if (request.args[0] === "info")
          return { exitCode: 0, stdout: '{"runsc":{}}', stderr: "" };
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

  const attachments = new ProviderAttachmentStore(join(root, "provider"));
  const prompts: string[] = [];
  const promptDigests: string[] = [];
  const histories: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const boundaries: WordPressCampaignBoundaries = {
    selection,
    freeze: async (target) => {
      if (target.slug === options.failFreeze)
        throw new Error("Synthetic download failure");
      return snapshots.freeze(target);
    },
    lab,
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
        promptDigests.push(run.campaignInput.promptDigest);
        histories.push(run.campaignInput.history.mode);
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        if (options.limitOnCalls?.includes(call) === true)
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
          };
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
            call === 1
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
      async attempt() {
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
    histories,
    docker,
    root,
    ledger: () => state.ledger,
    maxInFlight: () => maxInFlight,
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
    const started = ledger()
      .read({ type: "discovery-run-started" })
      .at(0)?.event;
    expect(started).toMatchObject({
      configuration: { labAccess: { database: "read-only" } },
    });
    expect(JSON.stringify(started)).not.toContain("wbh_reader");
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

  it("runs a pinned campaign end to end and exposes review, funnel and location-overlap", async () => {
    const { run, configPath, keysPath, prompts, docker } = await harness();

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
    expect(queue.stdout).toContain("reason: no-judge");
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
      "raw 2 → verifier通過 2 → confirmed 1 / contradicted 0 / incomplete 1 → reviewed 1 → in-scope 0 → submitted 0 → outcome 0",
    );
    expect(funnel.stdout).toContain("runs 3 (discovery attempts 3)");
    expect(funnel.stdout).toContain("3 run(s) unavailable");
    expect(funnel.stdout).toMatch(/account-takeover: raw 1 .* confirmed 1/);

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

  it("normalizes old history configuration and records four prompt-continuation cells", async () => {
    const base = {
      schemaVersion: 1 as const,
      programmeBoundary: { version: "v1", text: "Synthetic" },
      wordpressVersion: "6.8",
      lab: { siteTitle: "Synthetic", initialPosts: [], customerRole: false },
    };
    expect(
      wordpressCampaignConfigSchema.parse({
        ...base,
        ablation: { axis: "history", armBFraction: 0.5 },
      }).ablation?.axes,
    ).toEqual([{ axis: "history", armBFraction: 0.5 }]);
    expect(() =>
      wordpressCampaignConfigSchema.parse({
        ...base,
        ablation: { axes: [{ axis: "continuation", armBFraction: 0.5 }] },
      }),
    ).toThrow();
    const { run, configPath, prompts, promptDigests, ledger } = await harness({
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
            { axis: "continuation", armBFraction: 0.5 },
          ],
        },
        continuation: {},
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
      { prompt: "a", continuation: "a" },
      { prompt: "b", continuation: "a" },
      { prompt: "a", continuation: "b" },
      { prompt: "b", continuation: "b" },
    ]);
    expect(
      started.map((event) =>
        event.type === "discovery-run-started"
          ? event.configuration.promptDigest
          : null,
      ),
    ).toEqual(promptDigests);
    const funnel = ledger().funnel("campaign-multi-axis");
    expect(funnel.byArm["prompt:b+continuation:a"]?.runs).toBe(1);
    expect(funnel.byArm["prompt:a"]?.runs).toBe(2);
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

  it("builds a one-hop continuation prompt from one Lead and source-index facts", async () => {
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
        continuation: { maxRunsPerTrial: 1, runWallTimeMinutes: 30 },
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
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("## Lead");
    expect(prompts[1]).toContain("## Neighbourhood");
    expect(prompts[1]).toContain("Selected Lead");
    expect(prompts[1]).toContain("synthetic_save");
    expect(prompts[1]).not.toContain("Other Lead");
    expect(prompts[1]).not.toContain("Synthetic account-takeover claim");
    expect(prompts[1]).not.toContain("transcript");
    const started = ledger()
      .read({ campaignId: "campaign-lead", type: "discovery-run-started" })
      .map(({ event }) => event);
    expect(started).toHaveLength(2);
    expect(started[1]).toMatchObject({
      type: "discovery-run-started",
      runKind: "continue",
      trialId:
        started[0]?.type === "discovery-run-started" ? started[0].runId : "",
    });
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
    const { run, configPath } = await harness({ limitOnCalls: [2] });
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
    expect(resumed.code).toBe(0);
    // One completed run was spent; two more without new Findings meet the stop rule.
    expect(resumed.stdout).toContain("runs 2  stopped by no-new-finding");
    expect(resumed.stdout.match(/^  finding /gm)).toHaveLength(2);
    expect(resumed.stdout).toContain("raw 2 → verifier通過 2 → confirmed 1");

    const again = await run(...command);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("runs 0  stopped by no-new-finding");
    expect(again.stdout).not.toContain("  finding ");
  });

  it("keeps an incomplete Trial open and retries its ordinal without counting it as no findings", async () => {
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
    expect(retried.stdout).toContain("runs 1  stopped by no-new-finding");
    expect(ledger().read({ type: "discovery-run-started" })).toHaveLength(2);
    expect(ledger().read({ type: "discovery-concluded" })).toHaveLength(1);
  });

  it("runs discovery concurrently within the configured count and memory budget", async () => {
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
      `leftover containers 4: wbh-${uuid}-db, wbh-${uuid}-wp, wbh-${uuid}-proxy, provider-egress-broker-${uuid}`,
      `leftover networks 2: wbh-${uuid}-net, provider-egress-${uuid}`,
      `leftover volumes 1: wbh-${uuid}-site`,
      "nothing removed; run again with --remove when no campaign is running",
    ]);
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
      "removed 4 containers, 2 networks, 1 volumes",
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

  it("pins a fixed-version control without treating it as a latest-version scope check", async () => {
    const { run, configPath, ledger } = await harness();
    const campaign = ["--campaign", "campaign-1"];
    await run("campaign", "run", "--all", ...campaign, "--config", configPath);
    const finding = /^runtime-confirmed\s+\S+\s+finding (\S+)/m.exec(
      (await run("review", ...campaign)).stdout,
    )![1]!;

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
});
