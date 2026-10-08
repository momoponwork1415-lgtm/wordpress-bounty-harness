import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createPatchstackProgrammeAdapters,
  type PatchstackProgrammePageAdapter,
} from "../../../src/profiles/wordpress/patchstack-programme/index.js";
import { openProgrammeIntelligence } from "../../../src/profiles/wordpress/programme-intelligence/index.js";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const fixtureDirectory = join(
  import.meta.dirname,
  "..",
  "..",
  "fixtures",
  "target-intelligence",
  "patchstack-programme",
);

const sources = [
  {
    sourceKind: "rules",
    sourceUrl: "https://patchstack.com/articles/bug-bounty-guidelines-rules/",
    fixture: "rules.json",
  },
  {
    sourceKind: "report-form",
    sourceUrl: "https://patchstack.com/database/report",
    fixture: "report-form.json",
  },

  {
    sourceKind: "mvdp-directory",
    sourceUrl: "https://patchstack.com/database/managed-vdp/",
    fixture: "mvdp-directory.json",
  },
  {
    sourceKind: "marketing",
    sourceUrl: "https://patchstack.com/bug-bounty/",
    fixture: "marketing.json",
  },
] as const;

function fixturePageAdapters(): readonly PatchstackProgrammePageAdapter[] {
  return sources.map((source) => ({
    sourceKind: source.sourceKind,
    sourceUrl: source.sourceUrl,
    parserVersion: `patchstack-${source.sourceKind}-v2`,
    retrieve: () => readFile(join(fixtureDirectory, source.fixture)),
    parse: (bytes) => JSON.parse(Buffer.from(bytes).toString("utf8")),
  }));
}

