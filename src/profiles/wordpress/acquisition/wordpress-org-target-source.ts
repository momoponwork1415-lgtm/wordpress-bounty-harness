import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import {
  fetchBounded,
  ResponseTooLargeError,
} from "../../../infrastructure/bounded-fetch.js";
import {
  artifactId,
  bytesDigest,
} from "../../../infrastructure/content-digest.js";
import { persistContentAddressedFile } from "../../../infrastructure/immutable-file.js";

import {
  canonicalJsonPreservingProperties,
  canonicalDigestPreservingProperties,
} from "../../../infrastructure/canonical-json.js";
import {
  openLocalDirectoryTargetIntake,
  targetIntakeDirectory,
} from "./local-directory-target-intake.js";
import {
  wordPressOrgAcquireRequestSchema,
  wordPressOrgAcquisitionOriginalSchema,
  wordPressOrgObserveRequestSchema,
  wordPressOrgSourceResponseSchema,
  wordPressOrgTargetObservationRefSchema,
  wordPressOrgTargetObservationSchema,
  type OpenWordPressOrgTargetSourceOptions,
  type WordPressOrgAcquisitionFailure,
  type WordPressOrgAcquisitionDiagnostic,
  type WordPressOrgFetchAdapterOptions,
  type WordPressOrgAcquireRequest,
  type WordPressOrgAcquisitionResult,
  type WordPressOrgObservationResult,
  type WordPressOrgObservationFailure,
  type WordPressOrgObserveRequest,
  type WordPressOrgSourceAdapter,
  type WordPressOrgSourceRequest,
  type WordPressOrgSourceResponse,
  type WordPressOrgTargetObservation,
  type WordPressOrgTargetObservationRef,
  type WordPressOrgTargetSource,
} from "./wordpress-org-contracts.js";
import { extractZipArchive } from "./zip-archive.js";
import { wordPressOrgPluginIdentity } from "../target-identity.js";

const metadataSchema = z.object({
  slug: z.string(),
  name: z.string().min(1).max(256),
  version: z.string().min(1).max(64),
  requires: z.string().max(32).nullable().optional(),
  active_installs: z.number().int().nonnegative(),
  last_updated: z.string().min(1).max(128),
  author: z.string().min(1).max(1024).optional(),
  tags: z
    .union([z.array(z.string()), z.record(z.string(), z.string())])
    .optional(),
  closed: z.boolean().optional(),
  download_link: z.url(),
});

const DEFAULT_METADATA_MAXIMUM_BYTES = 1_000_000;
const METADATA_TIMEOUT_MS = 30_000;
const ARCHIVE_TIMEOUT_MS = 5 * 60_000;

function metadataUrl(slug: string): string {
  const url = new URL("https://api.wordpress.org/plugins/info/1.2/");
  url.searchParams.set("action", "plugin_information");
  url.searchParams.set("request[slug]", slug);
  return url.toString();
}

function observationFailure(
  reason: WordPressOrgObservationFailure["reason"],
  pluginIdentity: string,
): WordPressOrgObservationFailure {
  return { status: "failed", operation: "observe", reason, pluginIdentity };
}

