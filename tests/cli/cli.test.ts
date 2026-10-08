import { createHash } from "node:crypto";
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
async function harness() {
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
  const boundaries: WordPressCampaignBoundaries = {
    selection,
    freeze: (target) => snapshots.freeze(target),
    lab,
    sourceFor: async () => ({ directory: sourceDirectory, tree }),
    runtimeProfile: profile,
    attachments,
    executor: {
      async execute(run: DiscoveryTransportRun) {
        prompts.push(run.prompt);
        const report = {
          findings:
            prompts.length === 1
              ? [
                  claim("account-takeover", "includes/synthetic.php"),
                  claim("sqli", "synthetic-plugin.php"),
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
      candidateSlugs: ["synthetic-plugin"],
      pinnedVersions: { "synthetic-plugin": "3.3.1" },
      minimumActiveInstallations: 500,
      maximumObservationAgeDays: 2,
      maximumUpdateAgeDays: 365,
      maximumTargets: 1,
      excludedAuthors: [],
      excludedSlugs: [],
      surfaceTagWeights: {},
      scoreWeights: { installations: 1, recency: 1, surface: 1 },
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
  return { run, configPath, keysPath, prompts, docker };
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
    expect(queue.stdout).toMatch(/reproduction package: sha256:[a-f0-9]{64}/);
    expect(queue.stdout).toMatch(/evidence: sha256:[a-f0-9]{64}/);
    expect(queue.stdout).toMatch(/^incomplete .* sqli$/m);
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
