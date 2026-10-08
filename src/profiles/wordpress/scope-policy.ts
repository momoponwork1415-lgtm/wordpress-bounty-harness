import { readFile } from "node:fs/promises";

import { z } from "zod";

import { canonicalDigest } from "../../infrastructure/canonical-json.js";
import type { ProgrammeScopeEvaluator } from "../../review/index.js";

const category = z.enum([
  "rce",
  "php-file-write",
  "arbitrary-php-file-read",
  "arbitrary-php-file-delete",
  "arbitrary-file-read",
  "arbitrary-file-delete",
  "arbitrary-file-download",
  "lfi",
  "rfi",
  "sqli",
  "options-update",
  "privesc-to-admin",
  "auth-bypass-to-admin",
  "account-takeover",
  "privesc-to-contributor+",
  "auth-bypass-non-admin",
  "sensitive-object-access",
  "content-deletion",
  "stored-xss",
  "reflected-xss",
  "csrf-to-write",
  "missing-authz",
  "idor",
  "other",
]);
const programme = z.enum(["wordfence", "patchstack"]);
const observed = z.partialRecord(category, z.array(z.string().min(1)));
const policySchema = z.strictObject({
  observedAt: z.iso.date(),
  programmes: z.tuple([z.literal("wordfence"), z.literal("patchstack")]),
  wordfence: z.strictObject({
    highThreatMinimum: z.number().int().positive(),
    commonMinimum: z.number().int().positive(),
    otherMinimum: z.number().int().positive(),
    wordpressOrgRequiredBelow: z.number().int().positive(),
    premiumMinimum: z.number().int().positive(),
    highThreat: z.array(category),
    common: z.array(category),
    excluded: z.array(category),
    requiredObservations: observed,
  }),
  patchstack: z.strictObject({
    minimumInstalls: z.number().int().positive(),
    cvssGateBelow: z.number().int().positive(),
    cvssMinimumBelowGate: z.number().min(0).max(10),
    excluded: z.array(category),
    requiredObservations: observed,
  }),
});

export type WordpressScopePolicy = z.infer<typeof policySchema>;
export type WordpressScopeInput = {
  readonly category: z.infer<typeof category>;
  readonly attacker:
    "unauthenticated" | "subscriber" | "customer" | "contributor-or-higher";
  readonly activeInstalls?: number;
  readonly wordpressOrgListed?: boolean;
  readonly premium?: boolean;
  readonly latestVersionVerified?: boolean;
  readonly defaultOrCommonSettings?: boolean;
  readonly cvssScore?: number;
  readonly observations: readonly string[];
};
export type WordpressScopeAssessment = {
  readonly programme: z.infer<typeof programme>;
  readonly status: "in-scope" | "out-of-scope" | "ambiguous";
  readonly reason: string;
  readonly policyObservedAt: string;
};

/** Load the dated, versioned decision data from the human-owned policy file. */
export async function loadWordpressScopePolicy(
  path: URL | string = new URL("./policy/programme-scope.md", import.meta.url),
): Promise<WordpressScopePolicy> {
  const markdown = await readFile(path, "utf8");
  const matches = [
    ...markdown.matchAll(/```json scope-policy-v1\n([\s\S]*?)\n```/g),
  ];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new Error("Exactly one scope-policy-v1 block is required");
  }
  const value = policySchema.parse(JSON.parse(matches[0][1]) as unknown);
  if (!markdown.includes(`観測日: ${value.observedAt}`)) {
    throw new Error("Scope policy observation date mismatch");
  }
  return value;
}

