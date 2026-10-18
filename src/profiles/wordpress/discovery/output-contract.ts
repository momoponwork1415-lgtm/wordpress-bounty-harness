import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "../../../infrastructure/canonical-json.js";
import { wordpressFindingClaimSchema } from "./finding.js";
import { wordpressLeadClaimSchema } from "./lead.js";
import { wordpressCoverageRecordSchema } from "./coverage.js";

/** The claim schemas own keys, required fields, types, and enum values. */
function renderWordPressDiscoveryOutputContract<Version extends "v1" | "v2">(
  version: Version,
) {
  const finding = z.toJSONSchema(wordpressFindingClaimSchema, { io: "output" });
  const lead = z.toJSONSchema(wordpressLeadClaimSchema, { io: "output" });
  const text = [
    `## Finding and Lead output contract (wordpress-discovery-contract-${version})`,
    ...(version === "v2"
      ? [
          "As Root, include this complete contract in every child spawn assignment. In every follow-up to a child, require that child's latest final message to be one JSON object with exactly `findings`, `leads`, `examined`, and `unexamined`, even when there are no claims. Use empty arrays and the two strings for an empty report. A later prose reply must not replace the child's report.",
        ]
      : []),
    "Return `findings`, `leads`, `examined`, and `unexamined`. The last two are strings. A child reports direct Finding and Lead objects. In Root's final report, encode each Finding and Lead object as one JSON string in its array, as required by the transport schema.",
    "Each claim object must follow its schema below. Fields of type string are single strings, not arrays. `sourceTrace` is an array of objects with `file`, `function`, and positive integer `line`. Use target-relative paths; prefix WordPress core paths with `@wordpress/`.",
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

/** Root-only coverage is a new contract; v1/v2 remain pinned for old Trials. */
export function wordPressDiscoveryOutputContractV3() {
  const finding = z.toJSONSchema(wordpressFindingClaimSchema, { io: "output" });
  const lead = z.toJSONSchema(wordpressLeadClaimSchema, { io: "output" });
  const coverage = z.toJSONSchema(wordpressCoverageRecordSchema, {
    io: "output",
  });
  const text = [
    "## Finding, Lead, and Root coverage output contract (wordpress-discovery-contract-v3)",
    "As Root, include the Finding and Lead portion of this contract in every child spawn assignment. In every follow-up to a child, require that child's latest final message to be one JSON object with exactly `findings`, `leads`, `examined`, and `unexamined`, even when there are no claims. Use empty arrays and the two strings for an empty child report. A later prose reply must not replace the child's report. Children do not report `coverage`.",
    "Return `findings`, `leads`, `examined`, `unexamined`, and `coverage` in Root's final report. `examined` and `unexamined` are strings. A child reports direct Finding and Lead objects. In Root's final report, encode each Finding and Lead object as one JSON string in its array, as required by the transport schema.",
    "Each claim object must follow its schema below. Fields of type string are single strings, not arrays. `sourceTrace` is an array of objects with `file`, `function`, and positive integer `line`. Use target-relative paths; prefix WordPress core paths with `@wordpress/`.",
    "Root's `coverage` is one object for the supplied Entry points index. Include every listed id once. Copy its digest and incomplete flag. Use `observed`, `blocked`, or `unvisited` for each id. Use a short reason code only for `blocked`; use null for other statuses. Include children's results when recording Root coverage. This records coverage; it does not require visiting every entry.",
    `Finding schema: ${canonicalJson(finding)}`,
    `Lead schema: ${canonicalJson(lead)}`,
    `Coverage schema: ${canonicalJson(coverage)}`,
  ].join("\n\n");
  return {
    id: "wordpress-discovery-contract-v3" as const,
    text,
    digest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
    coverageSchema: coverage,
  };
}
