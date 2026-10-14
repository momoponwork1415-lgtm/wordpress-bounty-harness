import { z } from "zod";

import { canonicalDigest } from "../infrastructure/canonical-json.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const value = z.string().min(1).max(128);
const opus55CliVersion = value.refine((version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return (
    major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 280)))
  );
}, "Claude Code 2.1.280 or later is required for Opus 5.5");
const reported = z.union([value, z.literal("unavailable")]);
const effort = z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]);
const model = z.enum(["gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna"]);

/** Only Codex is admitted. The digest supplied here is measured from the CLI's bundled catalog. */
export const codexModelCatalog = {
  production: "gpt-6-sol",
  development: "gpt-6-luna",
  minimumCliVersion: "0.161.0",
} as const;

const bodySchema = z.strictObject({
  kind: z.literal("agent-runtime-profile"),
  schemaVersion: z.literal(2),
  id: value,
  transportKind: z.literal("codex-native/v1"),
  sandboxImageDigest: digest,
  requestedModelId: model,
  requestedEffort: effort,
  codexCliVersion: value,
  bundledCatalogDigest: digest,
  authenticationMethod: reported,
  cyberAccessProgram: z.enum([
    "standard",
    "daybreak_blue",
    "daybreak_red",
    "unavailable",
  ]),
  serviceTier: z.enum(["default", "priority", "flex", "fast", "unavailable"]),
  subagent: z.strictObject({ modelId: reported, effort: reported }),
});

const claudeBodySchema = z.strictObject({
  kind: z.literal("agent-runtime-profile"),
  schemaVersion: z.literal(3),
  id: value,
  transportKind: z.literal("claude-code/v1"),
  sandboxImageDigest: digest,
  requestedModelId: z.literal("claude-opus-5-5"),
  requestedEffort: z.enum(["low", "medium", "high", "xhigh", "max"]),
  codexCliVersion: z.literal("unavailable"),
  claudeCliVersion: opus55CliVersion,
  bundledCatalogDigest: z.literal("unavailable"),
  authenticationMethod: z.enum([
    "anthropic-api-key-host",
    "anthropic-subscription-host",
  ]),
  cyberAccessProgram: z.enum(["defense_access", "unavailable"]),
  serviceTier: z.enum(["default", "unavailable"]),
  subagent: z.strictObject({
    modelId: z.literal("claude-opus-5-5"),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
  }),
});

/** What a human writes; the kind, schema version and digest are derived. */
export const agentRuntimeProfileDefinitionSchema = bodySchema.omit({
  kind: true,
  schemaVersion: true,
});
export const claudeRuntimeProfileDefinitionSchema = claudeBodySchema.omit({
  kind: true,
  schemaVersion: true,
  transportKind: true,
  sandboxImageDigest: true,
  codexCliVersion: true,
  bundledCatalogDigest: true,
});

export const agentRuntimeProfileSchema = z
  .union([bodySchema.extend({ digest }), claudeBodySchema.extend({ digest })])
  .superRefine((profile, context) => {
    const { digest: actual, ...body } = profile;
    if (actual !== canonicalDigest(body)) {
      context.addIssue({
        code: "custom",
        path: ["digest"],
        message: "Profile digest mismatch",
      });
    }
    if (profile.transportKind === "claude-code/v1") {
      if (profile.subagent.effort !== profile.requestedEffort)
        context.addIssue({
          code: "custom",
          path: ["subagent"],
          message: "Claude child effort must match Root",
        });
      return;
    }
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z0-9.-]+))?$/.exec(
      profile.codexCliVersion,
    );
    if (
      match === null ||
      (Number(match[1]) === 0 && Number(match[2]) < 161) ||
      (Number(match[1]) === 0 &&
        Number(match[2]) === 161 &&
        match[4] !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["codexCliVersion"],
        message: "Codex CLI 0.161 or newer is required",
      });
    }
  });

export type AgentRuntimeProfile = z.infer<typeof agentRuntimeProfileSchema>;
export type CodexAgentRuntimeProfile = Extract<
  AgentRuntimeProfile,
  { transportKind: "codex-native/v1" }
