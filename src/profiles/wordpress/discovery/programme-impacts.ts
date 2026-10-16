/**
 * Programme Boundary を impact ラベルで引く。
 *
 * Wordfence の対象範囲（campaign.json の programmeBoundary.text）に無い効果と、
 * 所有者が 2026-10-17 に「重大かどうかの判別が付きにくい」として外した 5 分類
 * （ADR 0032 の 2026-10-17 節）は、Finding としては記録せず `finding-parked` に置く
 * （#185、ADR 0031、LESSONS 6・11）。
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
  // 2026-10-17 所有者決定: 分類としては対象内でも、実物が報奨になるかの判別が付きにくい。
  // Wordfence は「基本的な情報露出」「非公開 / 下書き投稿の閲覧」を明示的に対象外にしている。
  // 残すのは RCE、PHP ファイル書き込み、任意ファイルの read / delete / download、LFI / RFI、
  // SQLi、Stored XSS、管理者への昇格・認証回避・ATO。
  "sensitive-object-access",
  "content-deletion",
  "options-update",
  "privesc-to-contributor+",
  "auth-bypass-non-admin",
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
