import {
  appendFileSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
} from "node:http";

export const BODY_LIMIT_BYTES = 1024 * 1024;
export const CAPTURE_LIMIT_BYTES = 64 * BODY_LIMIT_BYTES;

export interface CapturedExchange {
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly headers: IncomingMessage["headers"];
    readonly body: string;
    readonly bodyBase64: string;
    readonly truncated: boolean;
  };
  readonly response: {
    readonly statusCode: number;
    readonly headers: IncomingMessage["headers"];
    readonly body: string;
    readonly bodyBase64: string;
    readonly truncated: boolean;
  };
}

/** Only the recorder's private file carries request and response contents. */
function tapBody(
  chunks: Buffer[],
  chunk: Buffer,
  held: { bytes: number; truncated: boolean },
  limit: number,
) {
  const remaining = limit - held.bytes;
  if (chunk.length > remaining) held.truncated = true;
  if (remaining > 0) {
    const kept = chunk.subarray(0, remaining);
    chunks.push(kept);
    held.bytes += kept.length;
  }
}

function body(chunks: Buffer[], held: { bytes: number; truncated: boolean }) {
  const bytes = Buffer.concat(chunks);
  return {
    body: bytes.toString("utf8"),
    bodyBase64: bytes.toString("base64"),
    truncated: held.truncated,
  };
}

export function createRecorderServer(options: {
  readonly upstreamHost: string;
  readonly upstreamPort: number;
  readonly capturePath: string;
  readonly droppedPath: string;
  readonly bodyLimitBytes?: number;
  readonly captureLimitBytes?: number;
}): Server {
  const bodyLimit = options.bodyLimitBytes ?? BODY_LIMIT_BYTES;
  const captureLimit = options.captureLimitBytes ?? CAPTURE_LIMIT_BYTES;
  if (
    !Number.isSafeInteger(bodyLimit) ||
    bodyLimit < 1 ||
    bodyLimit > BODY_LIMIT_BYTES
  )
    throw new Error("Invalid recorder body limit");
  if (
    !Number.isSafeInteger(captureLimit) ||
    captureLimit < 1 ||
    captureLimit > CAPTURE_LIMIT_BYTES
  )
    throw new Error("Invalid recorder capture limit");
  let capturedBytes = existsSync(options.capturePath)
    ? statSync(options.capturePath).size
    : 0;
  let dropped = existsSync(options.droppedPath)
    ? Number(readFileSync(options.droppedPath, "utf8")) || 0
    : 0;
  appendFileSync(options.capturePath, "", { mode: 0o600 });
  return createServer((clientRequest, clientResponse) => {
    const requestChunks: Buffer[] = [];
    const requestHeld = { bytes: 0, truncated: false };
    const responseChunks: Buffer[] = [];
    const responseHeld = { bytes: 0, truncated: false };
    const upstream = request({
      host: options.upstreamHost,
      port: options.upstreamPort,
      method: clientRequest.method,
      path: clientRequest.url,
      headers: clientRequest.headers,
    });
    clientRequest.on("data", (chunk: Buffer) =>
      tapBody(requestChunks, chunk, requestHeld, bodyLimit),
    );
    clientRequest.pipe(upstream);
    upstream.on("response", (response) => {
      clientResponse.writeHead(response.statusCode ?? 502, response.headers);
      response.on("data", (chunk: Buffer) =>
        tapBody(responseChunks, chunk, responseHeld, bodyLimit),
      );
      response.pipe(clientResponse);
      response.on("end", () => {
        const record: CapturedExchange = {
          request: {
            method: clientRequest.method ?? "GET",
            path: clientRequest.url ?? "/",
            headers: clientRequest.headers,
            ...body(requestChunks, requestHeld),
          },
          response: {
            statusCode: response.statusCode ?? 502,
            headers: response.headers,
            ...body(responseChunks, responseHeld),
          },
        };
        const line = `${JSON.stringify(record)}\n`;
        const size = Buffer.byteLength(line);
        if (capturedBytes + size > captureLimit) {
          dropped++;
          writeFileSync(options.droppedPath, String(dropped));
        } else {
          appendFileSync(options.capturePath, line, { mode: 0o600 });
          capturedBytes += size;
        }
      });
    });
    upstream.on("error", () => {
      if (!clientResponse.headersSent) clientResponse.writeHead(502);
      clientResponse.end();
    });
  });
}
