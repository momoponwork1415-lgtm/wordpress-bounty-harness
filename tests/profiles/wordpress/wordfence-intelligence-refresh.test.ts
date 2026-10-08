import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  mkdtemp,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

const filesystemFault = vi.hoisted<{
  afterDatabaseCreate: (() => Promise<void>) | undefined;
  afterArtifactRead: (() => Promise<void>) | undefined;
  artifactCloseFailuresRemaining: number;
  artifactCloseName: string | undefined;
  artifactReadName: string | undefined;
  directoryCloseFailuresRemaining: number;
  directoryClosePath: string | undefined;
  directorySyncPath: string | undefined;
  databaseCreatePath: string | undefined;
}>(() => ({
  afterDatabaseCreate: undefined,
  afterArtifactRead: undefined,
  artifactCloseFailuresRemaining: 0,
  artifactCloseName: undefined,
  artifactReadName: undefined,
  directoryCloseFailuresRemaining: 0,
  directoryClosePath: undefined,
  directorySyncPath: undefined,
  databaseCreatePath: undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (String(args[0]) === filesystemFault.databaseCreatePath) {
        const afterDatabaseCreate = filesystemFault.afterDatabaseCreate;
        filesystemFault.afterDatabaseCreate = undefined;
        filesystemFault.databaseCreatePath = undefined;
        await afterDatabaseCreate?.();
      }
      if (
        filesystemFault.artifactReadName !== undefined &&
        String(args[0]).endsWith(`/${filesystemFault.artifactReadName}`)
      ) {
        const readFile = handle.readFile.bind(handle);
        Object.defineProperty(handle, "readFile", {
          configurable: true,
          value: async () => {
            const bytes = await readFile();
            const afterRead = filesystemFault.afterArtifactRead;
            filesystemFault.afterArtifactRead = undefined;
            filesystemFault.artifactReadName = undefined;
            await afterRead?.();
            return bytes;
          },
        });
      }
      if (
        filesystemFault.artifactCloseName !== undefined &&
        String(args[0]).endsWith(`/${filesystemFault.artifactCloseName}`)
      ) {
        const close = handle.close.bind(handle);
        Object.defineProperty(handle, "close", {
          configurable: true,
          value: async () => {
            await close();
            if (filesystemFault.artifactCloseFailuresRemaining > 0) {
              filesystemFault.artifactCloseFailuresRemaining -= 1;
              const error = new Error("synthetic artifact close failure");
              Object.defineProperty(error, "code", { value: "EIO" });
              throw error;
            }
          },
        });
      }
      if (String(args[0]) === filesystemFault.directorySyncPath) {
        Object.defineProperty(handle, "sync", {
          configurable: true,
          value: async () => {
            const error = new Error("synthetic directory sync failure");
            Object.defineProperty(error, "code", { value: "EIO" });
            throw error;
          },
        });
      }
      if (
        String(args[0]) === filesystemFault.directoryClosePath &&
        filesystemFault.directoryCloseFailuresRemaining > 0
      ) {
        filesystemFault.directoryCloseFailuresRemaining -= 1;
        const close = handle.close.bind(handle);
        Object.defineProperty(handle, "close", {
          configurable: true,
          value: async () => {
            await close();
            const error = new Error("synthetic directory close failure");
            Object.defineProperty(error, "code", { value: "EIO" });
            throw error;
          },
        });
      }
      return handle;
    },
  };
});

import {
  knownRecordAccessAuthorizationSchema,
  openWordfenceIntelligence,
  openSqliteHostPrivateCredentialBroker,
  openWordfenceIntelligenceRefresh,
  wordfenceIntelligenceResultSchema,
  wordfenceStoredPluginRecordSchema,
  type HostPrivateCredentialBroker,
  type WordfenceSecretRef,
} from "../../../src/profiles/wordpress/wordfence-intelligence/index.js";

const sourceUrl =
  "https://www.wordfence.com/api/intelligence/v3/vulnerabilities/production";
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

async function knownRecordAuthorization() {
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
        candidate.subject.verifiedVersion === "1.2.0" &&
        candidate.subject.canonicalFileManifestDigest === digest("c"),
    );
  if (authorization === undefined) {
    throw new Error("Missing sanitized known-record authorization fixture");
  }
  return authorization;
}

async function filesBelow(directory: string): Promise<readonly string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await filesBelow(path)));
    } else if (entry.isFile()) {
      paths.push(path);
    }
  }
  return paths;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((completion) => {
    resolve = completion;
  });
  return { promise, resolve };
}

function controlledFetch(): {
  readonly fetch: typeof fetch;
  readonly started: Promise<void>;
  readonly respond: (response: Response) => void;
} {
  const started = deferred<void>();
  const response = deferred<Response>();
  return {
    fetch: vi.fn<typeof fetch>(async () => {
      started.resolve();
      return response.promise;
    }),
    started: started.promise,
    respond: response.resolve,
  };
}

function canonicalFixtureJson(value: unknown): string {
  const canonical = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) {
      return candidate.map(canonical);
    }
    if (typeof candidate === "object" && candidate !== null) {
      return Object.fromEntries(
        Object.entries(candidate)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, item]) => [key, canonical(item)]),
      );
    }
    return candidate;
  };
  return JSON.stringify(canonical(value));
}

async function createFixedMainLegacyWordfenceStorage(
  databasePath: string,
  artifactDirectory: string,
) {
  const bytes = await readFile(fixturePath);
  const sourceDatabasePath = join(
    dirname(dirname(databasePath)),
    "fixed-main-source.sqlite",
  );
  const fixedMain = openWordfenceIntelligence({
    databasePath: sourceDatabasePath,
    artifactDirectory,
    adapter: {
      sourceUrl,
      async retrieveProductionFeed() {
        return {
          status: 200,
          sourceUrl,
          complete: true,
          bytes,
        };
      },
    },
    credential: { kind: "secret-ref", id: "wordfence-v3-api-key" },
    clock: () => new Date("2030-08-01T00:00:00.000Z"),
  });
  const current = await fixedMain.refresh({
    kind: "wordfence-intelligence-refresh",
    schemaVersion: 1,
  });
  if (current.status !== "current") {
    throw new Error("Expected the fixed-main fixture to publish a snapshot");
  }
  const source = new Database(sourceDatabasePath, {
    fileMustExist: true,
    readonly: true,
  });
  const sourceSnapshot = z.strictObject({ snapshot_json: z.string() }).parse(
    source
      .prepare(
        `SELECT snapshot_json
             FROM wordfence_intelligence_snapshots
            WHERE snapshot_digest = ?`,
      )
      .get(current.snapshotRef.digest),
  );
  const rows = z
    .strictObject({ record_json: z.string() })
    .array()
    .parse(
      source
        .prepare(
          `SELECT record_json
         FROM wordfence_intelligence_records
        WHERE snapshot_digest = ?
        ORDER BY plugin_slug, record_id`,
        )
        .all(current.snapshotRef.digest),
    );
  source.close();

  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.exec(`
    CREATE TABLE wordfence_intelligence_snapshots (
      snapshot_digest TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL UNIQUE,
      snapshot_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE wordfence_intelligence_records (
      snapshot_digest TEXT NOT NULL,
      plugin_slug TEXT NOT NULL,
      record_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (snapshot_digest, plugin_slug, record_id)
    ) STRICT;
    CREATE TABLE wordfence_intelligence_current (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      snapshot_digest TEXT NOT NULL
    ) STRICT;
  `);
  database
    .prepare(
      `INSERT INTO wordfence_intelligence_snapshots (
         snapshot_digest, snapshot_id, snapshot_json
       ) VALUES (?, ?, ?)`,
    )
    .run(
      current.snapshotRef.digest,
      current.snapshotRef.id,
      sourceSnapshot.snapshot_json,
    );
  const insertRecord = database.prepare(
    `INSERT INTO wordfence_intelligence_records (
       snapshot_digest, plugin_slug, record_id, record_json
     ) VALUES (?, ?, ?, ?)`,
  );
  for (const value of rows) {
    const row = wordfenceStoredPluginRecordSchema.parse(
      JSON.parse(value.record_json),
    );
    insertRecord.run(
      current.snapshotRef.digest,
      row.pluginSlug,
      row.record.recordId,
      canonicalFixtureJson(row.record),
    );
  }
  database
    .prepare(
      `INSERT INTO wordfence_intelligence_current (
         singleton, snapshot_digest
       ) VALUES (1, ?)`,
    )
    .run(current.snapshotRef.digest);
  database.close();

  const rawDirectory = join(artifactDirectory, "wordfence-intelligence-v3");
  await chmod(rawDirectory, 0o755);
  await chmod(
    join(
      rawDirectory,
      `${current.snapshot.source.contentDigest.slice("sha256:".length)}.json`,
    ),
    0o644,
  );
  return current;
}

