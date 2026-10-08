import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import { canonicalJson, sha256Digest } from "./canonical-json.js";
import { openLocalDirectoryTargetIntake } from "./local-directory-target-intake.js";
import {
  wordPressOrgAcquireRequestSchema,
  wordPressOrgAcquisitionOriginalSchema,
  wordPressOrgObserveRequestSchema,
  wordPressOrgSourceResponseSchema,
  wordPressOrgTargetObservationRefSchema,
  wordPressOrgTargetObservationSchema,
  type OpenWordPressOrgTargetSourceOptions,
  type WordPressOrgAcquisitionFailure,
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

const metadataSchema = z.object({
  slug: z.string(),
  name: z.string().min(1).max(256),
  version: z.string().min(1).max(64),
  active_installs: z.number().int().nonnegative(),
  last_updated: z.string().min(1).max(128),
  download_link: z.url(),
});

const DEFAULT_METADATA_MAXIMUM_BYTES = 1_000_000;

class ResponseTooLargeError extends Error {
  constructor() {
    super("WordPress.org response exceeded its byte ceiling");
    this.name = "ResponseTooLargeError";
  }
}

function rawDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function artifactId(prefix: string, digest: string): string {
  return `${prefix}:${digest.slice(7, 31)}`;
}

async function persistBytes(path: string, bytes: Uint8Array): Promise<void> {
  try {
    await writeFile(path, bytes, { flag: "wx" });
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
    const existing = await readFile(path);
    if (!existing.equals(bytes)) {
      throw new Error(`Content-addressed artifact conflict: ${path}`);
    }
  }
}

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
): WordPressOrgAcquisitionFailure {
  return { status: "failed", operation: "acquire", reason, pluginIdentity };
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

async function boundedResponseBytes(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    Number.isFinite(Number(contentLength)) &&
    Number(contentLength) > maximumBytes
  ) {
    throw new ResponseTooLargeError();
  }
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes) {
      throw new ResponseTooLargeError();
    }
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new ResponseTooLargeError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

class FetchWordPressOrgSourceAdapter implements WordPressOrgSourceAdapter {
  readonly #fetch: typeof fetch;

  constructor(fetchImplementation: typeof fetch) {
    this.#fetch = fetchImplementation;
  }

  async retrieve(
    request: WordPressOrgSourceRequest,
  ): Promise<WordPressOrgSourceResponse> {
    const response = await this.#fetch(request.sourceUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        accept:
          request.kind === "metadata" ? "application/json" : "application/zip",
      },
    });
    const bytes = await boundedResponseBytes(response, request.maximumBytes);
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
    const pluginIdentity = `wporg:${request.slug}`;
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
    const retrievedAt = this.#clock().toISOString();
    const observation = wordPressOrgTargetObservationSchema.parse({
      kind: "wordpress-org-target-observation",
      schemaVersion: 1,
      pluginIdentity,
      officialSlug: request.slug,
      displayName: metadata.name,
      stableVersion: metadata.version,
      activeInstallations: metadata.active_installs,
      lastUpdated: metadata.last_updated,
      observedAt: retrievedAt,
      intelligenceSource: {
        kind: "wordpress-org-plugin-directory",
        sourceUrl: response.sourceUrl,
        retrievedAt,
        contentDigest: rawDigest(response.bytes),
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
    if (request.requestedVersion !== observation.stableVersion) {
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
          sourceUrl: observation.downloadProvenance.sourceUrl,
          maximumBytes: request.policy.limits.maxTotalBytes,
        }),
      );
    } catch (error) {
      return acquisitionFailure(
        error instanceof ResponseTooLargeError
          ? "quota-exceeded"
          : "network-failure",
        observation.pluginIdentity,
      );
    }
    if (response.bytes.byteLength > request.policy.limits.maxTotalBytes) {
      return acquisitionFailure("quota-exceeded", observation.pluginIdentity);
    }
    const failureReason = responseFailureReason(response.status);
    if (failureReason !== undefined) {
      return acquisitionFailure(failureReason, observation.pluginIdentity);
    }
    if (response.sourceUrl !== observation.downloadProvenance.sourceUrl) {
      return acquisitionFailure(
        "metadata-archive-mismatch",
        observation.pluginIdentity,
      );
    }

    const contentDigest = rawDigest(response.bytes);
    const acquisitionOriginalRef = {
      id: artifactId("wporg-archive", contentDigest),
      digest: contentDigest,
    };
    const originalsDirectory = join(
      this.#storageDirectory,
      "wordpress-org-acquisition-originals",
    );
    await mkdir(originalsDirectory, { recursive: true });
    await persistBytes(
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
        storageDirectory: join(this.#storageDirectory, "target-intake"),
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
          sourceUrl: observation.downloadProvenance.sourceUrl,
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
    const digest = sha256Digest(observation);
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
    await persistBytes(
      join(directory, `${digest.slice(7)}.json`),
      Buffer.from(canonicalJson(observation), "utf8"),
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
      sha256Digest(observation) !== ref.digest ||
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