>;
export type ClaudeAgentRuntimeProfile = Extract<
  AgentRuntimeProfile,
  { transportKind: "claude-code/v1" }
>;
export type AgentRuntimeProfileDefinition = z.infer<
  typeof agentRuntimeProfileDefinitionSchema
>;
export type ClaudeRuntimeProfileDefinition = z.infer<
  typeof claudeRuntimeProfileDefinitionSchema
>;

export function defineAgentRuntimeProfile(
  definition: AgentRuntimeProfileDefinition,
): CodexAgentRuntimeProfile {
  const body = bodySchema.parse({
    kind: "agent-runtime-profile",
    schemaVersion: 2,
    ...definition,
  });
  return agentRuntimeProfileSchema.parse({
    ...body,
    digest: canonicalDigest(body),
  }) as CodexAgentRuntimeProfile;
}

export function defineClaudeRuntimeProfile(
  definition: ClaudeRuntimeProfileDefinition,
  sandboxImageDigest: string,
): ClaudeAgentRuntimeProfile {
  const body = claudeBodySchema.parse({
    kind: "agent-runtime-profile",
    schemaVersion: 3,
    transportKind: "claude-code/v1",
    sandboxImageDigest,
    codexCliVersion: "unavailable",
    bundledCatalogDigest: "unavailable",
    ...definition,
  });
  return agentRuntimeProfileSchema.parse({
    ...body,
    digest: canonicalDigest(body),
  }) as ClaudeAgentRuntimeProfile;
}

export type AgentRuntimeProfileAdmission =
  | { readonly status: "admitted"; readonly profile: AgentRuntimeProfile }
  | { readonly status: "invalid-profile" | "image-mismatch" };

export function admitAgentRuntimeProfile(
  candidate: unknown,
  sandboxImage: string,
): AgentRuntimeProfileAdmission {
  const parsed = agentRuntimeProfileSchema.safeParse(candidate);
  if (!parsed.success) return { status: "invalid-profile" };
  const imageDigest = sandboxImage.slice(sandboxImage.lastIndexOf("sha256:"));
  if (imageDigest !== parsed.data.sandboxImageDigest)
    return { status: "image-mismatch" };
  return { status: "admitted", profile: parsed.data };
}

export type CooperativeRuntimeProfileAdmission =
  | { readonly status: "admitted"; readonly profile: AgentRuntimeProfile }
  | {
      readonly status:
        | "invalid-profile"
        | "image-mismatch"
        | "model-mismatch"
        | "access-mismatch"
        | "child-mismatch";
    };

/** Root and child CLI runs must share the measured model and effort. */
export function admitCooperativeRuntimeProfile(
  candidate: unknown,
  sandboxImage: string,
): CooperativeRuntimeProfileAdmission {
  const admitted = admitAgentRuntimeProfile(candidate, sandboxImage);
  if (admitted.status !== "admitted") return admitted;
  const profile = admitted.profile;
  if (profile.transportKind !== "codex-native/v1")
    return { status: "model-mismatch" };
  if (profile.requestedModelId !== codexModelCatalog.production)
    return { status: "model-mismatch" };
  if (profile.cyberAccessProgram !== "daybreak_blue")
    return { status: "access-mismatch" };
  if (
    profile.subagent.modelId !== profile.requestedModelId ||
    profile.subagent.effort !== profile.requestedEffort
  )
    return { status: "child-mismatch" };
  return admitted;
}

export function admitClaudeCooperativeRuntimeProfile(
  candidate: unknown,
  sandboxImage: string,
): CooperativeRuntimeProfileAdmission {
  const admitted = admitAgentRuntimeProfile(candidate, sandboxImage);
  if (admitted.status !== "admitted") return admitted;
  const profile = admitted.profile;
  if (profile.transportKind !== "claude-code/v1")
    return { status: "model-mismatch" };
  if (
    profile.subagent.modelId !== profile.requestedModelId ||
    profile.subagent.effort !== profile.requestedEffort
  )
    return { status: "child-mismatch" };
  return admitted;
}