/** This profile adapter never promotes missing or conflicting evidence into scope. */
export function assessWordpressScope(
  policy: WordpressScopePolicy,
  input: WordpressScopeInput,
): readonly WordpressScopeAssessment[] {
  const value = policySchema.parse(policy);
  const parsed = z
    .strictObject({
      category,
      attacker: z.enum([
        "unauthenticated",
        "subscriber",
        "customer",
        "contributor-or-higher",
      ]),
      activeInstalls: z.number().int().nonnegative().optional(),
      wordpressOrgListed: z.boolean().optional(),
      premium: z.boolean().optional(),
      latestVersionVerified: z.boolean().optional(),
      defaultOrCommonSettings: z.boolean().optional(),
      cvssScore: z.number().min(0).max(10).optional(),
      observations: z.array(z.string().min(1)),
    })
    .parse(input);
  const result = (
    programmeId: z.infer<typeof programme>,
    status: WordpressScopeAssessment["status"],
    reason: string,
  ): WordpressScopeAssessment => ({
    programme: programmeId,
    status,
    reason,
    policyObservedAt: value.observedAt,
  });
  return value.programmes.map((programmeId) => {
    if (parsed.attacker === "contributor-or-higher")
      return result(programmeId, "out-of-scope", "attacker-role");
    if (
      parsed.latestVersionVerified === false ||
      parsed.defaultOrCommonSettings === false
    )
      return result(programmeId, "out-of-scope", "version-or-configuration");
    if (
      parsed.latestVersionVerified !== true ||
      parsed.defaultOrCommonSettings !== true
    )
      return result(
        programmeId,
        "ambiguous",
        "version-or-configuration-unknown",
      );
    if (programmeId === "wordfence") {
      const rule = value.wordfence;
      if (rule.excluded.includes(parsed.category))
        return result(programmeId, "out-of-scope", "category-excluded");
      const minimum = rule.highThreat.includes(parsed.category)
        ? rule.highThreatMinimum
        : rule.common.includes(parsed.category)
          ? rule.commonMinimum
          : rule.otherMinimum;
      if (parsed.activeInstalls === undefined)
        return result(programmeId, "ambiguous", "install-count-unknown");
      if (
        parsed.activeInstalls < minimum ||
        (parsed.premium === true && parsed.activeInstalls < rule.premiumMinimum)
      )
        return result(programmeId, "out-of-scope", "install-threshold");
      if (
        parsed.activeInstalls < rule.premiumMinimum &&
        parsed.premium === undefined
      )
        return result(programmeId, "ambiguous", "premium-status-unknown");
      if (
        parsed.activeInstalls < rule.wordpressOrgRequiredBelow &&
        parsed.wordpressOrgListed === false
      )
        return result(programmeId, "out-of-scope", "wordpress-org-listing");
      if (
        parsed.activeInstalls < rule.wordpressOrgRequiredBelow &&
        parsed.wordpressOrgListed === undefined
      )
        return result(
          programmeId,
          "ambiguous",
          "wordpress-org-listing-unknown",
        );
    } else {
      const rule = value.patchstack;
      if (rule.excluded.includes(parsed.category))
        return result(programmeId, "out-of-scope", "category-excluded");
      if (parsed.activeInstalls === undefined)
        return result(programmeId, "ambiguous", "install-count-unknown");
      if (parsed.activeInstalls < rule.minimumInstalls)
        return result(programmeId, "out-of-scope", "install-threshold");
      if (parsed.activeInstalls < rule.cvssGateBelow) {
        if (parsed.cvssScore === undefined)
          return result(programmeId, "ambiguous", "cvss-unknown");
        if (parsed.cvssScore < rule.cvssMinimumBelowGate)
          return result(programmeId, "out-of-scope", "cvss-threshold");
      }
    }
    const required = value[programmeId].requiredObservations[parsed.category];
    if (required === undefined)
      return result(programmeId, "ambiguous", "category-rule-undefined");
    if (required.some((item) => !parsed.observations.includes(item)))
      return result(programmeId, "ambiguous", "observation-missing");
    return result(programmeId, "in-scope", "policy-conditions-met");
  });
}

/** The WordPress profile supplies the generic review module's scope boundary. */
export function createWordpressScopeEvaluator(
  policy: WordpressScopePolicy,
): ProgrammeScopeEvaluator<WordpressScopeInput> {
  return {
    programmeIds: policy.programmes,
    policyDigest: canonicalDigest(policy),
    async assess({ facts }) {
      return assessWordpressScope(policy, facts).map((assessment) => ({
        programmeId: assessment.programme,
        status: assessment.status,
        destination: assessment.programme,
        reason: `${assessment.reason}; policy observed ${assessment.policyObservedAt}`,
      }));
    },
  };
}
