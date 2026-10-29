import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CliState } from "../../src/cli/index.js";
import {
  DISCOVERY_RUN_MEMORY_MIB,
  openWordPressCampaignSession,
  type VerifierHandoff,
  type WordPressCampaignBoundaries,
  type WordPressCampaignConfig,
} from "../../src/cli/wordpress-session.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const policyFile = (overrides: Record<string, unknown> = {}) => ({
  kind: "wordpress-selection-policy",
  schemaVersion: 1,
  id: "session-test-policy",
  candidateSlugs: ["synthetic-plugin"],
  minimumActiveInstallations: 500,
  maximumObservationAgeDays: 2,
  maximumUpdateAgeDays: 365,
  maximumTargets: 1,
  excludedAuthors: [],
  excludedSlugs: [],

  ...overrides,
});

async function fixture(options: {
  readonly config?: Record<string, unknown>;
  readonly policy?: Record<string, unknown> | null;
  readonly policyName?: string;
  readonly legacyVerifier?: boolean;
  readonly handoffVerifier?: WordPressCampaignBoundaries["handoffVerifier"];
}) {
  const root = await mkdtemp(join(tmpdir(), "wbh-session-"));
  directories.push(root);
  const policyPath = join(root, options.policyName ?? "selection.json");
  if (options.policy !== null)
    await writeFile(policyPath, JSON.stringify(policyFile(options.policy)));
  const configPath = join(root, "campaign.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      selectionPolicyPath: policyPath,
      programmeBoundary: { version: "v1", text: "Synthetic boundary" },
      wordpressVersion: "6.8",
      lab: {
        siteTitle: "Lab",
        initialPosts: ["Welcome"],
        customerRole: true,
      },
      ...options.config,
    }),
  );
  const boundaryCalls: WordPressCampaignConfig[] = [];
  const boundaries = {
    lab: {},
    ...(options.legacyVerifier === false ? {} : { verifier: {} }),
    ...(options.handoffVerifier === undefined
      ? {}
      : { handoffVerifier: options.handoffVerifier }),
  } as unknown as WordPressCampaignBoundaries;
  const state = {
    stateDirectory: join(root, "state"),
    clock: () => new Date("2026-10-18T00:00:00Z"),
    newId: () => "id",
    ledger: {},
    store: {},
  } as unknown as CliState;
  const open = (input?: {
    selectionPolicyPath?: string;
    handoff?: VerifierHandoff;
  }) =>
    openWordPressCampaignSession(
      {
        boundaries: async (config) => {
          boundaryCalls.push(config);
          return boundaries;
        },
      },
      state,
      { configPath, ...input },
    );
  return { root, open, boundaryCalls, boundaries, policyPath };
}

