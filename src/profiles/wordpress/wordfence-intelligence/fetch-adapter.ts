import {
  wordfenceRateLimitBackoffSchema,
  type HostPrivateCredentialBroker,
  type WordfenceIntelligenceSourceResponse,
  type WordfenceIntelligenceV3Adapter,
  type WordfenceIntelligenceV3FetchAdapterOptions,
  type WordfenceRateLimitBackoff,
  type WordfenceSecretRef,
} from "./contracts.js";

const MAXIMUM_RETRY_AFTER_SECONDS = 86_400;
const DEFAULT_SOURCE_URL =
  "https://www.wordfence.com/api/intelligence/v3/vulnerabilities/production";

export class ResponseTooLargeError extends Error {
  constructor() {
    super("Wordfence Intelligence response exceeded its byte ceiling");
    this.name = "ResponseTooLargeError";
  }
}

export class PartialResponseError extends Error {
  constructor() {
    super("Wordfence Intelligence response was incomplete");
    this.name = "PartialResponseError";
  }
}

export class CredentialUnavailableError extends Error {
  constructor() {
    super("Wordfence Intelligence credential is unavailable");
    this.name = "CredentialUnavailableError";
  }
}

export function unspecifiedRateLimitBackoff(
  now: Date,
): WordfenceRateLimitBackoff {
  return wordfenceRateLimitBackoffSchema.parse({
    kind: "wordfence-rate-limit-backoff",
    schemaVersion: 2,
    automaticRetries: 0,
    boundedAt: now.toISOString(),
    maximumDelaySeconds: MAXIMUM_RETRY_AFTER_SECONDS,
    retryAfter: { kind: "unspecified" },
  });
}

async function boundedResponseBytes(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  const contentEncoding = response.headers.get("content-encoding");
  const hasIdentityEncoding =
    contentEncoding === null ||
    contentEncoding.trim().toLowerCase() === "identity";
  const expectedLength =
    declaredLength !== null &&
    hasIdentityEncoding &&
    Number.isSafeInteger(Number(declaredLength))
      ? Number(declaredLength)
      : undefined;
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > maximumBytes
  ) {
    throw new ResponseTooLargeError();
  }
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes) {
      throw new ResponseTooLargeError();
    }
    if (expectedLength !== undefined && bytes.byteLength !== expectedLength) {
      throw new PartialResponseError();
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let bodyFailure: unknown;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // The byte-ceiling failure is primary; cancellation is best-effort cleanup.
        }
        throw new ResponseTooLargeError();
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      bodyFailure = error;
    } else {
      try {
        await reader.cancel();
      } catch {
        // The incomplete-body failure is primary; cancellation is cleanup.
      }
      bodyFailure = new PartialResponseError();
    }
  }
  try {
    reader.releaseLock();
  } catch (error) {
    if (bodyFailure === undefined) {
      throw error;
    }
  }
  if (bodyFailure !== undefined) {
    throw bodyFailure;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (expectedLength !== undefined && bytes.byteLength !== expectedLength) {
    throw new PartialResponseError();
  }
  return bytes;
}

