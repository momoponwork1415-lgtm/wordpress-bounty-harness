import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "../../../infrastructure/canonical-json.js";
import {
  wordpressFindingCurrentContractSchema,
  wordpressFindingLegacyClaimSchema,
} from "./finding.js";
import { wordpressLeadClaimSchema } from "./lead.js";

/** The claim schemas own keys, required fields, types, and enum values. */
function renderWordPressDiscoveryOutputContract<
  Version extends "v1" | "v2" | "v3",
>(version: Version) {
  const finding = z.toJSONSchema(
    version === "v3"
      ? wordpressFindingCurrentContractSchema
      : wordpressFindingLegacyClaimSchema,
    { io: "output" },
  );
  const lead = z.toJSONSchema(wordpressLeadClaimSchema, { io: "output" });
  const text = [
    `## Finding and Lead output contract (wordpress-discovery-contract-${version})`,
    ...(version === "v2" || version === "v3"
      ? [
          "As Root, include this complete contract in every child spawn assignment. In every follow-up to a child, require that child's latest final message to be one JSON object with exactly `findings`, `leads`, `examined`, and `unexamined`, even when there are no claims. Use empty arrays and the two strings for an empty report. A later prose reply must not replace the child's report.",
        ]
      : []),
    "Return `findings`, `leads`, `examined`, and `unexamined`. The last two are strings. A child reports direct Finding and Lead objects. In Root's final report, encode each Finding and Lead object as one JSON string in its array, as required by the transport schema.",
    "Each claim object must follow its schema below. Fields of type string are single strings, not arrays. `sourceTrace` is an array of objects with `file`, `function`, and positive integer `line`. Use target-relative paths; prefix WordPress core paths with `@wordpress/`.",
    ...(version === "v3"
      ? [
          "For each Finding, classify the complete claimed effect in `impactScope`. Use `minor-ui-setting-only` only for a cosmetic or prompt-dismissal setting with no other effect; `non-sensitive-enumeration-only` only for labels, IDs, or titles without protected data; `protected-content-only` only for protected post content or its post password without any separate authentication or critical-data effect; `private-media-reference-only` only for a private attachment URL or metadata without arbitrary file control or another critical effect. If effects are mixed, a critical effect is claimed, or the effect is uncertain, use `other-or-uncertain`. This classification is an unverified claim, not a severity verdict.",
        ]
      : []),
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

/** New effect-scoped contract; archived v1/v2 bytes and digests stay stable. */
export function wordPressDiscoveryOutputContractV3() {
  return renderWordPressDiscoveryOutputContract("v3");
}
