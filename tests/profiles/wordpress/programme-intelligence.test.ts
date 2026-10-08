import { readFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalJsonPreservingProperties as canonicalJson,
  canonicalDigestPreservingProperties as sha256Digest,
} from "../../../src/infrastructure/canonical-json.js";
import {
  openProgrammeIntelligence,
  type ProgrammePolicySourceAdapter,
} from "../../../src/profiles/wordpress/programme-intelligence/index.js";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const fixtureDirectory = join(
  import.meta.dirname,
  "..",
  "..",
  "fixtures",
  "target-intelligence",
  "programme-eligibility",
);

const programmes = [
  {
    name: "Patchstack",
    identity: "programme:patchstack",
    fixture: "patchstack.json",
    sourceUrl: "https://fixtures.invalid/patchstack/policy",
    parserVersion: "patchstack-sanitized-fixture-v1",
    contentDigest:
      "sha256:d5219dd29aead1da3ee56db27dd87810288a428ac79d68d27afca5d2d54b76eb",
    opportunityBand: "broad",
  },
  {
    name: "Wordfence",
    identity: "programme:wordfence",
    fixture: "wordfence.json",
    sourceUrl: "https://fixtures.invalid/wordfence/policy",
    parserVersion: "wordfence-sanitized-fixture-v1",
    contentDigest:
      "sha256:595274a8eba837c3965d982c42932f85a78e31aa6b18b8ec0cf103384bc6fae9",
    opportunityBand: "high-impact-only",
  },
] as const;

function fixtureAdapter(
  programme: (typeof programmes)[number],
): ProgrammePolicySourceAdapter {
  return {
    sourceId: `${programme.identity}:eligibility-policy`,
    programmeIdentity: programme.identity,
    sourceUrl: programme.sourceUrl,
    parserVersion: programme.parserVersion,
    retrieve: () => readFile(join(fixtureDirectory, programme.fixture)),
    parse: (bytes) => JSON.parse(Buffer.from(bytes).toString("utf8")),
  };
}

