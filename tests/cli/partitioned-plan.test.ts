import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  planWordPressPartitionedDiscovery,
  wordpressCampaignConfigSchema,
  type WordPressCampaignBoundaries,
} from "../../src/cli/wordpress.js";
import {
  defineAgentRuntimeProfile,
  defineClaudeRuntimeProfile,
  PARTITIONED_TARGET_CEILING_MS,
} from "../../src/discovery/index.js";
import { wordPressDiscoveryOutputContractV4Solo } from "../../src/profiles/wordpress/discovery/output-contract.js";
import { WORDPRESS_ENUMERATION_TOOLS } from "../../src/profiles/wordpress/discovery/tools.js";
import {
  loadWordPressDiscoveryAsset,
  WORDPRESS_TRUST_BOUNDARY,
} from "../../src/profiles/wordpress/prompts/index.js";
import {
  loadWordPressRoleDefinition,
  WORDPRESS_CURRENT_ROLE_DEFINITION_IDS,
} from "../../src/profiles/wordpress/prompts/roles.js";

// ADR 0042: what each role of a partitioned Trial is handed, assembled from
// the existing prompt assets without changing their ids or texts. The role
// bodies and the objective are compared by containment only.

const digest = `sha256:${"a".repeat(64)}`;
const other = `sha256:${"b".repeat(64)}`;
const start = "2026-10-28T00:00:00.000Z";
const hostProfile = defineClaudeRuntimeProfile(
  {
    id: "opus",
    requestedModelId: "claude-opus-5-5",
    requestedEffort: "high",
    claudeCliVersion: "2.1.296",
    authenticationMethod: "anthropic-oauth-host",
    subagent: { modelId: "claude-opus-5-5", effort: "high" },
  },
  digest,
);
const codexProfile = defineAgentRuntimeProfile({
  id: "codex",
  transportKind: "codex-native/v1",
  sandboxImageDigest: digest,
  requestedModelId: "gpt-6-sol",
  requestedEffort: "high",
  codexCliVersion: "0.161.0",
  bundledCatalogDigest: digest,
  authenticationMethod: "unavailable",
  cyberAccessProgram: "unavailable",
  serviceTier: "unavailable",
  subagent: { modelId: "unavailable", effort: "unavailable" },
});

async function exampleConfig(overrides: Record<string, unknown> = {}) {
  const source = JSON.parse(
    await readFile(
      join(
        import.meta.dirname,
        "..",
        "..",
        "examples",
        "campaign-partitioned.json",
      ),
      "utf8",
    ),
  ) as Record<string, unknown>;
  return wordpressCampaignConfigSchema.parse({ ...source, ...overrides });
}

const unused = () => Promise.reject(new Error("not run in this test"));

async function context(config: Awaited<ReturnType<typeof exampleConfig>>) {
  const boundaries = {
    sourceFor: async () => ({
      directory: "/private/source",
      tree: { digest, entries: 1, bytes: 1 },
      dependency: {
        path: "/workspace/core",
        directory: "/private/core",
        tree: { digest: other, entries: 1, bytes: 1 },
      },
    }),
    runtimeProfile: codexProfile,
    executor: { execute: unused },
    claude: {
      runtimeProfile: hostProfile,
      executor: { execute: unused },
      oneShot: { execute: unused },
    },
    attachments: {},
  } as unknown as WordPressCampaignBoundaries;
  const [objective, trustBoundary] = await Promise.all([
    loadWordPressDiscoveryAsset("objective-partition-v1"),
    loadWordPressDiscoveryAsset(WORDPRESS_TRUST_BOUNDARY.id),
  ]);
  return {
    campaignId: "campaign-1",
    config,
    repeat: 1,
    boundaries,
    setupFor: () => ({}),
    state: {
      newId: () => "trial-x",
      clock: () => new Date(start),
    },
    objective,
    trustBoundary,
  } as unknown as Parameters<typeof planWordPressPartitionedDiscovery>[1];
}

const input = {
  snapshot: {
    digest,
    target: {
      identity: "wporg:example",
      version: "1.0.0",
      sourceDigest: digest,
    },
    dependencies: [],
  },
  target: {
    targetId: "wporg:example",
    version: "1.0.0",
    score: 1,
    selectedAt: start,
    policy: { id: "policy", digest },
  },
} as unknown as Parameters<typeof planWordPressPartitionedDiscovery>[0];

