import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { sha256Digest } from "../acquisition/canonical-json.js";
import {
  WordfenceKnownRecordAccessError,
  wordfenceIntelligenceFailure as failure,
  knownRecordAccessAuthorizationSchema,
  wordfenceIntelligenceInspectionRequestSchema,
  wordfenceIntelligenceRefreshRequestSchema,
  wordfenceIntelligenceResultSchema,
  wordfenceIntelligenceSnapshotSchema,
  wordfenceIntelligenceSourceResponseSchema,
  wordfenceKnownRecordInspectionRequestSchema,
  wordfenceSecretRefSchema,
  type OpenWordfenceIntelligenceRefreshOptions,
  type OpenWordfenceIntelligenceOptions,
  type KnownRecordAccessAuthorization,
  type KnownRecordAccessAuthorizationRef,
  type VulnerabilityHistoryAggregate,
  type VulnerabilityHistoryAggregateRequest,
  type WordfenceIntelligence,
  type WordfenceIntelligenceFailure,
  type WordfenceIntelligenceInspectionRequest,
  type WordfenceIntelligenceRefreshRequest,
  type WordfenceIntelligenceResult,
  type WordfenceIntelligenceRefresh,
  type WordfenceIntelligenceSourceResponse,
  type WordfenceIntelligenceV3Adapter,
  type WordfenceKnownRecordInspectionRequest,
  type WordfenceKnownRecordProjection,
  type WordfenceRateLimitBackoff,
  type WordfenceSecretRef,
} from "./contracts.js";
import { currentOwnerUid } from "./owner-identity.js";
import {
  CredentialUnavailableError,
  PartialResponseError,
  ResponseTooLargeError,
  createWordfenceIntelligenceV3FetchAdapter,
  unspecifiedRateLimitBackoff,
} from "./fetch-adapter.js";
import { AttributionMissingError, normalizeFeed } from "./plugin-records.js";
import {
  HostPrivateStorageError,
  rawDigest,
  persistBytes,
  isStorageFailure,
  type PinnedHostPrivateDirectory,
  prepareProductionStorage,
  requireProductionStorage,
  verifyStoredArtifact,
  requireProductionIndexIdentity,
  type ProductionIndexIdentity,
  secureCreatedSqliteSidecars,
  productionIndexIdentity,
  requirePreparedIndexIdentity,
} from "./host-private-storage.js";
import {
  SnapshotConflictError,
  snapshotReference,
  type ProductionRefreshAttemptToken,
} from "./storage-format.js";
import {
  WordfenceSnapshotStore,
  type WordfenceStorageOpenMode,
} from "./snapshot-store.js";
export { createWordfenceIntelligenceV3FetchAdapter } from "./fetch-adapter.js";

const DEFAULT_MAXIMUM_FEED_BYTES = 256_000_000;

function maximumFeedBytes(value: number | undefined): number {
  const maximum = value ?? DEFAULT_MAXIMUM_FEED_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new Error("maximumFeedBytes must be a positive safe integer");
  }
  return maximum;
}

function responseFailure(
  response: WordfenceIntelligenceSourceResponse,
  clock: () => Date,
): WordfenceIntelligenceFailure | undefined {
  const { status } = response;
  if (status === 401 || status === 403) {
    return failure("authentication-failed");
  }
  if (status === 404) {
    return failure("not-found");
  }
  if (status === 429) {
    return failure(
      "rate-limited",
      response.backoff ?? unspecifiedRateLimitBackoff(clock()),
    );
  }
  if (status < 200 || status >= 300) {
    return failure("network-failure");
  }
  return undefined;
}

class SqliteWordfenceIntelligence implements WordfenceIntelligence {
  readonly #artifactDirectory: string;
  readonly #adapter: WordfenceIntelligenceV3Adapter;
  readonly #credential: WordfenceSecretRef;
  readonly #maximumFeedBytes: number;
  readonly #knownRecordAuthorizationProvider: OpenWordfenceIntelligenceOptions["knownRecordAuthorizationProvider"];
  readonly #clock: () => Date;
  readonly #productionComposition: boolean;
  readonly #store: WordfenceSnapshotStore;

