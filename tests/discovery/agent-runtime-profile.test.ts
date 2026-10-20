import { describe, expect, it } from "vitest";

import {
  admitAgentRuntimeProfile,
  admitCooperativeRuntimeProfile,
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
  it("admits a pinned Daybreak Blue Root and four matching child slots", () => {
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
  const claude = {
    id: "opus",
    requestedModelId: "claude-opus-5-5" as const,
    requestedEffort: "high" as const,
    claudeCliVersion: "2.1.296",
    authenticationMethod: "anthropic-oauth-host" as const,
    subagent: { modelId: "claude-opus-5-5" as const, effort: "high" as const },
  };

  it("binds the Claude CLI and image, but stays out of the Codex cooperative admission", () => {
    const profile = defineClaudeRuntimeProfile(claude, digest);
    expect(profile).toMatchObject({
      transportKind: "claude-code/v1",
      codexCliVersion: "unavailable",
      sandboxImageDigest: digest,
    });
    expect(admitAgentRuntimeProfile(profile, digest).status).toBe("admitted");
    expect(admitCooperativeRuntimeProfile(profile, digest).status).not.toBe(
      "admitted",
    );
    expect(() =>
      defineClaudeRuntimeProfile(
        { ...claude, claudeCliVersion: "2.1.100" },
        digest,
      ),
    ).toThrow();
    expect(() =>
      defineClaudeRuntimeProfile(
        {
          ...claude,
          subagent: { modelId: "claude-haiku-4-5" as never, effort: "high" },
        },
        digest,
      ),
    ).toThrow();
  });

  it("keeps the digest of the Opus Root and Opus child profile the enum widening left unchanged", () => {
    // Measured before the Root and child models became an enum (#418).
    expect(defineClaudeRuntimeProfile(claude, digest).digest).toBe(
      "sha256:7cfbaa7c8ca66efd1ff3586fcb0fdd4beed6b1f1ce3a65089b1fcefeddac6c0f",
    );
  });

  it("binds the Root and child models separately, each to a Claude model", () => {
    const sonnetChildren = defineClaudeRuntimeProfile(
      {
        ...claude,
        subagent: { modelId: "claude-sonnet-5-5", effort: "high" },
      },
      digest,
    );
    expect(sonnetChildren).toMatchObject({
      requestedModelId: "claude-opus-5-5",
      subagent: { modelId: "claude-sonnet-5-5" },
    });
    expect(sonnetChildren.digest).not.toBe(
      defineClaudeRuntimeProfile(claude, digest).digest,
    );
    expect(
      defineClaudeRuntimeProfile(
        {
          ...claude,
          requestedModelId: "claude-sonnet-5-5",
          subagent: { modelId: "claude-haiku-5-5", effort: "high" },
        },
        digest,
      ),
    ).toMatchObject({
      requestedModelId: "claude-sonnet-5-5",
      subagent: { modelId: "claude-haiku-5-5" },
    });
    expect(() =>
      defineClaudeRuntimeProfile(
        { ...claude, requestedModelId: "gpt-6-sol" as never },
        digest,
      ),
    ).toThrow();
  });
});
