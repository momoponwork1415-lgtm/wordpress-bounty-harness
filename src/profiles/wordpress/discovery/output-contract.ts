import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "../../../infrastructure/canonical-json.js";
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
 * `solo` (ADR 0042) renders the same text without the paragraph addressed to
 * a Root and without the sentences about a child's report and Root's final
 * report, for an agent that starts no children; its id carries the suffix.
 */
function renderWordPressDiscoveryOutputContract<
  Version extends "v1" | "v2" | "v4" | "v5",
>(version: Version, solo = false) {
  const finding = z.toJSONSchema(
    version === "v5" ? wordpressFindingClaimSchema : archivedFindingClaimSchema,
    { io: "output" },
  );
  const lead = z.toJSONSchema(wordpressLeadClaimSchema, { io: "output" });
  const text = [
    `## Finding and Lead output contract (wordpress-discovery-contract-${version})`,
    ...((version === "v2" || version === "v4" || version === "v5") && !solo
      ? [
          "As Root, include this complete contract in every child spawn assignment. In every follow-up to a child, require that child's latest final message to be one JSON object with exactly `findings`, `leads`, `examined`, and `unexamined`, even when there are no claims. Use empty arrays and the two strings for an empty report. A later prose reply must not replace the child's report.",
        ]
      : []),
    solo
      ? "Return `findings`, `leads`, `examined`, and `unexamined`. The last two are strings."
      : "Return `findings`, `leads`, `examined`, and `unexamined`. The last two are strings. A child reports direct Finding and Lead objects. In Root's final report, encode each Finding and Lead object as one JSON string in its array, as required by the transport schema.",
    version === "v4" || version === "v5"
      ? "Each claim object must follow its schema below. Fields of type string are single strings, not arrays. `sourceTrace` is an array of objects with `file`, `function`, and positive integer `line`. Use target-relative paths; prefix WordPress core paths with `@wordpress/`, PHP paths with `@php/`, and supplied plugin dependency paths with `@dependencies/<id>/`."
      : "Each claim object must follow its schema below. Fields of type string are single strings, not arrays. `sourceTrace` is an array of objects with `file`, `function`, and positive integer `line`. Use target-relative paths; prefix WordPress core paths with `@wordpress/`.",
    `Finding schema: ${canonicalJson(finding)}`,
    `Lead schema: ${canonicalJson(lead)}`,
  ].join("\n\n");
  return {
    id: `wordpress-discovery-contract-${version}${solo ? "-solo" : ""}` as const,
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
 * The v4 contract for a tracer of a partitioned Trial (ADR 0042): the same
 * schemas and rules, without the paragraph that tells a Root what to relay
 * and without the two sentences about children and Root's final report.
 */
export function wordPressDiscoveryOutputContractV4Solo() {
  return renderWordPressDiscoveryOutputContract("v4", true);
}

/**
 * v4 with the Finding's declared `configurationClass`, `attackerInputPath`
 * and `exploitTiming` (#613, ADR 0038 追記 13). The Harness parks on the
 * declared value.
 */
export function wordPressDiscoveryOutputContractV5() {
  return renderWordPressDiscoveryOutputContract("v5");
}
