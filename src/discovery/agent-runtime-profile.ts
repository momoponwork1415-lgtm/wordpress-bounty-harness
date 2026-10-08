import { z } from "zod";

import { canonicalDigest } from "../infrastructure/canonical-json.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const value = z.string().min(1).max(128);
const reported = z.union([value, z.literal("unavailable")]);
const effort = z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]);
const model = z.enum(["gpt-6.1-sol", "gpt-6-luna"]);

/** Only Codex is admitted. The digest supplied here is measured from the CLI's bundled catalog. */
export const codexModelCatalog = {
  production: "gpt-6.1-sol",
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

export const agentRuntimeProfileSchema = bodySchema
  .extend({ digest })
  .superRefine((profile, context) => {
    const { digest: actual, ...body } = profile;
    if (actual !== canonicalDigest(body)) {
      context.addIssue({
        code: "custom",
        path: ["digest"],
        message: "Profile digest mismatch",
      });
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
export type AgentRuntimeProfileDefinition = Omit<
  AgentRuntimeProfile,
  "kind" | "schemaVersion" | "digest"
>;

export function defineAgentRuntimeProfile(
  definition: AgentRuntimeProfileDefinition,
): AgentRuntimeProfile {
  const body = bodySchema.parse({
    kind: "agent-runtime-profile",
    schemaVersion: 2,
    ...definition,
  });
  return agentRuntimeProfileSchema.parse({
    ...body,
    digest: canonicalDigest(body),
  });
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
