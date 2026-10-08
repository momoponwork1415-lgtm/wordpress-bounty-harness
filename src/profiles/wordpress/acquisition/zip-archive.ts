import { inflateRawSync } from "node:zlib";

import type { TargetIntakeReason, TargetIntakePolicy } from "./contracts.js";

interface ExtractedArchiveFile {
  readonly path: string;
  readonly bytes: Buffer;
}

interface ExtractedArchive {
  readonly status: "extracted";
  readonly files: readonly ExtractedArchiveFile[];
}

interface RejectedArchive {
  readonly status: "rejected";
  readonly reasons: readonly TargetIntakeReason[];
}

export type ZipArchiveExtraction = ExtractedArchive | RejectedArchive;

interface CentralEntry {
  readonly path: string;
  readonly flags: number;
  readonly method: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly externalAttributes: number;
  readonly localHeaderOffset: number;
}

const archiveReasonOrder: readonly TargetIntakeReason[] = [
  "archive-invalid",
  "path-traversal",
  "link-entry",
  "path-collision",
  "multiple-plugin-roots",
  "quota-exceeded",
];

function rejected(
  reasons: ReadonlySet<TargetIntakeReason> | readonly TargetIntakeReason[],
): RejectedArchive {
  const values = new Set(reasons);
  return {
    status: "rejected",
    reasons: archiveReasonOrder.filter((reason) => values.has(reason)),
  };
}

function within(buffer: Buffer, offset: number, length: number): boolean {
  return (
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    offset >= 0 &&
    length >= 0 &&
    offset + length <= buffer.byteLength
  );
}

