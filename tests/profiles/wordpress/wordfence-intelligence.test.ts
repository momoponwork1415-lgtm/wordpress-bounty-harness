import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import {
  createWordfenceIntelligenceV3FetchAdapter,
  knownRecordAccessAuthorizationSchema,
  openWordfenceIntelligence,
  wordfenceIntelligenceFailureSchema,
  type WordfenceIntelligenceV3Adapter,
} from "../../../src/profiles/wordpress/wordfence-intelligence/index.js";

const fixturePath = join(
  import.meta.dirname,
  "..",
  "..",
  "fixtures",
  "target-intelligence",
  "wordfence-intelligence-v3",
  "production.json",
);
const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const resultEnvelope = {
  kind: "wordfence-intelligence-result" as const,
  schemaVersion: 1 as const,
};

async function knownRecordAuthorization(
  verifiedVersion: string,
  canonicalFileManifestDigest = digest("c"),
): Promise<ReturnType<typeof knownRecordAccessAuthorizationSchema.parse>> {
  const fixture = JSON.parse(
    await readFile(
      join(
        import.meta.dirname,
        "..",
        "..",
        "fixtures",
        "target-intelligence",
        "wordfence-intelligence-v3",
        "known-record-authorizations.json",
      ),
      "utf8",
    ),
  ) as unknown;
  const authorization = knownRecordAccessAuthorizationSchema
    .array()
    .parse(fixture)
    .find(
      (candidate) =>
        candidate.subject.verifiedVersion === verifiedVersion &&
        candidate.subject.canonicalFileManifestDigest ===
          canonicalFileManifestDigest,
    );
  if (authorization === undefined) {
    throw new Error("Missing known-record authorization fixture");
  }
  return authorization;
}

function fixtureAdapter(): WordfenceIntelligenceV3Adapter {
  return {
    sourceUrl:
      "https://www.wordfence.com/api/intelligence/v3/vulnerabilities/production",
    retrieveProductionFeed: async () => ({
      status: 200,
      sourceUrl:
        "https://www.wordfence.com/api/intelligence/v3/vulnerabilities/production",
      complete: true,
      bytes: await readFile(fixturePath),
    }),
  };
}

