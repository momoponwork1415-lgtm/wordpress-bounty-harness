import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

export const PROVIDER_UPSTREAM_ORIGIN = "https://api.openai.com/v1";

export type ProviderApiProtocol = "responses" | "chat-completions";

export interface OpenProviderCredentialProxyOptions {
  readonly listenHost: string;
  readonly port: number;
  readonly upstreamOrigin: string;
  readonly apiKey: string;
  readonly grantToken: string;
  readonly model: string;
  readonly protocol: ProviderApiProtocol;
  readonly maxRequests: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly expiresAt: string;
  readonly clock?: () => Date;
}

export interface ProviderCredentialProxy {
  readonly origin: string;
  readonly server: Server;
}

function protocolPath(protocol: ProviderApiProtocol): string {
  return protocol === "responses" ? "/v1/responses" : "/v1/chat/completions";
}

function sendJson(
  response: ServerResponse,
  status: number,
  reason: string,
): void {
  const body = JSON.stringify({ error: { reason } });
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function bearerMatches(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

function redactSecret(body: Buffer, secret: string): Buffer {
  return Buffer.from(
    body.toString("utf8").split(secret).join("[REDACTED]"),
    "utf8",
  );
}

async function boundedRequestBody(
  request: IncomingMessage,
  limit: number,
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let exceeded = false;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.length;
    if (bytes > limit) {
      exceeded = true;
      continue;
    }
    chunks.push(chunk);
  }
  return exceeded ? undefined : Buffer.concat(chunks, bytes);
}

async function boundedResponseBody(
  response: Response,
  limit: number,
): Promise<Buffer | undefined> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > limit) {
        await reader.cancel("response limit exceeded");
        return undefined;
      }
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

function validateOptions(options: OpenProviderCredentialProxyOptions): void {
  const expiresAt = new Date(options.expiresAt);
  if (
    options.listenHost.length === 0 ||
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65_535 ||
    options.apiKey.length === 0 ||
    options.grantToken.length < 8 ||
    options.model.length === 0 ||
    !Number.isSafeInteger(options.maxRequests) ||
    options.maxRequests <= 0 ||
    !Number.isSafeInteger(options.maxRequestBytes) ||
    options.maxRequestBytes <= 0 ||
    !Number.isSafeInteger(options.maxResponseBytes) ||
    options.maxResponseBytes <= 0 ||
    !Number.isFinite(expiresAt.getTime())
  ) {
    throw new Error("Invalid Provider credential proxy options");
  }
  const upstream = new URL(options.upstreamOrigin);
  if (upstream.username.length > 0 || upstream.password.length > 0) {
    throw new Error("Provider upstream origin must not contain credentials");
  }
}

export async function openProviderCredentialProxy(
  options: OpenProviderCredentialProxyOptions,
): Promise<ProviderCredentialProxy> {
  validateOptions(options);
  const clock = options.clock ?? (() => new Date());
  const path = protocolPath(options.protocol);
  const upstreamOrigin = new URL(options.upstreamOrigin);
  let forwardedRequests = 0;

  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        response.writeHead(200, { "content-length": "0" });
        response.end();
        return;
      }
      if (!bearerMatches(request.headers.authorization, options.grantToken)) {
        sendJson(response, 401, "grant-unauthorized");
        return;
      }
      if (clock().getTime() >= new Date(options.expiresAt).getTime()) {
        sendJson(response, 401, "grant-expired");
        return;
      }
      if (request.method !== "POST" || request.url !== path) {
        sendJson(response, 404, "protocol-not-admitted");
        return;
      }
      const body = await boundedRequestBody(request, options.maxRequestBytes);
      if (body === undefined) {
        sendJson(response, 413, "request-limit-exceeded");
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body.toString("utf8")) as unknown;
      } catch {
        sendJson(response, 400, "request-json-invalid");
        return;
      }
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("model" in payload) ||
        payload.model !== options.model
      ) {
        sendJson(response, 403, "model-not-admitted");
        return;
      }
      if (forwardedRequests >= options.maxRequests) {
        sendJson(response, 429, "grant-request-limit-exceeded");
        return;
      }
      forwardedRequests += 1;
      const upstreamUrl = new URL(path, upstreamOrigin.origin);
      const remainingMs =
        new Date(options.expiresAt).getTime() - clock().getTime();
      if (remainingMs <= 0) {
        sendJson(response, 401, "grant-expired");
        return;
      }
      const upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
          accept: request.headers.accept ?? "application/json",
        },
        body: new Uint8Array(body),
        redirect: "error",
        signal: AbortSignal.timeout(remainingMs),
      });
      const upstreamBody = await boundedResponseBody(
        upstream,
        options.maxResponseBytes,
      );
      if (upstreamBody === undefined) {
        sendJson(response, 502, "response-limit-exceeded");
        return;
      }
      const redactedUpstreamBody = redactSecret(upstreamBody, options.apiKey);
      const contentType = upstream.headers.get("content-type");
      response.writeHead(upstream.status, {
        ...(contentType === null ? {} : { "content-type": contentType }),
        "content-length": redactedUpstreamBody.length,
      });
      response.end(redactedUpstreamBody);
    } catch {
      if (!response.headersSent) {
        sendJson(response, 502, "provider-unavailable");
      } else {
        response.destroy();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.listenHost);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Provider credential proxy did not bind a TCP listener");
  }
  return {
    server,
    origin: `http://${options.listenHost}:${address.port}`,
  };
}
