import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import { createServer as createTlsServer } from "node:https";
import type { Server as NetServer } from "node:net";

export const PROVIDER_UPSTREAM_ORIGIN = "https://api.openai.com/v1";
export const ANTHROPIC_UPSTREAM_ORIGIN = "https://api.anthropic.com";
/** The OAuth capability Claude Code forwards through a subscription gateway. */
export const ANTHROPIC_SUBSCRIPTION_BETA = "oauth-2025-04-20";
/** Codex subscription backend; only its responses endpoint is ever forwarded. */
export const CHATGPT_UPSTREAM_ORIGIN = "https://chatgpt.com";
/** The name the sandbox resolves to the broker and the grant certificate names. */
export const BROKER_TLS_HOSTNAME = "provider-egress.internal";
/** The account id the sandbox sees; the real one stays in the broker. */
export const CHATGPT_PLACEHOLDER_ACCOUNT_ID =
  "00000000-0000-4000-8000-000000000000";
const CHATGPT_RESPONSES_PATH = "/backend-api/codex/responses";
const CHATGPT_DISCOVERY_PATH = "/backend-api/wham/accounts/check";
/** Request headers the CLI sends that may reach the subscription backend. */
const CHATGPT_FORWARDED_HEADERS = [
  "accept",
  "originator",
  "session-id",
  "user-agent",
  "version",
  "x-client-request-id",
] as const;

export type ProviderApiProtocol =
  "responses" | "chat-completions" | "anthropic-messages";

/** The ChatGPT login the CLI would use, held by the broker only. */
export interface ChatgptProxyCredential {
  readonly accessToken: string;
  readonly accountId: string;
  readonly tls: { readonly keyPem: string; readonly certPem: string };
  /** Plain-HTTP health listener on the listen host; the agent never sees it. */
  readonly healthPort: number;
}

export type OpenProviderCredentialProxyOptions = {
  readonly listenHost: string;
  readonly port: number;
  readonly upstreamOrigin: string;
  readonly grantToken: string;
  readonly model: string;
  readonly protocol: ProviderApiProtocol;
  readonly maxRequests: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly expiresAt: string;
  readonly clock?: () => Date;
} & (
  | {
      readonly apiKey: string;
      readonly chatgpt?: never;
      readonly anthropicSubscriptionToken?: never;
    }
  | {
      readonly anthropicSubscriptionToken: string;
      readonly apiKey?: never;
      readonly chatgpt?: never;
    }
  | {
      readonly chatgpt: ChatgptProxyCredential;
      readonly apiKey?: never;
      readonly anthropicSubscriptionToken?: never;
    }
);

export interface ProviderCredentialProxy {
  readonly origin: string;
  readonly server: NetServer;
  /** Present in ChatGPT mode, where the main listener speaks TLS. */
  readonly healthOrigin?: string;
}

function protocolPath(protocol: ProviderApiProtocol): string {
  if (protocol === "responses") return "/v1/responses";
  if (protocol === "anthropic-messages") return "/v1/messages";
  return "/v1/chat/completions";
}

type ProxyCounters = {
  forwardedRequests: number;
  requestLimitExceeded: number;
  unauthorizedRequests: number;
  unauthorizedMissingCredentialRequests: number;
  unauthorizedMismatchedCredentialRequests: number;
  unauthorizedMessagesEndpointRequests: number;
  unauthorizedOtherEndpointRequests: number;
  rejectedConnectivityProbes: number;
  upstreamSuccess: number;
  upstreamClientError: number;
  upstreamServerError: number;
  relayFailures: number;
  responseLimitExceeded: number;
};

function recordUnauthorizedRequest(
  counters: ProxyCounters,
  request: IncomingMessage,
  credential: string | undefined,
): void {
  counters.unauthorizedRequests += 1;
  if (credential === undefined || credential.length === 0)
    counters.unauthorizedMissingCredentialRequests += 1;
  else counters.unauthorizedMismatchedCredentialRequests += 1;
  if ((request.url ?? "").split("?")[0] === "/v1/messages")
    counters.unauthorizedMessagesEndpointRequests += 1;
  else counters.unauthorizedOtherEndpointRequests += 1;
}

function sendMetrics(response: ServerResponse, counters: ProxyCounters): void {
  const body = JSON.stringify(counters);
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
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
  return tokenMatches(header.slice("Bearer ".length), token);
}