describe("WordfenceIntelligence", () => {
  it("requires bounded backoff exactly for rate-limited failures", () => {
    const backoff = {
      kind: "wordfence-rate-limit-backoff",
      schemaVersion: 2,
      automaticRetries: 0,
      boundedAt: "2030-08-01T00:00:00.000Z",
      maximumDelaySeconds: 86_400,
      retryAfter: { kind: "unspecified" },
    } as const;
    expect(
      wordfenceIntelligenceFailureSchema.safeParse({
        ...resultEnvelope,
        status: "failed",
        reason: "rate-limited",
      }).success,
    ).toBe(false);
    expect(
      wordfenceIntelligenceFailureSchema.safeParse({
        ...resultEnvelope,
        status: "failed",
        reason: "network-failure",
        backoff,
      }).success,
    ).toBe(false);
    expect(
      wordfenceIntelligenceFailureSchema.parse({
        ...resultEnvelope,
        status: "failed",
        reason: "rate-limited",
        backoff,
      }),
    ).toEqual({
      ...resultEnvelope,
      status: "failed",
      reason: "rate-limited",
      backoff,
    });
  });

  it("atomically refreshes the v3 feed while separating selection aggregate from verified-Finding records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wordfence-intelligence-"));
    try {
      const authorization = await knownRecordAuthorization("1.2.0");
      const intelligence = openWordfenceIntelligence({
        databasePath: join(directory, "target-intelligence.sqlite"),
        artifactDirectory: join(directory, "artifacts"),
        adapter: fixtureAdapter(),
        credential: { kind: "secret-ref", id: "wordfence-v3-api-key" },
        knownRecordAuthorizationProvider: {
          resolve: async () => ({ status: "authorized", authorization }),
        },
        clock: () => new Date("2030-08-01T00:00:00.000Z"),
      });

      const refreshed = await intelligence.refresh({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      expect(refreshed).toMatchObject({
        status: "current",
        snapshot: {
          kind: "wordfence-intelligence-snapshot",
          schemaVersion: 1,
          retrievedAt: "2030-08-01T00:00:00.000Z",
          source: {
            sourceUrl:
              "https://www.wordfence.com/api/intelligence/v3/vulnerabilities/production",
            contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            parserVersion: "wordfence-intelligence-production-v3",
            recordCount: 2,
            complete: true,
          },
        },
        snapshotRef: {
          id: expect.stringMatching(/^wordfence-snapshot:/),
          digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      });
      if (refreshed.status !== "current") {
        throw new Error("Expected a current Wordfence snapshot");
      }

      const aggregate = await intelligence.aggregate({
        kind: "wordfence-vulnerability-history-aggregate",
        schemaVersion: 1,
        snapshotRef: refreshed.snapshotRef,
        pluginIdentity: "wporg:fixture-plugin",
      });
      expect(aggregate).toEqual({
        kind: "vulnerability-history-aggregate",
        schemaVersion: 1,
        pluginIdentity: "wporg:fixture-plugin",
        snapshotRef: refreshed.snapshotRef,
        recordCount: 2,
        disclosureDensity: {
          kind: "records-per-published-year",
          publishedYears: 2,
          value: 1,
        },
        lastPublishedAt: "2029-02-20T08:30:00.000Z",
      });
      expect(JSON.stringify(aggregate)).not.toMatch(
        /CVE-|cwe|cvss|affected|patched|route/i,
      );

      const known = await intelligence.inspectKnownRecords({
        kind: "wordfence-known-record-inspection",
        schemaVersion: 2,
        snapshotRef: refreshed.snapshotRef,
        pluginIdentity: "wporg:fixture-plugin",
        verifiedVersion: "1.2.0",
        canonicalFileManifestDigest: digest("c"),
        authorizationRef: {
          kind: "known-record-access-authorization-ref",
          schemaVersion: 2,
          id: authorization.id,
          digest: authorization.digest,
        },
      });
      expect(known).toMatchObject({
        kind: "wordfence-known-record-projection",
        schemaVersion: 2,
        pluginIdentity: "wporg:fixture-plugin",
        verifiedVersion: "1.2.0",
        canonicalFileManifestDigest: digest("c"),
        records: [
          {
            recordId: "11111111-1111-4111-8111-111111111111",
            cve: "CVE-2099-0001",
            affectedVersionIntervals: [
              {
                fromVersion: "1.0.0",
                fromInclusive: true,
                toVersion: "1.4.0",
                toInclusive: true,
              },
            ],
            patchedVersions: ["1.4.1"],
            cwe: { id: 79 },
            cvss: { score: 6.1 },
            attribution: {
              wordfence: {
                notice: "Sanitized Wordfence notice",
                license: "Sanitized Wordfence license",
              },
              mitre: {
                notice: "Sanitized MITRE notice",
                license: "Sanitized MITRE license",
              },
            },
          },
          {
            recordId: "22222222-2222-4222-8222-222222222222",
            affectedVersionIntervals: [
              {
                fromVersion: "*",
                toVersion: "2.0.0",
                toInclusive: false,
              },
            ],
            patchedVersions: ["2.0.0"],
          },
        ],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses one canonical Unicode ordering for manifest publication and replay", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-unicode-ordering-"),
    );
    const databasePath = join(directory, "target-intelligence.sqlite");
    const artifactDirectory = join(directory, "artifacts");
    const feed = JSON.parse(await readFile(fixturePath, "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    const first = feed["11111111-1111-4111-8111-111111111111"];
    const software = first?.software;
    const template = Array.isArray(software) ? software[0] : undefined;
    if (
      !Array.isArray(software) ||
      typeof template !== "object" ||
      template === null
    ) {
      throw new Error("Fixture lost its first software record");
    }
    software.push(
      {
        ...template,
        name: "Sanitized supplementary-plane extension",
        slug: "sanitized-\u{10000}",
      },
      {
        ...template,
        name: "Sanitized private-use extension",
        slug: "sanitized-\uE000",
      },
    );
    const bytes = Buffer.from(JSON.stringify(feed));
    const adapter: WordfenceIntelligenceV3Adapter = {
      sourceUrl: fixtureAdapter().sourceUrl,
      retrieveProductionFeed: async () => ({
        status: 200,
        sourceUrl: fixtureAdapter().sourceUrl,
        complete: true,
        bytes,
      }),
    };
    try {
      const original = openWordfenceIntelligence({
        databasePath,
        artifactDirectory,
        adapter,
        credential: { kind: "secret-ref", id: "wordfence-v3-api-key" },
      });
      const current = await original.refresh({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      if (current.status !== "current") {
        throw new Error("Expected a current snapshot");
      }
      const request = {
        kind: "wordfence-vulnerability-history-aggregate" as const,
        schemaVersion: 1 as const,
        snapshotRef: current.snapshotRef,
        pluginIdentity: "wporg:fixture-plugin" as const,
      };
      const expected = {
        kind: "vulnerability-history-aggregate",
        schemaVersion: 1,
        pluginIdentity: "wporg:fixture-plugin",
        snapshotRef: current.snapshotRef,
        recordCount: 2,
        disclosureDensity: {
          kind: "records-per-published-year",
          publishedYears: 2,
          value: 1,
        },
        lastPublishedAt: "2029-02-20T08:30:00.000Z",
      };
      await expect(original.aggregate(request)).resolves.toEqual(expected);

      const restarted = openWordfenceIntelligence({
        databasePath,
        artifactDirectory,
        adapter,
        credential: { kind: "secret-ref", id: "wordfence-v3-api-key" },
      });
      await expect(restarted.aggregate(request)).resolves.toEqual(expected);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refreshes and replays a current local CAS artifact stored with mode 0644", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-local-cas-upgrade-"),
    );
    const databasePath = join(directory, "target-intelligence.sqlite");
    const artifactDirectory = join(directory, "artifacts");
    let now = new Date("2030-08-01T00:00:00.000Z");
    const options = {
      databasePath,
      artifactDirectory,
      adapter: fixtureAdapter(),
      credential: {
        kind: "secret-ref" as const,
        id: "wordfence-v3-api-key" as const,
      },
      clock: () => now,
    };
    try {
      const original = openWordfenceIntelligence(options);
      const first = await original.refresh({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      if (first.status !== "current") {
        throw new Error("Expected an initial current snapshot");
      }
      const artifactPath = join(
        artifactDirectory,
        "wordfence-intelligence-v3",
        `${first.snapshot.source.contentDigest.slice(7)}.json`,
      );
      await chmod(artifactPath, 0o644);

      now = new Date("2030-08-02T00:00:00.000Z");
      const upgraded = openWordfenceIntelligence(options);
      const refreshed = await upgraded.refresh({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      expect(refreshed.status).toBe("current");
      expect((await lstat(artifactPath)).mode & 0o777).toBe(0o644);

      const replay = openWordfenceIntelligence(options);
      await expect(
        replay.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toEqual(refreshed);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "high", slug: "sanitized-\uD800" },
    { name: "low", slug: "sanitized-\uDC00" },
  ])(
    "rejects a lone $name surrogate in a software identifier",
    async ({ slug }) => {
      const directory = await mkdtemp(
        join(tmpdir(), "wordfence-malformed-unicode-"),
      );
      const feed = JSON.parse(await readFile(fixturePath, "utf8")) as Record<
        string,
        Record<string, unknown>
      >;
      const first = feed["11111111-1111-4111-8111-111111111111"];
      const software = first?.software;
      const entry = Array.isArray(software) ? software[0] : undefined;
      if (typeof entry !== "object" || entry === null) {
        throw new Error("Fixture lost its first software record");
      }
      entry.slug = slug;
      try {
        const base = fixtureAdapter();
        const intelligence = openWordfenceIntelligence({
          databasePath: join(directory, "target-intelligence.sqlite"),
          artifactDirectory: join(directory, "artifacts"),
          adapter: {
            ...base,
            retrieveProductionFeed: async () => ({
              status: 200,
              sourceUrl: base.sourceUrl,
              complete: true,
              bytes: Buffer.from(JSON.stringify(feed)),
            }),
          },
          credential: { kind: "secret-ref", id: "wordfence-v3-api-key" },
        });
        await expect(
          intelligence.refresh({
            kind: "wordfence-intelligence-refresh",
            schemaVersion: 1,
          }),
        ).resolves.toEqual({
          ...resultEnvelope,
          status: "failed",
          reason: "schema-drift",
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("publishes concurrent raw CAS writers without exposing a partial final artifact", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-concurrent-raw-cas-"),
    );
    const artifactDirectory = join(directory, "artifacts");
    const feed = JSON.parse(await readFile(fixturePath, "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    const first = feed["11111111-1111-4111-8111-111111111111"];
    if (first === undefined) {
      throw new Error("Fixture lost its first record");
    }
    first.description = "sanitized-large-content".repeat(750_000);
    const bytes = Buffer.from(JSON.stringify(feed));
    const adapter: WordfenceIntelligenceV3Adapter = {
      sourceUrl: fixtureAdapter().sourceUrl,
      retrieveProductionFeed: async () => ({
        status: 200,
        sourceUrl: fixtureAdapter().sourceUrl,
        complete: true,
        bytes,
      }),
    };
    const openWriter = (name: string) =>
      openWordfenceIntelligence({
        databasePath: join(directory, `${name}.sqlite`),
        artifactDirectory,
        adapter,
        credential: { kind: "secret-ref", id: "wordfence-v3-api-key" },
        clock: () => new Date("2030-08-01T00:00:00.000Z"),
      });
    try {
      const request = {
        kind: "wordfence-intelligence-refresh" as const,
        schemaVersion: 1 as const,
      };
      const [left, right] = await Promise.all([
        openWriter("left").refresh(request),
        openWriter("right").refresh(request),
      ]);
      expect(left.status).toBe("current");
      expect(right).toEqual(left);
      if (left.status !== "current") {
        throw new Error("Expected a current snapshot");
      }
      const rawDirectory = join(artifactDirectory, "wordfence-intelligence-v3");
      const artifactName = `${left.snapshot.source.contentDigest.slice(7)}.json`;
      expect(await readdir(rawDirectory)).toEqual([artifactName]);
      const persisted = await readFile(join(rawDirectory, artifactName));
      expect(persisted.byteLength).toBe(bytes.byteLength);
      expect(persisted.equals(bytes)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a partial final CAS artifact and cleans only its own temporary file", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-partial-raw-cas-"),
    );
    const artifactDirectory = join(directory, "artifacts");
    const rawDirectory = join(artifactDirectory, "wordfence-intelligence-v3");
    const bytes = await readFile(fixturePath);
    const artifactName = `${createHash("sha256").update(bytes).digest("hex")}.json`;
    const artifactPath = join(rawDirectory, artifactName);
    const unrelatedTemporaryName = `.${artifactName}.unowned.tmp`;
    const unrelatedTemporaryPath = join(rawDirectory, unrelatedTemporaryName);
    const partial = Buffer.from('{"partial":');
    const unrelated = Buffer.from("unrelated-owned-content");
    await mkdir(rawDirectory, { recursive: true });
    await writeFile(artifactPath, partial);
    await writeFile(unrelatedTemporaryPath, unrelated);
    try {
      const intelligence = openWordfenceIntelligence({
        databasePath: join(directory, "target-intelligence.sqlite"),
        artifactDirectory,
        adapter: fixtureAdapter(),
        credential: { kind: "secret-ref", id: "wordfence-v3-api-key" },
      });
      await expect(
        intelligence.refresh({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence artifact conflict");
      expect(await readFile(artifactPath)).toEqual(partial);
      expect(await readFile(unrelatedTemporaryPath)).toEqual(unrelated);
      expect((await readdir(rawDirectory)).sort()).toEqual(
        [artifactName, unrelatedTemporaryName].sort(),
      );
      await expect(
        intelligence.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toEqual({
        ...resultEnvelope,
        status: "failed",
        reason: "not-refreshed",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replays the current snapshot after restart without retrieving the feed again", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wordfence-replay-"));
    const databasePath = join(directory, "target-intelligence.sqlite");
    const artifactDirectory = join(directory, "artifacts");
    try {
      const first = openWordfenceIntelligence({
        databasePath,
        artifactDirectory,
        adapter: fixtureAdapter(),
        credential: { kind: "secret-ref", id: "wordfence-v3-api-key" },
        clock: () => new Date("2030-08-01T00:00:00.000Z"),
      });
      const refreshed = await first.refresh({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      if (refreshed.status !== "current") {
        throw new Error("Expected a current snapshot");
      }
      const expectedAggregate = await first.aggregate({
        kind: "wordfence-vulnerability-history-aggregate",
        schemaVersion: 1,
        snapshotRef: refreshed.snapshotRef,
        pluginIdentity: "wporg:fixture-plugin",
      });

      const restarted = openWordfenceIntelligence({
        databasePath,
        artifactDirectory,
        adapter: {
          ...fixtureAdapter(),
          retrieveProductionFeed: () =>
            Promise.reject(new Error("must not retrieve during replay")),
        },
        credential: { kind: "secret-ref", id: "wordfence-v3-api-key" },
      });
      await expect(
        restarted.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toEqual(refreshed);
      await expect(
        restarted.aggregate({
          kind: "wordfence-vulnerability-history-aggregate",
          schemaVersion: 1,
          snapshotRef: refreshed.snapshotRef,
          pluginIdentity: "wporg:fixture-plugin",
        }),
      ).resolves.toEqual(expectedAggregate);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    "unmarked record-only",
    "marked record-only",
    "previous index version",
  ] as const)("rejects %s storage without changing it", async (format) => {
    const directory = await mkdtemp(join(tmpdir(), "wordfence-legacy-replay-"));
    const databasePath = join(directory, "target-intelligence.sqlite");
    const artifactDirectory = join(directory, "artifacts");
    try {
      const authorization = await knownRecordAuthorization("1.2.0");
      const authorizationProvider = {
        resolve: async () => ({
          status: "authorized" as const,
          authorization,
        }),
      };
      const original = openWordfenceIntelligence({
        databasePath,
        artifactDirectory,
        adapter: fixtureAdapter(),
        credential: { kind: "secret-ref", id: "wordfence-v3-api-key" },
        knownRecordAuthorizationProvider: authorizationProvider,
        clock: () => new Date("2030-08-01T00:00:00.000Z"),
      });
      const current = await original.refresh({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      if (current.status !== "current") {
        throw new Error("Expected a current snapshot");
      }
      const aggregateRequest = {
        kind: "wordfence-vulnerability-history-aggregate" as const,
        schemaVersion: 1 as const,
        snapshotRef: current.snapshotRef,
        pluginIdentity: "wporg:fixture-plugin" as const,
      };
      const exactRequest = {
        kind: "wordfence-known-record-inspection" as const,
        schemaVersion: 2 as const,
        snapshotRef: current.snapshotRef,
        pluginIdentity: "wporg:fixture-plugin" as const,
        verifiedVersion: "1.2.0",
        canonicalFileManifestDigest: digest("c"),
        authorizationRef: {
          kind: "known-record-access-authorization-ref" as const,
          schemaVersion: 2 as const,
          id: authorization.id,
          digest: authorization.digest,
        },
      };

      const legacyMigration = new Database(databasePath);
      if (format === "previous index version") {
        legacyMigration.exec(`
          CREATE TABLE IF NOT EXISTS wordfence_intelligence_legacy_record_sets
            (snapshot_digest TEXT PRIMARY KEY, legacy_json TEXT NOT NULL) STRICT;
          UPDATE wordfence_intelligence_index_metadata SET schema_version = 1;
        `);
      } else {
        legacyMigration.exec(`
          UPDATE wordfence_intelligence_records
             SET record_json = json_extract(record_json, '$.record');
          DROP TABLE wordfence_intelligence_record_set_manifests;
          DROP TABLE IF EXISTS wordfence_intelligence_legacy_record_sets;
          DROP TABLE wordfence_intelligence_index_metadata;
        `);
        if (format === "marked record-only") {
          legacyMigration.exec(`
            CREATE TABLE wordfence_intelligence_record_set_manifests
              (snapshot_digest TEXT PRIMARY KEY, manifest_json TEXT NOT NULL) STRICT;
            CREATE TABLE wordfence_intelligence_legacy_record_sets
              (snapshot_digest TEXT PRIMARY KEY, legacy_json TEXT NOT NULL) STRICT;
            CREATE TABLE wordfence_intelligence_index_metadata
              (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version INTEGER NOT NULL) STRICT;
            INSERT INTO wordfence_intelligence_index_metadata VALUES (1, 1);
          `);
          legacyMigration
            .prepare(
              `INSERT INTO wordfence_intelligence_legacy_record_sets VALUES (?, ?)`,
            )
            .run(
              current.snapshotRef.digest,
              JSON.stringify({
                kind: "wordfence-intelligence-legacy-record-set",
                schemaVersion: 1,
                snapshotDigest: current.snapshotRef.digest,
                snapshotSchemaVersion: 1,
                parserVersion: "wordfence-intelligence-production-v3",
                recordFormat: "record-only-v1",
                integrity: "unbound-read-only",
              }),
            );
        }
      }
      const before = legacyMigration.serialize();
      legacyMigration.close();

      const retrieve = vi.fn(fixtureAdapter().retrieveProductionFeed);
      const restarted = openWordfenceIntelligence({
        databasePath,
        artifactDirectory,
        adapter: { ...fixtureAdapter(), retrieveProductionFeed: retrieve },
        credential: { kind: "secret-ref", id: "wordfence-v3-api-key" },
        knownRecordAuthorizationProvider: authorizationProvider,
        clock: () => new Date("2030-08-01T00:00:00.000Z"),
      });
      await expect(
        restarted.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
      await expect(restarted.aggregate(aggregateRequest)).rejects.toThrow(
        "Wordfence Intelligence snapshot conflict",
      );
      await expect(restarted.inspectKnownRecords(exactRequest)).rejects.toThrow(
        "Wordfence Intelligence snapshot conflict",
      );
      await expect(
        restarted.refresh({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
      expect(retrieve).not.toHaveBeenCalled();
      const after = new Database(databasePath, { readonly: true });
      try {
        expect(after.serialize()).toEqual(before);
      } finally {
        after.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["missing", "tampered"] as const)(
    "rejects re-publication when persisted snapshot records are %s",
    async (caseName) => {
      const directory = await mkdtemp(
        join(tmpdir(), "wordfence-record-integrity-"),
      );
      const databasePath = join(directory, "target-intelligence.sqlite");
      const artifactDirectory = join(directory, "artifacts");
      try {
        const historical = openWordfenceIntelligence({
          databasePath,
          artifactDirectory,
          adapter: fixtureAdapter(),
          credential: { kind: "secret-ref", id: "wordfence-v3-api-key" },
          clock: () => new Date("2030-08-01T00:00:00.000Z"),
        });
        const historicalResult = await historical.refresh({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        });
        if (historicalResult.status !== "current") {
          throw new Error("Expected a historical snapshot");
        }
        const latest = openWordfenceIntelligence({
          databasePath,
          artifactDirectory,
          adapter: fixtureAdapter(),
          credential: { kind: "secret-ref", id: "wordfence-v3-api-key" },
          clock: () => new Date("2030-08-02T00:00:00.000Z"),
        });
        const latestResult = await latest.refresh({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        });
        if (latestResult.status !== "current") {
          throw new Error("Expected a latest snapshot");
        }

        const corruption = new Database(databasePath);
        if (caseName === "missing") {
          corruption
            .prepare(
              `DELETE FROM wordfence_intelligence_records
               WHERE snapshot_digest = ?`,
            )
            .run(historicalResult.snapshotRef.digest);
        } else {
          corruption
            .prepare(
              `UPDATE wordfence_intelligence_records
                  SET record_json = '{}'
                WHERE snapshot_digest = ?`,
            )
            .run(historicalResult.snapshotRef.digest);
        }
        corruption.close();

        const replay = openWordfenceIntelligence({
          databasePath,
          artifactDirectory,
          adapter: fixtureAdapter(),
          credential: { kind: "secret-ref", id: "wordfence-v3-api-key" },
          clock: () => new Date("2030-08-01T00:00:00.000Z"),
        });
        await expect(
          replay.refresh({
            kind: "wordfence-intelligence-refresh",
            schemaVersion: 1,
          }),
        ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
        await expect(
          replay.inspect({
            kind: "wordfence-intelligence-inspection",
            schemaVersion: 1,
          }),
        ).resolves.toEqual(latestResult);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["missing", "substituted", "extra"] as const)(
    "rejects %s record-set corruption before aggregate and exact projection",
    async (caseName) => {
      const directory = await mkdtemp(
        join(tmpdir(), "wordfence-projection-integrity-"),
      );
      const databasePath = join(directory, "target-intelligence.sqlite");
      try {
        const authorization = await knownRecordAuthorization("1.2.0");
        const intelligence = openWordfenceIntelligence({
          databasePath,
          artifactDirectory: join(directory, "artifacts"),
          adapter: fixtureAdapter(),
          credential: { kind: "secret-ref", id: "wordfence-v3-api-key" },
          knownRecordAuthorizationProvider: {
            resolve: async () => ({ status: "authorized", authorization }),
          },
          clock: () => new Date("2030-08-01T00:00:00.000Z"),
        });
        const current = await intelligence.refresh({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        });
        if (current.status !== "current") {
          throw new Error("Expected a current snapshot");
        }

        const corruption = new Database(databasePath);
        if (caseName === "missing") {
          corruption
            .prepare(
              `DELETE FROM wordfence_intelligence_records
               WHERE rowid = (
                 SELECT rowid
                   FROM wordfence_intelligence_records
                  WHERE snapshot_digest = ?
                  ORDER BY plugin_slug, record_id
                  LIMIT 1
               )`,
            )
            .run(current.snapshotRef.digest);
        } else if (caseName === "substituted") {
          corruption
            .prepare(
              `UPDATE wordfence_intelligence_records
                  SET record_json = (
                    SELECT record_json
                      FROM wordfence_intelligence_records
                     WHERE snapshot_digest = ?
                     ORDER BY plugin_slug DESC, record_id DESC
                     LIMIT 1
                  )
                WHERE rowid = (
                  SELECT rowid
                    FROM wordfence_intelligence_records
                   WHERE snapshot_digest = ?
                   ORDER BY plugin_slug, record_id
                   LIMIT 1
                )`,
            )
            .run(current.snapshotRef.digest, current.snapshotRef.digest);
        } else {
          corruption
            .prepare(
              `INSERT INTO wordfence_intelligence_records (
                 snapshot_digest, plugin_slug, record_id, record_json
               )
               SELECT snapshot_digest, ?, ?, record_json
                 FROM wordfence_intelligence_records
                WHERE snapshot_digest = ?
                ORDER BY plugin_slug, record_id
                LIMIT 1`,
            )
            .run(
              "extra-plugin",
              "33333333-3333-4333-8333-333333333333",
              current.snapshotRef.digest,
            );
        }
        corruption.close();

        await expect(
          intelligence.aggregate({
            kind: "wordfence-vulnerability-history-aggregate",
            schemaVersion: 1,
            snapshotRef: current.snapshotRef,
            pluginIdentity: "wporg:fixture-plugin",
          }),
        ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
        await expect(
          intelligence.inspectKnownRecords({
            kind: "wordfence-known-record-inspection",
            schemaVersion: 2,
            snapshotRef: current.snapshotRef,
            pluginIdentity: "wporg:fixture-plugin",
            verifiedVersion: "1.2.0",
            canonicalFileManifestDigest: digest("c"),
            authorizationRef: {
              kind: "known-record-access-authorization-ref",
              schemaVersion: 2,
              id: authorization.id,
              digest: authorization.digest,
            },
          }),
        ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("keeps the prior current pointer when a later feed fails validation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wordfence-atomic-"));
    let bytes = await readFile(fixturePath);
    const adapter: WordfenceIntelligenceV3Adapter = {
      sourceUrl: fixtureAdapter().sourceUrl,
      retrieveProductionFeed: async () => ({
        status: 200,
        sourceUrl: fixtureAdapter().sourceUrl,
        complete: true,
        bytes,
      }),
    };
    try {
      const intelligence = openWordfenceIntelligence({
        databasePath: join(directory, "target-intelligence.sqlite"),
        artifactDirectory: join(directory, "artifacts"),
        adapter,
        credential: { kind: "secret-ref", id: "wordfence-v3-api-key" },
        clock: () => new Date("2030-08-01T00:00:00.000Z"),
      });
      const current = await intelligence.refresh({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      if (current.status !== "current") {
        throw new Error("Expected the valid fixture to become current");
      }
      bytes = Buffer.from('{"not-a-uuid":{"id":"schema drift"}}');

      await expect(
        intelligence.refresh({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).resolves.toEqual({
        ...resultEnvelope,
        status: "failed",
        reason: "schema-drift",
      });
      await expect(
        intelligence.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toEqual(current);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      status: 401,
      complete: true,
      reason: "authentication-failed",
      source: "expected",
    },
    {
      status: 403,
      complete: true,
      reason: "authentication-failed",
      source: "expected",
    },
    {
      status: 404,
      complete: true,
      reason: "not-found",
      source: "expected",
    },
    {
      status: 429,
      complete: true,
      reason: "rate-limited",
      source: "expected",
    },
    {
      status: 503,
      complete: true,
      reason: "network-failure",
      source: "expected",
    },
    {
      status: 200,
      complete: false,
      reason: "partial-response",
      source: "expected",
    },
    {
      status: 200,
      complete: true,
      reason: "response-byte-ceiling-exceeded",
      source: "expected",
      maximumFeedBytes: 1,
    },
    {
      status: 200,
      complete: true,
      reason: "source-mismatch",
      source: "mismatch",
    },
  ] as const)(
    "returns $reason without publishing an invalid current snapshot",
    async ({ status, complete, reason, source, ...configuration }) => {
      const directory = await mkdtemp(join(tmpdir(), "wordfence-failure-"));
      try {
        const base = fixtureAdapter();
        const intelligence = openWordfenceIntelligence({
          databasePath: join(directory, "target-intelligence.sqlite"),
          artifactDirectory: join(directory, "artifacts"),
          adapter: {
            ...base,
            retrieveProductionFeed: async () => ({
              status,
              sourceUrl:
                source === "expected"
                  ? base.sourceUrl
                  : "https://example.invalid/untrusted-redirect",
              complete,
              bytes: await readFile(fixturePath),
            }),
          },
          credential: { kind: "secret-ref", id: "wordfence-v3-api-key" },
          clock: () => new Date("2030-08-01T00:00:00.000Z"),
          ...configuration,
        });
        await expect(
          intelligence.refresh({
            kind: "wordfence-intelligence-refresh",
            schemaVersion: 1,
          }),
        ).resolves.toEqual({
          ...resultEnvelope,
          status: "failed",
          reason,
          ...(reason === "rate-limited"
            ? {
                backoff: {
                  kind: "wordfence-rate-limit-backoff",
                  schemaVersion: 2,
                  automaticRetries: 0,
                  boundedAt: "2030-08-01T00:00:00.000Z",
                  maximumDelaySeconds: 86_400,
                  retryAfter: { kind: "unspecified" },
                },
              }
            : {}),
        });
        await expect(
          intelligence.inspect({
            kind: "wordfence-intelligence-inspection",
            schemaVersion: 1,
          }),
        ).resolves.toEqual({
          ...resultEnvelope,
          status: "failed",
          reason: "not-refreshed",
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects missing copyright metadata separately from schema drift", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wordfence-license-"));
    const feed = JSON.parse(await readFile(fixturePath, "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    const first = feed["11111111-1111-4111-8111-111111111111"];
    if (first === undefined) {
      throw new Error("Fixture lost its first record");
    }
    delete first.copyrights;
    try {
      const base = fixtureAdapter();
      const intelligence = openWordfenceIntelligence({
        databasePath: join(directory, "target-intelligence.sqlite"),
        artifactDirectory: join(directory, "artifacts"),
        adapter: {
          ...base,
          retrieveProductionFeed: async () => ({
            status: 200,
            sourceUrl: base.sourceUrl,
            complete: true,
            bytes: Buffer.from(JSON.stringify(feed)),
          }),
        },
        credential: { kind: "secret-ref", id: "wordfence-v3-api-key" },
      });
      await expect(
        intelligence.refresh({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).resolves.toEqual({
        ...resultEnvelope,
        status: "failed",
        reason: "attribution-missing",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires verified-Finding authorization and applies affected-version interval boundaries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wordfence-interval-"));
    try {
      const authorizations = await Promise.all(
        ["1.4.1", "2.0.0", "2.0"].map((version) =>
          knownRecordAuthorization(version),
        ),
      );
      const authorization = authorizations[0];
      if (authorization === undefined) {
        throw new Error("Expected a known-record authorization fixture");
      }
      const intelligence = openWordfenceIntelligence({
        databasePath: join(directory, "target-intelligence.sqlite"),
        artifactDirectory: join(directory, "artifacts"),
        adapter: fixtureAdapter(),
        credential: { kind: "secret-ref", id: "wordfence-v3-api-key" },
        knownRecordAuthorizationProvider: {
          resolve: async (ref) => {
            const matched = authorizations.find(
              (candidate) =>
                candidate.id === ref.id && candidate.digest === ref.digest,
            );
            return matched === undefined
              ? { status: "denied" as const }
              : { status: "authorized" as const, authorization: matched };
          },
        },
      });
      const refreshed = await intelligence.refresh({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      if (refreshed.status !== "current") {
        throw new Error("Expected a current snapshot");
      }
      const base = {
        kind: "wordfence-known-record-inspection" as const,
        schemaVersion: 2 as const,
        snapshotRef: refreshed.snapshotRef,
        pluginIdentity: "wporg:fixture-plugin",
        canonicalFileManifestDigest: digest("c"),
        authorizationRef: {
          kind: "known-record-access-authorization-ref" as const,
          schemaVersion: 2 as const,
          id: authorization.id,
          digest: authorization.digest,
        },
      };
      await expect(
        intelligence.inspectKnownRecords({
          ...base,
          verifiedVersion: "1.4.1",
        }),
      ).resolves.toMatchObject({
        verifiedFindingRef: authorization.verifiedFindingRef,
        authorizationRef: base.authorizationRef,
        records: [{ recordId: "22222222-2222-4222-8222-222222222222" }],
      });
      await expect(
        intelligence.inspectKnownRecords({
          ...base,
          verifiedVersion: "2.0.0",
          authorizationRef: {
            ...base.authorizationRef,
            id: authorizations[1]?.id ?? "missing",
            digest: authorizations[1]?.digest ?? digest("0"),
          },
        }),
      ).resolves.toMatchObject({ records: [] });
      await expect(
        intelligence.inspectKnownRecords({
          ...base,
          verifiedVersion: "2.0",
          authorizationRef: {
            ...base.authorizationRef,
            id: authorizations[2]?.id ?? "missing",
            digest: authorizations[2]?.digest ?? digest("0"),
          },
        }),
      ).resolves.toMatchObject({ records: [] });

      const selfAssertedFinding = {
        ...base,
        verifiedVersion: "1.2.0",
      } as Record<string, unknown>;
      delete selfAssertedFinding.authorizationRef;
      selfAssertedFinding.verifiedFindingRef = {
        id: "verified-finding:self-asserted",
        digest: digest("a"),
      };
      selfAssertedFinding.purpose = "known-duplicate-disposition";
      await expect(
        Reflect.apply(intelligence.inspectKnownRecords, intelligence, [
          selfAssertedFinding,
        ]),
      ).rejects.toMatchObject({ code: "known-record-access-denied" });

      await expect(
        intelligence.inspectKnownRecords({
          ...base,
          canonicalFileManifestDigest: digest("9"),
          verifiedVersion: "1.4.1",
        }),
      ).rejects.toMatchObject({ code: "known-record-access-denied" });

      await expect(
        intelligence.inspectKnownRecords({
          ...base,
          authorizationRef: {
            ...base.authorizationRef,
            id: "known-record-access:unknown",
          },
          verifiedVersion: "1.4.1",
        }),
      ).rejects.toMatchObject({ code: "known-record-access-denied" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resolves the Bearer credential only inside the production Adapter", async () => {
    const bytes = await readFile(fixturePath);
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(new Response(bytes, { status: 200 }));
    const adapter = createWordfenceIntelligenceV3FetchAdapter({
      credentialResolver: () => "test-only-secret",
      fetch: fetchMock,
    });
    const response = await adapter.retrieveProductionFeed({
      credential: { kind: "secret-ref", id: "wordfence-v3-api-key" },
      maximumBytes: 1_000_000,
    });

    expect(response).toMatchObject({ status: 200, complete: true });
    expect(JSON.stringify(response)).not.toContain("test-only-secret");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.wordfence.com/api/intelligence/v3/vulnerabilities/production",
      expect.objectContaining({
        headers: {
          accept: "application/json",
          authorization: "Bearer test-only-secret",
        },
      }),
    );
  });
});
