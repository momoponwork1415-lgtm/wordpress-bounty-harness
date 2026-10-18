import { createHash } from "node:crypto";

/** `sha256:<hex>` of raw bytes (or of a string's UTF-8 bytes). */
export function bytesDigest(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** A short, prefixed id derived from the first 24 hex characters of a digest. */
export function artifactId(prefix: string, digest: string): string {
  return `${prefix}:${digest.slice("sha256:".length, "sha256:".length + 24)}`;
}
