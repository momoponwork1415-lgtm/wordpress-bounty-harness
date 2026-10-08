import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createWordfenceProgrammeAdapters,
  type WordfenceProgrammePageAdapter,
} from "../../../src/profiles/wordpress/wordfence-programme/index.js";
import { openProgrammeIntelligence } from "../../../src/profiles/wordpress/programme-intelligence/index.js";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const fixtureDirectory = join(
  import.meta.dirname,
  "..",
  "..",
  "fixtures",
  "target-intelligence",
  "wordfence-programme",
);

const sources = [
  {
    sourceKind: "programme",
    sourceUrl: "https://www.wordfence.com/threat-intel/bug-bounty-program/",
    fixture: "programme.json",
  },
  {
    sourceKind: "terms",
    sourceUrl:
      "https://www.wordfence.com/threat-intel/bug-bounty-program/terms-and-conditions/",
    fixture: "terms.json",
  },
  {
    sourceKind: "report-form",
    sourceUrl: "https://www.wordfence.com/threat-intel/vulnerabilities/submit/",
    fixture: "report-form.json",
  },
] as const;

function fixturePageAdapters(): readonly WordfenceProgrammePageAdapter[] {
  return sources.map((source) => ({
    sourceKind: source.sourceKind,
    sourceUrl: source.sourceUrl,
    parserVersion: `wordfence-${source.sourceKind}-v2`,
    retrieve: () => readFile(join(fixtureDirectory, source.fixture)),
    parse: (bytes) => JSON.parse(Buffer.from(bytes).toString("utf8")),
  }));
}

describe("Wordfence Programme Adapter", () => {
  it("normalizes current scope using only programme, terms, and report form", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wordfence-programme-"));
    try {
      const intelligence = openProgrammeIntelligence({
        storageDirectory: directory,
        sourceAdapters: createWordfenceProgrammeAdapters({
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
        clock: () => new Date("2030-08-15T00:00:00.000Z"),
      });

      const request = {
        kind: "programme-intelligence-refresh",
        schemaVersion: 1 as const,
        programmeIdentity: "programme:wordfence",
      } as const;
      const refreshed = await intelligence.refresh(request);
      expect(refreshed).toMatchObject({
        status: "current",
        snapshot: {
          schemaVersion: 2,
          programmeIdentity: "programme:wordfence",
          retrievedAt: "2030-08-15T00:00:00.000Z",
          sources: sources.map((source, index) => ({
            sourceId: `programme:wordfence:0${index + 1}-${source.sourceKind}`,
            sourceUrl: source.sourceUrl,
            contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            parserVersion: `wordfence-${source.sourceKind}-v2`,
          })),
          policy: {
            eligibility: {
              activeInstallThreshold: { kind: "minimum", value: 1000 },
              researcherTiers: ["standard", "resourceful", "elite"],
              conditions: expect.arrayContaining([
                "latest-stable-version",
                "exclusive-responsible-disclosure",
              ]),
              limits: [{ key: "pending-submission-cap", value: 10 }],
            },
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
        /named-plugin|CVE-|affected-version|known-route|researcher-name/i,
      );
      if (refreshed.status !== "current") {
        throw new Error("Expected a current Wordfence programme snapshot");
      }
      await expect(intelligence.refresh(request)).resolves.toEqual(refreshed);

      const restarted = openProgrammeIntelligence({
        storageDirectory: directory,
        sourceAdapters: [],
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
        clock: () => new Date("2030-08-15T00:00:00.000Z"),
      });
      await expect(
        restarted.inspect({
          kind: "programme-eligibility-inspection",
          schemaVersion: 1,
          snapshotRef: refreshed.snapshotRef,
          requiredFor: "target-selection-batch",
        }),
      ).resolves.toEqual(refreshed);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports a contradiction between official Wordfence programme sources", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wordfence-conflict-"));
    const pages = fixturePageAdapters().map((page) =>
      page.sourceKind === "terms"
        ? {
            ...page,
            parse: async (bytes: Uint8Array) => {
              const document = JSON.parse(
                Buffer.from(bytes).toString("utf8"),
              ) as { assertions: { eligibility: object } };
              return {
                ...document,
                assertions: {
                  ...document.assertions,
                  eligibility: {
                    ...document.assertions.eligibility,
                    activeInstallThreshold: { kind: "none" },
                  },
                },
              };
            },
          }
        : page,
    );
    try {
      const intelligence = openProgrammeIntelligence({
        storageDirectory: directory,
        sourceAdapters: createWordfenceProgrammeAdapters({ pages }),
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
          programmeIdentity: "programme:wordfence",
        }),
      ).resolves.toMatchObject({
        status: "policy-conflict",
        programmeIdentity: "programme:wordfence",
        sources: expect.arrayContaining([
          expect.objectContaining({
            sourceId: "programme:wordfence:01-programme",
          }),
          expect.objectContaining({
            sourceId: "programme:wordfence:02-terms",
          }),
        ]),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns stale when any required Wordfence source cannot be refreshed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wordfence-stale-"));
    const pages = fixturePageAdapters().map((page) =>
      page.sourceKind === "terms"
        ? {
            ...page,
            retrieve: () => Promise.reject(new Error("fixture unavailable")),
          }
        : page,
    );
    try {
      const intelligence = openProgrammeIntelligence({
        storageDirectory: directory,
        sourceAdapters: createWordfenceProgrammeAdapters({ pages }),
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
          programmeIdentity: "programme:wordfence",
        }),
      ).resolves.toMatchObject({
        status: "stale",
        reason: "refresh-failed",
        requiredSources: sources.map((source, index) => ({
          sourceId: `programme:wordfence:0${index + 1}-${source.sourceKind}`,
          sourceUrl: source.sourceUrl,
          parserVersion: `wordfence-${source.sourceKind}-v2`,
        })),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects Oracle records in required scope sources", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wordfence-drift-"));
    const pages = fixturePageAdapters().map((page) =>
      page.sourceKind === "report-form"
        ? {
            ...page,
            parse: async (bytes: Uint8Array) => {
              const document = JSON.parse(
                Buffer.from(bytes).toString("utf8"),
              ) as { assertions: Record<string, unknown> };
              return {
                ...document,
                oracleRecords: [
                  {
                    namedPlugin: "private-fixture-plugin",
                    cve: "CVE-2099-9999",
                    affectedVersion: "1.2.3",
                    knownRoute: "must-not-cross-adapter",
                    researcherName: "fixture-person",
                  },
                ],
              };
            },
          }
        : page,
    );
    try {
      const intelligence = openProgrammeIntelligence({
        storageDirectory: directory,
        sourceAdapters: createWordfenceProgrammeAdapters({ pages }),
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
          programmeIdentity: "programme:wordfence",
        }),
      ).resolves.toMatchObject({
        status: "parse-failed",
        programmeIdentity: "programme:wordfence",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
