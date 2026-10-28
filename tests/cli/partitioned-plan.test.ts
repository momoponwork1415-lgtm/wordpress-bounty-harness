import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

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
import {
  loadWordPressEnumerationTool,
  WORDPRESS_ENUMERATION_TOOLS,
} from "../../src/profiles/wordpress/discovery/tools.js";
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
    oneShot: { execute: unused },
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
  it("runs the selected v2 bytes at the filename named by the unchanged role and keeps an explicit v1 pack intact", async () => {
    const config = await exampleConfig();
    const plan = await planWordPressPartitionedDiscovery(
      input,
      await context(config),
    );
    const files = plan.plannedTrials[0]!.partitioned!.enumerate.run.toolFiles;
    const v2 = await loadWordPressEnumerationTool("enumerate-sinks-v2");
    const alias = files.find((file) => file.name === "enumerate-sinks-v1.sh")!;
    expect(alias.content).toEqual(v2.bytes);
    const root = await mkdtemp(join(tmpdir(), "wbh-role-tool-"));
    try {
      await writeFile(join(root, alias.name), alias.content);
      await writeFile(
        join(root, "plugin.php"),
        "<?php\necho $one;\necho $two;\n",
      );
      expect(
        (await promisify(execFile)("sh", [join(root, alias.name), root]))
          .stdout,
      ).toBe("output\tplugin.php\t2\techo $one; (+1)\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    const old = await exampleConfig({
      discovery: {
        mode: "partitioned",
        enumerator: { tools: ["enumerate-sinks-v1"] },
      },
    });
    const oldPlan = await planWordPressPartitionedDiscovery(
      input,
      await context(old),
    );
    expect(
      oldPlan.plannedTrials[0]!.partitioned!.enumerate.run.toolFiles,
    ).toEqual([
      {
        name: "enumerate-sinks-v1.sh",
        content: (await loadWordPressEnumerationTool("enumerate-sinks-v1"))
          .bytes,
      },
    ]);
  });

  it.each(["claude", "codex"])("keeps %s role inputs", async (runtime) => {
    const role =
      runtime === "codex"
        ? { runtime, model: "gpt-6-luna", effort: "ultra" }
        : { runtime };
    const config = await exampleConfig({
      discovery: {
        mode: "partitioned",
        enumerator: role,
        tracer: role,
      },
    });
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
    const toolFiles = [
      ...WORDPRESS_ENUMERATION_TOOLS.filter(
        (tool) => tool.status === "current",
      ).map((tool) => tool.file),
      "enumerate-sinks-v1.sh",
    ];
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
      maxEntriesPerPartition: 300,
      maxPartitions: 8,
      maxResubmits: 2,
    });
    expect(plan.input.modelProfileDigest).toBe(
      partitioned.enumerate.run.profile.digest,
    );
    if (runtime === "claude")
      expect(plan.input.modelProfileDigest).toBe(hostProfile.digest);
    else {
      expect(plan.input.modelProfileDigest).not.toBe(codexProfile.digest);
      expect(partitioned.enumerate.run.profile).toMatchObject({
        transportKind: "codex-native/v1",
        requestedModelId: "gpt-6-luna",
        requestedEffort: "ultra",
      });
      expect(partitioned.trace.run.profile.digest).toBe(
        plan.input.modelProfileDigest,
      );
    }
    const missing = await context(config);
    const boundary =
      runtime === "claude" ? missing.boundaries.claude! : missing.boundaries;
    delete (boundary as { oneShot?: unknown }).oneShot;
    await expect(
      planWordPressPartitionedDiscovery(input, missing),
    ).rejects.toThrow(`${runtime} runtime with one-shot`);
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
    ).rejects.toThrow("claude runtime profile");
  });
});
