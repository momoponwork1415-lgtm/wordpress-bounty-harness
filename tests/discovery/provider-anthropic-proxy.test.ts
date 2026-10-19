import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ANTHROPIC_OAUTH_BETA,
  ANTHROPIC_UPSTREAM_ORIGIN,
  openProviderCredentialProxy,
} from "../../src/discovery/index.js";

const expiresAt = "2026-10-19T01:00:00.000Z";
const clock = () => new Date("2026-10-19T00:00:00.000Z");
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const close of closers.splice(0)) await close();
});

async function open() {
  const oauthToken = `sk-ant-oat-${randomBytes(24).toString("hex")}`;
  const grantToken = randomBytes(32).toString("hex");
  const upstream: { url: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: URL, init: RequestInit) => {
      upstream.push({
        url: url.toString(),
        headers: init.headers as Record<string, string>,
      });
      // An upstream echo of the token must not reach the agent.
      return Promise.resolve(
        new Response(`{"type":"message","echo":"${oauthToken}"}`, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "anthropic-ratelimit-unified-status": "allowed",
            "set-cookie": "session=1",
          },
        }),
      );
    }),
  );
  const proxy = await openProviderCredentialProxy({
    listenHost: "127.0.0.1",
    port: 0,
    upstreamOrigin: ANTHROPIC_UPSTREAM_ORIGIN,
    anthropicOauthToken: oauthToken,
    grantToken,
    model: "claude-opus-5-5",
    protocol: "anthropic-messages",
    maxRequests: 1,
    maxRequestBytes: 4096,
    maxResponseBytes: 4096,
    expiresAt,
    clock,
  });
  closers.push(
    () => new Promise<void>((resolve) => proxy.server.close(() => resolve())),
  );
  const port = Number(new URL(proxy.origin).port);
  const send = (input: {
    readonly method?: string;
    readonly path?: string;
    readonly body?: unknown;
    readonly authorization?: string;
  }) =>
    new Promise<{
      status: number;
      body: string;
      headers: Record<string, unknown>;
    }>((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method: input.method ?? "POST",
          path: input.path ?? "/v1/messages?beta=true",
          headers: {
            authorization: input.authorization ?? `Bearer ${grantToken}`,
            "anthropic-beta": "claude-code-20250219",
            "anthropic-version": "2023-06-01",
            "x-api-key": "agent-supplied",
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
              headers: response.headers,
            }),
          );
        },
      );
      request.on("error", reject);
      request.end(
        input.body === undefined ? undefined : JSON.stringify(input.body),
      );
    });
  return { oauthToken, upstream, send };
}

describe("Anthropic subscription egress proxy", () => {
  it("swaps the grant for the OAuth token on the bound model's messages request only", async () => {
    const { oauthToken, upstream, send } = await open();
    expect((await send({ method: "HEAD", path: "/api/hello" })).status).toBe(
      404,
    );
    expect(
      (
        await send({
          body: { model: "claude-opus-5-5" },
          authorization: "Bearer x",
        })
      ).status,
    ).toBe(401);
    expect((await send({ body: { model: "claude-haiku-4-5" } })).status).toBe(
      403,
    );
    expect(
      (
        await send({
          body: {
            model: "claude-opus-5-5",
            tools: [{ type: "web_search_20250305", name: "web_search" }],
          },
        })
      ).body,
    ).toContain("server-tool-not-admitted");
    expect(
      (await send({ path: "/v1/complete", body: { model: "claude-opus-5-5" } }))
        .status,
    ).toBe(404);
    expect(upstream).toHaveLength(0);

    const forwarded = await send({ body: { model: "claude-opus-5-5" } });
    expect(forwarded.status).toBe(200);
    expect(forwarded.body).not.toContain(oauthToken);
    expect(forwarded.headers["anthropic-ratelimit-unified-status"]).toBe(
      "allowed",
    );
    expect(forwarded.headers["set-cookie"]).toBeUndefined();
    expect(upstream).toEqual([
      {
        url: `${ANTHROPIC_UPSTREAM_ORIGIN}/v1/messages?beta=true`,
        headers: expect.objectContaining({
          authorization: `Bearer ${oauthToken}`,
          "anthropic-beta": `claude-code-20250219,${ANTHROPIC_OAUTH_BETA}`,
          "anthropic-version": "2023-06-01",
        }) as unknown,
      },
    ]);
    expect(upstream[0]?.headers).not.toHaveProperty("x-api-key");

    // The grant's request count holds for subscription traffic too.
    expect((await send({ body: { model: "claude-opus-5-5" } })).status).toBe(
      429,
    );
  });

  it("refuses an OAuth token bound to another origin or protocol", async () => {
    await expect(
      openProviderCredentialProxy({
        listenHost: "127.0.0.1",
        port: 0,
        upstreamOrigin: "http://127.0.0.1:1",
        anthropicOauthToken: "token",
        grantToken: "grant",
        model: "claude-opus-5-5",
        protocol: "anthropic-messages",
        maxRequests: 1,
        maxRequestBytes: 1,
        maxResponseBytes: 1,
        expiresAt,
        clock,
      }),
    ).rejects.toThrow();
  });
});
