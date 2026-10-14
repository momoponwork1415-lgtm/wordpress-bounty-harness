import { describe, expect, it } from "vitest";

import {
  admitAgentRuntimeProfile,
  admitCooperativeRuntimeProfile,
  admitClaudeCooperativeRuntimeProfile,
  defineAgentRuntimeProfile,
  defineClaudeRuntimeProfile,
} from "../../src/discovery/index.js";

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
  it("admits a pinned Daybreak Blue Root and three matching child slots", () => {
    const candidate = {
      ...definition,
      requestedModelId: "gpt-6-sol" as const,
      cyberAccessProgram: "daybreak_blue" as const,
      subagent: { modelId: "gpt-6-sol", effort: "high" },
    };
    const profile = defineAgentRuntimeProfile(candidate);
    expect(admitCooperativeRuntimeProfile(profile, digest)).toEqual({
      status: "admitted",
      profile,
    });
    expect(
      admitCooperativeRuntimeProfile(
        defineAgentRuntimeProfile({
          ...candidate,
          subagent: { modelId: "gpt-6-luna", effort: "high" },
        }),
        digest,
      ).status,
    ).toBe("child-mismatch");
    expect(
      admitCooperativeRuntimeProfile(
        defineAgentRuntimeProfile({
          ...candidate,
          cyberAccessProgram: "standard",
        }),
        digest,
      ).status,
    ).toBe("access-mismatch");
  });
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

describe("Claude runtime profile", () => {
  it("pins the Opus Root and child to one image, model and effort", () => {
    const definition = {
      id: "opus-55",
      requestedModelId: "claude-opus-5-5" as const,
      requestedEffort: "high" as const,
      claudeCliVersion: "2.1.278",
      authenticationMethod: "anthropic-api-key-host" as const,
      cyberAccessProgram: "unavailable" as const,
      serviceTier: "default" as const,
      subagent: {
        modelId: "claude-opus-5-5" as const,
        effort: "high" as const,
      },
    };
    const profile = defineClaudeRuntimeProfile(definition, digest);
    expect(admitClaudeCooperativeRuntimeProfile(profile, digest).status).toBe(
      "admitted",
    );
    expect(
      admitClaudeCooperativeRuntimeProfile(profile, `sha256:${"b".repeat(64)}`)
        .status,
    ).toBe("image-mismatch");
    expect(() =>
      defineClaudeRuntimeProfile(
        {
          ...definition,
          subagent: {
            modelId: "claude-opus-5-5",
            effort: "low",
          },
        },
        digest,
      ),
    ).toThrow();
  });
});
