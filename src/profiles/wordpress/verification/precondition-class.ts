import { z } from "zod";

import { nextWordPressScenario } from "../lab/scenarios.js";

export const preconditionClassSchema = z.enum([
  "default",
  "common-usage",
  "admin-configuration",
  "unknown",
]);
export type PreconditionClass = z.infer<typeof preconditionClassSchema>;

export type ClassifiedPrecondition = {
  readonly preconditionClass: PreconditionClass;
  readonly nextScenarioId?: string;
  readonly reasonCode?: "common-usage-scenario-missing";
};

/** Only exact default declarations are trusted as a claim of default settings. */
const DEFAULT =
  /^(?:default|defaults|default settings|no (?:special|additional|nondefault) (?:settings|configuration)|none required)$/i;
/** A concrete non-default choice must be explicit before it can exclude a Finding. */
const ADMIN_SETTING =
  /(?:(?:start time|button link).{0,30}\{[^}]{1,80}\}|(?:setting|option|configuration|visibility)\s+(?:is\s+)?(?:set|enabled|disabled|changed|selected|configured)\s+(?:to|as)|(?:administrator|admin)\s+(?:has\s+)?(?:sets?|selects?|chooses?|configures?|enables?|disables?)\s+.{0,50}(?:to\s+\S+|as\s+\S+|placeholder|password[- ]protect)|(?:administrator|admin)\s+(?:has\s+)?tick(?:s|ed)?\s+(?:the\s+)?[^.]{0,50}\b(?:setting|checkbox)\b|(?:trusted editor|administrator|admin).{0,35}restricts?\s+(?:the\s+)?pattern|heading level.{0,30}enabled.{0,25}mapping)/gi;
const SELECTED_PLACEHOLDER =
  /placeholder\s+(?:value|setting|text)\s+(?:(?:is|was)\s+)?(?:set|selected|configured)\s+(?:to|as)\s+\S+/gi;
/** Content with affirmative password visibility is an explicit non-default choice. */
const PASSWORD_PROTECTED_CONTENT =
  /\b(?:password[- ]protected\s+(?:post|page|block|content)|(?:post|page|block|content)\s+(?:is|must be)\s+password[- ]protected)\b/gi;
const POSITIVE_PROTECTED_ITEM_BEFORE =
  /\b(?:an?|the)\s+(?:administrator|admin)\s+(?:publishes?|creates?)\s+(?:an?|the)\s+$/i;
const POSITIVE_PROTECTED_ITEM_AFTER =
  /^\s+(?:is|must be)\s+(?:published|created)\b/i;
function affirmativePasswordProtectedContent(statement: string): boolean {
  return [...statement.matchAll(PASSWORD_PROTECTED_CONTENT)].some((match) => {
    const before =
      statement
        .slice(0, match.index)
        .split(/[.;!?]/)
        .at(-1) ?? "";
    if (/\b(?:no|not|never|without)\b|\bnon[- ]$/i.test(before)) return false;
    if (!/^password[- ]protected/i.test(match[0])) return true;
    const after = statement.slice(match.index + match[0].length);
    return (
      POSITIVE_PROTECTED_ITEM_BEFORE.test(before) ||
      POSITIVE_PROTECTED_ITEM_AFTER.test(after)
    );
  });
}
const RESTRICTED_PATTERN =
  /(?:trusted editor|administrator|admin).{0,35}restricts?\s+(?:the\s+)?synced\s+pattern/gi;
/** Ignore lexical matches in negated clauses before treating a setting as chosen. */
function affirmativeAdminSetting(statement: string): boolean {
  return [ADMIN_SETTING, SELECTED_PLACEHOLDER, RESTRICTED_PATTERN].some(
    (pattern) =>
      [...statement.matchAll(pattern)].some((match) => {
        const before =
          statement
            .slice(0, match.index)
            .split(/[.;!?。]/)
            .at(-1) ?? "";
        return !/\b(?:no|not|never|without)\b/i.test(before + match[0]);
      }),
  );
}
/** These are ordinary content operations; they are not arbitrary plugin settings. */
const COMMON_USAGE =
  /(?:public|published|公開).{0,60}(?:post|page|block|slider|widget|投稿|ページ|ブロック|スライダー|ウィジェット)|(?:post|page|block|slider|widget|投稿|ページ|ブロック|スライダー|ウィジェット).{0,60}(?:public|published|公開)|(?:place|insert|add|render|publish|create|置く|配置|挿入|作成).{0,30}(?:block|slider|widget|ブロック|スライダー|ウィジェット)/i;

/** Harness-owned classification. Unknown text never becomes a rejection. */
export function classifyWordPressPrecondition(input: {
  readonly configurationPrecondition: string;
  readonly attachmentPrecondition?: string | null;
  readonly currentScenarioId?: string | undefined;
  readonly secondaryLocaleConfigured?: boolean;
}): ClassifiedPrecondition {
  const statements = [
    input.configurationPrecondition,
    input.attachmentPrecondition,
  ]
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    )
    .map((value) => value.trim());
  if (
    statements.some(
      (statement) =>
        affirmativeAdminSetting(statement) ||
        affirmativePasswordProtectedContent(statement),
    )
  )
    return { preconditionClass: "admin-configuration" };
  const nonDefault = statements.filter((statement) => !DEFAULT.test(statement));
  if (nonDefault.length === 0) return { preconditionClass: "default" };
  const description = nonDefault.join(" ");
  const scenario = nextWordPressScenario(description, undefined, {
    secondaryLocaleConfigured: input.secondaryLocaleConfigured === true,
  });
  if (scenario !== "catalogue に無い前提") {
    const missing = nextWordPressScenario(
      description,
      input.currentScenarioId,
      { secondaryLocaleConfigured: input.secondaryLocaleConfigured === true },
    );
    return {
      preconditionClass: "common-usage",
      ...(missing === "catalogue に無い前提"
        ? {}
        : { nextScenarioId: scenario.split(":", 1)[0]! }),
    };
  }
  if (COMMON_USAGE.test(description))
    return {
      preconditionClass: "common-usage",
      reasonCode: "common-usage-scenario-missing",
    };
  return { preconditionClass: "unknown" };
}