function tokenMatches(value: string | undefined, token: string): boolean {
  if (value === undefined) return false;
  const supplied = Buffer.from(value);
  const expected = Buffer.from(token);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

function redactSecret(body: Buffer, ...secrets: readonly string[]): Buffer {
  let text = body.toString("utf8");
  for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
  return Buffer.from(text, "utf8");
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
    (options.chatgpt === undefined
      ? (options.anthropicSubscriptionToken ?? options.apiKey ?? "").length ===
        0
      : options.chatgpt.accessToken.length < 8 ||
        options.chatgpt.accountId.length === 0 ||
        !Number.isInteger(options.chatgpt.healthPort) ||
        options.chatgpt.healthPort < 0 ||
        options.chatgpt.healthPort > 65_535) ||
    options.grantToken.length < 8 ||
    options.model.length === 0 ||
    !Number.isSafeInteger(options.maxRequests) ||
    options.maxRequests <= 0 ||
    !Number.isSafeInteger(options.maxRequestBytes) ||
    options.maxRequestBytes <= 0 ||
    !Number.isSafeInteger(options.maxResponseBytes) ||
    options.maxResponseBytes <= 0 ||
    !Number.isFinite(expiresAt.getTime()) ||
    (options.anthropicSubscriptionToken !== undefined &&
      (options.protocol !== "anthropic-messages" ||
        options.upstreamOrigin !== ANTHROPIC_UPSTREAM_ORIGIN))
  ) {
    throw new Error("Invalid Provider credential proxy options");
  }
  const upstream = new URL(options.upstreamOrigin);
  if (upstream.username.length > 0 || upstream.password.length > 0) {
    throw new Error("Provider upstream origin must not contain credentials");
  }
}

/**
 * Streams an upstream body to the agent with every secret replaced, holding
 * back just enough text that a secret split across chunks is still caught.
 * Returns false when the body grew past the limit and was cut off.
 */
async function streamRedacted(
  upstream: Response,
  response: ServerResponse,
  limit: number,
  secrets: readonly string[],
): Promise<boolean> {
  if (upstream.body === null) {
    response.end();
    return true;
  }
  const holdBack = Math.max(0, ...secrets.map((secret) => secret.length - 1));
  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();
  let pending = "";
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > limit) {
        await reader.cancel("response limit exceeded");
        return false;
      }
      pending = redactSecret(
        Buffer.from(pending + decoder.decode(item.value, { stream: true })),
        ...secrets,
      ).toString("utf8");
      if (pending.length > holdBack) {
        response.write(pending.slice(0, pending.length - holdBack));
        pending = pending.slice(pending.length - holdBack);
      }
    }
  } finally {
    reader.releaseLock();
  }
  response.end(
    redactSecret(Buffer.from(pending + decoder.decode()), ...secrets),
  );
  return true;
}

const chatgptDiscovery = JSON.stringify({
  accounts: [
    {
      id: CHATGPT_PLACEHOLDER_ACCOUNT_ID,
      workspace_backend_origin: "NO_CONSTRAINT",
      account_routing_override: "NO_CONSTRAINT",
      structure: "personal",
    },
  ],
  account_ordering: [CHATGPT_PLACEHOLDER_ACCOUNT_ID],
  default_account_id: CHATGPT_PLACEHOLDER_ACCOUNT_ID,
});

/**
 * The Codex CLI in ChatGPT login mode. Only the responses endpoint reaches the
 * subscription backend, with the real login attached here; the workspace
 * discovery the CLI needs before a turn is answered locally, and everything
 * else (plugins, analytics, settings) is refused.
 */
