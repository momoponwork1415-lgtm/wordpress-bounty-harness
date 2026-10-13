import type { WordPressFinding } from "./finding.js";

/** The owner excludes only these complete effects within broad impact labels. */
const LOW_VALUE_READS = new Set<NonNullable<WordPressFinding["impactScope"]>>([
  "non-sensitive-enumeration-only",
  "protected-content-only",
  "private-media-reference-only",
]);

/** Missing, mixed, uncertain, or mismatched classifications remain admitted. */
export function isWordPressOwnerPriorityFinding(
  finding: WordPressFinding,
): boolean {
  if (finding.impact === "options-update")
    return finding.impactScope !== "minor-ui-setting-only";
  if (finding.impact === "sensitive-object-access")
    return (
      finding.impactScope === undefined ||
      !LOW_VALUE_READS.has(finding.impactScope)
    );
  return true;
}
