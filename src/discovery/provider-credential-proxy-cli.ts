import { readFile } from "node:fs/promises";

import {
  PROVIDER_UPSTREAM_ORIGIN,
  openProviderCredentialProxy,
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

async function main(): Promise<void> {
  const apiKey = (
    await readFile("/run/secrets/provider-api-key", "utf8")
  ).trim();
  const proxy = await openProviderCredentialProxy({
    listenHost: "0.0.0.0",
    port: 8080,
    upstreamOrigin: PROVIDER_UPSTREAM_ORIGIN,
    apiKey,
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