function chatgptListener(
  options: OpenProviderCredentialProxyOptions,
  chatgpt: ChatgptProxyCredential,
  clock: () => Date,
  counters: ProxyCounters,
): RequestListener {
  const upstreamOrigin = new URL(options.upstreamOrigin);
  return async (request, response) => {
    try {
      if (!bearerMatches(request.headers.authorization, options.grantToken)) {
        recordUnauthorizedRequest(
          counters,
          request,
          request.headers.authorization,
        );
        sendJson(response, 401, "grant-unauthorized");
        return;
      }
      if (clock().getTime() >= new Date(options.expiresAt).getTime()) {
        sendJson(response, 401, "grant-expired");
        return;
      }
      const path = (request.url ?? "").split("?")[0];
      if (request.method === "GET" && path === CHATGPT_DISCOVERY_PATH) {
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(chatgptDiscovery),
        });
        response.end(chatgptDiscovery);
        return;
      }
      if (path !== CHATGPT_RESPONSES_PATH) {
        sendJson(response, 403, "endpoint-not-admitted");
        return;
      }
      if (request.method === "GET") {
        // The CLI tries a WebSocket first and falls back to HTTP on 426.
        sendJson(response, 426, "websocket-not-admitted");
        return;
      }
      if (request.method !== "POST") {
        sendJson(response, 405, "method-not-admitted");
        return;
      }
      const encoding = request.headers["content-encoding"];
      if (encoding !== undefined && encoding !== "identity") {
        // A compressed body would hide the model from the check below.
        sendJson(response, 415, "content-encoding-not-admitted");
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
      if (counters.forwardedRequests >= options.maxRequests) {
        counters.requestLimitExceeded += 1;
        sendJson(response, 429, "grant-request-limit-exceeded");
        return;
      }
      counters.forwardedRequests += 1;
      const remainingMs =
        new Date(options.expiresAt).getTime() - clock().getTime();
      if (remainingMs <= 0) {
        sendJson(response, 401, "grant-expired");
        return;
      }
      const forwarded: Record<string, string> = {};
      for (const name of CHATGPT_FORWARDED_HEADERS) {
        const value = request.headers[name];
        if (typeof value === "string") forwarded[name] = value;
      }
      const upstream = await fetch(
        new URL(CHATGPT_RESPONSES_PATH, upstreamOrigin.origin),
        {
          method: "POST",
          headers: {
            ...forwarded,
            authorization: `Bearer ${chatgpt.accessToken}`,
            "chatgpt-account-id": chatgpt.accountId,
            "content-type": "application/json",
          },
          body: new Uint8Array(body),
          redirect: "error",
          signal: AbortSignal.timeout(remainingMs),
        },
      );
      if (upstream.status >= 500) counters.upstreamServerError += 1;
      else if (upstream.status >= 400) counters.upstreamClientError += 1;
      else counters.upstreamSuccess += 1;
      const contentType = upstream.headers.get("content-type");
      response.writeHead(upstream.status, {
        ...(contentType === null ? {} : { "content-type": contentType }),
      });
      const complete = await streamRedacted(
        upstream,
        response,
        options.maxResponseBytes,
        [chatgpt.accessToken, chatgpt.accountId],
      );
      if (!complete) {
        counters.responseLimitExceeded += 1;
        response.destroy();
      }
    } catch {
      counters.relayFailures += 1;
      if (!response.headersSent) {
        sendJson(response, 502, "provider-unavailable");
      } else {
        response.destroy();
      }
    }
  };
}

function providerCredentialListener(
  options: OpenProviderCredentialProxyOptions,
  credential: string,
  clock: () => Date,
  counters: ProxyCounters,
): RequestListener {
  const path = protocolPath(options.protocol);
  const upstreamOrigin = new URL(options.upstreamOrigin);
  return async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        sendMetrics(response, counters);
        return;
      }
      // Claude Code sends this unauthenticated, best-effort gateway probe.
      // Reject it locally without treating it as a failed Trial grant.
      if (
        options.protocol === "anthropic-messages" &&
        request.method === "HEAD" &&
        request.url === "/api/hello"
      ) {
        counters.rejectedConnectivityProbes += 1;
        response.writeHead(404, { "content-length": "0" });
        response.end();
        return;
      }
      const subscription = options.anthropicSubscriptionToken !== undefined;
      const suppliedCredential =
        options.protocol === "anthropic-messages" && !subscription
          ? typeof request.headers["x-api-key"] === "string"
            ? request.headers["x-api-key"]
            : undefined
          : request.headers.authorization;
      const grantAuthenticated =
        options.protocol === "anthropic-messages" && !subscription
          ? tokenMatches(suppliedCredential, options.grantToken)
          : bearerMatches(suppliedCredential, options.grantToken);
      if (!grantAuthenticated) {
        recordUnauthorizedRequest(counters, request, suppliedCredential);
        sendJson(response, 401, "grant-unauthorized");
        return;
      }
      if (clock().getTime() >= new Date(options.expiresAt).getTime()) {
        sendJson(response, 401, "grant-expired");
        return;
      }
      const admittedPath =
        request.url === path ||
        (options.protocol === "anthropic-messages" &&
          request.url === `${path}?beta=true`);
      if (request.method !== "POST" || !admittedPath) {
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
      if (counters.forwardedRequests >= options.maxRequests) {
        counters.requestLimitExceeded += 1;
        sendJson(response, 429, "grant-request-limit-exceeded");
        return;
      }
      const upstreamUrl = new URL(request.url ?? path, upstreamOrigin.origin);
      const remainingMs =
        new Date(options.expiresAt).getTime() - clock().getTime();
      if (remainingMs <= 0) {
        sendJson(response, 401, "grant-expired");
        return;
      }
      const anthropic = options.protocol === "anthropic-messages";
      const anthropicVersion = request.headers["anthropic-version"];
      if (anthropic && typeof anthropicVersion !== "string") {
        sendJson(response, 400, "anthropic-version-required");
        return;
      }
      const anthropicBeta = request.headers["anthropic-beta"];
      if (
        subscription &&
        (typeof anthropicBeta !== "string" ||
          !anthropicBeta
            .split(",")
            .some((value) => value.trim() === ANTHROPIC_SUBSCRIPTION_BETA))
      ) {
        sendJson(response, 400, "subscription-capability-required");
        return;
      }
      counters.forwardedRequests += 1;
      const upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          ...(anthropic
            ? {
                ...(subscription
                  ? { authorization: `Bearer ${credential}` }
                  : { "x-api-key": credential }),
                "anthropic-version": anthropicVersion as string,
                ...(typeof request.headers["anthropic-beta"] === "string"
                  ? { "anthropic-beta": request.headers["anthropic-beta"] }
                  : {}),
              }
            : { authorization: `Bearer ${credential}` }),
          "content-type": "application/json",
          accept: request.headers.accept ?? "application/json",
        },
        body: new Uint8Array(body),
        redirect: "error",
        signal: AbortSignal.timeout(remainingMs),
      });
      if (upstream.status >= 500) counters.upstreamServerError += 1;
      else if (upstream.status >= 400) counters.upstreamClientError += 1;
      else counters.upstreamSuccess += 1;
      const contentType = upstream.headers.get("content-type");
      const forwardHeaders: Record<string, string> = {};
      if (anthropic) {
        for (const [name, value] of upstream.headers) {
          if (
            name === "retry-after" ||
            name === "x-should-retry" ||
            name.startsWith("anthropic-ratelimit-unified-")
          )
            forwardHeaders[name] = value;
        }
      }
      if (anthropic && contentType?.startsWith("text/event-stream")) {
        response.writeHead(upstream.status, {
          "content-type": contentType,
          ...forwardHeaders,
        });
        if (
          !(await streamRedacted(upstream, response, options.maxResponseBytes, [
            credential,
          ]))
        ) {
          counters.responseLimitExceeded += 1;
          response.destroy();
        }
        return;
      }
      const upstreamBody = await boundedResponseBody(
        upstream,
        options.maxResponseBytes,
      );
      if (upstreamBody === undefined) {
        counters.responseLimitExceeded += 1;
        sendJson(response, 502, "response-limit-exceeded");
        return;
      }
      const redactedUpstreamBody = redactSecret(upstreamBody, credential);
      response.writeHead(upstream.status, {
        ...(contentType === null ? {} : { "content-type": contentType }),
        ...forwardHeaders,
        "content-length": redactedUpstreamBody.length,
      });
      response.end(redactedUpstreamBody);
    } catch {
      counters.relayFailures += 1;
      if (!response.headersSent) {
        sendJson(response, 502, "provider-unavailable");
      } else {
        response.destroy();
      }
    }
  };
}