describe("planWordPressPartitionedDiscovery (ADR 0042)", () => {
  it("hands the enumerator its role, the limits and the sources, and the tracer its role, the objective, the contract and both boundaries", async () => {
    const config = await exampleConfig();
    const plan = await planWordPressPartitionedDiscovery(
      input,
      await context(config),
    );
    const [enumeratorRole, tracerRole] = await Promise.all([
      loadWordPressRoleDefinition(
        WORDPRESS_CURRENT_ROLE_DEFINITION_IDS.enumerator,
      ),
      loadWordPressRoleDefinition(WORDPRESS_CURRENT_ROLE_DEFINITION_IDS.tracer),
    ]);
    const objective = await loadWordPressDiscoveryAsset(
      "objective-partition-v1",
    );
    const trustBoundary = await loadWordPressDiscoveryAsset(
      WORDPRESS_TRUST_BOUNDARY.id,
    );
    const contract = wordPressDiscoveryOutputContractV4Solo();
    expect(plan.plannedTrials).toHaveLength(1);
    const trial = plan.plannedTrials[0]!;
    const partitioned = trial.partitioned!;
    expect(trial.trialId).toBe("trial-x");
    expect(trial.explore.run.runId).toBe("trial-x");
    expect(plan.oneShotExecutor).toBeDefined();

    const enumerator = partitioned.enumerate.run.prompt;
    expect(enumerator.startsWith(enumeratorRole.body.trim())).toBe(true);
    expect(enumerator).toContain("## Run parameters");
    expect(enumerator).toContain("## Partition limits");
    expect(enumerator).toContain("/workspace/input/previous.json");
    expect(enumerator).toContain("/workspace/input/sent-back.json");
    expect(enumerator).toContain(
      "WordPress core source (read-only): /workspace/core.",
    );
    expect(enumerator).not.toContain(objective.text.trim());
    expect(enumerator).not.toContain(contract.text);

    const tracer = partitioned.trace.run.prompt;
    expect(tracer.startsWith(tracerRole.body.trim())).toBe(true);
    expect(tracer).toContain(objective.text.trim());
    expect(tracer).toContain(contract.text);
    expect(tracer).toContain("## Trust boundary");
    expect(tracer).toContain(trustBoundary.text.trim());
    expect(tracer).toContain(
      `## Programme Boundary (${config.programmeBoundary.version})`,
    );
    expect(tracer).toContain(config.programmeBoundary.text.trim());
    expect(tracer).toContain(
      "WordPress core source (read-only): /workspace/core.",
    );
    expect(tracer).not.toContain("## Partition limits");

    // Every configured tool is mounted for both roles.
    const toolFiles = WORDPRESS_ENUMERATION_TOOLS.map((tool) => tool.file);
    expect(
      partitioned.enumerate.run.toolFiles.map((file) => file.name),
    ).toEqual(toolFiles);
    expect(partitioned.trace.run.toolFiles.map((file) => file.name)).toEqual(
      toolFiles,
    );
    expect(partitioned.enumerate.run.output).toBe("files");
    expect(partitioned.trace.run.output).toBe("report");

    // The enumerator's start names its own body; the tracer's names the objective.
    expect(partitioned.enumerate.configuration).toMatchObject({
      promptVariant: enumeratorRole.id,
      promptDigest: enumeratorRole.digest,
      mode: "partitioned",
      wallMinutes: 20,
      role: { kind: "enumerator", definitionDigest: enumeratorRole.digest },
    });
    expect(partitioned.enumerate.configuration.objectiveDigest).toBeUndefined();
    expect(partitioned.enumerate.configuration.contractDigest).toBeUndefined();
    expect(partitioned.trace.configuration).toMatchObject({
      promptVariant: "objective-partition-v1",
      promptDigest: objective.digest,
      objectiveDigest: objective.digest,
      contractDigest: contract.digest,
      wallMinutes: 45,
      role: { kind: "tracer", definitionDigest: tracerRole.digest },
    });
    expect(partitioned.enumerate.configuration.inputDigest).not.toBe(
      partitioned.trace.configuration.inputDigest,
    );
    // 20 × 3 + ceil(8 / 2) × 45 = 240 minutes: the ceiling exactly.
    expect(partitioned.targetWallMs).toBe(PARTITIONED_TARGET_CEILING_MS);
    expect(partitioned.maxParallel).toBe(2);
    expect(partitioned.limits).toEqual({
      maxEntriesPerPartition: 60,
      maxPartitions: 8,
      maxResubmits: 2,
    });
    expect(plan.input.modelProfileDigest).toBe(hostProfile.digest);
    expect(plan.input.promptDigest).toBe(objective.digest);
  });

  it("refuses roles on different models or efforts, a script-only row source and a non-Claude host", async () => {
    const config = await exampleConfig();
    const differing = await exampleConfig({
      discovery: {
        ...config.discovery,
        tracer: { ...config.discovery.tracer, effort: "medium" },
      },
    });
    await expect(
      planWordPressPartitionedDiscovery(input, await context(differing)),
    ).rejects.toThrow("same model and effort");
    const scriptOnly = await exampleConfig({
      discovery: {
        ...config.discovery,
        enumerator: {
          ...config.discovery.enumerator,
          rowSource: "script-only",
        },
      },
    });
    await expect(
      planWordPressPartitionedDiscovery(input, await context(scriptOnly)),
    ).rejects.toThrow("script-only");
    const codexHost = await context(config);
    (
      codexHost.boundaries as { claude: { runtimeProfile: unknown } }
    ).claude.runtimeProfile = codexProfile;
    await expect(
      planWordPressPartitionedDiscovery(input, codexHost),
    ).rejects.toThrow("Claude runtime only");
  });
});
