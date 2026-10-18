import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  artifactId,
  bytesDigest,
} from "../../../infrastructure/content-digest.js";
import {
  hasErrorCode,
  persistContentAddressedFile,
} from "../../../infrastructure/immutable-file.js";
import {
  checkSourceAgainstManifest,
  SourceTreeError,
  walkCanonicalSourceTree,
  type SourceTreeRejection,
} from "../../../infrastructure/canonical-source-tree.js";
import type { AcquiredSource } from "../../../snapshot/index.js";
import { canonicalJson, sha256Digest } from "./canonical-json.js";
import {
  intakeDispositionSchema,
  manualTargetIntakeRequestSchema,
  type IntakeDisposition,
  type IntakeReceipt,
  type ManualTargetIntakeRequest,
  type TargetIntake,
  type TargetIntakePacket,
  type TargetIntakeReason,
} from "./contracts.js";

interface LocalDirectoryTargetIntakeOptions {
  readonly storageDirectory: string;
  readonly sourceCaptureKind?:
    | "captured-local-directory"
    | "captured-wordpress-org-archive"
    | "captured-wordpress-org-svn-export";
}

interface CapturedFile {
  readonly path: string;
  readonly digest: string;
  readonly size: number;
  readonly bytes: Buffer;
}

interface CaptureSuccess {
  readonly status: "captured";
  readonly files: readonly CapturedFile[];
}

interface CaptureRejected {
  readonly status: "rejected";
  readonly reasons: readonly TargetIntakeReason[];
}

type CaptureResult = CaptureSuccess | CaptureRejected;

/**
 * The intake store layout lives here and nowhere else: `objects/` holds the
 * canonical JSON records, `blobs/` holds the captured bytes by digest.
 */
const TARGET_INTAKE_SUBDIRECTORY = "target-intake";

/** Where a store root keeps its intake packets and captured blobs. */
export function targetIntakeDirectory(storageDirectory: string): string {
  return join(storageDirectory, TARGET_INTAKE_SUBDIRECTORY);
}

function blobPath(intakeDirectory: string, digest: string): string {
  return join(intakeDirectory, "blobs", digest.slice("sha256:".length));
}

/** Reads only the captured bytes named by an intake packet. */
export function acquiredSourceFromIntakePacket(
  packet: TargetIntakePacket,
  intakeStorageDirectory: string,
): AcquiredSource {
  const files = new Map(
    packet.sourceTree.manifest.entries.map((entry) => [
      entry.path,
      entry.digest,
    ]),
  );
  return {
    identity: packet.pluginIdentity,
    version: packet.version,
    manifest: packet.sourceTree.manifest,
    async readFile(path) {
      const digest = files.get(path);
      if (digest === undefined)
        throw new Error("File is absent from source manifest");
      return readFile(blobPath(intakeStorageDirectory, digest));
    },
  };
}

/** The strict walk's first refusal, in the intake's vocabulary. */
function structuralReason(
  rejection: SourceTreeRejection,
): TargetIntakeReason | undefined {
  switch (rejection) {
    case "root-not-directory":
      return "source-not-directory";
    case "symbolic-link":
      return "link-entry";
    case "hard-link":
      return "hardlink-entry";
    case "non-regular-entry":
    case "invalid-path":
      return "non-regular-entry";
    case "path-collision":
      return "path-collision";
    case "bounds-exceeded":
      return "quota-exceeded";
    case "changed-while-reading":
      return undefined;
  }
}

/** Walks the tree once, then reads back exactly the bytes the manifest names. */
async function captureDirectory(
  sourceDirectory: string,
  policy: ManualTargetIntakeRequest["policy"],
): Promise<CaptureResult> {
  let walked;
  try {
    walked = await walkCanonicalSourceTree(sourceDirectory, {
      maxEntries: policy.limits.maxEntries,
      maxBytes: policy.limits.maxTotalBytes,
    });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
      return { status: "rejected", reasons: ["source-not-directory"] };
    }
    const reason =
      error instanceof SourceTreeError
        ? structuralReason(error.code)
        : undefined;
    if (reason !== undefined) return { status: "rejected", reasons: [reason] };
    throw error;
  }
  const { entries } = walked.manifest;
  if (
    entries.some(
      (entry) =>
        entry.size > policy.limits.maxFileBytes ||
        Buffer.byteLength(entry.path, "utf8") > policy.limits.maxPathBytes ||
        entry.path.split("/").length - 1 > policy.limits.maxDepth,
    )
  ) {
    return { status: "rejected", reasons: ["quota-exceeded"] };
  }
  if (entries.length === 0) {
    return { status: "rejected", reasons: ["main-plugin-file-missing"] };
  }
  const files: CapturedFile[] = [];
  const checked = await checkSourceAgainstManifest(
    walked.manifest,
    (path) => readFile(join(sourceDirectory, path)),
    async (entry, bytes) => {
      files.push({
        ...entry,
        bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
      });
    },
  );
  if (checked.status !== "verified") {
    throw new Error(
      `Source file changed while being captured: ${checked.mismatch.path}`,
    );
  }
  return { status: "captured", files };
}

