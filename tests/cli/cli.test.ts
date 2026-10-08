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
    /** Candidate slugs; the first is not pinned. */
    readonly candidates?: readonly string[];
    /** A slug whose snapshot cannot be frozen. */
    readonly failFreeze?: string;
    /** Extra campaign config fields. */
    readonly config?: Readonly<Record<string, unknown>>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "wbh-cli-"));
  directories.push(root);
  const sourceDirectory = join(root, "source");
  await mkdir(join(sourceDirectory, "includes"), { recursive: true });
  await writeFile(
    join(sourceDirectory, "includes", "synthetic.php"),
    "<?php // harmless synthetic fixture\n",
  );
  await writeFile(
    join(sourceDirectory, "synthetic-plugin.php"),
    "<?php // harmless synthetic fixture\n",
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
    },
    source: {
      resolve: async () => ({
        target: {
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
        if (request.args[0] === "info")
          return { exitCode: 0, stdout: '{"runsc":{}}', stderr: "" };
        if (request.args[0] === "inspect")
          return { exitCode: 0, stdout: "172.20.0.2", stderr: "" };
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
    sourceFor: async () => ({ directory: sourceDirectory, tree }),
    runtimeProfile: profile,
    attachments,
    executor: {
      async execute(run: DiscoveryTransportRun) {
        const call = prompts.push(run.prompt);
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
        const report = {
          findings:
            call === 1
              ? [
                  claim("account-takeover", "includes/synthetic.php"),
                  claim("sensitive-object-access", "synthetic-plugin.php"),
                ]
              : [],
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

  it("refuses a memory budget below one run and stops at the daily run cap", async () => {
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

    const capped = await harness({ config: { dailyRunCap: 1 } });
    const stopped = await capped.run(
      "campaign",
      "run",
      "--all",
      "--campaign",
      "campaign-1",
      "--config",
      capped.configPath,
    );
    expect(stopped.code).toBe(3);
    expect(stopped.stdout).toContain("runs 1  stopped by daily-run-cap");
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
      /^reverified finding \S+ on wporg:synthetic-plugin 9\.9\.9  snapshot sha256:[a-f0-9]{64}  verification \S+: runtime-confirmed$/m,
    );

    const after = await run("review", ...campaign);
    const latest = /verification (\S+)\s+snapshot (\S+)/.exec(after.stdout)!;
    // A fresh verification on a fresh snapshot; the old digest is not reused.
    expect(latest[1]).not.toBe(original[1]);
    expect(latest[2]).not.toBe(original[2]);
    const scoped = await run(
      "review",
      "scope",
      ...campaign,
      "--finding",
      finding,
    );
    expect(scoped.stdout).toMatch(/^wordfence in-scope /m);
    expect(scoped.stdout).toMatch(/^patchstack in-scope /m);
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