async function listen(
  server: NetServer,
  port: number,
  host: string,
): Promise<number> {
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
    server.listen(port, host);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Provider credential proxy did not bind a TCP listener");
  }
  return address.port;
}

export async function openProviderCredentialProxy(
  options: OpenProviderCredentialProxyOptions,
): Promise<ProviderCredentialProxy> {
  validateOptions(options);
  const clock = options.clock ?? (() => new Date());
  const counters: ProxyCounters = {
    forwardedRequests: 0,
    requestLimitExceeded: 0,
    unauthorizedRequests: 0,
    unauthorizedMissingCredentialRequests: 0,
    unauthorizedMismatchedCredentialRequests: 0,
    unauthorizedMessagesEndpointRequests: 0,
    unauthorizedOtherEndpointRequests: 0,
    rejectedConnectivityProbes: 0,
    upstreamSuccess: 0,
    upstreamClientError: 0,
    upstreamServerError: 0,
    relayFailures: 0,
    responseLimitExceeded: 0,
  };
  if (options.chatgpt === undefined) {
    const credential = options.anthropicSubscriptionToken ?? options.apiKey;
    const server = createServer(
      providerCredentialListener(options, credential, clock, counters),
    );
    const port = await listen(server, options.port, options.listenHost);
    return { server, origin: `http://${options.listenHost}:${port}` };
  }
  const chatgpt = options.chatgpt;
  const health = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz")
      sendMetrics(response, counters);
    else {
      response.writeHead(404, { "content-length": "0" });
      response.end();
    }
  });
  const healthPort = await listen(
    health,
    chatgpt.healthPort,
    options.listenHost,
  );
  const server = createTlsServer(
    { key: chatgpt.tls.keyPem, cert: chatgpt.tls.certPem },
    chatgptListener(options, chatgpt, clock, counters),
  );
  server.on("close", () => health.close());
  const port = await listen(server, options.port, options.listenHost).catch(
    (error: unknown) => {
      health.close();
      throw error;
    },
  );
  return {
    server,
    origin: `https://${options.listenHost}:${port}`,
    healthOrigin: `http://${options.listenHost}:${healthPort}`,
  };
}