describe("WordPress campaign session", () => {
  it("builds the boundaries once from the parsed config and derives the Lab setup from it", async () => {
    const { open, boundaryCalls, boundaries } = await fixture({});
    const session = await open();
    expect(boundaryCalls).toHaveLength(1);
    expect(boundaryCalls[0]?.wordpressVersion).toBe("6.8");
    expect(boundaryCalls[0]?.lab.databaseAccess).toBe("read-only");
    expect(session.boundaries).toBe(boundaries);
    const snapshot = { digest: "sha256:" + "a".repeat(64) } as Parameters<
      typeof session.setupFor
    >[0];
    expect(session.setupFor(snapshot)).toMatchObject({
      schemaVersion: 1,
      snapshotDigest: snapshot.digest,
      siteTitle: "Lab",
    });
    expect(session.setupFor(snapshot)).not.toHaveProperty("scenario");
    expect(session.verification.promptVersion).toBeDefined();
  });

  it("rejects a config that names a Lab scenario removed in #353 before building boundaries", async () => {
    const { open, boundaryCalls } = await fixture({
      config: {
        lab: {
          siteTitle: "Lab",
          initialPosts: ["Welcome"],
          customerRole: true,
          scenarioId: "approved-comment-v1",
        },
      },
    });
    await expect(open()).rejects.toThrow("Lab scenarios were removed in #353");
    expect(boundaryCalls).toHaveLength(0);
  });

  it("opens administration without a legacy Verifier and never selects handoff implicitly", async () => {
    const handoffVerifier = vi.fn(() => {
      throw new Error("Handoff was not requested");
    });
    const { open, boundaryCalls, boundaries } = await fixture({
      legacyVerifier: false,
      handoffVerifier,
    });
    const session = await open();
    expect(boundaryCalls).toHaveLength(1);
    expect(session.boundaries).toBe(boundaries);
    expect(session.boundaries.verifier).toBeUndefined();
    expect(session.config.wordpressVersion).toBe("6.8");
    expect((await session.policy()).id).toBe("session-test-policy");
    const snapshot = { digest: "sha256:" + "a".repeat(64) } as Parameters<
      typeof session.setupFor
    >[0];
    expect(session.setupFor(snapshot).snapshotDigest).toBe(snapshot.digest);
    expect(() => session.verification).toThrow(
      "The legacy Codex Verifier is retired",
    );
    expect(handoffVerifier).not.toHaveBeenCalled();
  });

  it("constructs an explicitly requested handoff Verifier once, only when verification is used", async () => {
    const attempt = vi.fn(async () => {
      throw new Error("Session construction must not execute a Verifier");
    });
    const handoffVerifier = vi.fn(() => ({ attempt }));
    const { open, root } = await fixture({
      legacyVerifier: false,
      handoffVerifier,
    });
    const handoff = {
      directory: join(root, "handoff"),
      httpPort: 8080,
      databasePort: 3306,
    };
    const session = await open({ handoff });
    expect(handoffVerifier).not.toHaveBeenCalled();
    const verification = session.verification;
    expect(session.verification).toBe(verification);
    expect(handoffVerifier).toHaveBeenCalledExactlyOnceWith(handoff);
    expect(attempt).not.toHaveBeenCalled();
  });

  it("requires the explicitly requested handoff adapter without falling back to a legacy Verifier", async () => {
    const { open, root } = await fixture({});
    const session = await open({
      handoff: {
        directory: join(root, "handoff"),
        httpPort: 8080,
        databasePort: 3306,
      },
    });
    expect(session.boundaries.verifier).toBeDefined();
    expect(() => session.verification).toThrow(
      "This profile has no handoff Verifier",
    );
  });

  it("reads the policy the config names once, on demand", async () => {
    const { open, policyPath } = await fixture({});
    const session = await open();
    const first = await session.policy();
    expect(first.id).toBe("session-test-policy");
    // The file is replaced after the first read; the session keeps its answer.
    await writeFile(
      policyPath,
      JSON.stringify(policyFile({ id: "rewritten" })),
    );
    expect(await session.policy()).toBe(first);
  });

  it("stops a policy whose WordPress version or prompt variant differs from the campaign, only when the policy is used", async () => {
    const version = await fixture({ policy: { wordpressVersion: "6.7" } });
    const versionSession = await version.open();
    expect(version.boundaryCalls).toHaveLength(1);
    await expect(versionSession.policy()).rejects.toThrow(
      "Selection and campaign WordPress versions differ",
    );
    const prompt = await fixture({
      policy: { promptVariant: "wp2shell-bounty-v6" },
    });
    await expect((await prompt.open()).policy()).rejects.toThrow(
      "Selection and campaign prompt variants differ",
    );
  });

  it("rejects a memory budget below one discovery run before touching the host", async () => {
    const { open, boundaryCalls } = await fixture({
      config: {
        resources: { memoryBudgetMiB: DISCOVERY_RUN_MEMORY_MIB - 1 },
      },
    });
    await expect(open()).rejects.toThrow(
      `The memory budget is below one discovery run (${DISCOVERY_RUN_MEMORY_MIB} MiB)`,
    );
    expect(boundaryCalls).toHaveLength(0);
  });

  it("accepts an attached exploration Lab with its reset budget (Phase D1)", async () => {
    const { open } = await fixture({
      config: { discovery: { lab: { mode: "attached", maxResets: 3 } } },
    });
    const session = await open();
    expect(session.config.discovery.lab).toEqual({
      mode: "attached",
      maxResets: 3,
      maxObservations: 20,
    });
  });

  it("replaces the config's selection policy path in process", async () => {
    const { root, open, boundaryCalls } = await fixture({});
    const override = join(root, "override.json");
    await writeFile(
      override,
      JSON.stringify(policyFile({ id: "override-policy" })),
    );
    const session = await open({ selectionPolicyPath: override });
    expect(session.config.selectionPolicyPath).toBe(override);
    expect(boundaryCalls[0]?.selectionPolicyPath).toBe(override);
    expect((await session.policy()).id).toBe("override-policy");
  });
});

describe("discovery skills (ADR 0043)", () => {
  it("accepts pinned skill ids for a deep or wide campaign", async () => {
    const { open } = await fixture({
      config: { discovery: { lab: "none", skills: ["wbh-recon-v1"] } },
    });
    const session = await open();
    expect(session.config.discovery.skills).toEqual(["wbh-recon-v1"]);
    const wide = await fixture({
      config: {
        discovery: { lab: "none", mode: "wide", skills: ["wbh-recon-v1"] },
      },
    });
    expect((await wide.open()).config.discovery.skills).toEqual([
      "wbh-recon-v1",
    ]);
  });

  it("rejects unknown ids, repeated skills and skills on a partitioned campaign", async () => {
    for (const config of [
      { discovery: { lab: "none", skills: ["wbh-other-v1"] } },
      { discovery: { lab: "none", skills: ["wbh-recon-v1", "wbh-recon-v1"] } },
      {
        discovery: {
          lab: "none",
          mode: "partitioned",
          skills: ["wbh-recon-v1"],
        },
        promptId: "objective-partition-v1",
      },
    ]) {
      const { open } = await fixture({ config });
      await expect(open()).rejects.toThrow();
    }
  });
});