function acquisitionFailure(
  reason: WordPressOrgAcquisitionFailure["reason"],
  pluginIdentity: string,
  diagnostic?: WordPressOrgAcquisitionDiagnostic,
): WordPressOrgAcquisitionFailure {
  return {
    status: "failed",
    operation: "acquire",
    reason,
    pluginIdentity,
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

function transportDiagnostic(
  error: unknown,
): WordPressOrgAcquisitionDiagnostic {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  const codes: string[] = [];
  const names: string[] = [];
  const messages: string[] = [];
  while (pending.length > 0 && seen.size < 8) {
    const current = pending.shift();
    if (typeof current !== "object" || current === null || seen.has(current))
      continue;
    seen.add(current);
    const value = current as {
      code?: unknown;
      name?: unknown;
      message?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (typeof value.code === "string") codes.push(value.code);
    if (typeof value.name === "string") names.push(value.name);
    if (typeof value.message === "string")
      messages.push(
        `${typeof value.name === "string" ? value.name : "Error"}: ${value.message}`,
      );
    if (value.cause !== undefined) pending.push(value.cause);
    if (Array.isArray(value.errors)) pending.push(...value.errors);
  }
  const kind = codes.some(
    (code) => code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT",
  )
    ? "connect-timeout"
    : names.includes("TimeoutError")
      ? "request-timeout"
      : codes.some((code) => code === "ENOTFOUND" || code === "EAI_AGAIN")
        ? "dns"
        : "network";
  return {
    kind,
    ...(codes[0] === undefined ? {} : { code: codes[0] }),
    ...(messages.length === 0
      ? {}
      : { message: messages.join(" | ").slice(0, 2048) }),
  };
}

function responseFailureReason(
  status: number,
): "not-found" | "rate-limited" | "network-failure" | undefined {
  if (status === 404) {
    return "not-found";
  }
  if (status === 429) {
    return "rate-limited";
  }
  if (status < 200 || status >= 300) {
    return "network-failure";
  }
  return undefined;
}

function isOfficialDownloadUrl(sourceUrl: string, slug: string): boolean {
  try {
    const url = new URL(sourceUrl);
    return (
      url.protocol === "https:" &&
      url.hostname === "downloads.wordpress.org" &&
      url.pathname.startsWith(`/plugin/${slug}.`) &&
      url.pathname.endsWith(".zip") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

/** The stable release uses the observed link; a pinned release uses its official versioned archive. */
function archiveUrlFor(
  observation: WordPressOrgTargetObservation,
  version: string,
): string | undefined {
  if (version === observation.stableVersion)
    return observation.downloadProvenance.sourceUrl;
  if (!/^[0-9A-Za-z][0-9A-Za-z.-]*$/.test(version)) return undefined;
  const url = `https://downloads.wordpress.org/plugin/${observation.officialSlug}.${version}.zip`;
  return isOfficialDownloadUrl(url, observation.officialSlug) ? url : undefined;
}

class FetchWordPressOrgSourceAdapter implements WordPressOrgSourceAdapter {
  readonly #fetch: typeof fetch;

  constructor(fetchImplementation: typeof fetch) {
    this.#fetch = fetchImplementation;
  }

  async retrieve(
    request: WordPressOrgSourceRequest,
  ): Promise<WordPressOrgSourceResponse> {
    const { response, readBody } = await fetchBounded(
      this.#fetch,
      request.sourceUrl,
      {
        method: "GET",
        redirect: "follow",
        headers: {
          accept:
            request.kind === "metadata"
              ? "application/json"
              : "application/zip",
        },
        timeoutMs:
          request.kind === "metadata"
            ? METADATA_TIMEOUT_MS
            : ARCHIVE_TIMEOUT_MS,
        maximumBytes: request.maximumBytes,
      },
    );
    const bytes = await readBody();
    return {
      status: response.status,
      sourceUrl: response.url || request.sourceUrl,
      bytes,
    };
  }
}

export function createWordPressOrgFetchAdapter(
  options: WordPressOrgFetchAdapterOptions = {},
): WordPressOrgSourceAdapter {
  return new FetchWordPressOrgSourceAdapter(options.fetch ?? globalThis.fetch);
}

class FileWordPressOrgTargetSource implements WordPressOrgTargetSource {
  readonly #storageDirectory: string;
  readonly #adapter: WordPressOrgSourceAdapter;
  readonly #clock: () => Date;
  readonly #metadataMaximumBytes: number;

  constructor(options: OpenWordPressOrgTargetSourceOptions) {
    this.#storageDirectory = options.storageDirectory;
    this.#adapter = options.adapter ?? createWordPressOrgFetchAdapter();
    this.#clock = options.clock ?? (() => new Date());
    this.#metadataMaximumBytes =
      options.metadataMaximumBytes ?? DEFAULT_METADATA_MAXIMUM_BYTES;
    if (
      !Number.isSafeInteger(this.#metadataMaximumBytes) ||
      this.#metadataMaximumBytes <= 0
    ) {
      throw new Error("metadataMaximumBytes must be a positive safe integer");
    }
  }

  async observe(
    requestValue: WordPressOrgObserveRequest,
  ): Promise<WordPressOrgObservationResult> {
    const request = wordPressOrgObserveRequestSchema.parse(requestValue);
    const pluginIdentity = wordPressOrgPluginIdentity(request.slug);
    const sourceUrl = metadataUrl(request.slug);
    let response: WordPressOrgSourceResponse;
    try {
      response = wordPressOrgSourceResponseSchema.parse(
        await this.#adapter.retrieve({
          kind: "metadata",
          sourceUrl,
          maximumBytes: this.#metadataMaximumBytes,
        }),
      );
    } catch (error) {
      return observationFailure(
        error instanceof ResponseTooLargeError
          ? "quota-exceeded"
          : "network-failure",
        pluginIdentity,
      );
    }
    if (response.bytes.byteLength > this.#metadataMaximumBytes) {
      return observationFailure("quota-exceeded", pluginIdentity);
    }
    const failureReason = responseFailureReason(response.status);
    if (failureReason !== undefined) {
      return observationFailure(failureReason, pluginIdentity);
    }

    if (response.sourceUrl !== sourceUrl) {
      return observationFailure("invalid-metadata", pluginIdentity);
    }

    let metadata: z.infer<typeof metadataSchema>;
    try {
      metadata = metadataSchema.parse(
        JSON.parse(Buffer.from(response.bytes).toString("utf8")),
      );
    } catch {
      return observationFailure("invalid-metadata", pluginIdentity);
    }
    if (
      metadata.slug !== request.slug ||
      !isOfficialDownloadUrl(metadata.download_link, request.slug)
    ) {
      return observationFailure("invalid-metadata", pluginIdentity);
    }
    if (metadata.closed === true) {
      return observationFailure("closed", pluginIdentity);
    }
    const retrievedAt = this.#clock().toISOString();
    const observation = wordPressOrgTargetObservationSchema.parse({
      kind: "wordpress-org-target-observation",
      schemaVersion: 1,
      pluginIdentity,
      officialSlug: request.slug,
      displayName: metadata.name,
      stableVersion: metadata.version,
      ...(metadata.requires !== undefined &&
      metadata.requires !== null &&
      /^[0-9]+(?:\.[0-9]+){1,3}$/.test(metadata.requires.trim())
        ? { minimumWordPressVersion: metadata.requires.trim() }
        : {}),
      activeInstallations: metadata.active_installs,
      lastUpdated: metadata.last_updated,
      ...(metadata.author === undefined
        ? {}
        : { author: metadata.author.replace(/<[^>]*>/g, "").trim() }),
      ...(metadata.tags === undefined
        ? {}
        : {
            tags: Array.isArray(metadata.tags)
              ? metadata.tags
              : Object.keys(metadata.tags),
          }),
      observedAt: retrievedAt,
      intelligenceSource: {
        kind: "wordpress-org-plugin-directory",
        sourceUrl: response.sourceUrl,
        retrievedAt,
        contentDigest: bytesDigest(response.bytes),
        parserVersion: "wordpress-org-plugin-information-v1",
      },
      downloadProvenance: { sourceUrl: metadata.download_link },
    });
    const observationRef = await this.#persistObservation(observation);
    return { status: "observed", observation, observationRef };
  }

  async acquire(
    requestValue: WordPressOrgAcquireRequest,
  ): Promise<WordPressOrgAcquisitionResult> {
    const request = wordPressOrgAcquireRequestSchema.parse(requestValue);
    const observation = await this.#readObservation(request.observationRef);
    const archiveUrl = archiveUrlFor(observation, request.requestedVersion);
    if (archiveUrl === undefined) {
      return acquisitionFailure(
        "requested-version-mismatch",
        observation.pluginIdentity,
      );
    }
    let response: WordPressOrgSourceResponse;
    try {
      response = wordPressOrgSourceResponseSchema.parse(
        await this.#adapter.retrieve({
          kind: "archive",
          sourceUrl: archiveUrl,
          maximumBytes: request.policy.limits.maxTotalBytes,
        }),
      );
    } catch (error) {
      return acquisitionFailure(
        error instanceof ResponseTooLargeError
          ? "quota-exceeded"
          : "network-failure",
        observation.pluginIdentity,
        error instanceof ResponseTooLargeError
          ? undefined
          : transportDiagnostic(error),
      );
    }
    if (response.bytes.byteLength > request.policy.limits.maxTotalBytes) {
      return acquisitionFailure("quota-exceeded", observation.pluginIdentity);
    }
    const failureReason = responseFailureReason(response.status);
    if (failureReason !== undefined) {
      return acquisitionFailure(failureReason, observation.pluginIdentity, {
        kind: "http-response",
        status: response.status,
      });
    }
    if (response.sourceUrl !== archiveUrl) {
      return acquisitionFailure(
        "metadata-archive-mismatch",
        observation.pluginIdentity,
      );
    }

    const contentDigest = bytesDigest(response.bytes);
    const acquisitionOriginalRef = {
      id: artifactId("wporg-archive", contentDigest),
      digest: contentDigest,
    };
    const originalsDirectory = join(
      this.#storageDirectory,
      "wordpress-org-acquisition-originals",
    );
    await mkdir(originalsDirectory, { recursive: true });
    await persistContentAddressedFile(
      join(originalsDirectory, `${contentDigest.slice(7)}.zip`),
      response.bytes,
    );
    const acquisitionOriginal = wordPressOrgAcquisitionOriginalSchema.parse({
      kind: "wordpress-org-acquisition-original",
      schemaVersion: 1,
      pluginIdentity: observation.pluginIdentity,
      version: request.requestedVersion,
      sourceUrl: response.sourceUrl,
      retrievedAt: this.#clock().toISOString(),
      contentDigest,
      size: response.bytes.byteLength,
      observationRef: request.observationRef,
    });

    const extraction = extractZipArchive(
      response.bytes,
      observation.officialSlug,
      request.policy,
    );
    if (extraction.status === "rejected") {
      return {
        status: "rejected",
        acquisitionOriginal,
        acquisitionOriginalRef,
        reasons: extraction.reasons,
      };
    }

    await mkdir(this.#storageDirectory, { recursive: true });
    const scratchDirectory = await mkdtemp(
      join(this.#storageDirectory, "wporg-extract-"),
    );
    try {
      for (const file of extraction.files) {
        const path = join(scratchDirectory, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.bytes, { flag: "wx" });
      }
      const intake = openLocalDirectoryTargetIntake({
        storageDirectory: targetIntakeDirectory(this.#storageDirectory),
        sourceCaptureKind: "captured-wordpress-org-archive",
      });
      const disposition = await intake.intake({
        kind: "manual-target-intake",
        schemaVersion: 1,
        source: { kind: "local-directory", path: scratchDirectory },
        pluginIdentity: { kind: "wporg", slug: observation.officialSlug },
        requestedVersion: request.requestedVersion,
        canonicalInstallDirectory: observation.officialSlug,
        provenance: {
          kind: "wordpress-org",
          sourceUrl: archiveUrl,
          acquisitionRef: acquisitionOriginalRef,
        },
        policy: request.policy,
      });
      if (
        disposition.status === "rejected" &&
        disposition.reasons.includes("version-mismatch")
      ) {
        return {
          status: "failed",
          operation: "acquire",
          reason: "metadata-archive-mismatch",
          pluginIdentity: observation.pluginIdentity,
          acquisitionOriginal,
          acquisitionOriginalRef,
        };
      }
      switch (disposition.status) {
        case "ready":
          return {
            status: "ready",
            acquisitionOriginal,
            acquisitionOriginalRef,
            intake: disposition,
          };
        case "deferred":
          return {
            status: "deferred",
            acquisitionOriginal,
            acquisitionOriginalRef,
            intake: disposition,
          };
        case "rejected":
          return {
            status: "rejected",
            acquisitionOriginal,
            acquisitionOriginalRef,
            intake: disposition,
          };
      }
    } finally {
      await rm(scratchDirectory, { recursive: true, force: true });
    }
  }

  async #persistObservation(
    observation: WordPressOrgTargetObservation,
  ): Promise<WordPressOrgTargetObservationRef> {
    const digest = canonicalDigestPreservingProperties(observation);
    const ref = wordPressOrgTargetObservationRefSchema.parse({
      kind: "wordpress-org-target-observation-ref",
      schemaVersion: 1,
      id: artifactId("wporg-observation", digest),
      digest,
    });
    const directory = join(
      this.#storageDirectory,
      "wordpress-org-observations",
    );
    await mkdir(directory, { recursive: true });
    await persistContentAddressedFile(
      join(directory, `${digest.slice(7)}.json`),
      Buffer.from(canonicalJsonPreservingProperties(observation), "utf8"),
    );
    return ref;
  }

  async #readObservation(
    refValue: WordPressOrgTargetObservationRef,
  ): Promise<WordPressOrgTargetObservation> {
    const ref = wordPressOrgTargetObservationRefSchema.parse(refValue);
    const bytes = await readFile(
      join(
        this.#storageDirectory,
        "wordpress-org-observations",
        `${ref.digest.slice(7)}.json`,
      ),
    );
    const observation = wordPressOrgTargetObservationSchema.parse(
      JSON.parse(bytes.toString("utf8")),
    );
    if (
      canonicalDigestPreservingProperties(observation) !== ref.digest ||
      artifactId("wporg-observation", ref.digest) !== ref.id
    ) {
      throw new Error("WordPress.org Target Observation integrity mismatch");
    }
    return observation;
  }
}

export function openWordPressOrgTargetSource(
  options: OpenWordPressOrgTargetSourceOptions,
): WordPressOrgTargetSource {
  return new FileWordPressOrgTargetSource(options);
}