function findEndOfCentralDirectory(buffer: Buffer): number | undefined {
  const minimum = Math.max(0, buffer.byteLength - 65_557);
  for (let offset = buffer.byteLength - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  return undefined;
}

function decodePath(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function unsafePath(path: string): boolean {
  const segments = path.split("/");
  if (path.endsWith("/")) {
    segments.pop();
  }
  return (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    /^[A-Za-z]:/u.test(path) ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  );
}

function unixFileType(externalAttributes: number): number {
  return (externalAttributes >>> 16) & 0xf000;
}

function checksum(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parseCentralEntries(
  buffer: Buffer,
  policy: TargetIntakePolicy,
): readonly CentralEntry[] | RejectedArchive {
  const endOffset = findEndOfCentralDirectory(buffer);
  if (endOffset === undefined || !within(buffer, endOffset, 22)) {
    return rejected(["archive-invalid"]);
  }
  const diskNumber = buffer.readUInt16LE(endOffset + 4);
  const centralDisk = buffer.readUInt16LE(endOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(endOffset + 8);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  const commentLength = buffer.readUInt16LE(endOffset + 20);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    endOffset + 22 + commentLength !== buffer.byteLength ||
    !within(buffer, centralOffset, centralSize) ||
    centralOffset + centralSize !== endOffset
  ) {
    return rejected(["archive-invalid"]);
  }
  if (entryCount > policy.limits.maxEntries) {
    return rejected(["quota-exceeded"]);
  }

  const entries: CentralEntry[] = [];
  const reasons = new Set<TargetIntakeReason>();
  let offset = centralOffset;
  let totalSize = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      !within(buffer, offset, 46) ||
      buffer.readUInt32LE(offset) !== 0x02014b50
    ) {
      return rejected(["archive-invalid"]);
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc32 = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentSize = buffer.readUInt16LE(offset + 32);
    const diskStart = buffer.readUInt16LE(offset + 34);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const recordLength = 46 + nameLength + extraLength + commentSize;
    if (
      diskStart !== 0 ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      !within(buffer, offset, recordLength)
    ) {
      return rejected(["archive-invalid"]);
    }
    const path = decodePath(
      buffer.subarray(offset + 46, offset + 46 + nameLength),
    );
    if (path === undefined || unsafePath(path)) {
      reasons.add("path-traversal");
      offset += recordLength;
      continue;
    }
    const isDirectory =
      path.endsWith("/") || unixFileType(externalAttributes) === 0x4000;
    if (isDirectory) {
      offset += recordLength;
      continue;
    }
    if (unixFileType(externalAttributes) === 0xa000) {
      reasons.add("link-entry");
      offset += recordLength;
      continue;
    }
    if ((flags & 0x0001) !== 0 || (method !== 0 && method !== 8)) {
      reasons.add("archive-invalid");
      offset += recordLength;
      continue;
    }
    totalSize += uncompressedSize;
    if (
      uncompressedSize > policy.limits.maxFileBytes ||
      totalSize > policy.limits.maxTotalBytes
    ) {
      reasons.add("quota-exceeded");
      offset += recordLength;
      continue;
    }
    entries.push({
      path,
      flags,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      externalAttributes,
      localHeaderOffset,
    });
    offset += recordLength;
  }
  if (offset !== endOffset || reasons.size > 0) {
    return reasons.size > 0 ? rejected(reasons) : rejected(["archive-invalid"]);
  }
  if (entries.length === 0) {
    return rejected(["archive-invalid"]);
  }
  return entries;
}

function normalizedPaths(
  entries: readonly CentralEntry[],
  expectedRoot: string,
  policy: TargetIntakePolicy,
): readonly string[] | RejectedArchive {
  const firstSegments = new Set(
    entries.map((entry) => entry.path.split("/")[0]),
  );
  if (
    firstSegments.size !== 1 ||
    entries.some((entry) => entry.path.split("/").length < 2)
  ) {
    return rejected(["multiple-plugin-roots"]);
  }
  const actualRoot = entries[0]?.path.split("/")[0];
  if (actualRoot !== expectedRoot) {
    return rejected(["multiple-plugin-roots"]);
  }
  const paths: string[] = [];
  const collisionKeys = new Set<string>();
  const reasons = new Set<TargetIntakeReason>();
  for (const entry of entries) {
    const path = entry.path.split("/").slice(1).join("/");
    const segments = path.split("/");
    if (
      path.length === 0 ||
      Buffer.byteLength(path, "utf8") > policy.limits.maxPathBytes ||
      segments.length - 1 > policy.limits.maxDepth
    ) {
      reasons.add("quota-exceeded");
      continue;
    }
    const collisionKey = path.normalize("NFC").toLowerCase();
    if (collisionKeys.has(collisionKey)) {
      reasons.add("path-collision");
      continue;
    }
    collisionKeys.add(collisionKey);
    paths.push(path);
  }
  for (const path of paths) {
    const segments = path.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      const parentKey = segments
        .slice(0, length)
        .join("/")
        .normalize("NFC")
        .toLowerCase();
      if (collisionKeys.has(parentKey)) {
        reasons.add("path-collision");
      }
    }
  }
  return reasons.size > 0 ? rejected(reasons) : paths;
}

function decompressEntry(
  buffer: Buffer,
  entry: CentralEntry,
): Buffer | undefined {
  const offset = entry.localHeaderOffset;
  if (
    !within(buffer, offset, 30) ||
    buffer.readUInt32LE(offset) !== 0x04034b50
  ) {
    return undefined;
  }
  const localFlags = buffer.readUInt16LE(offset + 6);
  const localMethod = buffer.readUInt16LE(offset + 8);
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const contentOffset = offset + 30 + nameLength + extraLength;
  if (
    localFlags !== entry.flags ||
    localMethod !== entry.method ||
    !within(buffer, contentOffset, entry.compressedSize)
  ) {
    return undefined;
  }
  const compressed = buffer.subarray(
    contentOffset,
    contentOffset + entry.compressedSize,
  );
  let bytes: Buffer;
  try {
    bytes =
      entry.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, {
            maxOutputLength: entry.uncompressedSize + 1,
          });
  } catch {
    return undefined;
  }
  if (
    bytes.byteLength !== entry.uncompressedSize ||
    checksum(bytes) !== entry.crc32
  ) {
    return undefined;
  }
  return bytes;
}

export function extractZipArchive(
  value: Uint8Array,
  expectedRoot: string,
  policy: TargetIntakePolicy,
): ZipArchiveExtraction {
  const buffer = Buffer.from(value);
  const entries = parseCentralEntries(buffer, policy);
  if ("status" in entries) {
    return entries;
  }
  const paths = normalizedPaths(entries, expectedRoot, policy);
  if ("status" in paths) {
    return paths;
  }
  const files: ExtractedArchiveFile[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const path = paths[index];
    if (entry === undefined || path === undefined) {
      return rejected(["archive-invalid"]);
    }
    const bytes = decompressEntry(buffer, entry);
    if (bytes === undefined) {
      return rejected(["archive-invalid"]);
    }
    files.push({ path, bytes });
  }
  files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return { status: "extracted", files };
}
