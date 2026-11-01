import { createHash } from "node:crypto";

import { z } from "zod";

/**
 * WordPress.org's core version check (#741). `offers[0].current` names the
 * latest stable release. Only the version string and the response digest are
 * kept; the body is never stored.
 */
export const WORDPRESS_CORE_VERSION_CHECK_URL =
  "https://api.wordpress.org/core/version-check/1.7/";

const DEFAULT_MAXIMUM_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

const responseSchema = z
  .object({
    offers: z
      .array(
        z
          .object({
            current: z
              .string()
              .max(32)
              .regex(/^[0-9]+(?:\.[0-9]+){1,3}$/),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

export type WordPressCoreReleaseObservation =
  | {
      readonly status: "observed";
      readonly version: string;
      readonly observedAt: string;
      readonly sourceUrl: string;
      readonly responseDigest: string;
    }
  | {
      readonly status: "unavailable";
      readonly reason: "network" | "status" | "too-large" | "malformed";
    };

export function openWordPressCoreRelease(
  options: {
    readonly fetch?: typeof globalThis.fetch;
    readonly clock?: () => Date;
    readonly maximumBytes?: number;
    readonly timeoutMs?: number;
  } = {},
): () => Promise<WordPressCoreReleaseObservation> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const clock = options.clock ?? (() => new Date());
  const maximumBytes = options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async () => {
    let response: Response;
    try {
      response = await fetchImpl(WORDPRESS_CORE_VERSION_CHECK_URL, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json" },
      });
    } catch {
      return { status: "unavailable", reason: "network" };
    }
    if (response.status !== 200)
      return { status: "unavailable", reason: "status" };
    let body: string;
    try {
      body = await response.text();
    } catch {
      return { status: "unavailable", reason: "network" };
    }
    if (Buffer.byteLength(body, "utf8") > maximumBytes)
      return { status: "unavailable", reason: "too-large" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      return { status: "unavailable", reason: "malformed" };
    }
    const result = responseSchema.safeParse(parsed);
    if (!result.success) return { status: "unavailable", reason: "malformed" };
    return {
      status: "observed",
      version: result.data.offers[0]!.current,
      observedAt: clock().toISOString(),
      sourceUrl: WORDPRESS_CORE_VERSION_CHECK_URL,
      responseDigest: `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`,
    };
  };
}