function rateLimitBackoff(headers: Headers, now: Date) {
  const value = headers.get("retry-after");
  const boundedAt = now.toISOString();
  const earliestTimestamp = now.getTime();
  const latestTimestamp =
    earliestTimestamp + MAXIMUM_RETRY_AFTER_SECONDS * 1_000;
  let retryAfter:
    | { readonly kind: "unspecified" }
    | {
        readonly kind: "delay-seconds";
        readonly seconds: number;
        readonly capped: boolean;
      }
    | {
        readonly kind: "absolute-time";
        readonly at: string;
        readonly capped: boolean;
      } = { kind: "unspecified" };
  if (value !== null && /^\d+$/u.test(value)) {
    const normalizedSeconds = value.replace(/^0+(?=\d)/u, "");
    const maximumSeconds = String(MAXIMUM_RETRY_AFTER_SECONDS);
    const capped =
      normalizedSeconds.length > maximumSeconds.length ||
      (normalizedSeconds.length === maximumSeconds.length &&
        normalizedSeconds > maximumSeconds);
    retryAfter = {
      kind: "delay-seconds",
      seconds: capped ? MAXIMUM_RETRY_AFTER_SECONDS : Number(normalizedSeconds),
      capped,
    };
  } else if (value !== null) {
    const timestamp = Date.parse(value);
    if (!Number.isNaN(timestamp)) {
      const boundedTimestamp = Math.max(
        earliestTimestamp,
        Math.min(timestamp, latestTimestamp),
      );
      retryAfter = {
        kind: "absolute-time",
        at: new Date(boundedTimestamp).toISOString(),
        capped: boundedTimestamp !== timestamp,
      };
    }
  }
  return wordfenceRateLimitBackoffSchema.parse({
    kind: "wordfence-rate-limit-backoff",
    schemaVersion: 2,
    automaticRetries: 0,
    boundedAt,
    maximumDelaySeconds: MAXIMUM_RETRY_AFTER_SECONDS,
    retryAfter,
  });
}

class FetchWordfenceIntelligenceV3Adapter implements WordfenceIntelligenceV3Adapter {
  readonly sourceUrl: string;
  readonly #credentialResolver:
    ((reference: WordfenceSecretRef) => Promise<string> | string) | undefined;
  readonly #credentialBroker: HostPrivateCredentialBroker | undefined;
  readonly #fetch: typeof fetch;
  readonly #clock: () => Date;

  constructor(options: WordfenceIntelligenceV3FetchAdapterOptions) {
    this.sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
    this.#credentialResolver = options.credentialResolver;
    this.#credentialBroker = options.credentialBroker;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#clock = options.clock ?? (() => new Date());
    if (
      (this.#credentialResolver === undefined) ===
      (this.#credentialBroker === undefined)
    ) {
      throw new Error(
        "Wordfence Intelligence requires exactly one credential source",
      );
    }
  }

  async retrieveProductionFeed(request: {
    readonly credential: WordfenceSecretRef;
    readonly maximumBytes: number;
  }): Promise<WordfenceIntelligenceSourceResponse> {
    if (this.#credentialBroker !== undefined) {
      let credentialWasProvided = false;
      try {
        return await this.#credentialBroker.resolve(
          request.credential,
          async (credential) => {
            credentialWasProvided = true;
            return this.#retrieveWithCredential(
              credential,
              request.maximumBytes,
            );
          },
        );
      } catch (error) {
        if (!credentialWasProvided) {
          throw new CredentialUnavailableError();
        }
        throw error;
      }
    }
    const credential = await this.#credentialResolver?.(request.credential);
    if (credential === undefined) {
      throw new CredentialUnavailableError();
    }
    return this.#retrieveWithCredential(credential, request.maximumBytes);
  }

  async #retrieveWithCredential(
    credential: string,
    maximumBytes: number,
  ): Promise<WordfenceIntelligenceSourceResponse> {
    if (credential.length === 0) {
      throw new CredentialUnavailableError();
    }
    const response = await this.#fetch(this.sourceUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${credential}`,
      },
    });
    const complete =
      response.status === 200 && !response.headers.has("content-range");
    return {
      status: response.status,
      sourceUrl: response.url || this.sourceUrl,
      complete,
      redirected: response.status >= 300 && response.status < 400,
      ...(response.status === 429
        ? { backoff: rateLimitBackoff(response.headers, this.#clock()) }
        : {}),
      bytes: complete
        ? await boundedResponseBytes(response, maximumBytes)
        : new Uint8Array(),
    };
  }
}

export function createWordfenceIntelligenceV3FetchAdapter(
  options: WordfenceIntelligenceV3FetchAdapterOptions,
): WordfenceIntelligenceV3Adapter {
  return new FetchWordfenceIntelligenceV3Adapter(options);
}
