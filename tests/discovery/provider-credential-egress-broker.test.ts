import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createProviderCredentialEgressBroker } from "../../src/discovery/index.js";
import { readDiscoveryOwners } from "../../src/infrastructure/lab-owner-record.js";
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

  it("records itself as the owner of its network and broker before creating them (#550)", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-egress-"));
    try {
      const credentialFilePath = join(root, "credential");
      const proxyBundleDirectory = join(root, "bundle");
      const ownerDirectory = join(root, "discovery-owners");
      await writeFile(credentialFilePath, randomBytes(32).toString("hex"), {
        mode: 0o600,
      });
      await mkdir(proxyBundleDirectory);
      await writeFile(
        join(proxyBundleDirectory, "provider-credential-proxy-cli.js"),
        "// fixture",
      );
      const grantId = "6f1c1f9e-2a7b-4c1e-9d55-0d6a3b2f8e11";
      const network = `provider-egress-${grantId}`;
      const container = `provider-egress-broker-${grantId}`;
      /** What a sweep in another state directory would read at each creation. */
      const ownedAtCreate: string[][] = [];
      const broker = createProviderCredentialEgressBroker({
        dockerExecutablePath: "/usr/bin/docker",
        brokerImage: `node@${digest}`,
        credentialFilePath,
        scratchRootDirectory: root,
        ownerDirectory,
        proxyBundleDirectory,
        clock,
        randomUuid: () => grantId,
        resolveProviderAddresses: async () => ["203.0.113.10"],
        runDocker: async (args) => {
          if (
            (args[0] === "network" && args[1] === "create") ||
            args[0] === "create"
          )
            ownedAtCreate.push(
              [...(await readDiscoveryOwners(ownerDirectory)).live].sort(),
            );
          return {
            exitCode: 0,
            stdout: args[0] === "inspect" ? "172.28.0.2\n" : "",
            stderr: "",
          };
        },
      });
      const result = await broker.withGrant(request, async () =>
        [...(await readDiscoveryOwners(ownerDirectory)).live].sort(),
      );
      expect(ownedAtCreate).toEqual([[network], [container, network].sort()]);
      expect(result.operation).toEqual({
        status: "completed",
        value: [container, network].sort(),
      });
      // Released once removed: nothing is left for a later sweep to skip.
      expect(await readDiscoveryOwners(ownerDirectory)).toEqual({
        live: new Set(),
        dead: new Set(),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses an explicitly selected compact broker cgroup cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-egress-compact-"));
    try {
      const credentialFilePath = join(root, "credential");
      const proxyBundleDirectory = join(root, "bundle");
      await writeFile(credentialFilePath, randomBytes(32).toString("hex"), {
        mode: 0o600,
      });
      await mkdir(proxyBundleDirectory);
      await writeFile(
        join(proxyBundleDirectory, "provider-credential-proxy-cli.js"),
        "// fixture",
      );
      const calls: (readonly string[])[] = [];
      const broker = createProviderCredentialEgressBroker({
        dockerExecutablePath: "/usr/bin/docker",
        brokerImage: `node@${digest}`,
        credentialFilePath,
        scratchRootDirectory: root,
        proxyBundleDirectory,
        memoryMiB: 256,
        clock,
        resolveProviderAddresses: async () => ["203.0.113.10"],
        runDocker: async (args) => {
          calls.push(args);
          return {
            exitCode: 0,
            stdout: args[0] === "inspect" ? "172.28.0.2\n" : "",
            stderr: "",
          };
        },
      });
      expect(
        (await broker.withGrant(request, async () => "done")).operation,
      ).toEqual({
        status: "completed",
        value: "done",
      });
      expect(calls.find((args) => args[0] === "create")).toContain(
        "--memory=256m",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
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
      let failStop = false;
      let brokerStoppedAt = 0;
      const broker = createProviderCredentialEgressBroker({
        dockerExecutablePath: "/usr/bin/docker",
        brokerImage: `node@${digest}`,
        credentialFilePath,
        scratchRootDirectory: root,
        ownerDirectory: join(root, "discovery-owners"),
        proxyBundleDirectory,
        clock,
        resolveProviderAddresses: async () => ["203.0.113.10"],
        runDocker: async (args) => {
          commands.push([...args]);
          if (args[0] === "stop") brokerStoppedAt = performance.now();
          return {
            exitCode: failStop && args[0] === "stop" ? 1 : 0,
            stdout:
              args[0] === "exec" &&
              args.at(-1)?.includes("process.stdout.write")
                ? JSON.stringify({
                    forwardedRequests: 7,
                    requestLimitExceeded: 0,
                    unauthorizedRequests: 2,
                    upstreamSuccess: 7,
                    upstreamClientError: 0,
                    upstreamServerError: 0,
                    relayFailures: 0,
                    responseLimitExceeded: 0,
                  })
                : args[0] === "inspect"
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
      expect(result.receipt.metrics).toEqual({
        forwardedRequests: 7,
        requestLimitExceeded: 0,
        unauthorizedRequests: 2,
        upstreamSuccess: 7,
        upstreamClientError: 0,
        upstreamServerError: 0,
        relayFailures: 0,
        responseLimitExceeded: 0,
      });
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
      const long = await broker.withGrant(
        { ...request, expiresAt: "2026-10-08T09:30:00.000Z" },
        async () => "long trial",
      );
      expect(long.operation).toEqual({
        status: "completed",
        value: "long trial",
      });
      expect(long.receipt.expiresAt).toBe("2026-10-08T09:30:00.000Z");
      failStop = true;
      const cancelled = new AbortController();
      const beforeAbort = commands.length;
      const stopped = await broker.withGrant(
        request,
        async () => {
          const wallAt = performance.now();
          cancelled.abort("wall");
          expect((brokerStoppedAt - wallAt) / 1000).toBeLessThan(1);
          return "stopped";
        },
        cancelled.signal,
      );
      expect(stopped.operation.status).toBe("completed");
      const abortCommands = commands.slice(beforeAbort);
      const stop = abortCommands.find((args) => args[0] === "stop");
      expect(stop).toEqual([
        "stop",
        "-t",
        "10",
        expect.stringMatching(/^provider-egress-broker-/),
      ]);
      expect(abortCommands).toContainEqual(["kill", stop?.[3] ?? "missing"]);
      await expect(
        broker.withGrant(
          { ...request, expiresAt: "2026-10-08T11:01:00.000Z" },
          async () => "too long",
        ),
      ).rejects.toThrow("outside the admitted bound");
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

  it("keeps a Claude subscription token to the Claude model's Messages protocol", async () => {
    const commands: string[][] = [];
    const broker = (credentialKind: "api-key" | "anthropic-oauth") =>
      createProviderCredentialEgressBroker({
        dockerExecutablePath: "/usr/bin/docker",
        brokerImage: `node@${digest}`,
        credentialFilePath: "/nonexistent/credential",
        scratchRootDirectory: "/nonexistent",
        proxyBundleDirectory: "/nonexistent",
        credentialKind,
        clock,
        runDocker: async (args) => {
          commands.push([...args]);
          return { exitCode: 1, stdout: "", stderr: "" };
        },
      });
    const claude = {
      ...request,
      model: "claude-opus-5-5" as const,
      protocol: "anthropic-messages" as const,
    };
    await expect(
      broker("anthropic-oauth").withGrant(request, async () => "unused"),
    ).rejects.toThrow("Provider protocol, model and credential differ");
    await expect(
      broker("api-key").withGrant(claude, async () => "unused"),
    ).rejects.toThrow("Provider protocol, model and credential differ");
    // The children's model follows the same rule as the Root's.
    await expect(
      broker("anthropic-oauth").withGrant(
        { ...claude, subagentModel: "gpt-6-sol" },
        async () => "unused",
      ),
    ).rejects.toThrow("Provider protocol, model and credential differ");
    await expect(
      broker("api-key").withGrant(
        { ...request, subagentModel: "claude-sonnet-5-5" },
        async () => "unused",
      ),
    ).rejects.toThrow("Provider protocol, model and credential differ");
    expect(commands).toEqual([]);
  });

  it("binds a Claude Root model and children's model into the broker, the grant and the receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-egress-"));
    try {
      const credentialFilePath = join(root, "credential");
      const proxyBundleDirectory = join(root, "bundle");
      await writeFile(credentialFilePath, `sk-ant-oat-${"x".repeat(32)}`, {
        mode: 0o600,
      });
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
        credentialKind: "anthropic-oauth",
        scratchRootDirectory: root,
        ownerDirectory: join(root, "discovery-owners"),
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
      const result = await broker.withGrant(
        {
          ...request,
          model: "claude-opus-5-5",
          subagentModel: "claude-sonnet-5-5",
          protocol: "anthropic-messages",
        },
        async (grant) => [grant.model, grant.subagentModel],
      );
      expect(result.operation).toEqual({
        status: "completed",
        value: ["claude-opus-5-5", "claude-sonnet-5-5"],
      });
      expect(result.receipt).toMatchObject({
        model: "claude-opus-5-5",
        subagentModel: "claude-sonnet-5-5",
      });
      const created = commands.find((args) => args[0] === "create");
      expect(created).toEqual(
        expect.arrayContaining([
          "PROVIDER_MODEL=claude-opus-5-5",
          "PROVIDER_SUBAGENT_MODEL=claude-sonnet-5-5",
        ]),
      );
      // A grant without a children's model admits the Root model only.
      const single = await broker.withGrant(
        {
          ...request,
          model: "claude-opus-5-5",
          protocol: "anthropic-messages",
        },
        async (grant) => grant.subagentModel ?? "none",
      );
      expect(single.operation).toEqual({ status: "completed", value: "none" });
      expect(single.receipt).not.toHaveProperty("subagentModel");
      expect(
        commands
          .filter((args) => args[0] === "create")
          .at(-1)
          ?.some((arg) => arg.startsWith("PROVIDER_SUBAGENT_MODEL=")),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
