import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "../../../infrastructure/canonical-json.js";
import { wordPressAuditCheckSchema } from "./audit-check.js";
import { wordpressFindingClaimSchema } from "./finding.js";
import { wordpressLeadClaimSchema } from "./lead.js";

/**
 * The Finding schema before the declared-precondition fields (#613). The
 * archived contracts render it, so their text and digest stay what earlier
 * Trials recorded in `contractDigest`.
 */
const archivedFindingClaimSchema = wordpressFindingClaimSchema.omit({
  configurationClass: true,
  attackerInputPath: true,
  exploitTiming: true,
});

/**
 * The claim schemas own keys, required fields, types, and enum values.
 */
function renderWordPressDiscoveryOutputContract<
  Version extends "v1" | "v2" | "v4" | "v5",
>(version: Version) {
  const finding = z.toJSONSchema(
    version === "v5" ? wordpressFindingClaimSchema : archivedFindingClaimSchema,
    { io: "output" },
  );
  const lead = z.toJSONSchema(wordpressLeadClaimSchema, { io: "output" });
  const text = [
    `## Finding and Lead output contract (wordpress-discovery-contract-${version})`,
    ...(version === "v2" || version === "v4" || version === "v5"
      ? [
          "As Root, include this complete contract in every child spawn assignment. In every follow-up to a child, require that child's latest final message to be one JSON object with exactly `findings`, `leads`, `examined`, and `unexamined`, even when there are no claims. Use empty arrays and the two strings for an empty report. A later prose reply must not replace the child's report.",
        ]
      : []),
    "Return `findings`, `leads`, `examined`, and `unexamined`. The last two are strings. A child reports direct Finding and Lead objects. In Root's final report, encode each Finding and Lead object as one JSON string in its array, as required by the transport schema.",
    version === "v4" || version === "v5"
      ? "Each claim object must follow its schema below. Fields of type string are single strings, not arrays. `sourceTrace` is an array of objects with `file`, `function`, and positive integer `line`. Use target-relative paths; prefix WordPress core paths with `@wordpress/`, PHP paths with `@php/`, and supplied plugin dependency paths with `@dependencies/<id>/`."
      : "Each claim object must follow its schema below. Fields of type string are single strings, not arrays. `sourceTrace` is an array of objects with `file`, `function`, and positive integer `line`. Use target-relative paths; prefix WordPress core paths with `@wordpress/`.",
    `Finding schema: ${canonicalJson(finding)}`,
    `Lead schema: ${canonicalJson(lead)}`,
  ].join("\n\n");
  return {
    id: `wordpress-discovery-contract-${version}` as const,
    text,
    digest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
  };
}

/** Archived contract for earlier objective-only Trials. */
export function wordPressDiscoveryOutputContract() {
  return renderWordPressDiscoveryOutputContract("v1");
}

/** Root relays the schema contract to children at each turn. */
export function wordPressDiscoveryOutputContractV2() {
  return renderWordPressDiscoveryOutputContract("v2");
}

/**
 * v8 reports can cite pinned PHP and plugin dependency source trees.
 * The entry-index coverage contract (v3) was deleted with the index (ADR
 * 0034); old Trials keep its `contractDigest` in `discovery-run-started`.
 */
export function wordPressDiscoveryOutputContractV4() {
  return renderWordPressDiscoveryOutputContract("v4");
}

/**
 * v4 with the Finding's declared `configurationClass`, `attackerInputPath`
 * and `exploitTiming` (#613, ADR 0038 追記 13). The Harness parks on the
 * declared value.
 */
export function wordPressDiscoveryOutputContractV5() {
  return renderWordPressDiscoveryOutputContract("v5");
}

/** The checked/v1 handoff; old contract text and digests stay byte-identical. */
export function wordPressDiscoveryOutputContractV6() {
  const finding = z.toJSONSchema(archivedFindingClaimSchema, { io: "output" });
  const lead = z.toJSONSchema(wordpressLeadClaimSchema, { io: "output" });
  const check = z.toJSONSchema(wordPressAuditCheckSchema, { io: "output" });
  const text = [
    "## Finding and Lead output contract (wordpress-discovery-contract-v6)",
    "Include this complete contract in every child assignment and follow-up. Root's final report has exactly `findings`, `leads`, `examined`, and `unexamined`. Each child's final report has exactly those four keys plus `checks`. A later prose reply must not replace the child's report.",
    "Child `findings` and `leads` are empty arrays. Children that do not check a final draft return `checks: []`. A final-record checker returns one check object per draft. `kind` is `finding` or `lead`; `candidate` is always the complete unchanged draft claim object, including for `replace`; `verdict` is `verified`, `replace`, `refuted`, or `blocked`; `explanation` names the source and Lab facts checked and the exact unresolved gap. Put replacement text in the child's private scratch and explanation, then obtain a new `verified` check for the revised draft. An AI check is never a human confirmation.",
    "Root includes a claim only when a distinct child's `verified` check names the same normalized claim in the same Trial and Target Snapshot. `examined` and `unexamined` are strings. In Root's final report, encode each Finding and Lead object as one JSON string in its array, as required by the transport schema. In a child report, `checks` and its `candidate` values are JSON objects.",
    "Each claim object must follow its schema below. Fields of type string are single strings, not arrays. `sourceTrace` is an array of objects with `file`, `function`, and positive integer `line`. Use target-relative paths; prefix WordPress core paths with `@wordpress/`, PHP paths with `@php/`, and supplied plugin dependency paths with `@dependencies/<id>/`.",
    `Finding schema: ${canonicalJson(finding)}`,
    `Lead schema: ${canonicalJson(lead)}`,
    `Child check schema: ${canonicalJson(check)}`,
  ].join("\n\n");
  return {
    id: "wordpress-discovery-contract-v6" as const,
    text,
    digest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
  };
}
