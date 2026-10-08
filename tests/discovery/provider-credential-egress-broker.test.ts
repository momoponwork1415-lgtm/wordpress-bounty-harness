import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createProviderCredentialEgressBroker } from "../../src/discovery/index.js";
import { openProviderCredentialProxy } from "../../src/discovery/index.js";

const digest = `sha256:${"a".repeat(64)}`;
const expiresAt = "2026-10-08T07:30:00.000Z";
const clock = () => new Date("2026-10-08T07:00:00.000Z");
const request = {
  schemaVersion: 1 as const,
  runtimeProfileDigest: digest,
  model: "gpt-6.1-sol" as const,
  protocol: "responses" as const,
  maxRequests: 1,
  maxRequestBytes: 4096,
  maxResponseBytes: 4096,
  expiresAt,
};

describe("provider credential egress", () => {
  it("limits proxy requests to the bound path, model, count, and deadline", async () => {
    const credential = randomBytes(32).toString("hex");
    const grant = randomBytes(32).toString("hex");
    const received: string[] = [];
    const upstream = createServer((request, response) => {
      received.push(`${request.url} ${request.headers.authorization ?? ""}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const address = upstream.address();
    if (address === null || typeof address === "string")
      throw new Error("upstream unavailable");
    const proxy = await openProviderCredentialProxy({
      listenHost: "127.0.0.1",
      port: 0,
      upstreamOrigin: `http://127.0.0.1:${address.port}/v1`,
      apiKey: credential,
      grantToken: grant,
      model: "gpt-6.1-sol",
      protocol: "responses",
      maxRequests: 1,
      maxRequestBytes: 4096,
      maxResponseBytes: 4096,
      expiresAt,
      clock,
    });
    try {
      const send = (
        path: string,
        model: string,
        authorization = `Bearer ${grant}`,
      ) =>
        fetch(`${proxy.origin}${path}`, {
          method: "POST",
          headers: { authorization },
          body: JSON.stringify({ model, input: "review" }),
        });
      expect(
        (await send("/v1/responses", "gpt-6.1-sol", "Bearer invalid")).status,
      ).toBe(401);
      expect((await send("/v1/chat/completions", "gpt-6.1-sol")).status).toBe(
        404,
      );
      expect((await send("/v1/responses", "gpt-6-luna")).status).toBe(403);
      expect((await send("/v1/responses", "gpt-6.1-sol")).status).toBe(200);
      expect((await send("/v1/responses", "gpt-6.1-sol")).status).toBe(429);
      expect(received).toEqual([`/v1/responses Bearer ${credential}`]);
      expect(JSON.stringify(received)).not.toContain(grant);
    } finally {
      await new Promise<void>((resolve) => proxy.server.close(() => resolve()));
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("fails closed when a grant expires or byte limits are exceeded", async () => {
    const credential = randomBytes(32).toString("hex");
    const token = randomBytes(32).toString("hex");
    const upstream = createServer((_request, response) =>
      response.end("x".repeat(128)),
    );
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const address = upstream.address();
    if (address === null || typeof address === "string")
      throw new Error("upstream unavailable");
    const base = {
      listenHost: "127.0.0.1",
      port: 0,
      upstreamOrigin: `http://127.0.0.1:${address.port}/v1`,
      apiKey: credential,
      grantToken: token,
      model: "gpt-6.1-sol",
      protocol: "responses" as const,
      maxRequests: 1,
      maxRequestBytes: 4096,
      maxResponseBytes: 4096,
      expiresAt,
      clock,
    };
    const expired = await openProviderCredentialProxy({
      ...base,
      clock: () => new Date(expiresAt),
    });
    const requestLimited = await openProviderCredentialProxy({
      ...base,
      maxRequestBytes: 8,
    });
    const responseLimited = await openProviderCredentialProxy({
      ...base,
      maxResponseBytes: 8,
    });
    try {
      const send = (origin: string) =>
        fetch(`${origin}/v1/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ model: "gpt-6.1-sol" }),
        });
      expect((await send(expired.origin)).status).toBe(401);
      expect((await send(requestLimited.origin)).status).toBe(413);
      expect((await send(responseLimited.origin)).status).toBe(502);
    } finally {
      await Promise.all(
        [expired, requestLimited, responseLimited].map(
          (proxy) =>
            new Promise<void>((resolve) => proxy.server.close(() => resolve())),
        ),
      );
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("keeps provider credentials outside the agent grant and emits a bounded runsc receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-egress-"));
    try {
      const credential = randomBytes(32).toString("hex");
      const credentialFilePath = join(root, "credential");
      const proxyBundleDirectory = join(root, "bundle");
      await writeFile(credentialFilePath, credential, { mode: 0o600 });
      await chmod(credentialFilePath, 0o600);
      await mkdir(proxyBundleDirectory);
      await writeFile(
        join(proxyBundleDirectory, "provider-credential-proxy-cli.js"),
        "// fixture",
      );
      const commands: string[][] = [];
      const broker = createProviderCredentialEgressBroker({
        dockerExecutablePath: "/usr/bin/docker",
        brokerImage: `node@${digest}`,
        credentialFilePath,
        scratchRootDirectory: root,
        proxyBundleDirectory,
        clock,
        resolveProviderAddresses: async () => ["203.0.113.10"],
        runDocker: async (args) => {
          commands.push([...args]);
          return {
            exitCode: 0,
            stdout:
              args[0] === "inspect"
                ? "172.28.0.2\n"
                : args[0] === "network" && args[1] === "inspect"
                  ? "true\n"
                  : "",
            stderr: "",
          };
        },
      });
      const result = await broker.withGrant(request, async (grant) => {
        expect(grant.model).toBe(request.model);
        expect(grant.baseUrl).toBe("http://172.28.0.2:8080");
        expect(JSON.stringify(grant)).not.toContain(credential);
        return "done";
      });
      expect(result.operation).toEqual({ status: "completed", value: "done" });
      expect(result.receipt.setup.status).toBe("ready");
      expect(result.receipt.cleanup.status).toBe("completed");
      expect(result.receipt.isolation).toEqual({
        backend: "gvisor",
        runtime: "runsc",
        fallbackUsed: false,
        agentNetworkInternal: true,
      });
      expect(JSON.stringify(result.receipt)).not.toContain(credential);
      expect(JSON.stringify(commands)).not.toContain(credential);
      expect(commands.some((args) => args.includes("--runtime=runsc"))).toBe(
        true,
      );
      expect(commands).toContainEqual([
        "network",
        "create",
        "--internal",
        expect.any(String),
      ]);
      const beforeReuse = commands.length;
      const reused = await broker.withGrant(
        { ...request, agentNetworkName: "lab-internal" },
        async (grant) => grant.dockerNetworkName,
      );
      expect(reused.operation).toEqual({
        status: "completed",
        value: "lab-internal",
      });
      expect(commands.slice(beforeReuse)).toContainEqual([
        "network",
        "inspect",
        "--format",
        "{{.Internal}}",
        "lab-internal",
      ]);
      expect(
        commands
          .slice(beforeReuse)
          .some(
            (args) =>
              args[0] === "network" && ["create", "rm"].includes(args[1] ?? ""),
          ),
      ).toBe(false);
      await expect(
        broker.withGrant(
          { ...request, model: "unregistered" as never },
          async () => "impossible",
        ),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