interface PluginHeader {
  readonly pluginName: string;
  readonly version?: string;
}

function readPluginHeader(bytes: Buffer): PluginHeader | undefined {
  const text = bytes.subarray(0, 8_192).toString("utf8");
  let pluginName: string | undefined;
  let version: string | undefined;
  for (const originalLine of text.split(/\r?\n/u)) {
    const line = originalLine
      .replace(/^\s*(?:<\?php\s*)?(?:\/\*+|\*+|\/\/|#)?\s*/u, "")
      .replace(/\s*\*\/\s*$/u, "");
    const separator = line.indexOf(":");
    if (separator < 0) {
      continue;
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "plugin name" && value.length > 0 && pluginName === undefined) {
      pluginName = value;
    } else if (key === "version" && value.length > 0 && version === undefined) {
      version = value;
    }
  }
  if (pluginName === undefined) {
    return undefined;
  }
  return version === undefined ? { pluginName } : { pluginName, version };
}

function requestIdentity(
  request: ManualTargetIntakeRequest,
  sourceObservation: unknown,
): string {
  return sha256Digest({
    kind: request.kind,
    schemaVersion: request.schemaVersion,
    source: { kind: request.source.kind, observation: sourceObservation },
    pluginIdentity: request.pluginIdentity,
    requestedVersion: request.requestedVersion,
    ...(request.mainPluginFile === undefined
      ? {}
      : { mainPluginFile: request.mainPluginFile }),
    ...(request.canonicalInstallDirectory === undefined
      ? {}
      : { canonicalInstallDirectory: request.canonicalInstallDirectory }),
    provenance: request.provenance,
    policy: request.policy,
  });
}

class LocalDirectoryTargetIntake implements TargetIntake {
  readonly #storageDirectory: string;
  readonly #sourceCaptureKind:
    | "captured-local-directory"
    | "captured-wordpress-org-archive"
    | "captured-wordpress-org-svn-export";

  constructor(options: LocalDirectoryTargetIntakeOptions) {
    this.#storageDirectory = options.storageDirectory;
    this.#sourceCaptureKind =
      options.sourceCaptureKind ?? "captured-local-directory";
  }

  async #persistJson(value: unknown): Promise<{ id: string; digest: string }> {
    const bytes = Buffer.from(canonicalJson(value), "utf8");
    const digest = bytesDigest(bytes);
    const id = artifactId("artifact", digest);
    const directory = join(this.#storageDirectory, "objects");
    await mkdir(directory, { recursive: true });
    await persistContentAddressedFile(
      join(directory, `${digest.slice(7)}.json`),
      bytes,
    );
    return { id, digest };
  }

  async #persistDisposition(
    status: "deferred" | "rejected",
    request: ManualTargetIntakeRequest,
    reasons: readonly TargetIntakeReason[],
    sourceObservation: unknown,
  ): Promise<IntakeDisposition> {
    const requestDigest = requestIdentity(request, sourceObservation);
    const receipt: IntakeReceipt = {
      kind: "target-intake-receipt",
      schemaVersion: 1,
      id: artifactId("receipt", requestDigest),
      requestDigest,
      policy: { id: request.policy.id, digest: request.policy.digest },
      status,
      reasons: [...reasons],
    };
    const receiptRef = await this.#persistJson(receipt);
    return intakeDispositionSchema.parse({
      status,
      receipt,
      receiptRef,
      reasons,
    });
  }

  async intake(input: ManualTargetIntakeRequest): Promise<IntakeDisposition> {
    const request = manualTargetIntakeRequestSchema.parse(input);
    const capture = await captureDirectory(request.source.path, request.policy);
    if (capture.status === "rejected") {
      return this.#persistDisposition("rejected", request, capture.reasons, {
        structuralReasons: capture.reasons,
      });
    }

    const manifestEntries = capture.files.map(({ path, digest, size }) => ({
      path,
      digest,
      size,
    }));
    const manifest = {
      kind: "canonical-file-manifest" as const,
      schemaVersion: 1 as const,
      entries: manifestEntries,
    };
    const treeDigest = sha256Digest(manifest);
    const requestDigest = requestIdentity(request, { treeDigest });
    const phpFiles = capture.files.filter((file) => file.path.endsWith(".php"));
    const candidates = phpFiles.flatMap((file) => {
      const header = readPluginHeader(file.bytes);
      return header === undefined ? [] : [{ file, header }];
    });
    let selected = candidates[0];
    if (request.mainPluginFile !== undefined) {
      selected = candidates.find(
        (candidate) => candidate.file.path === request.mainPluginFile,
      );
      if (selected === undefined) {
        return this.#persistDisposition(
          "deferred",
          request,
          ["main-plugin-file-invalid"],
          { treeDigest },
        );
      }
    } else if (candidates.length === 0) {
      return this.#persistDisposition(
        "deferred",
        request,
        ["main-plugin-file-missing"],
        { treeDigest },
      );
    } else if (candidates.length > 1) {
      // WordPress.org archives commonly include secondary plugin headers. The
      // root file named after the official slug is a deterministic identity
      // signal; operator-provided sources still need an explicit choice.
      const officialSlug =
        (request.provenance.kind === "wordpress-org" ||
          request.provenance.kind === "wordpress-org-svn") &&
        request.pluginIdentity.kind === "wporg"
          ? request.pluginIdentity.slug
          : undefined;
      selected =
        officialSlug === undefined
          ? undefined
          : candidates.find(
              (candidate) => candidate.file.path === `${officialSlug}.php`,
            );
      if (selected === undefined)
        return this.#persistDisposition(
          "deferred",
          request,
          ["main-plugin-file-ambiguous"],
          { treeDigest },
        );
    }
    if (selected === undefined) {
      throw new Error(
        "Invariant violated: selected main plugin file is missing",
      );
    }
    if (selected.header.version === undefined) {
      return this.#persistDisposition(
        "deferred",
        request,
        ["version-evidence-missing"],
        { treeDigest },
      );
    }
    if (selected.header.version !== request.requestedVersion) {
      return this.#persistDisposition(
        "rejected",
        request,
        ["version-mismatch"],
        { treeDigest },
      );
    }

    const pluginSlug =
      request.pluginIdentity.kind === "wporg"
        ? request.pluginIdentity.slug
        : request.pluginIdentity.product;
    const canonicalInstallDirectory =
      request.pluginIdentity.kind === "wporg"
        ? request.pluginIdentity.slug
        : request.canonicalInstallDirectory;
    if (canonicalInstallDirectory === undefined) {
      return this.#persistDisposition(
        "deferred",
        request,
        ["canonical-install-directory-missing"],
        { treeDigest },
      );
    }
    const pluginIdentity =
      request.pluginIdentity.kind === "wporg"
        ? `wporg:${request.pluginIdentity.slug}`
        : `premium:${request.pluginIdentity.vendor}/${request.pluginIdentity.product}`;
    const targetSnapshotDigest = sha256Digest({
      kind: "target-snapshot",
      schemaVersion: 1,
      pluginIdentity,
      version: request.requestedVersion,
      treeDigest,
    });
    const packetSeed = sha256Digest({
      requestDigest,
      pluginIdentity,
      mainPluginFile: selected.file.path,
      treeDigest,
    });
    const packet: TargetIntakePacket = {
      kind: "target-intake-packet",
      schemaVersion: 1,
      id: artifactId("packet", packetSeed),
      pluginIdentity,
      version: request.requestedVersion,
      canonicalInstallDirectory,
      mainPluginFile: selected.file.path,
      pluginBasename: `${canonicalInstallDirectory}/${selected.file.path}`,
      targetSnapshot: {
        id: artifactId("target", targetSnapshotDigest),
        pluginSlug,
        version: request.requestedVersion,
        digest: targetSnapshotDigest,
      },
      sourceTree: {
        digest: treeDigest,
        entries: manifestEntries.length,
        manifest,
      },
      sourceCapture: {
        kind: this.#sourceCaptureKind,
        digest: treeDigest,
        files: manifestEntries,
      },
      versionEvidence: {
        requestedVersion: request.requestedVersion,
        mainHeaderVersion: selected.header.version,
        mainFileDigest: selected.file.digest,
      },
      provenance: request.provenance,
      policy: { id: request.policy.id, digest: request.policy.digest },
    };

    for (const file of capture.files) {
      await persistContentAddressedFile(
        blobPath(this.#storageDirectory, file.digest),
        file.bytes,
      );
    }
    const packetRef = await this.#persistJson(packet);
    const receipt: IntakeReceipt = {
      kind: "target-intake-receipt",
      schemaVersion: 1,
      id: artifactId("receipt", requestDigest),
      requestDigest,
      policy: { id: request.policy.id, digest: request.policy.digest },
      status: "ready",
      reasons: [],
      packetRef,
    };
    const receiptRef = await this.#persistJson(receipt);
    return intakeDispositionSchema.parse({
      status: "ready",
      receipt,
      receiptRef,
      packet,
      packetRef,
    });
  }
}

export function openLocalDirectoryTargetIntake(
  options: LocalDirectoryTargetIntakeOptions,
): TargetIntake {
  return new LocalDirectoryTargetIntake(options);
}
