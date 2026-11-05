import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "../../../infrastructure/canonical-json.js";
import { wordpressFindingClaimSchema } from "./finding.js";
import { wordpressLeadClaimSchema } from "./lead.js";

/**
 * The Finding schema without the declared-precondition fields (#613). The v4
 * contract renders it, so its text and digest stay what earlier Trials
 * recorded in `contractDigest` (ADR 0038 addendum 15).
 */
const v4FindingClaimSchema = wordpressFindingClaimSchema.omit({
  configurationClass: true,
  attackerInputPath: true,
  exploitTiming: true,
});

/**
 * v8 and later reports can cite pinned PHP and plugin dependency source
 * trees. The claim schemas own keys, required fields, types, and enum values.
 * The other contract versions (v1, v2, v5) served only objectives that moved
 * to `history/prompts/` on 2026-11-05; the entry-index coverage contract (v3)
 * was deleted with the index (ADR 0034). Old Trials keep their recorded
 * `contractDigest` in `discovery-run-started`.
 */
export function wordPressDiscoveryOutputContractV4() {
  const version = "v4";
  const finding = z.toJSONSchema(v4FindingClaimSchema, { io: "output" });
  const lead = z.toJSONSchema(wordpressLeadClaimSchema, { io: "output" });
  const text = [
    `## Finding and Lead output contract (wordpress-discovery-contract-${version})`,
    "As Root, include this complete contract in every child spawn assignment. In every follow-up to a child, require that child's latest final message to be one JSON object with exactly `findings`, `leads`, `examined`, and `unexamined`, even when there are no claims. Use empty arrays and the two strings for an empty report. A later prose reply must not replace the child's report.",
    "Return `findings`, `leads`, `examined`, and `unexamined`. The last two are strings. A child reports direct Finding and Lead objects. In Root's final report, encode each Finding and Lead object as one JSON string in its array, as required by the transport schema.",
    "Each claim object must follow its schema below. Fields of type string are single strings, not arrays. `sourceTrace` is an array of objects with `file`, `function`, and positive integer `line`. Use target-relative paths; prefix WordPress core paths with `@wordpress/`, PHP paths with `@php/`, and supplied plugin dependency paths with `@dependencies/<id>/`.",
    `Finding schema: ${canonicalJson(finding)}`,
    `Lead schema: ${canonicalJson(lead)}`,
  ].join("\n\n");
  return {
    id: `wordpress-discovery-contract-${version}` as const,
    text,
    digest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
  };
}
