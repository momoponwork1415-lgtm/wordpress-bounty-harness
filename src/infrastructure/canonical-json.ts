import { createHash } from "node:crypto";

import { z } from "zod";

type JsonPrimitive = boolean | null | number | string;

export type JsonValue =
  JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

const jsonValueSchema = z.json();

function isPropertyJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isPropertyJsonValue);
  }
  if (typeof value !== "object") {
    return false;
  }
  return Object.values(value).every(isPropertyJsonValue);
}

function digest(encoded: string): string {
  return `sha256:${createHash("sha256").update(encoded).digest("hex")}`;
}

/** Encode already-validated JSON without changing persisted byte ordering. */
export function encodeCanonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new TypeError("Value is not JSON encodable");
    }
    return encoded;
  }

  if (Array.isArray(value)) {
    return `[${value.map(encodeCanonicalJson).join(",")}]`;
  }

  const members = Object.keys(value)
    .sort()
    .map((key) => {
      const member = value[key];
      if (member === undefined) {
        throw new TypeError(`Missing JSON member: ${key}`);
      }
      return `${JSON.stringify(key)}:${encodeCanonicalJson(member)}`;
    });

  return `{${members.join(",")}}`;
}

/** Validate JSON and encode it using the persisted artifact format. */
export function canonicalJson(value: unknown): string {
  return encodeCanonicalJson(jsonValueSchema.parse(value));
}

/** Preserve the existing acquisition format, including its input contract. */
export function canonicalJsonPreservingProperties(value: unknown): string {
  if (!isPropertyJsonValue(value)) {
    throw new TypeError("Value is not JSON encodable");
  }
  return encodeCanonicalJson(value);
}

export function canonicalDigestPreservingProperties(value: unknown): string {
  return digest(canonicalJsonPreservingProperties(value));
}

/**
 * The identity a content-addressed artifact is stored and addressed by.
 *
 * Both contexts name an artifact by the SHA-256 of its canonical encoding, so
 * the digest belongs with the encoding rather than beside either store.
 */
export function canonicalDigest(value: unknown): string {
  return digest(canonicalJson(value));
}
