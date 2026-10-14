import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { openProviderCredentialProxy } from "../../src/discovery/index.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

describe("Anthropic Messages broker endpoint", () => {
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
        response.writeHead(200, { "content-type": "application/json" });
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
    expect(received).toEqual([
      {
        url: "/v1/messages",
        model: "claude-opus-5-5",
        key,
        version: "2023-06-01",
      },
    ]);
  });
});