  constructor(
    options: OpenWordfenceIntelligenceOptions,
    storageOpenMode: WordfenceStorageOpenMode = "local",
  ) {
    this.#artifactDirectory = options.artifactDirectory;
    this.#adapter = options.adapter;
    this.#credential = wordfenceSecretRefSchema.parse(options.credential);
    this.#maximumFeedBytes = maximumFeedBytes(options.maximumFeedBytes);
    this.#knownRecordAuthorizationProvider =
      options.knownRecordAuthorizationProvider;
    this.#clock = options.clock ?? (() => new Date());
    this.#productionComposition = storageOpenMode !== "local";
    this.#store = new WordfenceSnapshotStore(
      {
        databasePath: options.databasePath,
        artifactDirectory: options.artifactDirectory,
        clock: this.#clock,
      },
      storageOpenMode,
    );
  }

  close(): void {
    this.#store.close();
  }

  async refresh(
    requestValue: WordfenceIntelligenceRefreshRequest,
    productionArtifactDirectory?: PinnedHostPrivateDirectory,
    requireCurrentIndexIdentity?: () => Promise<void>,
  ): Promise<WordfenceIntelligenceResult> {
    wordfenceIntelligenceRefreshRequestSchema.parse(requestValue);
    this.#store.requireLocalRefreshOwnership();
    this.#store.requireCurrentProductionStorageFormat();
    const startingIndexFailure = await this.#productionIndexFailure(
      requireCurrentIndexIdentity,
    );
    if (startingIndexFailure !== undefined) {
      return startingIndexFailure;
    }
    const refreshStart = this.#store.recordRefreshStart();
    if (refreshStart?.kind === "wordfence-intelligence-result") {
      return refreshStart;
    }
    const productionAttempt = refreshStart;
    let retrieval:
      | { readonly status: "succeeded"; readonly value: unknown }
      | { readonly error: unknown; readonly status: "failed" };
    try {
      retrieval = {
        status: "succeeded",
        value: await this.#adapter.retrieveProductionFeed({
          credential: this.#credential,
          maximumBytes: this.#maximumFeedBytes,
        }),
      };
    } catch (error) {
      retrieval = { error, status: "failed" };
    }
    const indexFailure = await this.#productionIndexFailure(
      requireCurrentIndexIdentity,
    );
    if (indexFailure !== undefined) {
      return indexFailure;
    }
    if (retrieval.status === "failed") {
      const { error } = retrieval;
      return this.#refreshFailure(
        error instanceof ResponseTooLargeError
          ? "response-byte-ceiling-exceeded"
          : error instanceof PartialResponseError
            ? "partial-response"
            : error instanceof CredentialUnavailableError
              ? "credential-unavailable"
              : "network-failure",
        undefined,
        productionAttempt,
      );
    }
    const parsedResponse = wordfenceIntelligenceSourceResponseSchema.safeParse(
      retrieval.value,
    );
    if (!parsedResponse.success) {
      return this.#refreshFailure("schema-drift", undefined, productionAttempt);
    }
    const response = parsedResponse.data;
    if (
      response.redirected === true ||
      response.sourceUrl !== this.#adapter.sourceUrl
    ) {
      return this.#refreshFailure(
        "source-mismatch",
        undefined,
        productionAttempt,
      );
    }
    const responseFailureResult = responseFailure(response, this.#clock);
    if (responseFailureResult !== undefined) {
      return this.#store.recordRefreshFailure(
        responseFailureResult,
        productionAttempt,
      );
    }
    if (!response.complete) {
      return this.#refreshFailure(
        "partial-response",
        undefined,
        productionAttempt,
      );
    }
    if (response.bytes.byteLength > this.#maximumFeedBytes) {
      return this.#refreshFailure(
        "response-byte-ceiling-exceeded",
        undefined,
        productionAttempt,
      );
    }
    let normalized: ReturnType<typeof normalizeFeed>;
    try {
      normalized = normalizeFeed(response.bytes);
    } catch (error) {
      return this.#refreshFailure(
        error instanceof AttributionMissingError
          ? "attribution-missing"
          : "schema-drift",
        undefined,
        productionAttempt,
      );
    }
    const contentDigest = rawDigest(response.bytes);
    const artifactDirectory = join(
      this.#artifactDirectory,
      "wordfence-intelligence-v3",
    );
    try {
      if (this.#productionComposition) {
        if (productionArtifactDirectory === undefined) {
          throw new HostPrivateStorageError();
        }
      } else {
        await mkdir(artifactDirectory, { recursive: true });
      }
      await persistBytes(
        join(artifactDirectory, `${contentDigest.slice(7)}.json`),
        response.bytes,
        productionArtifactDirectory,
      );
    } catch (error) {
      if (isStorageFailure(error)) {
        const persistenceIndexFailure = await this.#productionIndexFailure(
          requireCurrentIndexIdentity,
        );
        if (persistenceIndexFailure !== undefined) {
          return persistenceIndexFailure;
        }
        return this.#refreshFailure(
          "storage-failure",
          undefined,
          productionAttempt,
        );
      }
      throw error;
    }
    const publicationIndexFailure = await this.#productionIndexFailure(
      requireCurrentIndexIdentity,
    );
    if (publicationIndexFailure !== undefined) {
      return publicationIndexFailure;
    }
    const snapshot = wordfenceIntelligenceSnapshotSchema.parse({
      kind: "wordfence-intelligence-snapshot",
      schemaVersion: 1,
      retrievedAt: this.#clock().toISOString(),
      source: {
        sourceUrl: response.sourceUrl,
        contentDigest,
        parserVersion: "wordfence-intelligence-production-v3",
        recordCount: normalized.recordCount,
        complete: true,
      },
    });
    const snapshotRef = snapshotReference(snapshot);
    let durableProjection: WordfenceIntelligenceResult;
    try {
      durableProjection = this.#store.storeSnapshot(
        snapshot,
        snapshotRef,
        normalized.records,
        productionAttempt,
      );
    } catch (error) {
      if (isStorageFailure(error)) {
        const failureIndexFailure = await this.#productionIndexFailure(
          requireCurrentIndexIdentity,
        );
        if (failureIndexFailure !== undefined) {
          return failureIndexFailure;
        }
        return this.#refreshFailure(
          "storage-failure",
          undefined,
          productionAttempt,
        );
      }
      throw error;
    }
    return durableProjection;
  }

  async #productionIndexFailure(
    requireCurrentIndexIdentity: (() => Promise<void>) | undefined,
  ): Promise<WordfenceIntelligenceFailure | undefined> {
    if (!this.#productionComposition) {
      return undefined;
    }
    if (requireCurrentIndexIdentity === undefined) {
      throw new HostPrivateStorageError();
    }
    try {
      await requireCurrentIndexIdentity();
      return undefined;
    } catch (error) {
      if (isStorageFailure(error)) {
        return failure("storage-failure");
      }
      throw error;
    }
  }

  async inspect(
    requestValue: WordfenceIntelligenceInspectionRequest,
  ): Promise<WordfenceIntelligenceResult> {
    return this.#store.inspect(requestValue);
  }

  async inspectProduction(
    requestValue: WordfenceIntelligenceInspectionRequest,
  ): Promise<WordfenceIntelligenceResult> {
    return this.#store.inspectProduction(requestValue);
  }

  async requireCurrentProductionArtifact(
    directory: PinnedHostPrivateDirectory,
  ): Promise<void> {
    return this.#store.requireCurrentProductionArtifact(directory);
  }

  async aggregate(
    requestValue: VulnerabilityHistoryAggregateRequest,
  ): Promise<VulnerabilityHistoryAggregate> {
    return this.#store.aggregate(requestValue);
  }

  async inspectKnownRecords(
    requestValue: WordfenceKnownRecordInspectionRequest,
  ): Promise<WordfenceKnownRecordProjection> {
    const parsedRequest =
      wordfenceKnownRecordInspectionRequestSchema.safeParse(requestValue);
    if (!parsedRequest.success) {
      throw new WordfenceKnownRecordAccessError();
    }
    this.#store.requireLocalStorageOwnership();
    const request = parsedRequest.data;
    const authorization = await this.#verifyKnownRecordAuthorization(
      request.authorizationRef,
    );
    if (
      authorization.subject.pluginIdentity !== request.pluginIdentity ||
      authorization.subject.verifiedVersion !== request.verifiedVersion ||
      authorization.subject.canonicalFileManifestDigest !==
        request.canonicalFileManifestDigest
    ) {
      throw new WordfenceKnownRecordAccessError();
    }
    return this.#store.readKnownRecords(request, authorization);
  }

  async #verifyKnownRecordAuthorization(
    reference: KnownRecordAccessAuthorizationRef,
  ): Promise<KnownRecordAccessAuthorization> {
    if (this.#knownRecordAuthorizationProvider === undefined) {
      throw new WordfenceKnownRecordAccessError();
    }
    let unvalidated: unknown;
    try {
      const resolution =
        await this.#knownRecordAuthorizationProvider.resolve(reference);
      if (resolution.status !== "authorized") {
        throw new Error("Known-record access was denied");
      }
      unvalidated = resolution.authorization;
    } catch {
      throw new WordfenceKnownRecordAccessError();
    }
    const result = knownRecordAccessAuthorizationSchema.safeParse(unvalidated);
    if (!result.success) {
      throw new WordfenceKnownRecordAccessError();
    }
    const authorization = result.data;
    const { id, digest, ...body } = authorization;
    if (
      id !== reference.id ||
      digest !== reference.digest ||
      digest !== sha256Digest(body) ||
      id !== `known-record-access:${digest.slice(7, 31)}`
    ) {
      throw new WordfenceKnownRecordAccessError();
    }
    return authorization;
  }

  #refreshFailure(
    reason: WordfenceIntelligenceFailure["reason"],
    backoff?: WordfenceRateLimitBackoff,
    productionAttempt?: ProductionRefreshAttemptToken,
  ): WordfenceIntelligenceResult {
    return this.#store.recordRefreshFailure(
      failure(reason, backoff),
      productionAttempt,
    );
  }
}