describe("Patchstack Programme Adapter", () => {
  it("normalizes current scope and membership conditions without reward routes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "patchstack-programme-"));
    try {
      const intelligence = openProgrammeIntelligence({
        storageDirectory: directory,
        sourceAdapters: createPatchstackProgrammeAdapters({
          pages: fixturePageAdapters(),
        }),
        freshnessPolicy: {
          kind: "programme-eligibility-freshness-policy",
          schemaVersion: 1,
          id: "programme-freshness-v1",
          digest: digest("f"),
          maximumAgeMs: {
            targetSelectionBatch: 86_400_000,
            submissionStaging: 3_600_000,
          },
        },
        clock: () => new Date("2030-09-01T00:00:00.000Z"),
      });

      const refreshed = await intelligence.refresh({
        kind: "programme-intelligence-refresh",
        schemaVersion: 1,
        programmeIdentity: "programme:patchstack",
      });
      expect(refreshed).toMatchObject({
        status: "current",
        snapshot: {
          schemaVersion: 2,
          programmeIdentity: "programme:patchstack",
          retrievedAt: "2030-09-01T00:00:00.000Z",
          sources: sources.map((source, index) => ({
            sourceId: `programme:patchstack:0${index + 1}-${source.sourceKind}`,
            sourceUrl: source.sourceUrl,
            contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            parserVersion: `patchstack-${source.sourceKind}-v2`,
          })),
          policy: {
            eligibility: {
              activeInstallThreshold: { kind: "minimum", value: 1000 },
              attackerRoles: [
                "unauthenticated",
                "subscriber",
                "customer",
                "contributor-for-mvdp",
              ],
              conditions: [
                "latest-stable-version",
                "updated-within-three-years",
                "mvdp-scope-exception",
                "working-exploit-required",
              ],
              directoryEligibilityRules: [
                {
                  directoryIdentity:
                    "managed-vulnerability-disclosure-programme",
                  requiredMembership: "listed-plugin",
                  eligibilityEffect: "contributor-attacker-role-exception",
                  authorizationCondition: "mvdp-scope-exception",
                },
              ],
            },
            programmeOpportunityBand: "broad",
          },
        },
      });
      if (refreshed.status !== "current") {
        throw new Error("Expected current eligibility without reward data");
      }
      expect(Object.keys(refreshed.snapshot.policy).sort()).toEqual([
        "eligibility",
        "programmeOpportunityBand",
      ]);
      expect(JSON.stringify(refreshed)).not.toMatch(
        /named-plugin|CVE-|known-vulnerability|leaderboard-researcher/i,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports a lower-precedence marketing contradiction instead of overriding Rules", async () => {
    const directory = await mkdtemp(join(tmpdir(), "patchstack-conflict-"));
    const pages = fixturePageAdapters().map((page) =>
      page.sourceKind === "marketing"
        ? {
            ...page,
            parse: async (bytes: Uint8Array) => ({
              ...(JSON.parse(Buffer.from(bytes).toString("utf8")) as object),
              assertions: {
                ...(
                  JSON.parse(Buffer.from(bytes).toString("utf8")) as {
                    assertions: object;
                  }
                ).assertions,
                programmeOpportunityBand: "research-only",
              },
            }),
          }
        : page,
    );
    try {
      const intelligence = openProgrammeIntelligence({
        storageDirectory: directory,
        sourceAdapters: createPatchstackProgrammeAdapters({ pages }),
        freshnessPolicy: {
          kind: "programme-eligibility-freshness-policy",
          schemaVersion: 1,
          id: "programme-freshness-v1",
          digest: digest("f"),
          maximumAgeMs: {
            targetSelectionBatch: 86_400_000,
            submissionStaging: 3_600_000,
          },
        },
      });
      await expect(
        intelligence.refresh({
          kind: "programme-intelligence-refresh",
          schemaVersion: 1,
          programmeIdentity: "programme:patchstack",
        }),
      ).resolves.toMatchObject({
        status: "policy-conflict",
        programmeIdentity: "programme:patchstack",
        sources: expect.arrayContaining([
          expect.objectContaining({
            sourceId: "programme:patchstack:01-rules",
          }),
        ]),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns stale when any required Patchstack source cannot be refreshed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "patchstack-stale-"));
    const pages = fixturePageAdapters().map((page) =>
      page.sourceKind === "mvdp-directory"
        ? {
            ...page,
            retrieve: () => Promise.reject(new Error("fixture unavailable")),
          }
        : page,
    );
    try {
      const intelligence = openProgrammeIntelligence({
        storageDirectory: directory,
        sourceAdapters: createPatchstackProgrammeAdapters({ pages }),
        freshnessPolicy: {
          kind: "programme-eligibility-freshness-policy",
          schemaVersion: 1,
          id: "programme-freshness-v1",
          digest: digest("f"),
          maximumAgeMs: {
            targetSelectionBatch: 86_400_000,
            submissionStaging: 3_600_000,
          },
        },
      });
      await expect(
        intelligence.refresh({
          kind: "programme-intelligence-refresh",
          schemaVersion: 1,
          programmeIdentity: "programme:patchstack",
        }),
      ).resolves.toMatchObject({
        status: "stale",
        reason: "refresh-failed",
        requiredSources: [
          { sourceId: "programme:patchstack:01-rules" },
          { sourceId: "programme:patchstack:02-report-form" },
          { sourceId: "programme:patchstack:03-mvdp-directory" },
          { sourceId: "programme:patchstack:04-marketing" },
        ],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an mVDP directory that omits its membership exception", async () => {
    const directory = await mkdtemp(join(tmpdir(), "patchstack-mvdp-drift-"));
    const pages = fixturePageAdapters().map((page) =>
      page.sourceKind === "mvdp-directory"
        ? {
            ...page,
            parse: async (bytes: Uint8Array) => {
              const document = JSON.parse(
                Buffer.from(bytes).toString("utf8"),
              ) as { assertions: Record<string, unknown> };
              delete document.assertions.directoryEligibilityRules;
              return document;
            },
          }
        : page,
    );
    try {
      const intelligence = openProgrammeIntelligence({
        storageDirectory: directory,
        sourceAdapters: createPatchstackProgrammeAdapters({ pages }),
        freshnessPolicy: {
          kind: "programme-eligibility-freshness-policy",
          schemaVersion: 1,
          id: "programme-freshness-v1",
          digest: digest("f"),
          maximumAgeMs: {
            targetSelectionBatch: 86_400_000,
            submissionStaging: 3_600_000,
          },
        },
      });
      await expect(
        intelligence.refresh({
          kind: "programme-intelligence-refresh",
          schemaVersion: 1,
          programmeIdentity: "programme:patchstack",
        }),
      ).resolves.toMatchObject({
        status: "parse-failed",
        programmeIdentity: "programme:patchstack",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an Oracle-labeled mVDP exception instead of projecting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "patchstack-mvdp-oracle-"));
    const pages = fixturePageAdapters().map((page) =>
      page.sourceKind === "mvdp-directory"
        ? {
            ...page,
            parse: async (bytes: Uint8Array) => {
              const document = JSON.parse(
                Buffer.from(bytes).toString("utf8"),
              ) as {
                assertions: {
                  directoryEligibilityRules: Array<Record<string, unknown>>;
                };
              };
              const first = document.assertions.directoryEligibilityRules[0];
              if (first !== undefined) {
                first.eligibilityEffect = "known-vulnerability-priority";
              }
              return document;
            },
          }
        : page,
    );
    try {
      const intelligence = openProgrammeIntelligence({
        storageDirectory: directory,
        sourceAdapters: createPatchstackProgrammeAdapters({ pages }),
        freshnessPolicy: {
          kind: "programme-eligibility-freshness-policy",
          schemaVersion: 1,
          id: "programme-freshness-v1",
          digest: digest("f"),
          maximumAgeMs: {
            targetSelectionBatch: 86_400_000,
            submissionStaging: 3_600_000,
          },
        },
      });
      const result = await intelligence.refresh({
        kind: "programme-intelligence-refresh",
        schemaVersion: 1,
        programmeIdentity: "programme:patchstack",
      });
      expect(result).toMatchObject({
        status: "parse-failed",
        programmeIdentity: "programme:patchstack",
      });
      expect(JSON.stringify(result)).not.toContain(
        "known-vulnerability-priority",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects Oracle fields without reusing an old default", async () => {
    const directory = await mkdtemp(join(tmpdir(), "patchstack-drift-"));
    const pages = fixturePageAdapters().map((page) =>
      page.sourceKind === "rules"
        ? {
            ...page,
            parse: async (bytes: Uint8Array) => {
              const document = JSON.parse(
                Buffer.from(bytes).toString("utf8"),
              ) as {
                assertions: Record<string, unknown>;
              };
              return {
                ...document,
                oracleFacts: {
                  cve: "CVE-2099-9999",
                  knownRoute: "must not cross the Adapter",
                },
              };
            },
          }
        : page,
    );
    try {
      const intelligence = openProgrammeIntelligence({
        storageDirectory: directory,
        sourceAdapters: createPatchstackProgrammeAdapters({ pages }),
        freshnessPolicy: {
          kind: "programme-eligibility-freshness-policy",
          schemaVersion: 1,
          id: "programme-freshness-v1",
          digest: digest("f"),
          maximumAgeMs: {
            targetSelectionBatch: 86_400_000,
            submissionStaging: 3_600_000,
          },
        },
      });
      await expect(
        intelligence.refresh({
          kind: "programme-intelligence-refresh",
          schemaVersion: 1,
          programmeIdentity: "programme:patchstack",
        }),
      ).resolves.toMatchObject({
        status: "parse-failed",
        programmeIdentity: "programme:patchstack",
        source: { sourceId: "programme:patchstack:01-rules" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
