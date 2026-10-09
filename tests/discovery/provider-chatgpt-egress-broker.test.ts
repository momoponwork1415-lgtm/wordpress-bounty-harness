import { randomBytes, X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BROKER_TLS_HOSTNAME,
  createProviderCredentialEgressBroker,
} from "../../src/discovery/index.js";

const digest = `sha256:${"a".repeat(64)}`;
const now = new Date("2026-10-08T07:00:00.000Z");
const expiresAt = "2026-10-08T07:30:00.000Z";
const request = {
  schemaVersion: 1 as const,
  runtimeProfileDigest: digest,
  model: "gpt-6-luna" as const,
  protocol: "responses" as const,
  maxRequests: 10,
  maxRequestBytes: 4096,
  maxResponseBytes: 4096,
  expiresAt,
};
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const base64url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
/** A login file shaped like the Codex CLI's, with synthetic values only. */
const login = (options: { exp: Date; authMode?: string }) => {
  const accessToken = `${base64url({ alg: "none" })}.${base64url({
    exp: Math.floor(options.exp.getTime() / 1000),
    marker: randomBytes(16).toString("hex"),
  })}.c2ln`;
  const accountId = `acct-${randomBytes(8).toString("hex")}`;
  return {
    accessToken,
    accountId,
    file: JSON.stringify({
      auth_mode: options.authMode ?? "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: "synthetic",
        access_token: accessToken,
        refresh_token: `refresh-${randomBytes(8).toString("hex")}`,
        account_id: accountId,
      },
      last_refresh: now.toISOString(),
    }),
  };
};

async function setup(file: string) {
  const root = await mkdtemp(join(tmpdir(), "chatgpt-egress-"));
  roots.push(root);
  const credentialFilePath = join(root, "auth.json");
  await writeFile(credentialFilePath, file, { mode: 0o600 });
  const proxyBundleDirectory = join(root, "bundle");
  await mkdir(proxyBundleDirectory);
  await writeFile(
    join(proxyBundleDirectory, "provider-credential-proxy-cli.js"),
    "// fixture",
  );
  const commands: string[][] = [];
  const staged: Record<string, string> = {};
  const broker = createProviderCredentialEgressBroker({
    dockerExecutablePath: "/usr/bin/docker",
    brokerImage: `node@${digest}`,
    credentialFilePath,
    credentialKind: "chatgpt-login",
    scratchRootDirectory: root,
    proxyBundleDirectory,
    clock: () => now,
    resolveProviderAddresses: async (hostname) =>
      hostname === "chatgpt.com" ? ["203.0.113.20"] : [],
    runDocker: async (args) => {
      commands.push([...args]);
      if (args[0] === "create")
        for (const [index, arg] of args.entries())
          if (args[index - 1] === "--volume" && arg.includes("/run/secrets/")) {
            const [source = "", target = ""] = arg.split(":");
            staged[target] = await readFile(source, "utf8");
          }
      return {
        exitCode: 0,
        stdout: args[0] === "inspect" ? "172.28.0.2\n" : "",
        stderr: "",
      };
    },
  });
  return { broker, commands, staged };
}

describe("ChatGPT subscription egress grant", () => {
  it("gives the agent a TLS broker name and a one-off CA, and the real login only to the broker", async () => {
    const { accessToken, accountId, file } = login({
      exp: new Date("2026-10-18T00:00:00.000Z"),
    });
    const { broker, commands, staged } = await setup(file);
    const result = await broker.withGrant(request, async (grant) => {
      expect(grant.baseUrl).toBe(`https://${BROKER_TLS_HOSTNAME}:8080`);
      expect(grant.tls?.hostname).toBe(BROKER_TLS_HOSTNAME);
      expect(grant.tls?.address).toBe("172.28.0.2");
      const ca = new X509Certificate(grant.tls?.caPem ?? "");
      expect(ca.ca).toBe(true);
      const serving = new X509Certificate(
        staged["/run/secrets/grant-tls-cert.pem"] ?? "",
      );
      expect(serving.verify(ca.publicKey)).toBe(true);
      expect(serving.checkHost(BROKER_TLS_HOSTNAME)).toBe(BROKER_TLS_HOSTNAME);
      expect(JSON.stringify(grant)).not.toContain(accessToken);
      expect(JSON.stringify(grant)).not.toContain(accountId);
      return "done";
    });
    expect(result.operation).toEqual({ status: "completed", value: "done" });
    expect(result.receipt.upstreamOrigin).toBe("https://chatgpt.com");
    expect(result.receipt.setup.status).toBe("ready");
    expect(result.receipt.cleanup.status).toBe("completed");
    // The broker gets the access token and account, never the refresh token.
    const loginSecret = JSON.parse(
      staged["/run/secrets/provider-chatgpt.json"] ?? "{}",
    ) as unknown;
    expect(loginSecret).toEqual({ accessToken, accountId });
    const create = commands.find((args) => args[0] === "create") ?? [];
    expect(create).toContain("--runtime=runsc");
    expect(create).toContain("--add-host=chatgpt.com=203.0.113.20");
    expect(create).toContain("PROVIDER_AUTHENTICATION=chatgpt");
    expect(create).not.toContain("--add-host=api.openai.com=203.0.113.20");
    expect(JSON.stringify(commands)).not.toContain(accessToken);
    expect(JSON.stringify(commands)).not.toContain(accountId);
    expect(JSON.stringify(result.receipt)).not.toContain(accessToken);
    const health = commands.find((args) => args[0] === "exec") ?? [];
    expect(health.join(" ")).toContain("http://127.0.0.1:8081/healthz");
  });

  it.each([
    {
      name: "the access token expires before the grant does",
      file: login({ exp: new Date("2026-10-08T07:20:00.000Z") }).file,
    },
    {
      name: "the login is an API key login",
      file: login({
        exp: new Date("2026-10-18T00:00:00.000Z"),
        authMode: "apikey",
      }).file,
    },
    { name: "the file is not a login", file: "not json" },
  ])(
    "reports an unavailable credential and starts nothing when $name",
    async ({ file }) => {
      const { broker, commands } = await setup(file);
      const result = await broker.withGrant(request, async () => "impossible");
      expect(result.operation).toEqual({ status: "not-started" });
      expect(result.receipt.setup).toEqual({
        status: "failed",
        stage: "credential",
        reason: "credential-unavailable",
      });
      expect(commands).toEqual([]);
    },
  );
});
