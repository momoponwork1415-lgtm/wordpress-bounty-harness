/**
 * Programme Boundary を impact ラベルで引く。
 *
 * Wordfence の対象範囲（campaign.json の programmeBoundary.text）に無い効果は、
 * Finding としては記録せず `finding-parked` に置く（#185、ADR 0031、LESSONS 6・11）。
 * 列挙は Finding schema の enum を正本とし、ここでは対象外のラベルだけを持つ。
 */
import { z } from "zod";

import { wordpressFindingClaimSchema } from "./finding.js";

/** Programme Boundary の外にある impact ラベル。これ以外の enum 値は対象範囲内。 */
export const WORDPRESS_PROGRAMME_EXCLUDED_IMPACTS: readonly string[] = [
  "other",
  "csrf-to-write",
  "missing-authz",
  "idor",
  "reflected-xss",
  "content-deletion",
];

const impactProperty = z
  .object({ enum: z.array(z.string()).min(1) })
  .parse(
    z
      .object({ properties: z.object({ impact: z.unknown() }) })
      .parse(z.toJSONSchema(wordpressFindingClaimSchema, { io: "output" }))
      .properties.impact,
  );
const knownImpacts = new Set(impactProperty.enum);
for (const excluded of WORDPRESS_PROGRAMME_EXCLUDED_IMPACTS)
  if (!knownImpacts.has(excluded))
    throw new Error(`Unknown excluded impact label: ${excluded}`);

/** True when a Finding with this impact is routed to verification and review. */
export function isWordPressProgrammeImpact(impact: string): boolean {
  return (
    knownImpacts.has(impact) &&
    !WORDPRESS_PROGRAMME_EXCLUDED_IMPACTS.includes(impact)
  );
}