export function openWordfenceIntelligence(
  options: OpenWordfenceIntelligenceOptions,
): WordfenceIntelligence {
  return new SqliteWordfenceIntelligence(options);
}

async function usePinnedProductionDirectory(
  directory: PinnedHostPrivateDirectory,
  operation: () => Promise<WordfenceIntelligenceResult>,
): Promise<WordfenceIntelligenceResult> {
  let result: WordfenceIntelligenceResult;
  try {
    result = await operation();
  } catch (error) {
    try {
      await directory.handle.close();
    } catch {
      // Preserve the primary operation failure.
    }
    throw error;
  }
  try {
    await directory.handle.close();
  } catch {
    return result.status === "current" ? failure("storage-failure") : result;
  }
  return result;
}

export function openWordfenceIntelligenceRefresh(
  options: OpenWordfenceIntelligenceRefreshOptions,
): WordfenceIntelligenceRefresh {
  const configuredMaximumFeedBytes = maximumFeedBytes(options.maximumFeedBytes);
  const adapter = createWordfenceIntelligenceV3FetchAdapter({
    credentialBroker: options.credentialBroker,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const intelligenceOptions: OpenWordfenceIntelligenceOptions = {
    databasePath: options.databasePath,
    artifactDirectory: options.artifactDirectory,
    adapter,
    credential: { kind: "secret-ref", id: "wordfence-v3-api-key" },
    maximumFeedBytes: configuredMaximumFeedBytes,
    ...(options.knownRecordAuthorizationProvider === undefined
      ? {}
      : {
          knownRecordAuthorizationProvider:
            options.knownRecordAuthorizationProvider,
        }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  };
  let intelligence: SqliteWordfenceIntelligence | undefined;
  let indexIdentity: ProductionIndexIdentity | undefined;
  let initializationPromise: Promise<void> | undefined;
  const ensureInitialized = (): Promise<void> => {
    if (intelligence !== undefined) {
      return Promise.resolve();
    }
    if (initializationPromise !== undefined) {
      return initializationPromise;
    }
    const pending = (async () => {
      if (currentOwnerUid() === undefined) {
        throw new HostPrivateStorageError();
      }
      let preparedStorage = await prepareProductionStorage(
        intelligenceOptions.databasePath,
        intelligenceOptions.artifactDirectory,
      );
      let candidate: SqliteWordfenceIntelligence;
      try {
        candidate = new SqliteWordfenceIntelligence(
          intelligenceOptions,
          preparedStorage.mode,
        );
      } catch (error) {
        if (
          preparedStorage.mode !== "new-production" ||
          !(error instanceof SnapshotConflictError)
        ) {
          throw error;
        }
        try {
          preparedStorage = await prepareProductionStorage(
            intelligenceOptions.databasePath,
            intelligenceOptions.artifactDirectory,
          );
        } catch (reopenError) {
          if (
            reopenError instanceof SnapshotConflictError ||
            isStorageFailure(reopenError)
          ) {
            throw new HostPrivateStorageError();
          }
          throw reopenError;
        }
        if (preparedStorage.mode !== "production") {
          throw new HostPrivateStorageError();
        }
        candidate = new SqliteWordfenceIntelligence(
          intelligenceOptions,
          preparedStorage.mode,
        );
      }
      let openedIndexIdentity: ProductionIndexIdentity;
      try {
        await secureCreatedSqliteSidecars(
          intelligenceOptions.databasePath,
          preparedStorage.indexIdentity,
        );
        openedIndexIdentity = await productionIndexIdentity(
          intelligenceOptions.databasePath,
          true,
        );
        requirePreparedIndexIdentity(
          preparedStorage.indexIdentity,
          openedIndexIdentity,
        );
      } catch (error) {
        candidate.close();
        throw error;
      }
      intelligence = candidate;
      indexIdentity = openedIndexIdentity;
    })();
    initializationPromise = pending;
    void pending.then(undefined, () => {
      if (initializationPromise === pending) {
        initializationPromise = undefined;
      }
    });
    return pending;
  };
  const initialize = async (): Promise<
    | {
        readonly artifactDirectory: PinnedHostPrivateDirectory;
        readonly intelligence: SqliteWordfenceIntelligence;
      }
    | undefined
  > => {
    try {
      await ensureInitialized();
      const expectedIndexIdentity = indexIdentity;
      if (expectedIndexIdentity === undefined) {
        throw new HostPrivateStorageError();
      }
      const storage = await requireProductionStorage(
        intelligenceOptions.databasePath,
        intelligenceOptions.artifactDirectory,
        expectedIndexIdentity,
      );
      const current = intelligence;
      if (current === undefined) {
        await storage.artifactDirectory.handle.close();
        throw new HostPrivateStorageError();
      }
      return {
        artifactDirectory: storage.artifactDirectory,
        intelligence: current,
      };
    } catch (error) {
      if (isStorageFailure(error)) {
        return undefined;
      }
      throw error;
    }
  };
  const requireCurrentIndexIdentity = async (): Promise<void> => {
    const expectedIndexIdentity = indexIdentity;
    if (expectedIndexIdentity === undefined) {
      throw new HostPrivateStorageError();
    }
    await requireProductionIndexIdentity(
      intelligenceOptions.databasePath,
      expectedIndexIdentity,
    );
  };
  return {
    run: async (request) => {
      wordfenceIntelligenceRefreshRequestSchema.parse(request);
      const current = await initialize();
      if (current === undefined) {
        return failure("storage-failure");
      }
      try {
        return await usePinnedProductionDirectory(
          current.artifactDirectory,
          async () => {
            await current.intelligence.requireCurrentProductionArtifact(
              current.artifactDirectory,
            );
            const result = wordfenceIntelligenceResultSchema.parse(
              await current.intelligence.refresh(
                request,
                current.artifactDirectory,
                requireCurrentIndexIdentity,
              ),
            );
            if (result.status === "current" || result.status === "stale") {
              await verifyStoredArtifact(
                current.artifactDirectory,
                result.snapshot.source.contentDigest,
              );
              await requireCurrentIndexIdentity();
            }
            return result;
          },
        );
      } catch (error) {
        if (isStorageFailure(error)) {
          return failure("storage-failure");
        }
        throw error;
      }
    },
    inspect: async (request) => {
      wordfenceIntelligenceInspectionRequestSchema.parse(request);
      const current = await initialize();
      if (current === undefined) {
        return failure("storage-failure");
      }
      try {
        return await usePinnedProductionDirectory(
          current.artifactDirectory,
          async () => {
            const result = wordfenceIntelligenceResultSchema.parse(
              await current.intelligence.inspectProduction(request),
            );
            if (result.status === "current" || result.status === "stale") {
              await verifyStoredArtifact(
                current.artifactDirectory,
                result.snapshot.source.contentDigest,
              );
              await requireCurrentIndexIdentity();
            }
            return result;
          },
        );
      } catch (error) {
        if (isStorageFailure(error)) {
          return failure("storage-failure");
        }
        throw error;
      }
    },
  };
}
