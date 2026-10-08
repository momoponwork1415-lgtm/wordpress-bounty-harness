import { describe, expect, it } from "vitest";

import {
  admitAgentRuntimeProfile,
  defineAgentRuntimeProfile,
} from "../../src/discovery/agent-runtime-profile.js";

const digest = `sha256:${"a".repeat(64)}`;
const definition = {
  id: "production",
  transportKind: "codex-native/v1" as const,
  sandboxImageDigest: digest,
  requestedModelId: "gpt-6.1-sol" as const,
  requestedEffort: "high" as const,
  codexCliVersion: "0.161.0",
  bundledCatalogDigest: digest,
  authenticationMethod: "unavailable",
  cyberAccessProgram: "unavailable" as const,
  serviceTier: "unavailable" as const,
  subagent: { modelId: "unavailable", effort: "unavailable" },
};

describe("Codex runtime profile", () => {
  it("binds recorded execution fields and the sandbox image", () => {
    const profile = defineAgentRuntimeProfile(definition);
    expect(admitAgentRuntimeProfile(profile, digest).status).toBe("admitted");
    expect(
      admitAgentRuntimeProfile({ ...profile, requestedEffort: "max" }, digest)
        .status,
    ).toBe("invalid-profile");
    expect(
      admitAgentRuntimeProfile(profile, `sha256:${"b".repeat(64)}`).status,
    ).toBe("image-mismatch");
  });

  it("admits the development model, but rejects old CLI versions and unregistered models", () => {
    expect(
      defineAgentRuntimeProfile({
        ...definition,
        requestedModelId: "gpt-6-luna",
      }).requestedModelId,
    ).toBe("gpt-6-luna");
    expect(
      defineAgentRuntimeProfile({
        ...definition,
        codexCliVersion: "0.162.0-alpha.2",
      }).codexCliVersion,
    ).toBe("0.162.0-alpha.2");
    expect(() =>
      defineAgentRuntimeProfile({ ...definition, codexCliVersion: "0.160.0" }),
    ).toThrow();
    expect(() =>
      defineAgentRuntimeProfile({
        ...definition,
        codexCliVersion: "0.161.0-alpha.1",
      }),
    ).toThrow();
    expect(() =>
      defineAgentRuntimeProfile({
        ...definition,
        requestedModelId: "gpt-daybreak-blue-latest" as never,
      }),
    ).toThrow();
  });
});
