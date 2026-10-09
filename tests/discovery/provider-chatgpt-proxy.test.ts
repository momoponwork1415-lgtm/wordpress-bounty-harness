import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";

import { afterEach, describe, expect, it } from "vitest";

import {
  BROKER_TLS_HOSTNAME,
  CHATGPT_PLACEHOLDER_ACCOUNT_ID,
  openProviderCredentialProxy,
  type ProviderCredentialProxy,
} from "../../src/discovery/index.js";
import { createGrantTls } from "../../src/discovery/grant-tls.js";

// TLS validity is checked against the real clock, so the grant uses it too.
const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

type Received = {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
};

async function open(options: { maxRequests?: number } = {}) {
  const accessToken = `real-access-${randomBytes(24).toString("hex")}`;
  const accountId = `real-account-${randomBytes(8).toString("hex")}`;
  const grantToken = randomBytes(32).toString("base64url");
  const received: Received[] = [];
  const upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      // An upstream echo of the token must not reach the agent, even when it
      // arrives split across two streamed chunks.
      const half = accessToken.length / 2;
      response.write(
        `data: {"type":"response.completed","echo":"${accessToken.slice(0, half)}`,
      );
      setTimeout(() => response.end(`${accessToken.slice(half)}"}\n\n`), 20);
    });
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const upstreamAddress = upstream.address();
  if (upstreamAddress === null || typeof upstreamAddress === "string")
    throw new Error("upstream unavailable");
  closers.push(
    () => new Promise<void>((resolve) => upstream.close(() => resolve())),
  );
  const tls = createGrantTls({
    hostname: BROKER_TLS_HOSTNAME,
    notAfter: new Date(expiresAt),
  });
  const proxy: ProviderCredentialProxy = await openProviderCredentialProxy({
    listenHost: "127.0.0.1",
    port: 0,
    upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
    chatgpt: {
      accessToken,
      accountId,
      tls: { keyPem: tls.keyPem, certPem: tls.certPem },
      healthPort: 0,
    },
    grantToken,
    model: "gpt-6-luna",
    protocol: "responses",
    maxRequests: options.maxRequests ?? 2,
    maxRequestBytes: 4096,
    maxResponseBytes: 4096,
    expiresAt,
  });
  closers.push(
    () => new Promise<void>((resolve) => proxy.server.close(() => resolve())),
  );
  const port = Number(new URL(proxy.origin).port);
  const send = (input: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
    readonly authorization?: string;
  }) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpsRequest(
        {
          host: "127.0.0.1",
          port,
          servername: BROKER_TLS_HOSTNAME,
          ca: tls.caPem,
          method: input.method,
          path: input.path,
          headers: {
            authorization: input.authorization ?? `Bearer ${grantToken}`,
            "chatgpt-account-id": CHATGPT_PLACEHOLDER_ACCOUNT_ID,
            ...input.headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      request.on("error", reject);
      request.end(input.body);
    });
  const responses = (model: string, headers: Record<string, string> = {}) =>
    send({
      method: "POST",
      path: "/backend-api/codex/responses",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model, input: [], stream: true }),
    });
  return { proxy, send, responses, received, accessToken, accountId };
}

describe("ChatGPT subscription egress proxy", () => {
  it("answers workspace discovery itself and lets the CLI fall back from WebSockets without calling upstream", async () => {
    const { send, received, proxy } = await open();
    const discovery = await send({
      method: "GET",
      path: "/backend-api/wham/accounts/check",
    });
    expect(discovery.status).toBe(200);
    expect(JSON.parse(discovery.body)).toEqual({
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
    const websocket = await send({
      method: "GET",
      path: "/backend-api/codex/responses",
      headers: { connection: "Upgrade", upgrade: "websocket" },
    });
    expect(websocket.status).toBe(426);
    for (const path of [
      "/backend-api/ps/plugins/list",
      "/backend-api/codex/analytics-events/events",
      "/backend-api/wham/settings/user",
    ])
      expect((await send({ method: "GET", path })).status).toBe(403);
    expect(received).toEqual([]);
    expect(proxy.origin).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
    expect(proxy.healthOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(`${proxy.healthOrigin ?? ""}/healthz`)).status).toBe(
      200,
    );
  });

  it("forwards only the bound model's responses request with the real subscription credential", async () => {
    const { responses, send, received, accessToken, accountId } = await open();
    expect(
      (
        await send({
          method: "GET",
          path: "/backend-api/wham/accounts/check",
          authorization: "Bearer not-the-grant",
        })
      ).status,
    ).toBe(401);
    expect((await responses("gpt-6.1-sol")).status).toBe(403);
    expect(
      (await responses("gpt-6-luna", { "content-encoding": "zstd" })).status,
    ).toBe(415);
    const forwarded = await responses("gpt-6-luna", {
      originator: "codex_exec",
      "session-id": "session-1",
      cookie: "must-not-pass",
    });
    expect(forwarded.status).toBe(200);
    expect(forwarded.body).not.toContain(accessToken);
    expect(forwarded.body).toContain("[REDACTED]");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      method: "POST",
      url: "/backend-api/codex/responses",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId,
        originator: "codex_exec",
        "session-id": "session-1",
      },
    });
    expect(received[0]?.headers.cookie).toBeUndefined();
    expect(JSON.parse(received[0]?.body ?? "{}")).toMatchObject({
      model: "gpt-6-luna",
    });
  });

  it("stops forwarding at the grant's request count", async () => {
    const { responses, received } = await open({ maxRequests: 1 });
    expect((await responses("gpt-6-luna")).status).toBe(200);
    expect((await responses("gpt-6-luna")).status).toBe(429);
    expect(received).toHaveLength(1);
  });
});
