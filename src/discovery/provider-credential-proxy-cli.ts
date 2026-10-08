import { readFile } from "node:fs/promises";

import {
  CHATGPT_UPSTREAM_ORIGIN,
  PROVIDER_UPSTREAM_ORIGIN,
  openProviderCredentialProxy,
  type OpenProviderCredentialProxyOptions,
  type ProviderApiProtocol,
} from "./provider-credential-proxy.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error("Provider credential proxy configuration is incomplete");
  }
  return value;
}

function positiveInteger(name: string): number {
  const value = Number(requiredEnvironment(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Provider credential proxy configuration is invalid");
  }
  return value;
}

function protocol(): ProviderApiProtocol {
  const value = requiredEnvironment("PROVIDER_PROTOCOL");
  if (value !== "responses" && value !== "chat-completions") {
    throw new Error("Provider credential proxy protocol is invalid");
  }
  return value;
}

/** The credential half of the proxy options, chosen by the broker. */
async function credential(): Promise<
  | { upstreamOrigin: string; apiKey: string }
  | {
      upstreamOrigin: string;
      chatgpt: NonNullable<OpenProviderCredentialProxyOptions["chatgpt"]>;
    }
> {
  const authentication = process.env.PROVIDER_AUTHENTICATION ?? "api-key";
  if (authentication === "api-key")
    return {
      upstreamOrigin: PROVIDER_UPSTREAM_ORIGIN,
      apiKey: (await readFile("/run/secrets/provider-api-key", "utf8")).trim(),
    };
  if (authentication !== "chatgpt")
    throw new Error("Provider credential proxy authentication is invalid");
  const login = JSON.parse(
    await readFile("/run/secrets/provider-chatgpt.json", "utf8"),
  ) as unknown;
  if (
    typeof login !== "object" ||
    login === null ||
    !("accessToken" in login) ||
    typeof login.accessToken !== "string" ||
    !("accountId" in login) ||
    typeof login.accountId !== "string"
  )
    throw new Error("Provider credential proxy login is invalid");
  return {
    upstreamOrigin: CHATGPT_UPSTREAM_ORIGIN,
    chatgpt: {
      accessToken: login.accessToken,
      accountId: login.accountId,
      tls: {
        keyPem: await readFile("/run/secrets/grant-tls-key.pem", "utf8"),
        certPem: await readFile("/run/secrets/grant-tls-cert.pem", "utf8"),
      },
      healthPort: 8081,
    },
  };
}

async function main(): Promise<void> {
  const proxy = await openProviderCredentialProxy({
    listenHost: "0.0.0.0",
    port: 8080,
    ...(await credential()),
    grantToken: requiredEnvironment("PROVIDER_GRANT_TOKEN"),
    model: requiredEnvironment("PROVIDER_MODEL"),
    protocol: protocol(),
    maxRequests: positiveInteger("PROVIDER_MAX_REQUESTS"),
    maxRequestBytes: positiveInteger("PROVIDER_MAX_REQUEST_BYTES"),
    maxResponseBytes: positiveInteger("PROVIDER_MAX_RESPONSE_BYTES"),
    expiresAt: requiredEnvironment("PROVIDER_GRANT_EXPIRES_AT"),
  });
  const shutdown = (): void => {
    proxy.server.close(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch(() => {
  process.stderr.write("Provider credential proxy failed\n");
  process.exitCode = 1;
});
