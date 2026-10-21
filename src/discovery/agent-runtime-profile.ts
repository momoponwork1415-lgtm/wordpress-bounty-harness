import { z } from "zod";

import { canonicalDigest } from "../infrastructure/canonical-json.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const value = z.string().min(1).max(128);
const reported = z.union([value, z.literal("unavailable")]);
const effort = z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]);
const model = z.enum(["gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna"]);

/** The Codex models. The digest supplied here is measured from the CLI's bundled catalog. */
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

/** What a human writes; the kind, schema version and digest are derived. */
export const agentRuntimeProfileDefinitionSchema = bodySchema.omit({
  kind: true,
  schemaVersion: true,
});

/**
 * Claude Code under the owner's subscription OAuth token, which only the
 * egress broker holds. Codex-only fields stay `unavailable` so receipts keep
 * one shape; the CLI version is measured from the pinned image.
 */
const claudeEffort = z.enum(["low", "medium", "high", "xhigh", "max"]);
/**
 * The Claude models a profile may bind, for the Root and for the children
 * separately (#418). The broker admits exactly the pair the profile names.
 */
export const claudeModelSchema = z.enum([
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
]);
const claudeBodySchema = z.strictObject({
  kind: z.literal("agent-runtime-profile"),
  schemaVersion: z.literal(2),
  id: value,
  transportKind: z.literal("claude-code/v1"),
  sandboxImageDigest: digest,
  requestedModelId: claudeModelSchema,
  requestedEffort: claudeEffort,
  claudeCliVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .refine((version) => {
      const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
      return major * 1e6 + minor * 1e3 + patch >= 2_001_280;
    }, "Claude Code 2.1.280 or newer is required for Opus 5.5"),
  codexCliVersion: z.literal("unavailable"),
  bundledCatalogDigest: z.literal("unavailable"),
  authenticationMethod: z.literal("anthropic-oauth-host"),
  cyberAccessProgram: z.literal("unavailable"),
  serviceTier: z.literal("unavailable"),
  subagent: z.strictObject({
    modelId: claudeModelSchema,
    effort: claudeEffort,
  }),
});

/** What a human writes for the Claude runtime; the rest is derived. */
export const claudeRuntimeProfileDefinitionSchema = claudeBodySchema.omit({
  kind: true,
  schemaVersion: true,
  transportKind: true,
  sandboxImageDigest: true,
  codexCliVersion: true,
  bundledCatalogDigest: true,
  cyberAccessProgram: true,
  serviceTier: true,
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
    if (profile.transportKind === "claude-code/v1") return;
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
export type AgentRuntimeProfileDefinition = Omit<
  CodexAgentRuntimeProfile,
  "kind" | "schemaVersion" | "digest"
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
    schemaVersion: 2,
    transportKind: "claude-code/v1",
    sandboxImageDigest,
    codexCliVersion: "unavailable",
    bundledCatalogDigest: "unavailable",
    cyberAccessProgram: "unavailable",
    serviceTier: "unavailable",
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
