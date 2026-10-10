import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "../../../infrastructure/canonical-json.js";
import { wordpressFindingClaimSchema } from "./finding.js";
import { wordpressLeadClaimSchema } from "./lead.js";

/** The claim schemas own keys, required fields, types, and enum values. */
export function wordPressDiscoveryOutputContract() {
  const finding = z.toJSONSchema(wordpressFindingClaimSchema, { io: "output" });
  const lead = z.toJSONSchema(wordpressLeadClaimSchema, { io: "output" });
  const text = [
    "## Finding and Lead output contract (wordpress-discovery-contract-v1)",
    "Return `findings`, `leads`, `examined`, and `unexamined`. The last two are strings. A child reports direct Finding and Lead objects. In Root's final report, encode each Finding and Lead object as one JSON string in its array, as required by the transport schema.",
    "Each claim object must follow its schema below. Fields of type string are single strings, not arrays. `sourceTrace` is an array of objects with `file`, `function`, and positive integer `line`. Use target-relative paths; prefix WordPress core paths with `@wordpress/`.",
    `Finding schema: ${canonicalJson(finding)}`,
    `Lead schema: ${canonicalJson(lead)}`,
  ].join("\n\n");
  return {
    id: "wordpress-discovery-contract-v1" as const,
    text,
    digest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
  };
}
