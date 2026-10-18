export class ResponseTooLargeError extends Error {
  constructor() {
    super("Response exceeded its byte ceiling");
    this.name = "ResponseTooLargeError";
  }
}

/** Reads a response body, stopping as soon as it passes `maximumBytes`. */
export async function readBoundedResponse(
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
        await reader.cancel().catch(() => undefined);
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

export interface BoundedFetchOptions {
  readonly maximumBytes: number;
  readonly timeoutMs: number;
  /** Required: each caller decides whether a redirect is followed or is an error. */
  readonly redirect: "follow" | "error" | "manual";
  readonly headers: Record<string, string>;
  readonly method?: "GET";
  readonly credentials?: "omit";
}

/**
 * Issues one request with a timeout and returns the response with a reader
 * that enforces the byte ceiling. The body is read only when `readBody` is
 * called, so a caller can reject on status or headers first.
 */
export async function fetchBounded(
  fetcher: typeof fetch,
  url: string,
  options: BoundedFetchOptions,
): Promise<{
  readonly response: Response;
  readonly readBody: () => Promise<Uint8Array>;
}> {
  const response = await fetcher(url, {
    ...(options.method === undefined ? {} : { method: options.method }),
    redirect: options.redirect,
    ...(options.credentials === undefined
      ? {}
      : { credentials: options.credentials }),
    headers: options.headers,
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  return {
    response,
    readBody: () => readBoundedResponse(response, options.maximumBytes),
  };
}