describe("WordfenceIntelligenceRefresh", () => {
  it("reads a production snapshot through the existing inspection and aggregate seams", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-production-existing-reads-"),
    );
    const databasePath = join(directory, "index", "target-intelligence.sqlite");
    const artifactDirectory = join(directory, "artifacts");
    const bytes = await readFile(fixturePath);
    let productionCredentialResolutions = 0;
    const productionFetch = vi.fn<typeof fetch>(async () =>
      Promise.resolve(new Response(bytes, { status: 200 })),
    );
    try {
      const production = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            productionCredentialResolutions += 1;
            return use("synthetic-existing-read-credential");
          },
        },
        fetch: productionFetch,
        clock: () => new Date("2030-08-01T00:00:00.000Z"),
      });
      const current = await production.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      if (current.status !== "current") {
        throw new Error("Expected a production current snapshot");
      }
      expect(productionCredentialResolutions).toBe(1);
      expect(productionFetch).toHaveBeenCalledOnce();

      const localFeed = vi.fn(async () => {
        throw new Error("production-backed reads must not retrieve the feed");
      });
      const options = {
        databasePath,
        artifactDirectory,
        adapter: { sourceUrl, retrieveProductionFeed: localFeed },
        credential: {
          kind: "secret-ref" as const,
          id: "wordfence-v3-api-key" as const,
        },
      };
      const reader = openWordfenceIntelligence(options);
      const request = {
        kind: "wordfence-vulnerability-history-aggregate" as const,
        schemaVersion: 1 as const,
        snapshotRef: current.snapshotRef,
        pluginIdentity: "wporg:fixture-plugin" as const,
      };
      const expectedAggregate = {
        kind: "vulnerability-history-aggregate" as const,
        schemaVersion: 1 as const,
        pluginIdentity: "wporg:fixture-plugin" as const,
        snapshotRef: current.snapshotRef,
        recordCount: 2,
        disclosureDensity: {
          kind: "records-per-published-year" as const,
          publishedYears: 2,
          value: 1,
        },
        lastPublishedAt: "2029-02-20T08:30:00.000Z",
      };

      await expect(
        reader.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toEqual(current);
      await expect(reader.aggregate(request)).resolves.toEqual(
        expectedAggregate,
      );
      await expect(
        openWordfenceIntelligence(options).aggregate(request),
      ).resolves.toEqual(expectedAggregate);
      expect(JSON.stringify(expectedAggregate)).not.toMatch(
        /CVE-|"(?:cwe|cvss|affectedVersionIntervals|patchedVersions|verifiedVersion|versions?|routes?)"/i,
      );
      expect(localFeed).not.toHaveBeenCalled();
      expect(productionCredentialResolutions).toBe(1);
      expect(productionFetch).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("gates production known-record reads and validates their raw artifact after restart", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-production-known-record-read-"),
    );
    const databasePath = join(directory, "index", "target-intelligence.sqlite");
    const artifactDirectory = join(directory, "artifacts");
    const bytes = await readFile(fixturePath);
    const localFeed = vi.fn(async () => {
      throw new Error("known-record reads must not retrieve the feed");
    });
    try {
      const production = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            return use("synthetic-known-record-read-credential");
          },
        },
        fetch: vi.fn<typeof fetch>(async () =>
          Promise.resolve(new Response(bytes, { status: 200 })),
        ),
      });
      const current = await production.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      if (current.status !== "current") {
        throw new Error("Expected a production current snapshot");
      }
      const authorization = await knownRecordAuthorization();
      const request = {
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
      const options = {
        databasePath,
        artifactDirectory,
        adapter: { sourceUrl, retrieveProductionFeed: localFeed },
        credential: {
          kind: "secret-ref" as const,
          id: "wordfence-v3-api-key" as const,
        },
      };
      const projection = await openWordfenceIntelligence({
        ...options,
        knownRecordAuthorizationProvider: {
          resolve: async () => ({
            status: "authorized" as const,
            authorization,
          }),
        },
      }).inspectKnownRecords(request);
      expect(projection).toMatchObject({
        verifiedFindingRef: authorization.verifiedFindingRef,
        purpose: "known-duplicate-disposition",
      });
      expect(projection.records.map((record) => record.recordId)).toEqual([
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ]);
      await expect(
        openWordfenceIntelligence({
          ...options,
          knownRecordAuthorizationProvider: {
            resolve: async () => ({ status: "denied" as const }),
          },
        }).inspectKnownRecords(request),
      ).rejects.toMatchObject({ code: "known-record-access-denied" });

      const artifactPath = join(
        artifactDirectory,
        "wordfence-intelligence-v3",
        `${current.snapshot.source.contentDigest.slice("sha256:".length)}.json`,
      );
      await chmod(artifactPath, 0o600);
      await writeFile(artifactPath, Buffer.from("sanitized-corruption"));
      await expect(
        openWordfenceIntelligence({
          ...options,
          knownRecordAuthorizationProvider: {
            resolve: async () => ({
              status: "authorized" as const,
              authorization,
            }),
          },
        }).inspectKnownRecords(request),
      ).rejects.toThrow("Wordfence Intelligence artifact conflict");
      expect(localFeed).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not transfer production ownership to local access when the marker table is deleted", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-deleted-production-marker-"),
    );
    const databasePath = join(directory, "index", "target-intelligence.sqlite");
    const artifactDirectory = join(directory, "artifacts");
    const bytes = await readFile(fixturePath);
    let brokerCalls = 0;
    const productionFetch = vi.fn<typeof fetch>(async () =>
      Promise.resolve(new Response(bytes, { status: 200 })),
    );
    const localFeed = vi.fn(async () => {
      throw new Error("a production-owned store must not retrieve locally");
    });
    const authorizationProvider = vi.fn(async () => ({
      status: "denied" as const,
    }));
    try {
      const production = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            brokerCalls += 1;
            return use("synthetic-deleted-marker-credential");
          },
        },
        fetch: productionFetch,
      });
      const current = await production.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      if (current.status !== "current") {
        throw new Error("Expected a production current snapshot");
      }

      const markerDeletion = new Database(databasePath);
      markerDeletion.exec(
        "DROP TABLE wordfence_intelligence_production_storage",
      );
      markerDeletion.pragma("wal_checkpoint(TRUNCATE)");
      const currentPointer = z
        .strictObject({ snapshot_digest: z.string() })
        .parse(
          markerDeletion
            .prepare(
              `SELECT snapshot_digest
                 FROM wordfence_intelligence_current
                WHERE singleton = 1`,
            )
            .get(),
        );
      markerDeletion.close();
      const rawDirectory = join(artifactDirectory, "wordfence-intelligence-v3");
      const rawPathsBefore = await readdir(rawDirectory);
      const rawBytesBefore = await Promise.all(
        rawPathsBefore.map((name) => readFile(join(rawDirectory, name))),
      );
      const databaseBytesBefore = await readFile(databasePath);
      const walBytesBefore = await readFile(`${databasePath}-wal`);

      const local = openWordfenceIntelligence({
        databasePath,
        artifactDirectory,
        adapter: { sourceUrl, retrieveProductionFeed: localFeed },
        credential: { kind: "secret-ref", id: "wordfence-v3-api-key" },
        knownRecordAuthorizationProvider: {
          resolve: authorizationProvider,
        },
      });
      await expect(
        local.refresh({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
      await expect(
        local.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
      await expect(
        local.aggregate({
          kind: "wordfence-vulnerability-history-aggregate",
          schemaVersion: 1,
          snapshotRef: current.snapshotRef,
          pluginIdentity: "wporg:fixture-plugin",
        }),
      ).rejects.toThrow("Wordfence Intelligence snapshot conflict");

      expect(localFeed).not.toHaveBeenCalled();
      expect(authorizationProvider).not.toHaveBeenCalled();
      expect(brokerCalls).toBe(1);
      expect(productionFetch).toHaveBeenCalledOnce();
      expect(await readFile(databasePath)).toEqual(databaseBytesBefore);
      expect(await readFile(`${databasePath}-wal`)).toEqual(walBytesBefore);
      expect(await readdir(rawDirectory)).toEqual(rawPathsBefore);
      const rawBytesAfter = await Promise.all(
        rawPathsBefore.map((name) => readFile(join(rawDirectory, name))),
      );
      expect(rawBytesAfter).toEqual(rawBytesBefore);
      const verification = new Database(databasePath, {
        fileMustExist: true,
        readonly: true,
      });
      expect(
        z.strictObject({ snapshot_digest: z.string() }).parse(
          verification
            .prepare(
              `SELECT snapshot_digest
                   FROM wordfence_intelligence_current
                  WHERE singleton = 1`,
            )
            .get(),
        ),
      ).toEqual(currentPointer);
      verification.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects local refresh writes to a production-owned store", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-local-production-boundary-"),
    );
    const databasePath = join(directory, "target-intelligence.sqlite");
    const artifactDirectory = join(directory, "artifacts");
    const bytes = await readFile(fixturePath);
    try {
      const production = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            return use("synthetic-production-boundary-credential");
          },
        },
        fetch: vi.fn<typeof fetch>(async () =>
          Promise.resolve(new Response(bytes, { status: 200 })),
        ),
        clock: () => new Date("2030-08-01T00:00:00.000Z"),
      });
      const current = await production.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      if (current.status !== "current") {
        throw new Error("Expected a production current snapshot");
      }
      const rawDirectory = join(artifactDirectory, "wordfence-intelligence-v3");
      const rawPaths = await readdir(rawDirectory);
      const changedBytes = Buffer.from(
        bytes
          .toString("utf8")
          .replace("Sanitized example one", "Different sanitized example"),
      );
      const retrieveProductionFeed = vi.fn(async () => ({
        status: 200,
        sourceUrl,
        complete: true,
        bytes: changedBytes,
      }));
      const local = openWordfenceIntelligence({
        databasePath,
        artifactDirectory,
        adapter: { sourceUrl, retrieveProductionFeed },
        credential: { kind: "secret-ref", id: "wordfence-v3-api-key" },
        clock: () => new Date("2030-08-02T00:00:00.000Z"),
      });

      await expect(
        local.refresh({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
      expect(retrieveProductionFeed).not.toHaveBeenCalled();
      expect(await readdir(rawDirectory)).toEqual(rawPaths);
      await expect(
        production.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toEqual(current);
      await expect(
        openWordfenceIntelligenceRefresh({
          databasePath,
          artifactDirectory,
          credentialBroker: {
            async resolve<T>(): Promise<T> {
              throw new Error("inspection must not resolve a credential");
            },
          },
          fetch: vi.fn<typeof fetch>(),
        }).inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toEqual(current);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes concurrent cold-start refreshes without exposing SQLite races", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-concurrent-cold-runs-"),
    );
    const pendingFetch = controlledFetch();
    let resolveCalls = 0;
    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath: join(directory, "index", "target-intelligence.sqlite"),
        artifactDirectory: join(directory, "artifacts"),
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            resolveCalls += 1;
            return use("synthetic-concurrent-cold-run-credential");
          },
        },
        fetch: pendingFetch.fetch,
        clock: () => new Date("2030-08-01T00:00:00.000Z"),
      });
      const first = refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      const second = refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      const completion = Promise.all([first, second]);
      await pendingFetch.started;
      pendingFetch.respond(
        new Response(await readFile(fixturePath), { status: 200 }),
      );
      const results = await completion;

      expect(results).toContainEqual(
        expect.objectContaining({ status: "current" }),
      );
      expect(results).toContainEqual({
        kind: "wordfence-intelligence-result",
        schemaVersion: 1,
        status: "failed",
        reason: "storage-failure",
      });
      expect(resolveCalls).toBe(1);
      expect(pendingFetch.fetch).toHaveBeenCalledOnce();
    } finally {
      pendingFetch.respond(new Response(undefined, { status: 500 }));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes concurrent cold-start refreshes across production compositions", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-cross-composition-cold-runs-"),
    );
    const databasePath = join(directory, "index", "target-intelligence.sqlite");
    const artifactDirectory = join(directory, "artifacts");
    const pendingFetch = controlledFetch();
    let resolveCalls = 0;
    const options = {
      databasePath,
      artifactDirectory,
      credentialBroker: {
        async resolve<T>(
          _reference: WordfenceSecretRef,
          use: (credential: string) => Promise<T>,
        ): Promise<T> {
          resolveCalls += 1;
          return use("synthetic-cross-composition-cold-run-credential");
        },
      },
      fetch: pendingFetch.fetch,
      clock: () => new Date("2030-08-01T00:00:00.000Z"),
    };
    try {
      const first = openWordfenceIntelligenceRefresh(options);
      const second = openWordfenceIntelligenceRefresh(options);
      const completion = Promise.all([
        first.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
        second.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ]).then(
        (results) => ({ status: "completed" as const, results }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      await pendingFetch.started;
      pendingFetch.respond(
        new Response(await readFile(fixturePath), { status: 200 }),
      );
      const outcome = await completion;
      if (outcome.status === "rejected") {
        throw outcome.error;
      }
      const { results } = outcome;

      expect(results).toContainEqual(
        expect.objectContaining({ status: "current" }),
      );
      expect(results).toContainEqual({
        kind: "wordfence-intelligence-result",
        schemaVersion: 1,
        status: "failed",
        reason: "storage-failure",
      });
      expect(resolveCalls).toBe(1);
      expect(pendingFetch.fetch).toHaveBeenCalledOnce();
      const current = results.find((result) => result.status === "current");
      await expect(
        openWordfenceIntelligenceRefresh({
          ...options,
          credentialBroker: {
            async resolve<T>(): Promise<T> {
              throw new Error("inspection must not resolve a credential");
            },
          },
          fetch: vi.fn<typeof fetch>(),
        }).inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toEqual(current);
    } finally {
      pendingFetch.respond(new Response(undefined, { status: 500 }));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes a cold refresh and inspections across three production compositions", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-cross-composition-cold-inspections-"),
    );
    const databasePath = join(directory, "index", "target-intelligence.sqlite");
    const artifactDirectory = join(directory, "artifacts");
    const pendingFetch = controlledFetch();
    const options = {
      databasePath,
      artifactDirectory,
      credentialBroker: {
        async resolve<T>(
          _reference: WordfenceSecretRef,
          use: (credential: string) => Promise<T>,
        ): Promise<T> {
          return use("synthetic-three-composition-cold-credential");
        },
      },
      fetch: pendingFetch.fetch,
      clock: () => new Date("2030-08-01T00:00:00.000Z"),
    };
    try {
      const runner = openWordfenceIntelligenceRefresh(options);
      const firstInspector = openWordfenceIntelligenceRefresh(options);
      const secondInspector = openWordfenceIntelligenceRefresh(options);
      const run = runner.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      const inspections = Promise.all([
        firstInspector.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
        secondInspector.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ]);
      const inspected = expect(inspections).resolves.toEqual([
        expect.objectContaining({ status: "failed" }),
        expect.objectContaining({ status: "failed" }),
      ]);
      await pendingFetch.started;
      await inspected;
      pendingFetch.respond(
        new Response(await readFile(fixturePath), { status: 200 }),
      );
      const current = await run;
      expect(current.status).toBe("current");
      expect(pendingFetch.fetch).toHaveBeenCalledOnce();

      await expect(
        Promise.all([
          firstInspector.inspect({
            kind: "wordfence-intelligence-inspection",
            schemaVersion: 1,
          }),
          secondInspector.inspect({
            kind: "wordfence-intelligence-inspection",
            schemaVersion: 1,
          }),
          openWordfenceIntelligenceRefresh({
            ...options,
            credentialBroker: {
              async resolve<T>(): Promise<T> {
                throw new Error("inspection must not resolve a credential");
              },
            },
            fetch: vi.fn<typeof fetch>(),
          }).inspect({
            kind: "wordfence-intelligence-inspection",
            schemaVersion: 1,
          }),
        ]),
      ).resolves.toEqual([current, current, current]);
    } finally {
      pendingFetch.respond(new Response(undefined, { status: 500 }));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["incomplete current", "old"] as const)(
    "preserves %s storage left by a competing cold initializer",
    async (format) => {
      const directory = await mkdtemp(
        join(tmpdir(), "wordfence-incomplete-cold-winner-"),
      );
      const databasePath = join(
        directory,
        "index",
        "target-intelligence.sqlite",
      );
      const artifactDirectory = join(directory, "artifacts");
      let resolveCalls = 0;
      let before: Buffer | undefined;
      const fetchMock = vi.fn<typeof fetch>();
      filesystemFault.databaseCreatePath = databasePath;
      filesystemFault.afterDatabaseCreate = async () => {
        const incomplete = new Database(databasePath);
        if (format === "incomplete current") {
          incomplete.exec(`CREATE TABLE wordfence_intelligence_refresh_order (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        publication_sequence INTEGER NOT NULL CHECK (publication_sequence >= 0),
        latest_completed_sequence INTEGER NOT NULL CHECK (latest_completed_sequence >= publication_sequence)
      ) STRICT`);
          incomplete
            .prepare(
              `INSERT INTO wordfence_intelligence_refresh_order (
             singleton, publication_sequence, latest_completed_sequence
           ) VALUES (1, 0, 0)`,
            )
            .run();
        } else {
          incomplete.exec(`CREATE TABLE wordfence_intelligence_snapshots (
          snapshot_digest TEXT PRIMARY KEY,
          snapshot_id TEXT NOT NULL UNIQUE,
          snapshot_json TEXT NOT NULL
        ) STRICT`);
        }
        before = incomplete.serialize();
        incomplete.close();
      };
      try {
        const refresh = openWordfenceIntelligenceRefresh({
          databasePath,
          artifactDirectory,
          credentialBroker: {
            async resolve<T>(): Promise<T> {
              resolveCalls += 1;
              throw new Error("incomplete initialization must not resolve");
            },
          },
          fetch: fetchMock,
        });
        await expect(
          refresh.run({
            kind: "wordfence-intelligence-refresh",
            schemaVersion: 1,
          }),
        ).resolves.toEqual({
          kind: "wordfence-intelligence-result",
          schemaVersion: 1,
          status: "failed",
          reason: "storage-failure",
        });
        await expect(
          refresh.inspect({
            kind: "wordfence-intelligence-inspection",
            schemaVersion: 1,
          }),
        ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
        const after = new Database(databasePath, { readonly: true });
        try {
          expect(after.serialize()).toEqual(before);
        } finally {
          after.close();
        }
        expect(resolveCalls).toBe(0);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        filesystemFault.afterDatabaseCreate = undefined;
        filesystemFault.databaseCreatePath = undefined;
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("serializes a concurrent cold-start refresh and inspection", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-concurrent-cold-inspection-"),
    );
    const pendingFetch = controlledFetch();
    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath: join(directory, "index", "target-intelligence.sqlite"),
        artifactDirectory: join(directory, "artifacts"),
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            return use("synthetic-concurrent-cold-inspection-credential");
          },
        },
        fetch: pendingFetch.fetch,
        clock: () => new Date("2030-08-01T00:00:00.000Z"),
      });
      const run = refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      const inspection = refresh.inspect({
        kind: "wordfence-intelligence-inspection",
        schemaVersion: 1,
      });
      const inspected = expect(inspection).resolves.toMatchObject({
        status: "failed",
      });
      await pendingFetch.started;
      await inspected;
      pendingFetch.respond(
        new Response(await readFile(fixturePath), { status: 200 }),
      );
      await expect(run).resolves.toMatchObject({ status: "current" });
      expect(pendingFetch.fetch).toHaveBeenCalledOnce();
    } finally {
      pendingFetch.respond(new Response(undefined, { status: 500 }));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retries a cold initialization after a typed storage failure", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-cold-init-retry-"),
    );
    const rawDirectory = join(
      directory,
      "artifacts",
      "wordfence-intelligence-v3",
    );
    await mkdir(rawDirectory, { recursive: true, mode: 0o755 });
    await chmod(rawDirectory, 0o755);
    let resolveCalls = 0;
    const fetchMock = vi.fn<typeof fetch>();
    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath: join(directory, "index", "target-intelligence.sqlite"),
        artifactDirectory: join(directory, "artifacts"),
        credentialBroker: {
          async resolve<T>(): Promise<T> {
            resolveCalls += 1;
            throw new Error("inspection must not resolve a credential");
          },
        },
        fetch: fetchMock,
      });
      await expect(
        refresh.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toMatchObject({ status: "failed", reason: "storage-failure" });

      await chmod(rawDirectory, 0o700);
      await expect(
        refresh.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toMatchObject({ status: "failed", reason: "not-refreshed" });
      expect(resolveCalls).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("publishes raw CAS bytes only in a protected immutable regular file", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-private-cas-publication-"),
    );
    const artifactDirectory = join(directory, "artifacts");
    const rawDirectory = join(artifactDirectory, "wordfence-intelligence-v3");
    const bytes = await readFile(fixturePath);
    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath: join(directory, "index", "target-intelligence.sqlite"),
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            return use("synthetic-private-cas-credential");
          },
        },
        fetch: vi.fn<typeof fetch>(async () =>
          Promise.resolve(new Response(bytes, { status: 200 })),
        ),
      });
      const result = await refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      if (result.status !== "current") {
        throw new Error("Expected a current snapshot");
      }

      const artifactName = `${result.snapshot.source.contentDigest.slice(7)}.json`;
      const finalPath = join(rawDirectory, artifactName);
      const directoryMetadata = await lstat(rawDirectory);
      const finalMetadata = await lstat(finalPath);
      expect(directoryMetadata.isDirectory()).toBe(true);
      expect(directoryMetadata.mode & 0o777).toBe(0o700);
      expect(finalMetadata.isFile()).toBe(true);
      expect(finalMetadata.isSymbolicLink()).toBe(false);
      expect(finalMetadata.mode & 0o777).toBe(0o400);
      expect(await readFile(finalPath)).toEqual(bytes);
      expect(await readdir(rawDirectory)).toEqual([artifactName]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a missing current raw artifact before another production fetch", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-missing-current-artifact-"),
    );
    const artifactDirectory = join(directory, "artifacts");
    let resolveCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(await readFile(fixturePath), { status: 200 }),
      ),
    );
    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath: join(directory, "index", "target-intelligence.sqlite"),
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            resolveCalls += 1;
            return use("synthetic-missing-artifact-credential");
          },
        },
        fetch: fetchMock,
      });
      const current = await refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      if (current.status !== "current") {
        throw new Error("Expected a current snapshot");
      }
      await unlink(
        join(
          artifactDirectory,
          "wordfence-intelligence-v3",
          `${current.snapshot.source.contentDigest.slice(7)}.json`,
        ),
      );

      await expect(
        refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).resolves.toEqual({
        kind: "wordfence-intelligence-result",
        schemaVersion: 1,
        status: "failed",
        reason: "storage-failure",
      });
      expect(resolveCalls).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects same-inode current raw artifact tampering before another production fetch", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-tampered-current-artifact-"),
    );
    const artifactDirectory = join(directory, "artifacts");
    let resolveCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(await readFile(fixturePath), { status: 200 }),
      ),
    );
    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath: join(directory, "index", "target-intelligence.sqlite"),
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            resolveCalls += 1;
            return use("synthetic-tampered-artifact-credential");
          },
        },
        fetch: fetchMock,
      });
      const current = await refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      if (current.status !== "current") {
        throw new Error("Expected a current snapshot");
      }
      const artifactPath = join(
        artifactDirectory,
        "wordfence-intelligence-v3",
        `${current.snapshot.source.contentDigest.slice(7)}.json`,
      );
      const originalInode = (await lstat(artifactPath)).ino;
      await chmod(artifactPath, 0o600);
      await writeFile(artifactPath, Buffer.from('{"tampered":true}'));
      await chmod(artifactPath, 0o400);
      expect((await lstat(artifactPath)).ino).toBe(originalInode);

      await expect(
        refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence artifact conflict");
      expect(resolveCalls).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(
    (["same instance", "fresh open"] as const).flatMap((lifecycle) =>
      (["run", "inspect"] as const).flatMap((operation) =>
        (
          [
            "deletion",
            "same-inode content tamper",
            "0644 mode",
            "symlink",
            "byte-identical regular replacement",
          ] as const
        ).map((mutation) => [lifecycle, operation, mutation] as const),
      ),
    ),
  )(
    "%s production %s binds the current pointer across raw artifact %s",
    async (lifecycle, operation, mutation) => {
      const directory = await mkdtemp(
        join(tmpdir(), "wordfence-current-artifact-binding-"),
      );
      const artifactDirectory = join(directory, "artifacts");
      const bytes = await readFile(fixturePath);
      let resolveCalls = 0;
      const fetchMock = vi.fn<typeof fetch>(async () =>
        Promise.resolve(new Response(bytes, { status: 200 })),
      );
      const options = {
        databasePath: join(directory, "index", "target-intelligence.sqlite"),
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            resolveCalls += 1;
            return use("synthetic-current-artifact-binding-credential");
          },
        },
        fetch: fetchMock,
      };
      try {
        const refresh = openWordfenceIntelligenceRefresh(options);
        const current = await refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        });
        if (current.status !== "current") {
          throw new Error("Expected a current snapshot");
        }
        const artifactPath = join(
          artifactDirectory,
          "wordfence-intelligence-v3",
          `${current.snapshot.source.contentDigest.slice(7)}.json`,
        );
        const originalInode = (await lstat(artifactPath)).ino;
        if (mutation === "deletion") {
          await unlink(artifactPath);
        } else if (mutation === "same-inode content tamper") {
          await chmod(artifactPath, 0o600);
          await writeFile(artifactPath, Buffer.from('{"tampered":true}'));
          await chmod(artifactPath, 0o400);
          expect((await lstat(artifactPath)).ino).toBe(originalInode);
        } else if (mutation === "0644 mode") {
          await chmod(artifactPath, 0o644);
        } else if (mutation === "symlink") {
          const backingPath = join(directory, "artifact-backing.json");
          await writeFile(backingPath, bytes, { mode: 0o400 });
          await unlink(artifactPath);
          await symlink(backingPath, artifactPath, "file");
        } else {
          const replacementPath = join(
            artifactDirectory,
            "wordfence-intelligence-v3",
            "byte-identical-replacement.json",
          );
          await writeFile(replacementPath, bytes, { mode: 0o400 });
          await chmod(replacementPath, 0o400);
          await rename(replacementPath, artifactPath);
          expect((await lstat(artifactPath)).ino).not.toBe(originalInode);
        }

        const selected =
          lifecycle === "same instance"
            ? refresh
            : openWordfenceIntelligenceRefresh(options);
        const result =
          operation === "run"
            ? selected.run({
                kind: "wordfence-intelligence-refresh",
                schemaVersion: 1,
              })
            : selected.inspect({
                kind: "wordfence-intelligence-inspection",
                schemaVersion: 1,
              });
        if (mutation === "deletion") {
          await expect(result).resolves.toEqual({
            kind: "wordfence-intelligence-result",
            schemaVersion: 1,
            status: "failed",
            reason: "storage-failure",
          });
        } else if (mutation === "byte-identical regular replacement") {
          await expect(result).resolves.toMatchObject({ status: "current" });
        } else {
          await expect(result).rejects.toThrow(
            "Wordfence Intelligence artifact conflict",
          );
        }
        const expectedFetches =
          mutation === "byte-identical regular replacement" &&
          operation === "run"
            ? 2
            : 1;
        expect(resolveCalls).toBe(expectedFetches);
        expect(fetchMock).toHaveBeenCalledTimes(expectedFetches);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects index directory replacement during production artifact inspection", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-index-inspect-replacement-"),
    );
    const indexDirectory = join(directory, "index");
    const displacedIndexDirectory = join(directory, "displaced-index");
    const databasePath = join(indexDirectory, "target-intelligence.sqlite");
    const displacedDatabasePath = join(
      displacedIndexDirectory,
      "target-intelligence.sqlite",
    );
    const artifactDirectory = join(directory, "artifacts");
    const bytes = await readFile(fixturePath);
    let substitute: Database.Database | undefined;
    const options = {
      databasePath,
      artifactDirectory,
      credentialBroker: {
        async resolve<T>(
          _reference: WordfenceSecretRef,
          use: (credential: string) => Promise<T>,
        ): Promise<T> {
          return use("synthetic-inspect-replacement-credential");
        },
      },
      fetch: vi.fn<typeof fetch>(async () =>
        Promise.resolve(new Response(bytes, { status: 200 })),
      ),
    };
    try {
      const refresh = openWordfenceIntelligenceRefresh(options);
      const current = await refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      if (current.status !== "current") {
        throw new Error("Expected an initial current snapshot");
      }
      filesystemFault.artifactReadName = `${current.snapshot.source.contentDigest.slice(7)}.json`;
      filesystemFault.afterArtifactRead = async () => {
        await rename(indexDirectory, displacedIndexDirectory);
        await mkdir(indexDirectory, { mode: 0o700 });
        substitute = new Database(databasePath);
        substitute.pragma("journal_mode = WAL");
        substitute.exec("CREATE TABLE replacement_marker (value TEXT) STRICT");
        await chmod(indexDirectory, 0o700);
        await chmod(databasePath, 0o600);
        await chmod(`${databasePath}-wal`, 0o600);
        await chmod(`${databasePath}-shm`, 0o600);
      };

      await expect(
        refresh.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toEqual({
        kind: "wordfence-intelligence-result",
        schemaVersion: 1,
        status: "failed",
        reason: "storage-failure",
      });

      const configuredRestart = openWordfenceIntelligenceRefresh(options);
      await expect(
        configuredRestart.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence snapshot conflict");

      const displacedRestart = openWordfenceIntelligenceRefresh({
        ...options,
        databasePath: displacedDatabasePath,
      });
      await expect(
        displacedRestart.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toEqual(current);
    } finally {
      filesystemFault.afterArtifactRead = undefined;
      filesystemFault.artifactReadName = undefined;
      substitute?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["deletion", "content tamper"] as const)(
    "does not replay stale state after raw artifact %s",
    async (mutation) => {
      const directory = await mkdtemp(
        join(tmpdir(), "wordfence-stale-artifact-binding-"),
      );
      const artifactDirectory = join(directory, "artifacts");
      const bytes = await readFile(fixturePath);
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(bytes, { status: 200 }))
        .mockResolvedValueOnce(new Response(undefined, { status: 404 }));
      const options = {
        databasePath: join(directory, "index", "target-intelligence.sqlite"),
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            return use("synthetic-stale-artifact-binding-credential");
          },
        },
        fetch: fetchMock,
      };
      try {
        const refresh = openWordfenceIntelligenceRefresh(options);
        const current = await refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        });
        if (current.status !== "current") {
          throw new Error("Expected a current snapshot");
        }
        const stale = await refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        });
        expect(stale).toMatchObject({
          status: "stale",
          latestRefresh: {
            result: { status: "failed", reason: "not-found" },
          },
        });
        await expect(
          refresh.inspect({
            kind: "wordfence-intelligence-inspection",
            schemaVersion: 1,
          }),
        ).resolves.toEqual(stale);

        const artifactPath = join(
          artifactDirectory,
          "wordfence-intelligence-v3",
          `${current.snapshot.source.contentDigest.slice(7)}.json`,
        );
        if (mutation === "deletion") {
          await unlink(artifactPath);
        } else {
          await chmod(artifactPath, 0o600);
          await writeFile(artifactPath, Buffer.from('{"tampered":true}'));
          await chmod(artifactPath, 0o400);
        }

        const restarted = openWordfenceIntelligenceRefresh(options);
        const result = restarted.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        });
        if (mutation === "deletion") {
          await expect(result).resolves.toEqual({
            kind: "wordfence-intelligence-result",
            schemaVersion: 1,
            status: "failed",
            reason: "storage-failure",
          });
        } else {
          await expect(result).rejects.toThrow(
            "Wordfence Intelligence artifact conflict",
          );
        }
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects a permissive raw CAS directory before credential resolution", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-permissive-cas-directory-"),
    );
    const artifactDirectory = join(directory, "artifacts");
    const rawDirectory = join(artifactDirectory, "wordfence-intelligence-v3");
    let resolveCalls = 0;
    const fetchMock = vi.fn<typeof fetch>();
    await mkdir(rawDirectory, { recursive: true, mode: 0o755 });
    await chmod(rawDirectory, 0o755);
    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath: join(directory, "index", "target-intelligence.sqlite"),
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(): Promise<T> {
            resolveCalls += 1;
            throw new Error("must not resolve for unsafe CAS storage");
          },
        },
        fetch: fetchMock,
      });
      await expect(
        refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).resolves.toEqual({
        kind: "wordfence-intelligence-result",
        schemaVersion: 1,
        status: "failed",
        reason: "storage-failure",
      });
      expect(resolveCalls).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect((await lstat(rawDirectory)).mode & 0o777).toBe(0o755);
      expect(await readdir(rawDirectory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a permissive existing raw CAS file without changing it", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-permissive-cas-file-"),
    );
    const artifactDirectory = join(directory, "artifacts");
    const rawDirectory = join(artifactDirectory, "wordfence-intelligence-v3");
    const bytes = await readFile(fixturePath);
    const artifactName = `${createHash("sha256").update(bytes).digest("hex")}.json`;
    const finalPath = join(rawDirectory, artifactName);
    await mkdir(rawDirectory, { recursive: true, mode: 0o700 });
    await chmod(rawDirectory, 0o700);
    await writeFile(finalPath, bytes, { mode: 0o644 });
    await chmod(finalPath, 0o644);
    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath: join(directory, "index", "target-intelligence.sqlite"),
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            return use("synthetic-private-cas-credential");
          },
        },
        fetch: vi.fn<typeof fetch>(async () =>
          Promise.resolve(new Response(bytes, { status: 200 })),
        ),
      });
      await expect(
        refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence artifact conflict");
      expect((await lstat(finalPath)).mode & 0o777).toBe(0o644);
      expect(await readFile(finalPath)).toEqual(bytes);
      expect(await readdir(rawDirectory)).toEqual([artifactName]);
      await expect(
        refresh.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toMatchObject({ status: "failed", reason: "storage-failure" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a matching raw CAS symlink before publishing current state", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-private-cas-symlink-"),
    );
    const artifactDirectory = join(directory, "artifacts");
    const rawDirectory = join(artifactDirectory, "wordfence-intelligence-v3");
    const bytes = await readFile(fixturePath);
    const artifactName = `${createHash("sha256").update(bytes).digest("hex")}.json`;
    const finalPath = join(rawDirectory, artifactName);
    const backingPath = join(directory, "mutable-backing.json");
    await mkdir(rawDirectory, { recursive: true, mode: 0o700 });
    await chmod(rawDirectory, 0o700);
    await writeFile(backingPath, bytes, { mode: 0o600 });
    await symlink(backingPath, finalPath, "file");
    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath: join(directory, "index", "target-intelligence.sqlite"),
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            return use("synthetic-private-cas-credential");
          },
        },
        fetch: vi.fn<typeof fetch>(async () =>
          Promise.resolve(new Response(bytes, { status: 200 })),
        ),
      });

      await expect(
        refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence artifact conflict");
      expect((await lstat(finalPath)).isSymbolicLink()).toBe(true);
      await writeFile(backingPath, Buffer.from('{"mutated":true}'));
      await expect(
        refresh.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toEqual({
        kind: "wordfence-intelligence-result",
        schemaVersion: 1,
        status: "failed",
        reason: "storage-failure",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves a CAS integrity failure when directory finalization also fails", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-cas-primary-failure-"),
    );
    const artifactDirectory = join(directory, "artifacts");
    const rawDirectory = join(artifactDirectory, "wordfence-intelligence-v3");
    const bytes = await readFile(fixturePath);
    const artifactName = `${createHash("sha256").update(bytes).digest("hex")}.json`;
    const finalPath = join(rawDirectory, artifactName);
    const backingPath = join(directory, "mutable-backing.json");
    await mkdir(rawDirectory, { recursive: true, mode: 0o700 });
    await chmod(rawDirectory, 0o700);
    await writeFile(backingPath, bytes, { mode: 0o600 });
    await symlink(backingPath, finalPath, "file");
    filesystemFault.directorySyncPath = rawDirectory;
    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath: join(directory, "index", "target-intelligence.sqlite"),
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            return use("synthetic-cas-primary-failure-credential");
          },
        },
        fetch: vi.fn<typeof fetch>(async () =>
          Promise.resolve(new Response(bytes, { status: 200 })),
        ),
      });

      await expect(
        refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence artifact conflict");
    } finally {
      filesystemFault.directorySyncPath = undefined;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["persist verification", "current artifact verification"] as const)(
    "preserves the primary conflict when %s and artifact close both fail",
    async (operation) => {
      const directory = await mkdtemp(
        join(tmpdir(), "wordfence-artifact-close-primary-"),
      );
      const artifactDirectory = join(directory, "artifacts");
      const rawDirectory = join(artifactDirectory, "wordfence-intelligence-v3");
      const bytes = await readFile(fixturePath);
      const artifactName = `${createHash("sha256").update(bytes).digest("hex")}.json`;
      const artifactPath = join(rawDirectory, artifactName);
      let resolveCalls = 0;
      const fetchMock = vi.fn<typeof fetch>(async () =>
        Promise.resolve(new Response(bytes, { status: 200 })),
      );
      try {
        if (operation === "persist verification") {
          await mkdir(rawDirectory, { recursive: true, mode: 0o700 });
          await chmod(rawDirectory, 0o700);
          await writeFile(artifactPath, Buffer.from('{"conflict":true}'), {
            mode: 0o400,
          });
          await chmod(artifactPath, 0o400);
        }
        const refresh = openWordfenceIntelligenceRefresh({
          databasePath: join(directory, "index", "target-intelligence.sqlite"),
          artifactDirectory,
          credentialBroker: {
            async resolve<T>(
              _reference: WordfenceSecretRef,
              use: (credential: string) => Promise<T>,
            ): Promise<T> {
              resolveCalls += 1;
              return use("synthetic-artifact-close-primary-credential");
            },
          },
          fetch: fetchMock,
        });
        if (operation === "current artifact verification") {
          const current = await refresh.run({
            kind: "wordfence-intelligence-refresh",
            schemaVersion: 1,
          });
          if (current.status !== "current") {
            throw new Error("Expected an initial current snapshot");
          }
          await chmod(artifactPath, 0o600);
          await writeFile(artifactPath, Buffer.from('{"conflict":true}'));
          await chmod(artifactPath, 0o400);
        }
        filesystemFault.artifactCloseName = artifactName;
        filesystemFault.artifactCloseFailuresRemaining = 1;

        await expect(
          refresh.run({
            kind: "wordfence-intelligence-refresh",
            schemaVersion: 1,
          }),
        ).rejects.toThrow("Wordfence Intelligence artifact conflict");
        expect(resolveCalls).toBe(1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        filesystemFault.artifactCloseFailuresRemaining = 0;
        filesystemFault.artifactCloseName = undefined;
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects raw CAS directory replacement during production fetch", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-private-cas-replacement-"),
    );
    const artifactDirectory = join(directory, "artifacts");
    const rawDirectory = join(artifactDirectory, "wordfence-intelligence-v3");
    const displacedDirectory = join(artifactDirectory, "displaced-raw-cas");
    const bytes = await readFile(fixturePath);
    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath: join(directory, "index", "target-intelligence.sqlite"),
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            return use("synthetic-cas-replacement-credential");
          },
        },
        fetch: vi.fn<typeof fetch>(async () => {
          await rename(rawDirectory, displacedDirectory);
          await mkdir(rawDirectory, { mode: 0o777 });
          await chmod(rawDirectory, 0o777);
          return new Response(bytes, { status: 200 });
        }),
      });

      await expect(
        refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).resolves.toEqual({
        kind: "wordfence-intelligence-result",
        schemaVersion: 1,
        status: "failed",
        reason: "storage-failure",
      });
      expect(await readdir(displacedDirectory)).toEqual([]);
      expect(await readdir(rawDirectory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not commit a current snapshot before the raw CAS directory is durable", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-cas-durability-"),
    );
    const rawDirectory = join(
      directory,
      "artifacts",
      "wordfence-intelligence-v3",
    );
    filesystemFault.directorySyncPath = rawDirectory;
    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath: join(directory, "index", "target-intelligence.sqlite"),
        artifactDirectory: join(directory, "artifacts"),
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            return use("synthetic-cas-durability-credential");
          },
        },
        fetch: vi.fn<typeof fetch>(async () =>
          Promise.resolve(
            new Response(await readFile(fixturePath), { status: 200 }),
          ),
        ),
      });

      await expect(
        refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).resolves.toEqual({
        kind: "wordfence-intelligence-result",
        schemaVersion: 1,
        status: "failed",
        reason: "storage-failure",
      });
      await expect(
        refresh.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toEqual({
        kind: "wordfence-intelligence-result",
        schemaVersion: 1,
        status: "failed",
        reason: "storage-failure",
      });

      filesystemFault.directorySyncPath = undefined;
      await expect(
        refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).resolves.toMatchObject({ status: "current" });
    } finally {
      filesystemFault.directorySyncPath = undefined;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["run", "inspect"] as const)(
    "returns a typed storage failure when the %s publication-directory handle cannot close",
    async (operation) => {
      const directory = await mkdtemp(
        join(tmpdir(), "wordfence-cas-close-failure-"),
      );
      const rawDirectory = join(
        directory,
        "artifacts",
        "wordfence-intelligence-v3",
      );
      try {
        const refresh = openWordfenceIntelligenceRefresh({
          databasePath: join(directory, "index", "target-intelligence.sqlite"),
          artifactDirectory: join(directory, "artifacts"),
          credentialBroker: {
            async resolve<T>(
              _reference: WordfenceSecretRef,
              use: (credential: string) => Promise<T>,
            ): Promise<T> {
              return use("synthetic-close-failure-credential");
            },
          },
          fetch: vi.fn<typeof fetch>(async () =>
            Promise.resolve(
              new Response(await readFile(fixturePath), { status: 200 }),
            ),
          ),
        });
        await expect(
          refresh.run({
            kind: "wordfence-intelligence-refresh",
            schemaVersion: 1,
          }),
        ).resolves.toMatchObject({ status: "current" });

        filesystemFault.directoryClosePath = rawDirectory;
        filesystemFault.directoryCloseFailuresRemaining = 1;
        const result =
          operation === "run"
            ? refresh.run({
                kind: "wordfence-intelligence-refresh",
                schemaVersion: 1,
              })
            : refresh.inspect({
                kind: "wordfence-intelligence-inspection",
                schemaVersion: 1,
              });
        await expect(result).resolves.toEqual({
          kind: "wordfence-intelligence-result",
          schemaVersion: 1,
          status: "failed",
          reason: "storage-failure",
        });
      } finally {
        filesystemFault.directoryCloseFailuresRemaining = 0;
        filesystemFault.directoryClosePath = undefined;
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("preserves an earlier refresh failure when its directory handle cannot close", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-cas-close-primary-failure-"),
    );
    const rawDirectory = join(
      directory,
      "artifacts",
      "wordfence-intelligence-v3",
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(await readFile(fixturePath), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(undefined, { status: 404 }));
    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath: join(directory, "index", "target-intelligence.sqlite"),
        artifactDirectory: join(directory, "artifacts"),
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            return use("synthetic-close-primary-failure-credential");
          },
        },
        fetch: fetchMock,
      });
      await expect(
        refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).resolves.toMatchObject({ status: "current" });

      filesystemFault.directoryClosePath = rawDirectory;
      filesystemFault.directoryCloseFailuresRemaining = 1;
      await expect(
        refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).resolves.toMatchObject({
        status: "stale",
        latestRefresh: {
          result: { status: "failed", reason: "not-found" },
        },
      });
    } finally {
      filesystemFault.directoryCloseFailuresRemaining = 0;
      filesystemFault.directoryClosePath = undefined;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates the production SQLite index and sidecars as owner-only storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wordfence-private-index-"));
    const indexDirectory = join(directory, "index");
    const databasePath = join(indexDirectory, "target-intelligence.sqlite");
    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory: join(directory, "artifacts"),
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            return use("synthetic-private-index-credential");
          },
        },
        fetch: vi.fn<typeof fetch>(async () =>
          Promise.resolve(
            new Response(await readFile(fixturePath), { status: 200 }),
          ),
        ),
      });

      await expect(
        refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).resolves.toMatchObject({ status: "current" });

      const indexMetadata = await lstat(indexDirectory);
      expect(indexMetadata.isDirectory()).toBe(true);
      expect(indexMetadata.mode & 0o777).toBe(0o700);
      for (const path of [
        databasePath,
        `${databasePath}-wal`,
        `${databasePath}-shm`,
      ]) {
        const metadata = await lstat(path);
        expect(metadata.isFile()).toBe(true);
        expect(metadata.mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(
    (["run", "inspect"] as const).flatMap((operation) =>
      (
        [
          "index directory",
          "database",
          "wal",
          "shm",
          "raw CAS directory",
        ] as const
      ).map((storage) => [operation, storage] as const),
    ),
  )(
    "rejects %s after post-success %s permission drift",
    async (operation, storage) => {
      const directory = await mkdtemp(
        join(tmpdir(), "wordfence-private-storage-drift-"),
      );
      const indexDirectory = join(directory, "index");
      const databasePath = join(indexDirectory, "target-intelligence.sqlite");
      const rawDirectory = join(
        directory,
        "artifacts",
        "wordfence-intelligence-v3",
      );
      let resolveCalls = 0;
      try {
        const refresh = openWordfenceIntelligenceRefresh({
          databasePath,
          artifactDirectory: join(directory, "artifacts"),
          credentialBroker: {
            async resolve<T>(
              _reference: WordfenceSecretRef,
              use: (credential: string) => Promise<T>,
            ): Promise<T> {
              resolveCalls += 1;
              return use("synthetic-storage-drift-credential");
            },
          },
          fetch: vi.fn<typeof fetch>(async () =>
            Promise.resolve(
              new Response(await readFile(fixturePath), { status: 200 }),
            ),
          ),
        });
        await expect(
          refresh.run({
            kind: "wordfence-intelligence-refresh",
            schemaVersion: 1,
          }),
        ).resolves.toMatchObject({ status: "current" });

        const driftedPath =
          storage === "index directory"
            ? indexDirectory
            : storage === "database"
              ? databasePath
              : storage === "wal"
                ? `${databasePath}-wal`
                : storage === "shm"
                  ? `${databasePath}-shm`
                  : rawDirectory;
        await chmod(driftedPath, 0o777);

        const result =
          operation === "run"
            ? await refresh.run({
                kind: "wordfence-intelligence-refresh",
                schemaVersion: 1,
              })
            : await refresh.inspect({
                kind: "wordfence-intelligence-inspection",
                schemaVersion: 1,
              });
        expect(result).toEqual({
          kind: "wordfence-intelligence-result",
          schemaVersion: 1,
          status: "failed",
          reason: "storage-failure",
        });
        expect(resolveCalls).toBe(1);
        expect((await lstat(driftedPath)).mode & 0o777).toBe(0o777);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(
    (["run", "inspect"] as const).flatMap((operation) =>
      (["index directory", "database", "wal", "shm"] as const).map(
        (storage) => [operation, storage] as const,
      ),
    ),
  )(
    "rejects fresh %s after modern %s permission drift without repair",
    async (operation, storage) => {
      const directory = await mkdtemp(
        join(tmpdir(), "wordfence-modern-storage-restart-drift-"),
      );
      const indexDirectory = join(directory, "index");
      const databasePath = join(indexDirectory, "target-intelligence.sqlite");
      const artifactDirectory = join(directory, "artifacts");
      const validBytes = await readFile(fixturePath);
      try {
        const seed = openWordfenceIntelligenceRefresh({
          databasePath,
          artifactDirectory,
          credentialBroker: {
            async resolve<T>(
              _reference: WordfenceSecretRef,
              use: (credential: string) => Promise<T>,
            ): Promise<T> {
              return use("synthetic-modern-storage-drift-credential");
            },
          },
          fetch: vi.fn<typeof fetch>(async () =>
            Promise.resolve(new Response(validBytes, { status: 200 })),
          ),
        });
        await expect(
          seed.run({
            kind: "wordfence-intelligence-refresh",
            schemaVersion: 1,
          }),
        ).resolves.toMatchObject({ status: "current" });

        const driftedPath =
          storage === "index directory"
            ? indexDirectory
            : storage === "database"
              ? databasePath
              : storage === "wal"
                ? `${databasePath}-wal`
                : `${databasePath}-shm`;
        await chmod(driftedPath, 0o777);
        let resolveCalls = 0;
        const fetchMock = vi.fn<typeof fetch>(async () =>
          Promise.resolve(new Response(validBytes, { status: 200 })),
        );
        const restarted = openWordfenceIntelligenceRefresh({
          databasePath,
          artifactDirectory,
          credentialBroker: {
            async resolve<T>(
              _reference: WordfenceSecretRef,
              use: (credential: string) => Promise<T>,
            ): Promise<T> {
              resolveCalls += 1;
              return use("must-not-resolve-drifted-modern-storage");
            },
          },
          fetch: fetchMock,
        });

        const result =
          operation === "run"
            ? await restarted.run({
                kind: "wordfence-intelligence-refresh",
                schemaVersion: 1,
              })
            : await restarted.inspect({
                kind: "wordfence-intelligence-inspection",
                schemaVersion: 1,
              });
        expect(result).toEqual({
          kind: "wordfence-intelligence-result",
          schemaVersion: 1,
          status: "failed",
          reason: "storage-failure",
        });
        expect(resolveCalls).toBe(0);
        expect(fetchMock).not.toHaveBeenCalled();
        expect((await lstat(driftedPath)).mode & 0o777).toBe(0o777);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(
    (["run", "inspect"] as const).flatMap((operation) =>
      (["index directory", "database"] as const).map(
        (replacement) => [operation, replacement] as const,
      ),
    ),
  )(
    "rejects cached %s after secure %s replacement and preserves restart state",
    async (operation, replacement) => {
      const directory = await mkdtemp(
        join(tmpdir(), "wordfence-private-index-replacement-"),
      );
      const indexDirectory = join(directory, "index");
      const displacedIndexDirectory = join(directory, "displaced-index");
      const databasePath = join(indexDirectory, "target-intelligence.sqlite");
      const displacedDatabasePath = join(
        indexDirectory,
        "displaced-target-intelligence.sqlite",
      );
      let resolveCalls = 0;
      let substitute: Database.Database | undefined;
      const credentialBroker: HostPrivateCredentialBroker = {
        async resolve<T>(
          _reference: WordfenceSecretRef,
          use: (credential: string) => Promise<T>,
        ): Promise<T> {
          resolveCalls += 1;
          return use("synthetic-index-replacement-credential");
        },
      };
      const options = {
        databasePath,
        artifactDirectory: join(directory, "artifacts"),
        credentialBroker,
        fetch: vi.fn<typeof fetch>(async () =>
          Promise.resolve(
            new Response(await readFile(fixturePath), { status: 200 }),
          ),
        ),
      };
      try {
        const refresh = openWordfenceIntelligenceRefresh(options);
        await expect(
          refresh.run({
            kind: "wordfence-intelligence-refresh",
            schemaVersion: 1,
          }),
        ).resolves.toMatchObject({ status: "current" });

        if (replacement === "index directory") {
          await rename(indexDirectory, displacedIndexDirectory);
          await mkdir(indexDirectory, { mode: 0o700 });
        } else {
          await rename(databasePath, displacedDatabasePath);
          await rename(`${databasePath}-wal`, `${displacedDatabasePath}-wal`);
          await rename(`${databasePath}-shm`, `${displacedDatabasePath}-shm`);
        }
        substitute = new Database(databasePath);
        substitute.pragma("journal_mode = WAL");
        substitute.exec("CREATE TABLE replacement_marker (value TEXT) STRICT");
        await chmod(indexDirectory, 0o700);
        await chmod(databasePath, 0o600);
        await chmod(`${databasePath}-wal`, 0o600);
        await chmod(`${databasePath}-shm`, 0o600);

        const result =
          operation === "run"
            ? await refresh.run({
                kind: "wordfence-intelligence-refresh",
                schemaVersion: 1,
              })
            : await refresh.inspect({
                kind: "wordfence-intelligence-inspection",
                schemaVersion: 1,
              });
        expect(result).toEqual({
          kind: "wordfence-intelligence-result",
          schemaVersion: 1,
          status: "failed",
          reason: "storage-failure",
        });
        expect(resolveCalls).toBe(1);

        const restarted = openWordfenceIntelligenceRefresh(options);
        await expect(
          restarted.inspect({
            kind: "wordfence-intelligence-inspection",
            schemaVersion: 1,
          }),
        ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
      } finally {
        substitute?.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { response: "success", status: 200 },
    { response: "failure", status: 404 },
  ] as const)(
    "rejects index directory replacement during a $response production fetch",
    async ({ status }) => {
      const directory = await mkdtemp(
        join(tmpdir(), "wordfence-index-fetch-replacement-"),
      );
      const indexDirectory = join(directory, "index");
      const displacedIndexDirectory = join(directory, "displaced-index");
      const databasePath = join(indexDirectory, "target-intelligence.sqlite");
      const displacedDatabasePath = join(
        displacedIndexDirectory,
        "target-intelligence.sqlite",
      );
      const artifactDirectory = join(directory, "artifacts");
      const bytes = await readFile(fixturePath);
      let now = new Date("2030-08-01T00:00:00.000Z");
      let resolveCalls = 0;
      let substitute: Database.Database | undefined;
      const credentialBroker: HostPrivateCredentialBroker = {
        async resolve<T>(
          _reference: WordfenceSecretRef,
          use: (credential: string) => Promise<T>,
        ): Promise<T> {
          resolveCalls += 1;
          return use("synthetic-fetch-replacement-credential");
        },
      };
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(bytes, { status: 200 }))
        .mockImplementationOnce(async () => {
          await rename(indexDirectory, displacedIndexDirectory);
          await mkdir(indexDirectory, { mode: 0o700 });
          substitute = new Database(databasePath);
          substitute.pragma("journal_mode = WAL");
          substitute.exec(
            "CREATE TABLE replacement_marker (value TEXT) STRICT",
          );
          await chmod(indexDirectory, 0o700);
          await chmod(databasePath, 0o600);
          await chmod(`${databasePath}-wal`, 0o600);
          await chmod(`${databasePath}-shm`, 0o600);
          return new Response(status === 200 ? bytes : undefined, { status });
        });
      const options = {
        databasePath,
        artifactDirectory,
        credentialBroker,
        fetch: fetchMock,
        clock: () => now,
      };
      try {
        const refresh = openWordfenceIntelligenceRefresh(options);
        const current = await refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        });
        if (current.status !== "current") {
          throw new Error("Expected an initial current snapshot");
        }

        now = new Date("2030-08-02T00:00:00.000Z");
        await expect(
          refresh.run({
            kind: "wordfence-intelligence-refresh",
            schemaVersion: 1,
          }),
        ).resolves.toEqual({
          kind: "wordfence-intelligence-result",
          schemaVersion: 1,
          status: "failed",
          reason: "storage-failure",
        });
        expect(resolveCalls).toBe(2);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        await expect(
          refresh.inspect({
            kind: "wordfence-intelligence-inspection",
            schemaVersion: 1,
          }),
        ).resolves.toEqual({
          kind: "wordfence-intelligence-result",
          schemaVersion: 1,
          status: "failed",
          reason: "storage-failure",
        });

        const configuredRestart = openWordfenceIntelligenceRefresh(options);
        await expect(
          configuredRestart.inspect({
            kind: "wordfence-intelligence-inspection",
            schemaVersion: 1,
          }),
        ).rejects.toThrow("Wordfence Intelligence snapshot conflict");

        const displacedRestart = openWordfenceIntelligenceRefresh({
          ...options,
          databasePath: displacedDatabasePath,
        });
        await expect(
          displacedRestart.inspect({
            kind: "wordfence-intelligence-inspection",
            schemaVersion: 1,
          }),
        ).resolves.toEqual({
          ...current,
          status: "stale",
          latestRefresh: {
            kind: "wordfence-intelligence-refresh-attempt",
            schemaVersion: 1,
            attemptedAt: "2030-08-02T00:00:00.000Z",
            result: {
              kind: "wordfence-intelligence-result",
              schemaVersion: 1,
              status: "failed",
              reason: "storage-failure",
            },
          },
        });
      } finally {
        substitute?.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects a fixed-main SQLite index without adopting or rewriting it", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-existing-private-index-"),
    );
    const indexDirectory = join(directory, "index");
    const databasePath = join(indexDirectory, "target-intelligence.sqlite");
    const artifactDirectory = join(directory, "artifacts");
    await mkdir(indexDirectory, { mode: 0o755 });
    const fixedMainCurrent = await createFixedMainLegacyWordfenceStorage(
      databasePath,
      artifactDirectory,
    );
    const rawDirectory = join(artifactDirectory, "wordfence-intelligence-v3");
    const rawPath = join(
      rawDirectory,
      `${fixedMainCurrent.snapshot.source.contentDigest.slice("sha256:".length)}.json`,
    );
    const fixedMainConnection = new Database(databasePath);
    fixedMainConnection
      .prepare("SELECT snapshot_digest FROM wordfence_intelligence_current")
      .get();
    await chmod(indexDirectory, 0o755);
    await chmod(databasePath, 0o644);
    await chmod(`${databasePath}-wal`, 0o644);
    await chmod(`${databasePath}-shm`, 0o644);
    try {
      const unconfigured = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(): Promise<T> {
            throw new Error("inspection must not resolve a credential");
          },
        },
      });
      await expect(
        unconfigured.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toEqual({
        kind: "wordfence-intelligence-result",
        schemaVersion: 1,
        status: "failed",
        reason: "storage-failure",
      });
      expect((await lstat(indexDirectory)).mode & 0o777).toBe(0o755);
      expect((await lstat(databasePath)).mode & 0o777).toBe(0o644);

      await chmod(indexDirectory, 0o700);
      await chmod(databasePath, 0o600);
      await chmod(`${databasePath}-wal`, 0o600);
      await chmod(`${databasePath}-shm`, 0o600);
      await chmod(rawDirectory, 0o700);
      await chmod(rawPath, 0o400);
      const before = fixedMainConnection.serialize();
      const rawBefore = await readFile(rawPath);
      const privateButUnconfigured = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(): Promise<T> {
            throw new Error("inspection must not resolve a credential");
          },
        },
      });
      await expect(
        privateButUnconfigured.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence snapshot conflict");

      await expect(
        privateButUnconfigured.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
      expect(fixedMainConnection.serialize()).toEqual(before);
      expect(await readFile(rawPath)).toEqual(rawBefore);
      expect((await lstat(databasePath)).mode & 0o777).toBe(0o600);
    } finally {
      fixedMainConnection.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    "previous index",
    "unsequenced refresh result",
    "in-progress refresh marker",
  ] as const)("rejects %s through both public readers", async (format) => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-previous-format-"),
    );
    const databasePath = join(directory, "index", "target-intelligence.sqlite");
    const artifactDirectory = join(directory, "artifacts");
    const options = {
      databasePath,
      artifactDirectory,
      credentialBroker: {
        async resolve<T>(): Promise<T> {
          throw new Error("must not resolve a credential");
        },
      },
    };
    try {
      const initial = openWordfenceIntelligenceRefresh(options);
      await expect(
        initial.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toMatchObject({ status: "failed", reason: "not-refreshed" });
      const database = new Database(databasePath);
      try {
        if (format === "previous index") {
          database.exec(`
          CREATE TABLE IF NOT EXISTS wordfence_intelligence_legacy_record_sets
            (snapshot_digest TEXT PRIMARY KEY, legacy_json TEXT NOT NULL) STRICT;
          UPDATE wordfence_intelligence_index_metadata SET schema_version = 1;
          UPDATE wordfence_intelligence_production_storage
            SET format_json = json_set(format_json, '$.schemaVersion', 1);
        `);
        } else {
          const attemptedAt = "2030-08-01T00:00:00.000Z";
          const state =
            format === "unsequenced refresh result"
              ? {
                  kind: "wordfence-intelligence-production-refresh-state",
                  schemaVersion: 1,
                  latestRefresh: {
                    kind: "wordfence-intelligence-refresh-attempt",
                    schemaVersion: 1,
                    attemptedAt,
                    result: {
                      kind: "wordfence-intelligence-result",
                      schemaVersion: 1,
                      status: "failed",
                      reason: "network-failure",
                    },
                  },
                }
              : {
                  kind: "wordfence-intelligence-production-refresh-in-progress",
                  schemaVersion: 1,
                  attemptedAt,
                };
          database
            .prepare(
              `INSERT INTO wordfence_intelligence_refresh_state VALUES (1, ?)`,
            )
            .run(JSON.stringify(state));
        }
        const before = database.serialize();
        const refresh = openWordfenceIntelligenceRefresh(options);
        const reader = openWordfenceIntelligence({
          databasePath,
          artifactDirectory,
          credential: { kind: "secret-ref", id: "wordfence-v3-api-key" },
          adapter: {
            sourceUrl,
            retrieveProductionFeed: () =>
              Promise.reject(new Error("must not retrieve")),
          },
        });
        for (const instance of [refresh, reader]) {
          await expect(
            instance.inspect({
              kind: "wordfence-intelligence-inspection",
              schemaVersion: 1,
            }),
          ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
        }
        await expect(
          refresh.run({
            kind: "wordfence-intelligence-refresh",
            schemaVersion: 1,
          }),
        ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
        expect(database.serialize()).toEqual(before);
        expect((await lstat(databasePath)).mode & 0o777).toBe(0o600);
      } finally {
        database.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects pre-existing unprotected SQLite sidecars without repair", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-existing-private-sidecars-"),
    );
    const indexDirectory = join(directory, "index");
    const databasePath = join(indexDirectory, "target-intelligence.sqlite");
    await mkdir(indexDirectory, { mode: 0o755 });
    const existing = new Database(databasePath);
    existing.pragma("journal_mode = WAL");
    existing.exec("CREATE TABLE pre_existing_marker (value TEXT) STRICT");
    await chmod(indexDirectory, 0o755);
    await chmod(databasePath, 0o644);
    await chmod(`${databasePath}-wal`, 0o644);
    await chmod(`${databasePath}-shm`, 0o644);
    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory: join(directory, "artifacts"),
        credentialBroker: {
          async resolve<T>(): Promise<T> {
            throw new Error("inspection must not resolve a credential");
          },
        },
      });
      await expect(
        refresh.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toEqual({
        kind: "wordfence-intelligence-result",
        schemaVersion: 1,
        status: "failed",
        reason: "storage-failure",
      });

      expect((await lstat(indexDirectory)).mode & 0o777).toBe(0o755);
      for (const path of [
        databasePath,
        `${databasePath}-wal`,
        `${databasePath}-shm`,
      ]) {
        expect((await lstat(path)).mode & 0o777).toBe(0o644);
      }
    } finally {
      existing.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["ancestor directory", "directory", "database"] as const)(
    "rejects an existing production SQLite %s symlink before credential resolution",
    async (target) => {
      const directory = await mkdtemp(
        join(tmpdir(), "wordfence-private-index-symlink-"),
      );
      const realIndexDirectory = join(directory, "real-index");
      const selectedIndexDirectory = join(directory, "selected-index");
      const databasePath = join(
        target === "database" ? realIndexDirectory : selectedIndexDirectory,
        ...(target === "ancestor directory" ? ["nested"] : []),
        "target-intelligence.sqlite",
      );
      let resolveCalls = 0;
      await mkdir(realIndexDirectory, { mode: 0o700 });
      if (target !== "database") {
        await symlink(realIndexDirectory, selectedIndexDirectory, "dir");
      } else {
        const backingPath = join(directory, "backing.sqlite");
        await writeFile(backingPath, new Uint8Array(), { mode: 0o600 });
        await symlink(backingPath, databasePath, "file");
      }
      try {
        const refresh = openWordfenceIntelligenceRefresh({
          databasePath,
          artifactDirectory: join(directory, "artifacts"),
          credentialBroker: {
            async resolve<T>(): Promise<T> {
              resolveCalls += 1;
              throw new Error("must not resolve for unsafe storage");
            },
          },
        });
        await expect(
          refresh.run({
            kind: "wordfence-intelligence-refresh",
            schemaVersion: 1,
          }),
        ).resolves.toEqual({
          kind: "wordfence-intelligence-result",
          schemaVersion: 1,
          status: "failed",
          reason: "storage-failure",
        });
        expect(resolveCalls).toBe(0);
        if (target === "ancestor directory") {
          await expect(
            lstat(join(realIndexDirectory, "nested")),
          ).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("refreshes through the host-private SQLite credential broker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wordfence-broker-"));
    const applicationDirectory = join(directory, "application");
    const brokerPath = join(directory, "credential-broker.sqlite");
    const credential = "synthetic-sqlite-broker-value";
    const brokerDatabase = new Database(brokerPath);
    brokerDatabase.pragma("journal_mode = WAL");
    brokerDatabase.exec(`
      CREATE TABLE secret_values (
        ref_id TEXT PRIMARY KEY NOT NULL,
        provider TEXT NOT NULL,
        purpose TEXT NOT NULL,
        secret_value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT
    `);
    brokerDatabase
      .prepare(
        `INSERT INTO secret_values (
           ref_id, provider, purpose, secret_value, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "wordfence-v3-api-key",
        "wordfence",
        "wordfence-intelligence-v3-production-feed",
        credential,
        "2030-01-01T00:00:00.000Z",
        "2030-01-01T00:00:00.000Z",
      );
    await chmod(brokerPath, 0o600);
    await chmod(`${brokerPath}-wal`, 0o600);
    await chmod(`${brokerPath}-shm`, 0o600);
    await mkdir(applicationDirectory);
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${credential}`,
      );
      return new Response(await readFile(fixturePath), { status: 200 });
    });

    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath: join(applicationDirectory, "target-intelligence.sqlite"),
        artifactDirectory: join(applicationDirectory, "artifacts"),
        credentialBroker: openSqliteHostPrivateCredentialBroker({
          databasePath: brokerPath,
        }),
        fetch: fetchMock,
      });

      const result = await refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      expect(result).toEqual({
        kind: "wordfence-intelligence-result",
        schemaVersion: 1,
        status: "current",
        snapshot: {
          kind: "wordfence-intelligence-snapshot",
          schemaVersion: 1,
          retrievedAt: expect.stringMatching(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
          ),
          source: {
            sourceUrl,
            contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
            parserVersion: "wordfence-intelligence-production-v3",
            recordCount: 2,
            complete: true,
          },
        },
        snapshotRef: {
          kind: "wordfence-intelligence-snapshot-ref",
          schemaVersion: 1,
          id: expect.stringMatching(/^wordfence-snapshot:[a-f0-9]{24}$/u),
          digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        },
      });
      expect(JSON.stringify(result)).not.toContain(credential);
      const persisted = await Promise.all(
        (await filesBelow(applicationDirectory)).map((path) => readFile(path)),
      );
      expect(persisted.every((bytes) => !bytes.includes(credential))).toBe(
        true,
      );
    } finally {
      brokerDatabase.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    "permissive parent",
    "parent symlink",
    "permissive sidecars",
  ] as const)(
    "rejects a credential broker with %s before reading its synthetic secret",
    async (unsafeStorage) => {
      const directory = await mkdtemp(
        join(tmpdir(), "wordfence-unsafe-broker-storage-"),
      );
      const realDirectory = join(directory, "real-broker");
      const selectedDirectory = join(directory, "selected-broker");
      const realDatabasePath = join(realDirectory, "credential-broker.sqlite");
      const selectedDatabasePath =
        unsafeStorage === "parent symlink"
          ? join(selectedDirectory, "credential-broker.sqlite")
          : realDatabasePath;
      const credential = `synthetic-${unsafeStorage.replaceAll(" ", "-")}-credential`;
      let useCalled = false;
      await mkdir(realDirectory, { mode: 0o700 });
      const database = new Database(realDatabasePath);
      database.pragma("journal_mode = WAL");
      database.exec(`
        CREATE TABLE secret_values (
          ref_id TEXT PRIMARY KEY NOT NULL,
          provider TEXT NOT NULL,
          purpose TEXT NOT NULL,
          secret_value TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT
      `);
      database
        .prepare(
          `INSERT INTO secret_values (
             ref_id, provider, purpose, secret_value, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "wordfence-v3-api-key",
          "wordfence",
          "wordfence-intelligence-v3-production-feed",
          credential,
          "2030-01-01T00:00:00.000Z",
          "2030-01-01T00:00:00.000Z",
        );
      await chmod(realDatabasePath, 0o600);
      await chmod(
        `${realDatabasePath}-wal`,
        unsafeStorage === "permissive sidecars" ? 0o644 : 0o600,
      );
      await chmod(
        `${realDatabasePath}-shm`,
        unsafeStorage === "permissive sidecars" ? 0o644 : 0o600,
      );
      await chmod(
        realDirectory,
        unsafeStorage === "permissive parent" ? 0o755 : 0o700,
      );
      if (unsafeStorage === "parent symlink") {
        await symlink(realDirectory, selectedDirectory, "dir");
      }
      try {
        expect(
          (await readFile(`${realDatabasePath}-wal`)).includes(credential),
        ).toBe(true);
        const broker = openSqliteHostPrivateCredentialBroker({
          databasePath: selectedDatabasePath,
        });
        await expect(
          broker.resolve(
            { kind: "secret-ref", id: "wordfence-v3-api-key" },
            async () => {
              useCalled = true;
              return "must-not-resolve";
            },
          ),
        ).rejects.toThrow("Host-private credential is unavailable");
        expect(useCalled).toBe(false);
      } finally {
        database.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("returns a typed failure when the local index cannot be opened", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wordfence-storage-"));
    const blockingFile = join(directory, "not-a-directory");
    let resolveCalls = 0;
    const credentialBroker: HostPrivateCredentialBroker = {
      async resolve<T>(): Promise<T> {
        resolveCalls += 1;
        throw new Error("must not resolve when storage is unavailable");
      },
    };
    await writeFile(blockingFile, "blocks SQLite parent creation");
    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath: join(blockingFile, "target-intelligence.sqlite"),
        artifactDirectory: join(directory, "artifacts"),
        credentialBroker,
      });

      await expect(
        refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).resolves.toEqual({
        kind: "wordfence-intelligence-result",
        schemaVersion: 1,
        status: "failed",
        reason: "storage-failure",
      });
      expect(resolveCalls).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns a typed failure when the production database path is a directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wordfence-storage-"));
    const databasePath = join(directory, "index-path");
    let resolveCalls = 0;
    await mkdir(databasePath, { mode: 0o700 });
    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory: join(directory, "artifacts"),
        credentialBroker: {
          async resolve<T>(): Promise<T> {
            resolveCalls += 1;
            throw new Error("must not resolve when storage is unavailable");
          },
        },
      });
      const expected = {
        kind: "wordfence-intelligence-result" as const,
        schemaVersion: 1 as const,
        status: "failed" as const,
        reason: "storage-failure" as const,
      };
      await expect(
        refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).resolves.toEqual(expected);
      await expect(
        refresh.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toEqual(expected);
      expect(resolveCalls).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns a typed failure when the host cannot allocate the index path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wordfence-storage-"));
    const overlongPathComponent = "x".repeat(300);
    let resolveCalls = 0;
    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath: join(
          directory,
          overlongPathComponent,
          "target-intelligence.sqlite",
        ),
        artifactDirectory: join(directory, "artifacts"),
        credentialBroker: {
          async resolve<T>(): Promise<T> {
            resolveCalls += 1;
            throw new Error("must not resolve when storage is unavailable");
          },
        },
      });

      await expect(
        refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).resolves.toEqual({
        kind: "wordfence-intelligence-result",
        schemaVersion: 1,
        status: "failed",
        reason: "storage-failure",
      });
      expect(resolveCalls).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not relabel an invalid request as a storage failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wordfence-integrity-"));
    const blockingFile = join(directory, "not-a-directory");
    await writeFile(blockingFile, "blocks SQLite parent creation");
    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath: join(blockingFile, "target-intelligence.sqlite"),
        artifactDirectory: join(directory, "artifacts"),
        credentialBroker: {
          async resolve<T>(): Promise<T> {
            throw new Error("must not resolve for an invalid request");
          },
        },
      });
      await expect(
        Reflect.apply(refresh.run, refresh, [
          {
            kind: "wordfence-intelligence-refresh",
            schemaVersion: 2,
          },
        ]),
      ).rejects.toMatchObject({ name: "ZodError" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    "arbitrary SQLite",
    "branch-intermediate SQLite",
    "marker-only SQLite",
  ] as const)(
    "rejects %s storage without rewriting records or permissions",
    async (fixture) => {
      const directory = await mkdtemp(join(tmpdir(), "wordfence-integrity-"));
      const databasePath = join(directory, "target-intelligence.sqlite");
      const database = new Database(databasePath);
      database.pragma("journal_mode = WAL");
      if (fixture === "marker-only SQLite") {
        database.exec(`
        CREATE TABLE wordfence_intelligence_production_storage (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          format_json TEXT NOT NULL
        ) STRICT;
        INSERT INTO wordfence_intelligence_production_storage (
          singleton, format_json
        ) VALUES (
          1,
          '{"kind":"wordfence-intelligence-production-storage-format","refreshAttemptLeaseSeconds":300,"schemaVersion":1}'
        )
      `);
      } else if (fixture === "branch-intermediate SQLite") {
        database.exec(`
        CREATE TABLE wordfence_intelligence_snapshots (
          snapshot_digest TEXT PRIMARY KEY,
          snapshot_id TEXT NOT NULL UNIQUE,
          snapshot_json TEXT NOT NULL
        ) STRICT;
        CREATE TABLE wordfence_intelligence_records (
          snapshot_digest TEXT NOT NULL,
          plugin_slug TEXT NOT NULL,
          record_id TEXT NOT NULL,
          record_json TEXT NOT NULL,
          PRIMARY KEY (snapshot_digest, plugin_slug, record_id)
        ) STRICT;
        CREATE TABLE wordfence_intelligence_current (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          snapshot_digest TEXT NOT NULL
        ) STRICT;
        CREATE TABLE wordfence_intelligence_refresh_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          state_json TEXT NOT NULL
        ) STRICT
      `);
      } else {
        database.exec(`
        CREATE VIEW wordfence_intelligence_snapshots AS
        SELECT 'invalid-existing-schema' AS snapshot_digest
      `);
      }
      database.close();
      await chmod(databasePath, 0o600);
      await mkdir(join(directory, "artifacts", "wordfence-intelligence-v3"), {
        recursive: true,
        mode: 0o700,
      });
      const bytesBefore = await readFile(databasePath);
      const modeBefore = (await lstat(databasePath)).mode & 0o777;
      let resolveCalls = 0;
      try {
        const refresh = openWordfenceIntelligenceRefresh({
          databasePath,
          artifactDirectory: join(directory, "artifacts"),
          credentialBroker: {
            async resolve<T>(): Promise<T> {
              resolveCalls += 1;
              throw new Error("must not resolve for an integrity failure");
            },
          },
        });
        await expect(
          refresh.inspect({
            kind: "wordfence-intelligence-inspection",
            schemaVersion: 1,
          }),
        ).rejects.toThrow();
        expect(resolveCalls).toBe(0);
        expect(await readFile(databasePath)).toEqual(bytesBefore);
        expect((await lstat(databasePath)).mode & 0o777).toBe(modeBefore);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects a dangling persisted current pointer after restart", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-dangling-current-pointer-"),
    );
    const databasePath = join(directory, "index", "target-intelligence.sqlite");
    const options = {
      databasePath,
      artifactDirectory: join(directory, "artifacts"),
      credentialBroker: {
        async resolve<T>(
          _reference: WordfenceSecretRef,
          use: (credential: string) => Promise<T>,
        ): Promise<T> {
          return use("synthetic-dangling-current-credential");
        },
      },
      fetch: vi.fn<typeof fetch>(async () =>
        Promise.resolve(
          new Response(await readFile(fixturePath), { status: 200 }),
        ),
      ),
    };
    try {
      const initial = openWordfenceIntelligenceRefresh(options);
      await expect(
        initial.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).resolves.toMatchObject({ status: "current" });

      const corruption = new Database(databasePath);
      corruption
        .prepare(
          `UPDATE wordfence_intelligence_current
              SET snapshot_digest = ?
            WHERE singleton = 1`,
        )
        .run(`sha256:${"0".repeat(64)}`);
      corruption.close();

      const restarted = openWordfenceIntelligenceRefresh(options);
      await expect(
        restarted.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a persisted freshness binding to a different current snapshot", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-mismatched-refresh-binding-"),
    );
    const databasePath = join(directory, "index", "target-intelligence.sqlite");
    const bytes = await readFile(fixturePath);
    let now = new Date("2030-08-01T00:00:00.000Z");
    const options = {
      databasePath,
      artifactDirectory: join(directory, "artifacts"),
      credentialBroker: {
        async resolve<T>(
          _reference: WordfenceSecretRef,
          use: (credential: string) => Promise<T>,
        ): Promise<T> {
          return use("synthetic-mismatched-refresh-binding-credential");
        },
      },
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(bytes, { status: 200 }))
        .mockResolvedValueOnce(new Response(undefined, { status: 404 })),
      clock: () => now,
    };
    try {
      const initial = openWordfenceIntelligenceRefresh(options);
      await expect(
        initial.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).resolves.toMatchObject({ status: "current" });
      now = new Date("2030-08-02T00:00:00.000Z");
      await expect(
        initial.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).resolves.toMatchObject({
        status: "stale",
        latestRefresh: {
          result: { status: "failed", reason: "not-found" },
        },
      });

      const corruption = new Database(databasePath);
      corruption
        .prepare(
          `UPDATE wordfence_intelligence_refresh_state
              SET state_json = ?
            WHERE singleton = 1`,
        )
        .run(
          JSON.stringify({
            kind: "wordfence-intelligence-production-refresh-state",
            schemaVersion: 1,
            currentSnapshotDigest: `sha256:${"0".repeat(64)}`,
            latestRefresh: {
              kind: "wordfence-intelligence-refresh-attempt",
              schemaVersion: 1,
              attemptedAt: "2030-08-02T00:00:00.000Z",
              result: {
                kind: "wordfence-intelligence-result",
                schemaVersion: 1,
                status: "failed",
                reason: "not-found",
              },
            },
          }),
        );
      corruption.close();

      const restarted = openWordfenceIntelligenceRefresh(options);
      await expect(
        restarted.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["missing bound current", "mismatched bound current"] as const)(
    "rejects a run with a %s before credential resolution",
    async (corruptionKind) => {
      const directory = await mkdtemp(
        join(tmpdir(), "wordfence-corrupt-refresh-run-"),
      );
      const databasePath = join(
        directory,
        "index",
        "target-intelligence.sqlite",
      );
      const bytes = await readFile(fixturePath);
      let now = new Date("2030-08-01T00:00:00.000Z");
      let resolveCalls = 0;
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(bytes, { status: 200 }))
        .mockResolvedValueOnce(new Response(undefined, { status: 404 }))
        .mockRejectedValueOnce(new Error("corrupt state must not fetch"));
      const options = {
        databasePath,
        artifactDirectory: join(directory, "artifacts"),
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            resolveCalls += 1;
            return use("synthetic-corrupt-refresh-run-credential");
          },
        },
        fetch: fetchMock,
        clock: () => now,
      };
      try {
        const refresh = openWordfenceIntelligenceRefresh(options);
        await refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        });
        now = new Date("2030-08-02T00:00:00.000Z");
        await refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        });
        expect(resolveCalls).toBe(2);

        const corruption = new Database(databasePath);
        if (corruptionKind === "missing bound current") {
          corruption.exec("DELETE FROM wordfence_intelligence_current");
        } else {
          corruption
            .prepare(
              `UPDATE wordfence_intelligence_refresh_state
                  SET state_json = json_set(
                    state_json,
                    '$.currentSnapshotDigest',
                    ?
                  )
                WHERE singleton = 1`,
            )
            .run(`sha256:${"0".repeat(64)}`);
        }
        corruption.close();

        await expect(
          refresh.run({
            kind: "wordfence-intelligence-refresh",
            schemaVersion: 1,
          }),
        ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
        expect(resolveCalls).toBe(2);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("resolves the brokered credential at final use and publishes only a fully validated production snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wordfence-live-refresh-"));
    const credential = "synthetic-broker-value-not-a-real-secret";
    const resolutions: unknown[] = [];
    let credentialInUse = false;
    const credentialBroker: HostPrivateCredentialBroker = {
      async resolve<T>(
        reference: WordfenceSecretRef,
        use: (credential: string) => Promise<T>,
      ): Promise<T> {
        resolutions.push(reference);
        credentialInUse = true;
        try {
          return await use(credential);
        } finally {
          credentialInUse = false;
        }
      },
    };
    const validBytes = await readFile(fixturePath);
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockImplementationOnce(async (_input, init) => {
      expect(credentialInUse).toBe(true);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${credential}`,
      );
      return new Response(validBytes, { status: 200 });
    });
    fetchMock.mockImplementationOnce(async (_input, init) => {
      expect(credentialInUse).toBe(true);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${credential}`,
      );
      return new Response(undefined, {
        status: 429,
        headers: { "retry-after": "120" },
      });
    });

    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath: join(directory, "target-intelligence.sqlite"),
        artifactDirectory: join(directory, "artifacts"),
        credentialBroker,
        fetch: fetchMock,
        clock: () => new Date("2030-08-01T00:00:00.000Z"),
      });

      const current = await refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      expect(current).toEqual({
        kind: "wordfence-intelligence-result",
        schemaVersion: 1,
        status: "current",
        snapshot: {
          kind: "wordfence-intelligence-snapshot",
          schemaVersion: 1,
          retrievedAt: "2030-08-01T00:00:00.000Z",
          source: {
            sourceUrl,
            contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
            parserVersion: "wordfence-intelligence-production-v3",
            recordCount: 2,
            complete: true,
          },
        },
        snapshotRef: {
          kind: "wordfence-intelligence-snapshot-ref",
          schemaVersion: 1,
          id: expect.stringMatching(/^wordfence-snapshot:[a-f0-9]{24}$/u),
          digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        },
      });

      const rateLimitedFailure = {
        kind: "wordfence-intelligence-result",
        schemaVersion: 1 as const,
        status: "failed" as const,
        reason: "rate-limited" as const,
        backoff: {
          kind: "wordfence-rate-limit-backoff" as const,
          schemaVersion: 2 as const,
          automaticRetries: 0,
          boundedAt: "2030-08-01T00:00:00.000Z",
          maximumDelaySeconds: 86_400,
          retryAfter: {
            kind: "delay-seconds" as const,
            seconds: 120,
            capped: false,
          },
        },
      };
      const rateLimited = await refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      expect(rateLimited).toEqual({
        ...current,
        status: "stale",
        latestRefresh: {
          kind: "wordfence-intelligence-refresh-attempt",
          schemaVersion: 1,
          attemptedAt: "2030-08-01T00:00:00.000Z",
          result: rateLimitedFailure,
        },
      });
      expect(wordfenceIntelligenceResultSchema.parse(rateLimited)).toEqual(
        rateLimited,
      );
      expect(wordfenceIntelligenceResultSchema.parse(current)).toEqual(current);
      const stale = await refresh.inspect({
        kind: "wordfence-intelligence-inspection",
        schemaVersion: 1,
      });
      expect(stale).toEqual(rateLimited);
      expect(wordfenceIntelligenceResultSchema.parse(stale)).toEqual(stale);

      const replayFetch = vi.fn<typeof fetch>(() =>
        Promise.reject(new Error("inspect must not access the network")),
      );
      const restarted = openWordfenceIntelligenceRefresh({
        databasePath: join(directory, "target-intelligence.sqlite"),
        artifactDirectory: join(directory, "artifacts"),
        credentialBroker,
        fetch: replayFetch,
      });
      const replayed = await restarted.inspect({
        kind: "wordfence-intelligence-inspection",
        schemaVersion: 1,
      });
      expect(replayed).toEqual(stale);
      expect(replayFetch).not.toHaveBeenCalled();

      expect(
        JSON.stringify([current, rateLimited, stale, replayed]),
      ).not.toContain(credential);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(resolutions).toEqual([
        { kind: "secret-ref", id: "wordfence-v3-api-key" },
        { kind: "secret-ref", id: "wordfence-v3-api-key" },
      ]);
      const persisted = await Promise.all(
        (await filesBelow(directory)).map((path) => readFile(path)),
      );
      expect(persisted.every((bytes) => !bytes.includes(credential))).toBe(
        true,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { signal: "HTTP 206", status: 206, headers: {} },
    {
      signal: "Content-Range",
      status: 200,
      headers: { "content-range": "bytes 0-1023/2048" },
    },
  ] as const)(
    "treats $signal as a partial response and preserves the prior current snapshot",
    async ({ status, headers }) => {
      const directory = await mkdtemp(
        join(tmpdir(), "wordfence-http-partial-"),
      );
      const bytes = await readFile(fixturePath);
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(bytes, { status: 200 }))
        .mockResolvedValueOnce(new Response(bytes, { status, headers }));
      let now = new Date("2030-08-01T00:00:00.000Z");
      try {
        const refresh = openWordfenceIntelligenceRefresh({
          databasePath: join(directory, "index", "target-intelligence.sqlite"),
          artifactDirectory: join(directory, "artifacts"),
          credentialBroker: {
            async resolve<T>(
              _reference: WordfenceSecretRef,
              use: (credential: string) => Promise<T>,
            ): Promise<T> {
              return use("synthetic-partial-response-credential");
            },
          },
          fetch: fetchMock,
          clock: () => now,
        });
        const current = await refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        });
        if (current.status !== "current") {
          throw new Error("Expected an initial current snapshot");
        }

        now = new Date("2030-08-02T00:00:00.000Z");
        const partial = await refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        });
        expect(partial).toEqual({
          ...current,
          status: "stale",
          latestRefresh: {
            kind: "wordfence-intelligence-refresh-attempt",
            schemaVersion: 1,
            attemptedAt: "2030-08-02T00:00:00.000Z",
            result: {
              kind: "wordfence-intelligence-result",
              schemaVersion: 1,
              status: "failed",
              reason: "partial-response",
            },
          },
        });
        await expect(
          refresh.inspect({
            kind: "wordfence-intelligence-inspection",
            schemaVersion: 1,
          }),
        ).resolves.toEqual(partial);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["Identity", "\t IDENTITY \t"])(
    "treats Content-Encoding %j as identity when enforcing response length",
    async (contentEncoding) => {
      const directory = await mkdtemp(
        join(tmpdir(), "wordfence-identity-length-"),
      );
      const bytes = await readFile(fixturePath);
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(bytes, { status: 200 }))
        .mockResolvedValueOnce(
          new Response(bytes, {
            status: 200,
            headers: {
              "content-encoding": contentEncoding,
              "content-length": String(bytes.byteLength + 1),
            },
          }),
        );
      try {
        const refresh = openWordfenceIntelligenceRefresh({
          databasePath: join(directory, "index", "target-intelligence.sqlite"),
          artifactDirectory: join(directory, "artifacts"),
          credentialBroker: {
            async resolve<T>(
              _reference: WordfenceSecretRef,
              use: (credential: string) => Promise<T>,
            ): Promise<T> {
              return use("synthetic-identity-length-credential");
            },
          },
          fetch: fetchMock,
        });
        const current = await refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        });
        if (current.status !== "current") {
          throw new Error("Expected an initial current snapshot");
        }

        const partial = await refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        });
        expect(partial).toMatchObject({
          status: "stale",
          snapshotRef: current.snapshotRef,
          latestRefresh: {
            result: { status: "failed", reason: "partial-response" },
          },
        });
        await expect(
          refresh.inspect({
            kind: "wordfence-intelligence-inspection",
            schemaVersion: 1,
          }),
        ).resolves.toEqual(partial);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("treats a body-stream failure after prefix bytes as a partial response", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-stream-partial-"),
    );
    const bytes = await readFile(fixturePath);
    let pullCount = 0;
    let cancellationAttempted = false;
    const partialResponse = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pullCount += 1;
          if (pullCount === 1) {
            controller.enqueue(bytes.subarray(0, 64));
            return;
          }
          throw new Error("synthetic body stream failure");
        },
      }),
      {
        status: 200,
        headers: { "content-length": String(bytes.byteLength) },
      },
    );
    const responseBody = partialResponse.body;
    if (responseBody === null) {
      throw new Error("Expected a response body");
    }
    const getReader = responseBody.getReader.bind(responseBody);
    Object.defineProperty(responseBody, "getReader", {
      configurable: true,
      value: () => {
        const reader = getReader();
        Object.defineProperty(reader, "cancel", {
          configurable: true,
          value: async () => {
            cancellationAttempted = true;
            throw new Error("synthetic cancellation cleanup failure");
          },
        });
        return reader;
      },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }))
      .mockResolvedValueOnce(partialResponse);
    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath: join(directory, "index", "target-intelligence.sqlite"),
        artifactDirectory: join(directory, "artifacts"),
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            return use("synthetic-stream-partial-credential");
          },
        },
        fetch: fetchMock,
      });
      const current = await refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      if (current.status !== "current") {
        throw new Error("Expected an initial current snapshot");
      }

      const partial = await refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      expect(partial).toMatchObject({
        status: "stale",
        snapshotRef: current.snapshotRef,
        latestRefresh: {
          result: { status: "failed", reason: "partial-response" },
        },
      });
      expect(cancellationAttempted).toBe(true);
      await expect(
        refresh.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toEqual(partial);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replays a production refresh interrupted after its durable start as stale", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-interrupted-refresh-"),
    );
    const databasePath = join(directory, "index", "target-intelligence.sqlite");
    const artifactDirectory = join(directory, "artifacts");
    const bytes = await readFile(fixturePath);
    const pendingFetch = controlledFetch();
    let now = new Date("2030-08-01T00:00:00.000Z");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }))
      .mockImplementationOnce(pendingFetch.fetch);
    const options = {
      databasePath,
      artifactDirectory,
      credentialBroker: {
        async resolve<T>(
          _reference: WordfenceSecretRef,
          use: (credential: string) => Promise<T>,
        ): Promise<T> {
          return use("synthetic-interrupted-refresh-credential");
        },
      },
      fetch: fetchMock,
      clock: () => now,
    };
    try {
      const refresh = openWordfenceIntelligenceRefresh(options);
      const current = await refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      if (current.status !== "current") {
        throw new Error("Expected an initial current snapshot");
      }

      now = new Date("2030-08-02T00:00:00.000Z");
      const interrupted = refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      await pendingFetch.started;

      const restarted = openWordfenceIntelligenceRefresh(options);
      await expect(
        restarted.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toEqual({
        ...current,
        status: "stale",
        latestRefresh: {
          kind: "wordfence-intelligence-refresh-attempt",
          schemaVersion: 1,
          attemptedAt: "2030-08-02T00:00:00.000Z",
          result: {
            kind: "wordfence-intelligence-result",
            schemaVersion: 1,
            status: "failed",
            reason: "storage-failure",
          },
        },
      });

      pendingFetch.respond(new Response(bytes, { status: 200 }));
      await expect(interrupted).resolves.toMatchObject({ status: "current" });
      await expect(
        restarted.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toMatchObject({ status: "current" });
    } finally {
      pendingFetch.respond(new Response(bytes, { status: 200 }));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not steal or fetch while a durable refresh attempt lease is live", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-live-refresh-lease-"),
    );
    const databasePath = join(directory, "target-intelligence.sqlite");
    const artifactDirectory = join(directory, "artifacts");
    const bytes = await readFile(fixturePath);
    const pendingFetch = controlledFetch();
    let now = new Date("2030-08-01T00:00:00.000Z");
    const credentialBroker: HostPrivateCredentialBroker = {
      async resolve<T>(
        _reference: WordfenceSecretRef,
        use: (credential: string) => Promise<T>,
      ): Promise<T> {
        return use("synthetic-live-refresh-lease-credential");
      },
    };
    const refresh = openWordfenceIntelligenceRefresh({
      databasePath,
      artifactDirectory,
      credentialBroker,
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(bytes, { status: 200 }))
        .mockImplementationOnce(pendingFetch.fetch),
      clock: () => now,
    });
    let pendingRun: Promise<unknown> | undefined;
    try {
      const current = await refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      if (current.status !== "current") {
        throw new Error("Expected an initial current snapshot");
      }
      now = new Date("2030-08-02T00:00:00.000Z");
      pendingRun = refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      await pendingFetch.started;

      now = new Date("2030-08-02T00:04:59.000Z");
      let resolveCalls = 0;
      const restartedFetch = vi.fn<typeof fetch>(async () =>
        Promise.resolve(new Response(bytes, { status: 200 })),
      );
      const restarted = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            resolveCalls += 1;
            return use("must-not-resolve-live-refresh-lease");
          },
        },
        fetch: restartedFetch,
        clock: () => now,
      });

      await expect(
        restarted.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).resolves.toEqual({
        ...current,
        status: "stale",
        latestRefresh: {
          kind: "wordfence-intelligence-refresh-attempt",
          schemaVersion: 1,
          attemptedAt: "2030-08-02T00:00:00.000Z",
          result: {
            kind: "wordfence-intelligence-result",
            schemaVersion: 1,
            status: "failed",
            reason: "storage-failure",
          },
        },
      });
      expect(resolveCalls).toBe(0);
      expect(restartedFetch).not.toHaveBeenCalled();

      pendingFetch.respond(new Response(bytes, { status: 200 }));
      await expect(pendingRun).resolves.toMatchObject({ status: "current" });
    } finally {
      pendingFetch.respond(new Response(bytes, { status: 200 }));
      await pendingRun?.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("terminalizes an expired orphan before a successful replacement refresh", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-expired-refresh-lease-"),
    );
    const databasePath = join(directory, "target-intelligence.sqlite");
    const artifactDirectory = join(directory, "artifacts");
    const bytes = await readFile(fixturePath);
    const pendingFetch = controlledFetch();
    let now = new Date("2030-08-01T00:00:00.000Z");
    const credentialBroker: HostPrivateCredentialBroker = {
      async resolve<T>(
        _reference: WordfenceSecretRef,
        use: (credential: string) => Promise<T>,
      ): Promise<T> {
        return use("synthetic-expired-refresh-lease-credential");
      },
    };
    const refresh = openWordfenceIntelligenceRefresh({
      databasePath,
      artifactDirectory,
      credentialBroker,
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(bytes, { status: 200 }))
        .mockImplementationOnce(pendingFetch.fetch),
      clock: () => now,
    });
    let orphanedRun: Promise<unknown> | undefined;
    try {
      const current = await refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      if (current.status !== "current") {
        throw new Error("Expected an initial current snapshot");
      }
      now = new Date("2030-08-02T00:00:00.000Z");
      orphanedRun = refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      await pendingFetch.started;

      now = new Date("2030-08-02T00:05:01.000Z");
      let resolveCalls = 0;
      const replacementFetch = vi.fn<typeof fetch>(async () =>
        Promise.resolve(new Response(bytes, { status: 200 })),
      );
      const restarted = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            resolveCalls += 1;
            return use("synthetic-replacement-refresh-credential");
          },
        },
        fetch: replacementFetch,
        clock: () => now,
      });
      const recovered = await restarted.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      expect(recovered).toMatchObject({ status: "current" });
      expect(resolveCalls).toBe(1);
      expect(replacementFetch).toHaveBeenCalledOnce();
      await expect(
        restarted.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toEqual(recovered);

      pendingFetch.respond(new Response(bytes, { status: 200 }));
      await expect(orphanedRun).rejects.toThrow(
        "Wordfence Intelligence snapshot conflict",
      );
    } finally {
      pendingFetch.respond(new Response(bytes, { status: 200 }));
      await orphanedRun?.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rolls back an interrupted orphan recovery transaction", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-interrupted-orphan-recovery-"),
    );
    const databasePath = join(directory, "target-intelligence.sqlite");
    const artifactDirectory = join(directory, "artifacts");
    const bytes = await readFile(fixturePath);
    const pendingFetch = controlledFetch();
    let now = new Date("2030-08-01T00:00:00.000Z");
    const credentialBroker: HostPrivateCredentialBroker = {
      async resolve<T>(
        _reference: WordfenceSecretRef,
        use: (credential: string) => Promise<T>,
      ): Promise<T> {
        return use("synthetic-interrupted-recovery-credential");
      },
    };
    const refresh = openWordfenceIntelligenceRefresh({
      databasePath,
      artifactDirectory,
      credentialBroker,
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(bytes, { status: 200 }))
        .mockImplementationOnce(pendingFetch.fetch),
      clock: () => now,
    });
    let orphanedRun: Promise<unknown> | undefined;
    try {
      const current = await refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      if (current.status !== "current") {
        throw new Error("Expected an initial current snapshot");
      }
      now = new Date("2030-08-02T00:00:00.000Z");
      orphanedRun = refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      await pendingFetch.started;
      const maximumSequence = Number.MAX_SAFE_INTEGER;
      const fault = new Database(databasePath);
      fault.transaction(() => {
        fault
          .prepare(
            `UPDATE wordfence_intelligence_refresh_attempts
                SET sequence = ?`,
          )
          .run(maximumSequence);
        fault
          .prepare(
            `UPDATE sqlite_sequence
                SET seq = ?
              WHERE name = 'wordfence_intelligence_refresh_attempts'`,
          )
          .run(maximumSequence);
        fault
          .prepare(
            `UPDATE wordfence_intelligence_refresh_order
                SET latest_completed_sequence = ?
              WHERE singleton = 1`,
          )
          .run(maximumSequence - 1);
        fault
          .prepare(
            `INSERT INTO wordfence_intelligence_refresh_state (
               singleton, state_json
             ) VALUES (1, ?)
             ON CONFLICT(singleton) DO UPDATE SET
               state_json = excluded.state_json`,
          )
          .run(
            canonicalFixtureJson({
              kind: "wordfence-intelligence-production-refresh-state",
              schemaVersion: 2,
              attemptSequence: maximumSequence - 1,
              currentSnapshotDigest: current.snapshotRef.digest,
              latestRefresh: {
                kind: "wordfence-intelligence-refresh-attempt",
                schemaVersion: 1,
                attemptedAt: "2030-08-01T23:59:59.000Z",
                result: {
                  kind: "wordfence-intelligence-result",
                  schemaVersion: 1,
                  status: "failed",
                  reason: "storage-failure",
                },
              },
            }),
          );
      })();
      fault.close();

      now = new Date("2030-08-02T00:05:01.000Z");
      let resolveCalls = 0;
      const replacementFetch = vi.fn<typeof fetch>(async () =>
        Promise.resolve(new Response(bytes, { status: 200 })),
      );
      const options = {
        databasePath,
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            resolveCalls += 1;
            return use("synthetic-recovery-after-crash-credential");
          },
        },
        fetch: replacementFetch,
        clock: () => now,
      };
      await expect(
        openWordfenceIntelligenceRefresh(options).run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).rejects.toThrow();
      expect(resolveCalls).toBe(0);
      expect(replacementFetch).not.toHaveBeenCalled();
      await expect(
        openWordfenceIntelligenceRefresh(options).inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toMatchObject({
        status: "stale",
        snapshotRef: current.snapshotRef,
        latestRefresh: {
          attemptedAt: "2030-08-02T00:00:00.000Z",
          result: { status: "failed", reason: "storage-failure" },
        },
      });

      const recovery = new Database(databasePath);
      recovery.transaction(() => {
        recovery
          .prepare(
            `UPDATE wordfence_intelligence_refresh_attempts
                SET sequence = 2
              WHERE sequence = ?`,
          )
          .run(maximumSequence);
        recovery
          .prepare(
            `UPDATE sqlite_sequence
                SET seq = 2
              WHERE name = 'wordfence_intelligence_refresh_attempts'`,
          )
          .run();
        recovery
          .prepare(
            `UPDATE wordfence_intelligence_refresh_order
                SET latest_completed_sequence = 1
              WHERE singleton = 1`,
          )
          .run();
        recovery.exec("DELETE FROM wordfence_intelligence_refresh_state");
      })();
      recovery.close();
      await expect(
        openWordfenceIntelligenceRefresh(options).run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).resolves.toMatchObject({ status: "current" });
      expect(resolveCalls).toBe(1);
      expect(replacementFetch).toHaveBeenCalledOnce();
    } finally {
      pendingFetch.respond(new Response(bytes, { status: 200 }));
      await orphanedRun?.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves an explicitly requested historical snapshot outside current freshness state", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-historical-production-inspection-"),
    );
    const databasePath = join(directory, "index", "target-intelligence.sqlite");
    const bytes = await readFile(fixturePath);
    let now = new Date("2030-08-01T00:00:00.000Z");
    const refresh = openWordfenceIntelligenceRefresh({
      databasePath,
      artifactDirectory: join(directory, "artifacts"),
      credentialBroker: {
        async resolve<T>(
          _reference: WordfenceSecretRef,
          use: (credential: string) => Promise<T>,
        ): Promise<T> {
          return use("synthetic-historical-inspection-credential");
        },
      },
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(bytes, { status: 200 }))
        .mockResolvedValueOnce(new Response(bytes, { status: 200 }))
        .mockResolvedValueOnce(new Response(undefined, { status: 404 })),
      clock: () => now,
    });
    try {
      const historical = await refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      if (historical.status !== "current") {
        throw new Error("Expected a historical snapshot");
      }
      now = new Date("2030-08-02T00:00:00.000Z");
      const current = await refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      if (current.status !== "current") {
        throw new Error("Expected a current snapshot");
      }
      now = new Date("2030-08-03T00:00:00.000Z");
      const stale = await refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      expect(stale).toMatchObject({
        status: "stale",
        snapshotRef: current.snapshotRef,
        latestRefresh: {
          result: { status: "failed", reason: "not-found" },
        },
      });
      await expect(
        refresh.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toEqual(stale);
      await expect(
        refresh.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
          snapshotRef: current.snapshotRef,
        }),
      ).resolves.toMatchObject({
        status: "stale",
        snapshotRef: current.snapshotRef,
      });

      await expect(
        refresh.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
          snapshotRef: historical.snapshotRef,
        }),
      ).resolves.toEqual(historical);

      const corruption = new Database(databasePath);
      corruption
        .prepare(
          `UPDATE wordfence_intelligence_record_set_manifests
              SET manifest_json = ?
            WHERE snapshot_digest = ?`,
        )
        .run("{}", historical.snapshotRef.digest);
      corruption.close();
      await expect(
        refresh.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
          snapshotRef: historical.snapshotRef,
        }),
      ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(
    (["current", "stale"] as const).flatMap((projection) =>
      (
        [
          "manifest table",
          "current manifest row",
          "current manifest digest",
        ] as const
      ).map((corruption) => [projection, corruption] as const),
    ),
  )(
    "rejects a $projection projection with a corrupted $corruption after restart",
    async (projection, corruption) => {
      const directory = await mkdtemp(
        join(tmpdir(), "wordfence-current-manifest-integrity-"),
      );
      const databasePath = join(directory, "target-intelligence.sqlite");
      const artifactDirectory = join(directory, "artifacts");
      const validBytes = await readFile(fixturePath);
      const credentialBroker: HostPrivateCredentialBroker = {
        async resolve<T>(
          _reference: WordfenceSecretRef,
          use: (credential: string) => Promise<T>,
        ): Promise<T> {
          return use("synthetic-current-manifest-integrity-credential");
        },
      };
      try {
        const seed = openWordfenceIntelligenceRefresh({
          databasePath,
          artifactDirectory,
          credentialBroker,
          fetch: vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(new Response(validBytes, { status: 200 }))
            .mockResolvedValueOnce(new Response(undefined, { status: 404 })),
        });
        const current = await seed.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        });
        if (current.status !== "current") {
          throw new Error("Expected a current snapshot");
        }
        if (projection === "stale") {
          await seed.run({
            kind: "wordfence-intelligence-refresh",
            schemaVersion: 1,
          });
        }

        const database = new Database(databasePath);
        if (corruption === "manifest table") {
          database.exec(
            "DROP TABLE wordfence_intelligence_record_set_manifests",
          );
        } else if (corruption === "current manifest row") {
          database
            .prepare(
              `DELETE FROM wordfence_intelligence_record_set_manifests
                     WHERE snapshot_digest = ?`,
            )
            .run(current.snapshotRef.digest);
        } else {
          database
            .prepare(
              `UPDATE wordfence_intelligence_record_set_manifests
                  SET manifest_json = ?
                WHERE snapshot_digest = ?`,
            )
            .run("{}", current.snapshotRef.digest);
        }
        database.close();
        let resolveCalls = 0;
        const fetchMock = vi.fn<typeof fetch>(async () =>
          Promise.resolve(new Response(validBytes, { status: 200 })),
        );
        const restarted = openWordfenceIntelligenceRefresh({
          databasePath,
          artifactDirectory,
          credentialBroker: {
            async resolve<T>(
              _reference: WordfenceSecretRef,
              use: (credential: string) => Promise<T>,
            ): Promise<T> {
              resolveCalls += 1;
              return use("must-not-resolve-corrupted-current-manifest");
            },
          },
          fetch: fetchMock,
        });

        await expect(
          restarted.inspect({
            kind: "wordfence-intelligence-inspection",
            schemaVersion: 1,
          }),
        ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
        await expect(
          restarted.run({
            kind: "wordfence-intelligence-refresh",
            schemaVersion: 1,
          }),
        ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
        expect(resolveCalls).toBe(0);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("keeps a pre-response connectivity failure distinct from a partial body", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-connectivity-failure-"),
    );
    const bytes = await readFile(fixturePath);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }))
      .mockRejectedValueOnce(new Error("synthetic connection failure"));
    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath: join(directory, "index", "target-intelligence.sqlite"),
        artifactDirectory: join(directory, "artifacts"),
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            return use("synthetic-connectivity-failure-credential");
          },
        },
        fetch: fetchMock,
      });
      const current = await refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      if (current.status !== "current") {
        throw new Error("Expected an initial current snapshot");
      }

      const disconnected = await refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      expect(disconnected).toMatchObject({
        status: "stale",
        snapshotRef: current.snapshotRef,
        latestRefresh: {
          result: { status: "failed", reason: "network-failure" },
        },
      });
      await expect(
        refresh.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toEqual(disconnected);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed UTF-8 without publishing or replacing the current snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wordfence-fatal-utf8-"));
    const bytes = await readFile(fixturePath);
    const malformed = Buffer.from(bytes);
    const slugOffset = malformed.indexOf("fixture-plugin");
    if (slugOffset < 0) {
      throw new Error("Expected the sanitized fixture slug");
    }
    malformed[slugOffset] = 0xff;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }))
      .mockResolvedValueOnce(new Response(malformed, { status: 200 }));
    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath: join(directory, "index", "target-intelligence.sqlite"),
        artifactDirectory: join(directory, "artifacts"),
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            return use("synthetic-fatal-utf8-credential");
          },
        },
        fetch: fetchMock,
      });
      const current = await refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      if (current.status !== "current") {
        throw new Error("Expected an initial current snapshot");
      }

      const malformedResult = await refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      expect(malformedResult).toMatchObject({
        status: "stale",
        snapshotRef: current.snapshotRef,
        latestRefresh: {
          result: { status: "failed", reason: "schema-drift" },
        },
      });
      await expect(
        refresh.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toEqual(malformedResult);
      expect(
        await readdir(
          join(directory, "artifacts", "wordfence-intelligence-v3"),
        ),
      ).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      status: 429,
      headers: { "retry-after": "120" },
      expected: {
        kind: "wordfence-intelligence-result",
        schemaVersion: 1,
        status: "failed",
        reason: "rate-limited",
        backoff: {
          kind: "wordfence-rate-limit-backoff",
          schemaVersion: 2,
          automaticRetries: 0,
          boundedAt: "2030-08-01T00:00:00.000Z",
          maximumDelaySeconds: 86_400,
          retryAfter: {
            kind: "delay-seconds",
            seconds: 120,
            capped: false,
          },
        },
      },
    },
    {
      status: 401,
      headers: {},
      expected: {
        kind: "wordfence-intelligence-result",
        schemaVersion: 1,
        status: "failed",
        reason: "authentication-failed",
      },
    },
  ] as const)(
    "replays an initial $expected.reason failure after restart",
    async ({ status, headers, expected }) => {
      const directory = await mkdtemp(
        join(tmpdir(), "wordfence-initial-failure-"),
      );
      const databasePath = join(directory, "target-intelligence.sqlite");
      const credentialBroker: HostPrivateCredentialBroker = {
        async resolve<T>(
          _reference: WordfenceSecretRef,
          use: (credential: string) => Promise<T>,
        ): Promise<T> {
          return use("synthetic-initial-failure-credential");
        },
      };
      try {
        const initial = openWordfenceIntelligenceRefresh({
          databasePath,
          artifactDirectory: join(directory, "artifacts"),
          credentialBroker,
          fetch: vi.fn<typeof fetch>(async () =>
            Promise.resolve(new Response(undefined, { status, headers })),
          ),
          clock: () => new Date("2030-08-01T00:00:00.000Z"),
        });
        await expect(
          initial.run({
            kind: "wordfence-intelligence-refresh",
            schemaVersion: 1,
          }),
        ).resolves.toEqual(expected);

        const replayFetch = vi.fn<typeof fetch>(() =>
          Promise.reject(new Error("inspection must not retrieve the feed")),
        );
        const restarted = openWordfenceIntelligenceRefresh({
          databasePath,
          artifactDirectory: join(directory, "artifacts"),
          credentialBroker,
          fetch: replayFetch,
        });
        await expect(
          restarted.inspect({
            kind: "wordfence-intelligence-inspection",
            schemaVersion: 1,
          }),
        ).resolves.toEqual(expected);
        expect(replayFetch).not.toHaveBeenCalled();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("does not publish a successful snapshot when schema drifts during retrieval", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-atomic-refresh-"),
    );
    const databasePath = join(directory, "target-intelligence.sqlite");
    const validBytes = await readFile(fixturePath);
    const seedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(validBytes, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(undefined, {
          status: 429,
          headers: { "retry-after": "120" },
        }),
      );
    const credentialBroker: HostPrivateCredentialBroker = {
      async resolve<T>(
        _reference: WordfenceSecretRef,
        use: (credential: string) => Promise<T>,
      ): Promise<T> {
        return use("synthetic-atomic-refresh-credential");
      },
    };
    try {
      const seed = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory: join(directory, "artifacts"),
        credentialBroker,
        fetch: seedFetch,
        clock: () => new Date("2030-08-01T00:00:00.000Z"),
      });
      await seed.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      await seed.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      const before = await seed.inspect({
        kind: "wordfence-intelligence-inspection",
        schemaVersion: 1,
      });
      expect(before.status).toBe("stale");

      const pendingFetch = controlledFetch();
      const attempted = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory: join(directory, "artifacts"),
        credentialBroker,
        fetch: pendingFetch.fetch,
        clock: () => new Date("2030-08-02T00:00:00.000Z"),
      });
      const completion = attempted.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      const rejected = expect(completion).rejects.toThrow(
        "Wordfence Intelligence snapshot conflict",
      );
      await pendingFetch.started;
      const failureInjection = new Database(databasePath);
      failureInjection.exec(`
        CREATE TRIGGER reject_refresh_state_cleanup
        BEFORE DELETE ON wordfence_intelligence_refresh_state
        BEGIN
          SELECT RAISE(ABORT, 'synthetic freshness-state commit failure');
        END
      `);
      failureInjection.close();
      pendingFetch.respond(new Response(validBytes, { status: 200 }));
      await rejected;

      const cleanup = new Database(databasePath);
      cleanup.exec("DROP TRIGGER reject_refresh_state_cleanup");
      cleanup.close();
      await expect(
        attempted.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toEqual({
        ...before,
        latestRefresh: {
          kind: "wordfence-intelligence-refresh-attempt",
          schemaVersion: 1,
          attemptedAt: "2030-08-02T00:00:00.000Z",
          result: {
            kind: "wordfence-intelligence-result",
            schemaVersion: 1,
            status: "failed",
            reason: "storage-failure",
          },
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { mutation: "missing token", outcome: "success" },
    { mutation: "missing token", outcome: "failure" },
    { mutation: "mismatched token", outcome: "success" },
    { mutation: "mismatched token", outcome: "failure" },
  ] as const)(
    "rejects $outcome completion with a $mutation",
    async ({ mutation, outcome }) => {
      const directory = await mkdtemp(
        join(tmpdir(), "wordfence-refresh-token-integrity-"),
      );
      const databasePath = join(directory, "target-intelligence.sqlite");
      const artifactDirectory = join(directory, "artifacts");
      const validBytes = await readFile(fixturePath);
      const pendingFetch = controlledFetch();
      const credentialBroker: HostPrivateCredentialBroker = {
        async resolve<T>(
          _reference: WordfenceSecretRef,
          use: (credential: string) => Promise<T>,
        ): Promise<T> {
          return use("synthetic-refresh-token-integrity-credential");
        },
      };
      const options = {
        databasePath,
        artifactDirectory,
        credentialBroker,
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(validBytes, { status: 200 }))
          .mockImplementationOnce(pendingFetch.fetch),
        clock: () => new Date("2030-08-01T00:00:00.000Z"),
      };
      try {
        const refresh = openWordfenceIntelligenceRefresh(options);
        const current = await refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        });
        if (current.status !== "current") {
          throw new Error("Expected an initial current snapshot");
        }
        const completion = refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        });
        await pendingFetch.started;

        const corruption = new Database(databasePath);
        if (mutation === "missing token") {
          corruption.exec(
            "DELETE FROM wordfence_intelligence_refresh_attempts",
          );
        } else {
          corruption
            .prepare(
              `UPDATE wordfence_intelligence_refresh_attempts
                  SET attempted_at = ?`,
            )
            .run("2030-08-09T00:00:00.000Z");
        }
        corruption.close();
        pendingFetch.respond(
          outcome === "success"
            ? new Response(validBytes, { status: 200 })
            : new Response(undefined, { status: 404 }),
        );

        await expect(completion).rejects.toThrow(
          "Wordfence Intelligence snapshot conflict",
        );
        if (mutation === "missing token") {
          let resolveCalls = 0;
          const restartedFetch = vi.fn<typeof fetch>(async () =>
            Promise.resolve(new Response(validBytes, { status: 200 })),
          );
          const restarted = openWordfenceIntelligenceRefresh({
            ...options,
            credentialBroker: {
              async resolve<T>(
                _reference: WordfenceSecretRef,
                use: (credential: string) => Promise<T>,
              ): Promise<T> {
                resolveCalls += 1;
                return use("must-not-resolve-deleted-attempt-credential");
              },
            },
            fetch: restartedFetch,
          });
          await expect(
            restarted.inspect({
              kind: "wordfence-intelligence-inspection",
              schemaVersion: 1,
            }),
          ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
          await expect(
            restarted.run({
              kind: "wordfence-intelligence-refresh",
              schemaVersion: 1,
            }),
          ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
          expect(resolveCalls).toBe(0);
          expect(restartedFetch).not.toHaveBeenCalled();
        } else {
          await expect(
            openWordfenceIntelligenceRefresh(options).inspect({
              kind: "wordfence-intelligence-inspection",
              schemaVersion: 1,
            }),
          ).resolves.toMatchObject({
            snapshotRef: current.snapshotRef,
            status: "stale",
          });
        }
      } finally {
        pendingFetch.respond(new Response(validBytes, { status: 200 }));
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects a missing refresh order bound to sequenced stale state before retrieval", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-missing-sequenced-refresh-order-"),
    );
    const databasePath = join(directory, "target-intelligence.sqlite");
    const artifactDirectory = join(directory, "artifacts");
    const validBytes = await readFile(fixturePath);
    const credentialBroker: HostPrivateCredentialBroker = {
      async resolve<T>(
        _reference: WordfenceSecretRef,
        use: (credential: string) => Promise<T>,
      ): Promise<T> {
        return use("synthetic-missing-sequenced-order-credential");
      },
    };
    try {
      const seed = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory,
        credentialBroker,
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(validBytes, { status: 200 }))
          .mockResolvedValueOnce(new Response(undefined, { status: 404 })),
        clock: () => new Date("2030-08-01T00:00:00.000Z"),
      });
      await seed.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      await seed.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });

      const corruption = new Database(databasePath);
      corruption.exec("DELETE FROM wordfence_intelligence_refresh_order");
      corruption.close();
      let resolveCalls = 0;
      const fetchMock = vi.fn<typeof fetch>(async () =>
        Promise.resolve(new Response(validBytes, { status: 200 })),
      );
      const restarted = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            resolveCalls += 1;
            return use("must-not-resolve-missing-order-credential");
          },
        },
        fetch: fetchMock,
        clock: () => new Date("2030-08-02T00:00:00.000Z"),
      });

      await expect(
        restarted.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
      await expect(
        restarted.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
      expect(resolveCalls).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
      await expect(
        restarted.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a refresh order removed from a live production composition without repair", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-live-missing-refresh-order-"),
    );
    const databasePath = join(directory, "target-intelligence.sqlite");
    const artifactDirectory = join(directory, "artifacts");
    const validBytes = await readFile(fixturePath);
    let resolveCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Promise.resolve(new Response(validBytes, { status: 200 })),
    );
    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            resolveCalls += 1;
            return use("synthetic-live-missing-order-credential");
          },
        },
        fetch: fetchMock,
      });
      await refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      expect(resolveCalls).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const corruption = new Database(databasePath);
      corruption.exec("DELETE FROM wordfence_intelligence_refresh_order");
      corruption.close();

      await expect(
        refresh.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
      await expect(
        refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
      expect(resolveCalls).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      missing: "refresh order",
      corrupt: "DELETE FROM wordfence_intelligence_refresh_order",
    },
    {
      missing: "refresh order and allocator",
      corrupt: `DELETE FROM wordfence_intelligence_refresh_order;
                DELETE FROM sqlite_sequence
                 WHERE name = 'wordfence_intelligence_refresh_attempts'`,
    },
    {
      missing: "production storage format marker",
      corrupt: "DELETE FROM wordfence_intelligence_production_storage",
    },
    {
      missing: "required refresh-state table",
      corrupt: "DROP TABLE wordfence_intelligence_refresh_state",
    },
  ] as const)(
    "rejects a missing $missing on fresh open",
    async ({ corrupt }) => {
      const directory = await mkdtemp(
        join(tmpdir(), "wordfence-missing-production-format-marker-"),
      );
      const databasePath = join(directory, "target-intelligence.sqlite");
      const artifactDirectory = join(directory, "artifacts");
      const validBytes = await readFile(fixturePath);
      try {
        const seed = openWordfenceIntelligenceRefresh({
          databasePath,
          artifactDirectory,
          credentialBroker: {
            async resolve<T>(
              _reference: WordfenceSecretRef,
              use: (credential: string) => Promise<T>,
            ): Promise<T> {
              return use("synthetic-production-format-marker-credential");
            },
          },
          fetch: vi.fn<typeof fetch>(async () =>
            Promise.resolve(new Response(validBytes, { status: 200 })),
          ),
        });
        await seed.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        });

        const corruption = new Database(databasePath);
        corruption.exec(corrupt);
        corruption.close();
        let resolveCalls = 0;
        const fetchMock = vi.fn<typeof fetch>(async () =>
          Promise.resolve(new Response(validBytes, { status: 200 })),
        );
        const restarted = openWordfenceIntelligenceRefresh({
          databasePath,
          artifactDirectory,
          credentialBroker: {
            async resolve<T>(
              _reference: WordfenceSecretRef,
              use: (credential: string) => Promise<T>,
            ): Promise<T> {
              resolveCalls += 1;
              return use("must-not-resolve-without-production-format-marker");
            },
          },
          fetch: fetchMock,
        });

        await expect(
          restarted.inspect({
            kind: "wordfence-intelligence-inspection",
            schemaVersion: 1,
          }),
        ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
        await expect(
          restarted.run({
            kind: "wordfence-intelligence-refresh",
            schemaVersion: 1,
          }),
        ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
        expect(resolveCalls).toBe(0);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    {
      corruption: "versioned marker",
      sql: `UPDATE wordfence_intelligence_production_storage
               SET format_json = '{}'
             WHERE singleton = 1`,
    },
    {
      corruption: "unknown trigger",
      sql: `CREATE TRIGGER unexpected_wordfence_trigger
            AFTER INSERT ON wordfence_intelligence_snapshots
            BEGIN
              SELECT 1;
            END`,
    },
    {
      corruption: "unknown view",
      sql: `CREATE VIEW unexpected_wordfence_view AS
            SELECT snapshot_digest
              FROM wordfence_intelligence_snapshots`,
    },
    {
      corruption: "unknown index",
      sql: `CREATE INDEX unexpected_wordfence_index
              ON wordfence_intelligence_snapshots (snapshot_id)`,
    },
  ] as const)(
    "rejects live $corruption drift before retrieval without repair",
    async ({ sql }) => {
      const directory = await mkdtemp(
        join(tmpdir(), "wordfence-live-schema-drift-"),
      );
      const databasePath = join(directory, "target-intelligence.sqlite");
      let resolveCalls = 0;
      const fetchMock = vi.fn<typeof fetch>(async () =>
        Promise.resolve(
          new Response(await readFile(fixturePath), { status: 200 }),
        ),
      );
      try {
        const refresh = openWordfenceIntelligenceRefresh({
          databasePath,
          artifactDirectory: join(directory, "artifacts"),
          credentialBroker: {
            async resolve<T>(
              _reference: WordfenceSecretRef,
              use: (credential: string) => Promise<T>,
            ): Promise<T> {
              resolveCalls += 1;
              return use("must-not-resolve-live-schema-drift");
            },
          },
          fetch: fetchMock,
        });
        await expect(
          refresh.inspect({
            kind: "wordfence-intelligence-inspection",
            schemaVersion: 1,
          }),
        ).resolves.toMatchObject({ status: "failed", reason: "not-refreshed" });

        const corruption = new Database(databasePath);
        corruption.exec(sql);
        corruption.close();

        await expect(
          refresh.inspect({
            kind: "wordfence-intelligence-inspection",
            schemaVersion: 1,
          }),
        ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
        await expect(
          refresh.run({
            kind: "wordfence-intelligence-refresh",
            schemaVersion: 1,
          }),
        ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
        expect(resolveCalls).toBe(0);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects a missing refresh order with an active attempt before retrieval", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-missing-active-refresh-order-"),
    );
    const databasePath = join(directory, "target-intelligence.sqlite");
    const artifactDirectory = join(directory, "artifacts");
    const validBytes = await readFile(fixturePath);
    const pendingFetch = controlledFetch();
    const credentialBroker: HostPrivateCredentialBroker = {
      async resolve<T>(
        _reference: WordfenceSecretRef,
        use: (credential: string) => Promise<T>,
      ): Promise<T> {
        return use("synthetic-missing-active-order-credential");
      },
    };
    let pendingRun: Promise<unknown> | undefined;
    try {
      const seed = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory,
        credentialBroker,
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(validBytes, { status: 200 }))
          .mockImplementationOnce(pendingFetch.fetch),
        clock: () => new Date("2030-08-01T00:00:00.000Z"),
      });
      await seed.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      pendingRun = seed.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      await pendingFetch.started;

      const corruption = new Database(databasePath);
      corruption.exec("DELETE FROM wordfence_intelligence_refresh_order");
      corruption.close();
      let resolveCalls = 0;
      const fetchMock = vi.fn<typeof fetch>(async () =>
        Promise.resolve(new Response(validBytes, { status: 200 })),
      );
      const restarted = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            resolveCalls += 1;
            return use("must-not-resolve-missing-order-credential");
          },
        },
        fetch: fetchMock,
        clock: () => new Date("2030-08-02T00:00:00.000Z"),
      });

      await expect(
        restarted.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
      await expect(
        restarted.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
      expect(resolveCalls).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
      await expect(
        restarted.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
    } finally {
      pendingFetch.respond(new Response(undefined, { status: 404 }));
      await pendingRun?.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a refresh order above the allocated sequence high-water", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-refresh-order-over-allocation-"),
    );
    const databasePath = join(directory, "target-intelligence.sqlite");
    const artifactDirectory = join(directory, "artifacts");
    const validBytes = await readFile(fixturePath);
    const credentialBroker: HostPrivateCredentialBroker = {
      async resolve<T>(
        _reference: WordfenceSecretRef,
        use: (credential: string) => Promise<T>,
      ): Promise<T> {
        return use("synthetic-order-over-allocation-credential");
      },
    };
    try {
      const seed = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory,
        credentialBroker,
        fetch: vi.fn<typeof fetch>(async () =>
          Promise.resolve(new Response(validBytes, { status: 200 })),
        ),
      });
      await seed.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });

      const corruption = new Database(databasePath);
      corruption
        .prepare(
          `UPDATE wordfence_intelligence_refresh_order
              SET publication_sequence = 100,
                  latest_completed_sequence = 100
            WHERE singleton = 1`,
        )
        .run();
      corruption.close();
      let resolveCalls = 0;
      const fetchMock = vi.fn<typeof fetch>(async () =>
        Promise.resolve(new Response(validBytes, { status: 200 })),
      );
      const restarted = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            resolveCalls += 1;
            return use("must-not-resolve-over-allocation-credential");
          },
        },
        fetch: fetchMock,
      });

      await expect(
        restarted.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
      await expect(
        restarted.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
      expect(resolveCalls).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a missing intermediate active refresh sequence", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-missing-active-refresh-sequence-"),
    );
    const databasePath = join(directory, "target-intelligence.sqlite");
    const artifactDirectory = join(directory, "artifacts");
    const validBytes = await readFile(fixturePath);
    try {
      const seed = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            return use("synthetic-missing-active-sequence-credential");
          },
        },
        fetch: vi.fn<typeof fetch>(async () =>
          Promise.resolve(new Response(validBytes, { status: 200 })),
        ),
        clock: () => new Date("2030-08-01T00:00:00.000Z"),
      });
      const current = await seed.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      if (current.status !== "current") {
        throw new Error("Expected an initial current snapshot");
      }

      const corruption = new Database(databasePath);
      const insertAttempt = corruption.prepare(
        `INSERT INTO wordfence_intelligence_refresh_attempts (
           sequence, attempted_at, current_snapshot_digest
         ) VALUES (?, ?, ?)`,
      );
      const corruptLedger = corruption.transaction(() => {
        insertAttempt.run(
          2,
          "2030-08-02T00:00:00.000Z",
          current.snapshotRef.digest,
        );
        insertAttempt.run(
          3,
          "2030-08-02T00:01:00.000Z",
          current.snapshotRef.digest,
        );
        insertAttempt.run(
          4,
          "2030-08-02T00:02:00.000Z",
          current.snapshotRef.digest,
        );
        corruption
          .prepare(
            `DELETE FROM wordfence_intelligence_refresh_attempts
                   WHERE sequence = 3`,
          )
          .run();
      });
      corruptLedger.immediate();
      corruption.close();

      let resolveCalls = 0;
      const restartedFetch = vi.fn<typeof fetch>(async () =>
        Promise.resolve(new Response(validBytes, { status: 200 })),
      );
      const restarted = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            resolveCalls += 1;
            return use("must-not-resolve-missing-sequence-credential");
          },
        },
        fetch: restartedFetch,
        clock: () => new Date("2030-08-02T00:03:00.000Z"),
      });

      await expect(
        restarted.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
      await expect(
        restarted.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
      expect(resolveCalls).toBe(0);
      expect(restartedFetch).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a missing sequenced failure state while an older attempt is active", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-missing-failure-state-"),
    );
    const databasePath = join(directory, "target-intelligence.sqlite");
    const artifactDirectory = join(directory, "artifacts");
    const validBytes = await readFile(fixturePath);
    let now = "2030-08-01T00:00:00.000Z";
    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            return use("synthetic-missing-failure-state-credential");
          },
        },
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(validBytes, { status: 200 }))
          .mockResolvedValueOnce(new Response(undefined, { status: 404 }))
          .mockResolvedValueOnce(new Response(undefined, { status: 404 })),
        clock: () => new Date(now),
      });
      const current = await refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      if (current.status !== "current") {
        throw new Error("Expected an initial current snapshot");
      }
      now = "2030-08-02T00:00:00.000Z";
      await refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      now = "2030-08-03T00:00:00.000Z";
      await refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });

      const corruption = new Database(databasePath);
      corruption
        .prepare(
          `INSERT INTO wordfence_intelligence_refresh_attempts (
             sequence, attempted_at, current_snapshot_digest
           ) VALUES (2, ?, ?)`,
        )
        .run("2030-08-02T00:00:00.000Z", current.snapshotRef.digest);
      corruption.close();

      await expect(
        openWordfenceIntelligenceRefresh({
          databasePath,
          artifactDirectory,
          credentialBroker: {
            async resolve<T>(): Promise<T> {
              throw new Error("inspection must not resolve a credential");
            },
          },
          clock: () => new Date("2030-08-03T00:01:00.000Z"),
        }).inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toMatchObject({
        status: "stale",
        snapshotRef: current.snapshotRef,
      });

      const missingState = new Database(databasePath);
      missingState.exec("DELETE FROM wordfence_intelligence_refresh_state");
      missingState.close();

      let resolveCalls = 0;
      const restartedFetch = vi.fn<typeof fetch>(async () =>
        Promise.resolve(new Response(validBytes, { status: 200 })),
      );
      const restarted = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            resolveCalls += 1;
            return use("must-not-resolve-missing-state-credential");
          },
        },
        fetch: restartedFetch,
        clock: () => new Date("2030-08-04T00:00:00.000Z"),
      });

      await expect(
        restarted.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
      await expect(
        restarted.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).rejects.toThrow("Wordfence Intelligence snapshot conflict");
      expect(resolveCalls).toBe(0);
      expect(restartedFetch).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("initializes durable production ordering for a new store", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-new-refresh-order-initialization-"),
    );
    const databasePath = join(directory, "target-intelligence.sqlite");
    const artifactDirectory = join(directory, "artifacts");
    const validBytes = await readFile(fixturePath);
    const credentialBroker: HostPrivateCredentialBroker = {
      async resolve<T>(
        _reference: WordfenceSecretRef,
        use: (credential: string) => Promise<T>,
      ): Promise<T> {
        return use("synthetic-safe-order-initialization-credential");
      },
    };
    try {
      let resolveCalls = 0;
      const fetchMock = vi.fn<typeof fetch>(async () =>
        Promise.resolve(new Response(validBytes, { status: 200 })),
      );
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory,
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            resolveCalls += 1;
            return use("synthetic-safe-order-initialization-credential");
          },
        },
        fetch: fetchMock,
        clock: () => new Date("2030-08-02T00:00:00.000Z"),
      });

      const published = await refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      expect(published).toMatchObject({ status: "current" });
      expect(resolveCalls).toBe(1);
      expect(fetchMock).toHaveBeenCalledOnce();
      const restarted = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory,
        credentialBroker,
        fetch: vi.fn<typeof fetch>(() =>
          Promise.reject(new Error("inspection must not retrieve the feed")),
        ),
      });
      await expect(
        restarted.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        }),
      ).resolves.toEqual(published);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("inspects the snapshot and freshness marker from one committed state", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wordfence-consistent-inspection-"),
    );
    const databasePath = join(directory, "target-intelligence.sqlite");
    const validBytes = await readFile(fixturePath);
    let now = "2030-08-02T00:00:00.000Z";
    const credentialBroker: HostPrivateCredentialBroker = {
      async resolve<T>(
        _reference: WordfenceSecretRef,
        use: (credential: string) => Promise<T>,
      ): Promise<T> {
        return use("synthetic-consistent-inspection-credential");
      },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(validBytes, { status: 200 }))
      .mockResolvedValueOnce(new Response(validBytes, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(undefined, {
          status: 429,
          headers: { "retry-after": "120" },
        }),
      );
    try {
      const writer = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory: join(directory, "artifacts"),
        credentialBroker,
        fetch: fetchMock,
        clock: () => new Date(now),
      });
      const replacement = await writer.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      expect(replacement.status).toBe("current");
      if (replacement.status !== "current") {
        throw new Error("Expected a replacement snapshot");
      }
      now = "2030-08-01T00:00:00.000Z";
      await writer.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      now = "2030-08-03T00:00:00.000Z";
      await writer.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });

      const reader = openWordfenceIntelligenceRefresh({
        databasePath,
        artifactDirectory: join(directory, "artifacts"),
        credentialBroker,
        fetch: vi.fn<typeof fetch>(() =>
          Promise.reject(new Error("inspection must not retrieve the feed")),
        ),
      });
      const stale = await reader.inspect({
        kind: "wordfence-intelligence-inspection",
        schemaVersion: 1,
      });
      expect(stale.status).toBe("stale");

      const concurrentPublication = new Database(databasePath);
      let observed: Awaited<ReturnType<typeof reader.inspect>>;
      try {
        const publishReplacement = concurrentPublication.transaction(() => {
          concurrentPublication
            .prepare(
              `UPDATE wordfence_intelligence_current
                  SET snapshot_digest = ?
                WHERE singleton = 1`,
            )
            .run(replacement.snapshotRef.digest);
          concurrentPublication
            .prepare(
              `DELETE FROM wordfence_intelligence_refresh_state
               WHERE singleton = 1`,
            )
            .run();
          concurrentPublication
            .prepare(
              `UPDATE wordfence_intelligence_refresh_order
                  SET publication_sequence = 4,
                      latest_completed_sequence = 4
                WHERE singleton = 1`,
            )
            .run();
          concurrentPublication
            .prepare(
              `UPDATE sqlite_sequence
                  SET seq = 4
                WHERE name = 'wordfence_intelligence_refresh_attempts'`,
            )
            .run();
        });
        const inspection = reader.inspect({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        });
        const publication = Promise.resolve().then(() => {
          publishReplacement.immediate();
        });
        [observed] = await Promise.all([inspection, publication]);
      } finally {
        concurrentPublication.close();
      }

      expect([stale, replacement]).toContainEqual(observed);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      retryAfter: "999999999999999999999999999999",
      expected: {
        kind: "delay-seconds",
        seconds: 86_400,
        capped: true,
      },
    },
    {
      retryAfter: "Thu, 01 Jan 2099 00:00:00 GMT",
      expected: {
        kind: "absolute-time",
        at: "2030-08-02T00:00:00.000Z",
        capped: true,
      },
    },
  ] as const)(
    "bounds Retry-After $retryAfter without an automatic retry",
    async ({ retryAfter, expected }) => {
      const directory = await mkdtemp(join(tmpdir(), "wordfence-backoff-"));
      const fetchMock = vi.fn<typeof fetch>(async () =>
        Promise.resolve(
          new Response(undefined, {
            status: 429,
            headers: { "retry-after": retryAfter },
          }),
        ),
      );
      try {
        const refresh = openWordfenceIntelligenceRefresh({
          databasePath: join(directory, "target-intelligence.sqlite"),
          artifactDirectory: join(directory, "artifacts"),
          credentialBroker: {
            async resolve<T>(
              _reference: WordfenceSecretRef,
              use: (credential: string) => Promise<T>,
            ): Promise<T> {
              return use("synthetic-bounded-backoff-credential");
            },
          },
          fetch: fetchMock,
          clock: () => new Date("2030-08-01T00:00:00.000Z"),
        });

        await expect(
          refresh.run({
            kind: "wordfence-intelligence-refresh",
            schemaVersion: 1,
          }),
        ).resolves.toEqual({
          kind: "wordfence-intelligence-result",
          schemaVersion: 1,
          status: "failed",
          reason: "rate-limited",
          backoff: {
            kind: "wordfence-rate-limit-backoff",
            schemaVersion: 2,
            automaticRetries: 0,
            boundedAt: "2030-08-01T00:00:00.000Z",
            maximumDelaySeconds: 86_400,
            retryAfter: expected,
          },
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("reports the response byte ceiling separately from a partial response", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wordfence-byte-ceiling-"));
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(await readFile(fixturePath), { status: 200 }),
      ),
    );
    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath: join(directory, "target-intelligence.sqlite"),
        artifactDirectory: join(directory, "artifacts"),
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            return use("synthetic-byte-ceiling-credential");
          },
        },
        maximumFeedBytes: 1,
        fetch: fetchMock,
      });

      await expect(
        refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).resolves.toEqual({
        kind: "wordfence-intelligence-result",
        schemaVersion: 1,
        status: "failed",
        reason: "response-byte-ceiling-exceeded",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves the response byte ceiling when stream cancellation fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wordfence-byte-ceiling-"));
    let cancellationAttempted = false;
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2]));
            },
            cancel() {
              cancellationAttempted = true;
              throw new Error("synthetic cancellation cleanup failure");
            },
          }),
          { status: 200 },
        ),
      ),
    );
    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath: join(directory, "target-intelligence.sqlite"),
        artifactDirectory: join(directory, "artifacts"),
        credentialBroker: {
          async resolve<T>(
            _reference: WordfenceSecretRef,
            use: (credential: string) => Promise<T>,
          ): Promise<T> {
            return use("synthetic-cancel-failure-credential");
          },
        },
        maximumFeedBytes: 1,
        fetch: fetchMock,
      });

      await expect(
        refresh.run({
          kind: "wordfence-intelligence-refresh",
          schemaVersion: 1,
        }),
      ).resolves.toEqual({
        kind: "wordfence-intelligence-result",
        schemaVersion: 1,
        status: "failed",
        reason: "response-byte-ceiling-exceeded",
      });
      expect(cancellationAttempted).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("sanitizes credential-broker errors from public results, logs, and storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wordfence-secret-error-"));
    const credential = "synthetic-secret-only-present-in-broker-error";
    const logged: unknown[][] = [];
    const consoleSpies = [
      vi.spyOn(console, "debug").mockImplementation((...values) => {
        logged.push(values);
      }),
      vi.spyOn(console, "info").mockImplementation((...values) => {
        logged.push(values);
      }),
      vi.spyOn(console, "log").mockImplementation((...values) => {
        logged.push(values);
      }),
      vi.spyOn(console, "warn").mockImplementation((...values) => {
        logged.push(values);
      }),
      vi.spyOn(console, "error").mockImplementation((...values) => {
        logged.push(values);
      }),
    ];
    try {
      const refresh = openWordfenceIntelligenceRefresh({
        databasePath: join(directory, "target-intelligence.sqlite"),
        artifactDirectory: join(directory, "artifacts"),
        credentialBroker: {
          async resolve<T>(): Promise<T> {
            throw new Error(`broker failed while handling ${credential}`);
          },
        },
      });

      const result = await refresh.run({
        kind: "wordfence-intelligence-refresh",
        schemaVersion: 1,
      });
      expect(result).toEqual({
        kind: "wordfence-intelligence-result",
        schemaVersion: 1,
        status: "failed",
        reason: "credential-unavailable",
      });
      expect(JSON.stringify(result)).not.toContain(credential);
      expect(logged.flat().map(String).join("\n")).not.toContain(credential);
      const persisted = await Promise.all(
        (await filesBelow(directory)).map((path) => readFile(path)),
      );
      expect(persisted.every((bytes) => !bytes.includes(credential))).toBe(
        true,
      );
    } finally {
      for (const spy of consoleSpies) {
        spy.mockRestore();
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