describe("ProgrammeIntelligence", () => {
  it.each(["old-version", "removed-fields"])(
    "rejects %s storage without rewriting its artifact",
    async (unsupported) => {
      const directory = await mkdtemp(join(tmpdir(), "programme-format-"));
      try {
        const programme = programmes[0];
        const policy = JSON.parse(
          await readFile(join(fixtureDirectory, programme.fixture), "utf8"),
        ) as Record<string, unknown>;
        delete policy.programmeIdentity;
        const freshnessPolicy = {
          kind: "programme-eligibility-freshness-policy" as const,
          schemaVersion: 1 as const,
          id: "programme-freshness-v1",
          digest: digest("f"),
          maximumAgeMs: {
            targetSelectionBatch: 86_400_000,
            submissionStaging: 3_600_000,
          },
        };
        const snapshot = {
          kind: "programme-eligibility-snapshot",
          schemaVersion: unsupported === "old-version" ? 1 : 2,
          programmeIdentity: programme.identity,
          retrievedAt: "2030-07-01T00:00:00.000Z",
          sources: [
            {
              sourceId: `${programme.identity}:eligibility-policy`,
              sourceUrl: programme.sourceUrl,
              parserVersion: programme.parserVersion,
              retrievedAt: "2030-07-01T00:00:00.000Z",
              contentDigest: programme.contentDigest,
            },
          ],
          policy: {
            ...policy,
            ...(unsupported === "removed-fields"
              ? {
                  rewardEstimateInput: {
                    kind: "finding-only-reward-estimate-input",
                    currency: "USD",
                    factors: ["fixture-factor"],
                  },
                }
              : {}),
          },
          freshnessPolicy,
        };
        const snapshotDigest = sha256Digest(snapshot);
        const path = join(
          directory,
          "programme-snapshots",
          `${snapshotDigest.slice(7)}.json`,
        );
        const bytes = canonicalJson(snapshot);
        await mkdir(join(directory, "programme-snapshots"));
        await writeFile(path, bytes);
        const intelligence = openProgrammeIntelligence({
          storageDirectory: directory,
          sourceAdapters: [],
          freshnessPolicy,
          clock: () => new Date("2030-07-01T00:00:00.000Z"),
        });
        await expect(
          intelligence.inspect({
            kind: "programme-eligibility-inspection",
            schemaVersion: 1,
            snapshotRef: {
              kind: "programme-eligibility-snapshot-ref",
              schemaVersion: 1,
              id: `programme-snapshot:${snapshotDigest.slice(7, 31)}`,
              digest: snapshotDigest,
            },
            requiredFor: "target-selection-batch",
          }),
        ).rejects.toMatchObject({ name: "ZodError" });
        await expect(readFile(path, "utf8")).resolves.toBe(bytes);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(programmes)(
    "normalizes the $name fixture into the common eligibility contract",
    async (programme) => {
      const directory = await mkdtemp(
        join(tmpdir(), "programme-intelligence-"),
      );
      try {
        const intelligence = openProgrammeIntelligence({
          storageDirectory: directory,
          sourceAdapters: [fixtureAdapter(programme)],
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
          clock: () => new Date("2030-07-01T00:00:00.000Z"),
        });
        const request = {
          kind: "programme-intelligence-refresh" as const,
          schemaVersion: 1 as const,
          programmeIdentity: programme.identity,
        };

        const refreshed = await intelligence.refresh(request);
        expect(refreshed).toMatchObject({
          status: "current",
          snapshot: {
            kind: "programme-eligibility-snapshot",
            schemaVersion: 2,
            programmeIdentity: programme.identity,
            retrievedAt: "2030-07-01T00:00:00.000Z",
            sources: [
              {
                sourceId: `${programme.identity}:eligibility-policy`,
                sourceUrl: programme.sourceUrl,
                retrievedAt: "2030-07-01T00:00:00.000Z",
                contentDigest: programme.contentDigest,
                parserVersion: programme.parserVersion,
              },
            ],
            policy: {
              eligibility: {
                assets: expect.any(Array),
                vulnerabilityClasses: expect.any(Array),
                attackerRoles: expect.any(Array),
                activeInstallThreshold: expect.any(Object),
                researcherTiers: expect.any(Array),
                exclusions: expect.any(Array),
              },
              programmeOpportunityBand: programme.opportunityBand,
            },
          },
          snapshotRef: {
            kind: "programme-eligibility-snapshot-ref",
            schemaVersion: 1,
            id: expect.stringMatching(/^programme-snapshot:/),
            digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          },
        });
        if (refreshed.status !== "current") {
          throw new Error("Expected a current Programme Eligibility Snapshot");
        }

        await expect(intelligence.refresh(request)).resolves.toEqual(refreshed);
        for (const requiredFor of [
          "target-selection-batch",
          "submission-staging",
        ] as const) {
          await expect(
            intelligence.inspect({
              kind: "programme-eligibility-inspection",
              schemaVersion: 1,
              snapshotRef: refreshed.snapshotRef,
              requiredFor,
            }),
          ).resolves.toEqual(refreshed);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("returns policy-conflict when required sources disagree", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "programme-intelligence-conflict-"),
    );
    try {
      const programme = programmes[0];
      const primary = fixtureAdapter(programme);
      const conflicting: ProgrammePolicySourceAdapter = {
        ...primary,
        sourceId: "programme:patchstack:programme-directory",
        sourceUrl: "https://fixtures.invalid/patchstack/directory",
        retrieve: () =>
          readFile(join(fixtureDirectory, "patchstack-conflict.json")),
      };
      const intelligence = openProgrammeIntelligence({
        storageDirectory: directory,
        sourceAdapters: [primary, conflicting],
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
        clock: () => new Date("2030-07-01T00:00:00.000Z"),
      });

      await expect(
        intelligence.refresh({
          kind: "programme-intelligence-refresh",
          schemaVersion: 1,
          programmeIdentity: programme.identity,
        }),
      ).resolves.toMatchObject({
        status: "policy-conflict",
        programmeIdentity: programme.identity,
        sources: [
          {
            sourceId: "programme:patchstack:eligibility-policy",
            sourceUrl: programme.sourceUrl,
          },
          {
            sourceId: "programme:patchstack:programme-directory",
            sourceUrl: "https://fixtures.invalid/patchstack/directory",
          },
        ],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns parse-failed when a required policy field is missing", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "programme-intelligence-parse-"),
    );
    try {
      const programme = programmes[0];
      const incomplete: ProgrammePolicySourceAdapter = {
        ...fixtureAdapter(programme),
        retrieve: () =>
          readFile(join(fixtureDirectory, "patchstack-missing-field.json")),
      };
      const intelligence = openProgrammeIntelligence({
        storageDirectory: directory,
        sourceAdapters: [incomplete],
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
        clock: () => new Date("2030-07-01T00:00:00.000Z"),
      });

      await expect(
        intelligence.refresh({
          kind: "programme-intelligence-refresh",
          schemaVersion: 1,
          programmeIdentity: programme.identity,
        }),
      ).resolves.toMatchObject({
        status: "parse-failed",
        programmeIdentity: programme.identity,
        source: {
          sourceId: "programme:patchstack:eligibility-policy",
          sourceUrl: programme.sourceUrl,
          retrievedAt: "2030-07-01T00:00:00.000Z",
          contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          parserVersion: programme.parserVersion,
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects technical-validity claims and Oracle Facts from normalized policy", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "programme-intelligence-oracle-"),
    );
    try {
      const programme = programmes[0];
      const tainted: ProgrammePolicySourceAdapter = {
        ...fixtureAdapter(programme),
        retrieve: () =>
          readFile(join(fixtureDirectory, "patchstack-oracle-tainted.json")),
      };
      const intelligence = openProgrammeIntelligence({
        storageDirectory: directory,
        sourceAdapters: [tainted],
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
        clock: () => new Date("2030-07-01T00:00:00.000Z"),
      });

      await expect(
        intelligence.refresh({
          kind: "programme-intelligence-refresh",
          schemaVersion: 1,
          programmeIdentity: programme.identity,
        }),
      ).resolves.toMatchObject({
        status: "parse-failed",
        programmeIdentity: programme.identity,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns stale when a required source refresh fails", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "programme-intelligence-refresh-failure-"),
    );
    try {
      const programme = programmes[1];
      const unavailable: ProgrammePolicySourceAdapter = {
        ...fixtureAdapter(programme),
        retrieve: () => Promise.reject(new Error("fixture source unavailable")),
      };
      const intelligence = openProgrammeIntelligence({
        storageDirectory: directory,
        sourceAdapters: [unavailable],
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
        clock: () => new Date("2030-07-01T00:00:00.000Z"),
      });

      await expect(
        intelligence.refresh({
          kind: "programme-intelligence-refresh",
          schemaVersion: 1,
          programmeIdentity: programme.identity,
        }),
      ).resolves.toEqual({
        status: "stale",
        programmeIdentity: programme.identity,
        reason: "refresh-failed",
        requiredSources: [
          {
            sourceId: "programme:wordfence:eligibility-policy",
            sourceUrl: programme.sourceUrl,
            parserVersion: programme.parserVersion,
          },
        ],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires refresh at both freshness gates without treating stale policy as current", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "programme-intelligence-freshness-"),
    );
    let currentTime = "2030-07-01T00:00:00.000Z";
    try {
      const programme = programmes[0];
      const intelligence = openProgrammeIntelligence({
        storageDirectory: directory,
        sourceAdapters: [fixtureAdapter(programme)],
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
        clock: () => new Date(currentTime),
      });
      const refreshed = await intelligence.refresh({
        kind: "programme-intelligence-refresh",
        schemaVersion: 1,
        programmeIdentity: programme.identity,
      });
      if (refreshed.status !== "current") {
        throw new Error("Expected a current Programme Eligibility Snapshot");
      }

      currentTime = "2030-07-01T02:00:00.000Z";
      await expect(
        intelligence.inspect({
          kind: "programme-eligibility-inspection",
          schemaVersion: 1,
          snapshotRef: refreshed.snapshotRef,
          requiredFor: "submission-staging",
        }),
      ).resolves.toEqual({
        status: "stale",
        programmeIdentity: programme.identity,
        reason: "snapshot-expired",
        requiredFor: "submission-staging",
        snapshotRef: refreshed.snapshotRef,
        retrievedAt: "2030-07-01T00:00:00.000Z",
        maximumAgeMs: 3_600_000,
        refreshRequired: true,
      });

      currentTime = "2030-07-02T01:00:00.000Z";
      await expect(
        intelligence.inspect({
          kind: "programme-eligibility-inspection",
          schemaVersion: 1,
          snapshotRef: refreshed.snapshotRef,
          requiredFor: "target-selection-batch",
        }),
      ).resolves.toEqual({
        status: "stale",
        programmeIdentity: programme.identity,
        reason: "snapshot-expired",
        requiredFor: "target-selection-batch",
        snapshotRef: refreshed.snapshotRef,
        retrievedAt: "2030-07-01T00:00:00.000Z",
        maximumAgeMs: 86_400_000,
        refreshRequired: true,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
