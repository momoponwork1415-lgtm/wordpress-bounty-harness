import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

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
    "captured-local-directory" | "captured-wordpress-org-archive";
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

const structuralReasonOrder: readonly TargetIntakeReason[] = [
  "source-not-directory",
  "link-entry",
  "hardlink-entry",
  "non-regular-entry",
  "path-collision",
  "quota-exceeded",
];

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

function sortedReasons(
  reasons: ReadonlySet<TargetIntakeReason>,
): readonly TargetIntakeReason[] {
  return structuralReasonOrder.filter((reason) => reasons.has(reason));
}

async function readRegularFileWithoutFollowingLink(
  absolutePath: string,
): Promise<{ readonly bytes: Buffer; readonly nlink: number } | undefined> {
  let handle;
  try {
    handle = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (hasErrorCode(error, "ELOOP")) {
      return undefined;
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      return undefined;
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.byteLength !== after.size
    ) {
      throw new Error(
        `Source file changed while being captured: ${absolutePath}`,
      );
    }
    return { bytes, nlink: after.nlink };
  } finally {
    await handle.close();
  }
}

async function captureDirectory(
  sourceDirectory: string,
  policy: ManualTargetIntakeRequest["policy"],
): Promise<CaptureResult> {
  let rootStat;
  try {
    rootStat = await lstat(sourceDirectory);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
      return { status: "rejected", reasons: ["source-not-directory"] };
    }
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return { status: "rejected", reasons: ["source-not-directory"] };
  }

  const files: CapturedFile[] = [];
  const reasons = new Set<TargetIntakeReason>();
  const collisionKeys = new Set<string>();
  let entryCount = 0;
  let totalBytes = 0;

  const walk = async (
    absoluteDirectory: string,
    pathSegments: readonly string[],
  ): Promise<void> => {
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > policy.limits.maxEntries) {
        reasons.add("quota-exceeded");
        continue;
      }
      const segments = [...pathSegments, entry.name];
      const relativePath = segments.join("/");
      const absolutePath = join(absoluteDirectory, entry.name);
      if (
        entry.name.includes("\\") ||
        entry.name.includes("\0") ||
        entry.name === "." ||
        entry.name === ".."
      ) {
        reasons.add("non-regular-entry");
        continue;
      }
      if (
        Buffer.byteLength(relativePath, "utf8") > policy.limits.maxPathBytes ||
        segments.length - 1 > policy.limits.maxDepth
      ) {
        reasons.add("quota-exceeded");
        continue;
      }
      const collisionKey = relativePath.normalize("NFC").toLowerCase();
      if (collisionKeys.has(collisionKey)) {
        reasons.add("path-collision");
        continue;
      }
      collisionKeys.add(collisionKey);

      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        reasons.add("link-entry");
        continue;
      }
      if (stat.isDirectory()) {
        await walk(absolutePath, segments);
        continue;
      }
      if (!stat.isFile()) {
        reasons.add("non-regular-entry");
        continue;
      }
      if (stat.nlink > 1) {
        reasons.add("hardlink-entry");
        continue;
      }
      if (stat.size > policy.limits.maxFileBytes) {
        reasons.add("quota-exceeded");
        continue;
      }
      const captured = await readRegularFileWithoutFollowingLink(absolutePath);
      if (captured === undefined) {
        reasons.add("link-entry");
        continue;
      }
      if (captured.nlink > 1) {
        reasons.add("hardlink-entry");
        continue;
      }
      totalBytes += captured.bytes.byteLength;
      if (totalBytes > policy.limits.maxTotalBytes) {
        reasons.add("quota-exceeded");
        continue;
      }
      files.push({
        path: relativePath,
        digest: rawDigest(captured.bytes),
        size: captured.bytes.byteLength,
        bytes: captured.bytes,
      });
    }
  };

  await walk(sourceDirectory, []);
  if (reasons.size > 0) {
    return { status: "rejected", reasons: sortedReasons(reasons) };
  }
  if (files.length === 0) {
    return { status: "rejected", reasons: ["main-plugin-file-missing"] };
  }
  files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
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

function artifactId(prefix: string, digest: string): string {
  return `${prefix}:${digest.slice("sha256:".length, "sha256:".length + 24)}`;
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

class LocalDirectoryTargetIntake implements TargetIntake {
  readonly #storageDirectory: string;
  readonly #sourceCaptureKind:
    "captured-local-directory" | "captured-wordpress-org-archive";

  constructor(options: LocalDirectoryTargetIntakeOptions) {
    this.#storageDirectory = options.storageDirectory;
    this.#sourceCaptureKind =
      options.sourceCaptureKind ?? "captured-local-directory";
  }

  async #persistJson(value: unknown): Promise<{ id: string; digest: string }> {
    const bytes = Buffer.from(canonicalJson(value), "utf8");
    const digest = rawDigest(bytes);
    const id = artifactId("artifact", digest);
    const directory = join(this.#storageDirectory, "objects");
    await mkdir(directory, { recursive: true });
    await persistBytes(join(directory, `${digest.slice(7)}.json`), bytes);
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

    const blobDirectory = join(this.#storageDirectory, "blobs");
    await mkdir(blobDirectory, { recursive: true });
    for (const file of capture.files) {
      await persistBytes(join(blobDirectory, file.digest.slice(7)), file.bytes);
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
