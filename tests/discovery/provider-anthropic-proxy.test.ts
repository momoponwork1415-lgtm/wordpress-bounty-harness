import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openProviderCredentialProxy } from "../../src/discovery/index.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0)) await close();
});

describe("Anthropic Messages broker endpoint", () => {
  it("rejects the exact Claude connectivity probe without treating it as a grant failure", async () => {
    const proxy = await openProviderCredentialProxy({
      listenHost: "127.0.0.1",
      port: 0,
      upstreamOrigin: "https://api.anthropic.com",
      anthropicSubscriptionToken: "private-subscription-token",
      grantToken: "trial-only-bearer-grant",
      model: "claude-opus-5-5",
      protocol: "anthropic-messages",
      maxRequests: 2,
      maxRequestBytes: 4096,
      maxResponseBytes: 4096,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    closers.push(
      () => new Promise<void>((resolve) => proxy.server.close(() => resolve())),
    );
    expect(
      (await fetch(new URL("/api/hello", proxy.origin), { method: "HEAD" }))
        .status,
    ).toBe(404);
    expect((await fetch(new URL("/api/hello", proxy.origin))).status).toBe(401);
    expect(
      (
        await fetch(new URL("/api/hello?extra=1", proxy.origin), {
          method: "HEAD",
        })
      ).status,
    ).toBe(401);
    expect(
      await (await fetch(new URL("/healthz", proxy.origin))).json(),
    ).toMatchObject({
      forwardedRequests: 0,
      unauthorizedRequests: 2,
      rejectedConnectivityProbes: 1,
    });
  });

  it("admits only the grant token, pinned model, and Messages path", async () => {
    const key = "private-anthropic-key";
    const grant = "trial-only-token";
    const received: Array<{
      url?: string;
      model?: string;
      key?: string;
      version?: string;
    }> = [];
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          model: string;
        };
        received.push({
          url: request.url ?? "",
          model: payload.model,
          key: request.headers["x-api-key"] as string,
          version: request.headers["anthropic-version"] as string,
        });
        response.writeHead(200, {
          "content-type": "application/json",
          "anthropic-ratelimit-unified-requests-remaining": "17",
          "x-should-retry": "false",
        });
        response.end(JSON.stringify({ type: "message", echo: key }));
      });
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    closers.push(
      () => new Promise<void>((resolve) => upstream.close(() => resolve())),
    );
    const address = upstream.address();
    if (address === null || typeof address === "string")
      throw new Error("upstream unavailable");
    const proxy = await openProviderCredentialProxy({
      listenHost: "127.0.0.1",
      port: 0,
      upstreamOrigin: `http://127.0.0.1:${address.port}`,
      apiKey: key,
      grantToken: grant,
      model: "claude-opus-5-5",
      protocol: "anthropic-messages",
      maxRequests: 2,
      maxRequestBytes: 4096,
      maxResponseBytes: 4096,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    closers.push(
      () => new Promise<void>((resolve) => proxy.server.close(() => resolve())),
    );
    const send = (model: string, token = grant, path = "/v1/messages") =>
      fetch(new URL(path, proxy.origin), {
        method: "POST",
        headers: {
          "x-api-key": token,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model, messages: [], max_tokens: 16 }),
      });
    expect((await send("claude-opus-5-5", "wrong")).status).toBe(401);
    expect((await send("claude-sonnet-5")).status).toBe(403);
    expect((await send("claude-opus-5-5", grant, "/v1/models")).status).toBe(
      404,
    );
    const allowed = await send("claude-opus-5-5");
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).not.toContain(key);
    expect(
      allowed.headers.get("anthropic-ratelimit-unified-requests-remaining"),
    ).toBe("17");
    expect(allowed.headers.get("x-should-retry")).toBe("false");
    const betaAllowed = await send(
      "claude-opus-5-5",
      grant,
      "/v1/messages?beta=true",
    );
    expect(betaAllowed.status).toBe(200);
    expect(await betaAllowed.text()).not.toContain(key);
    expect(received).toEqual([
      {
        url: "/v1/messages",
        model: "claude-opus-5-5",
        key,
        version: "2023-06-01",
      },
      {
        url: "/v1/messages?beta=true",
        model: "claude-opus-5-5",
        key,
        version: "2023-06-01",
      },
    ]);
  });

  it("keeps the subscription token in the broker and forwards the OAuth capability", async () => {
    const subscriptionToken = "private-subscription-token";
    const grant = "trial-only-bearer-grant";
    const received: Array<{
      authorization: string | null;
      apiKey: string | null;
      beta: string | null;
      url: string;
    }> = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (new URL(input.toString()).hostname !== "api.anthropic.com")
        return realFetch(input, init);
      const headers = new Headers(init?.headers);
      received.push({
        authorization: headers.get("authorization"),
        apiKey: headers.get("x-api-key"),
        beta: headers.get("anthropic-beta"),
        url:
          new URL(input.toString()).pathname + new URL(input.toString()).search,
      });
      return new Response(
        JSON.stringify({ type: "message", echo: subscriptionToken }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    const proxy = await openProviderCredentialProxy({
      listenHost: "127.0.0.1",
      port: 0,
      upstreamOrigin: "https://api.anthropic.com",
      anthropicSubscriptionToken: subscriptionToken,
      grantToken: grant,
      model: "claude-opus-5-5",
      protocol: "anthropic-messages",
      maxRequests: 2,
      maxRequestBytes: 4096,
      maxResponseBytes: 4096,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    closers.push(
      () => new Promise<void>((resolve) => proxy.server.close(() => resolve())),
    );
    const send = (
      token: string,
      model = "claude-opus-5-5",
      beta = "oauth-2025-04-20,claude-code-20250219",
    ) =>
      fetch(new URL("/v1/messages?beta=true", proxy.origin), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": beta,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model, messages: [], max_tokens: 16 }),
      });
    expect((await send("incorrect-grant")).status).toBe(401);
    expect((await send(grant, "claude-sonnet-5-5")).status).toBe(403);
    expect(
      (await send(grant, "claude-opus-5-5", "claude-code-20250219")).status,
    ).toBe(400);
    const allowed = await send(grant);
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).not.toContain(subscriptionToken);
    const missingGrant = await fetch(new URL("/v1/models", proxy.origin), {
      method: "GET",
    });
    expect(missingGrant.status).toBe(401);
    const metrics = (await (
      await fetch(new URL("/healthz", proxy.origin))
    ).json()) as Record<string, number>;
    expect(metrics).toMatchObject({
      unauthorizedRequests: 2,
      unauthorizedMissingCredentialRequests: 1,
      unauthorizedMismatchedCredentialRequests: 1,
      unauthorizedMessagesEndpointRequests: 1,
      unauthorizedOtherEndpointRequests: 1,
      rejectedConnectivityProbes: 0,
    });
    expect(received).toEqual([
      {
        authorization: `Bearer ${subscriptionToken}`,
        apiKey: null,
        beta: "oauth-2025-04-20,claude-code-20250219",
        url: "/v1/messages?beta=true",
      },
    ]);
  });
});
