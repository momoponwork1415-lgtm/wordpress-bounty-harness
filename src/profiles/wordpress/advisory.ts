import { z } from "zod";

import type { ProspectiveAdvisory } from "../../evaluation/index.js";
import { wordpressAnswerKeySchema } from "./answer-key.js";
import { intervalContains } from "./wordfence-intelligence/plugin-records.js";

const nonEmpty = z.string().trim().min(1);

/**
 * A public advisory written as an Answer Key: catalog facts plus the locations a
 * human read from the public patch. Private evaluation data; kept outside Git.
 */
export const wordpressAdvisorySchema = z.strictObject({
  schemaVersion: z.literal(1),
  advisoryId: nonEmpty,
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  affectedVersions: z
    .array(
      z.strictObject({
        fromVersion: nonEmpty,
        fromInclusive: z.boolean(),
        toVersion: nonEmpty,
        toInclusive: z.boolean(),
      }),
    )
    .min(1),
  publishedAt: z.iso.date(),
  impact: wordpressAnswerKeySchema.shape.impact,
  allowedLocations: wordpressAnswerKeySchema.shape.allowedLocations,
});

/** Maps advisories to the key shape; a target matches by `wporg:<slug>@<version>`. */
export function parseWordPressAdvisories(
  value: unknown,
): readonly ProspectiveAdvisory[] {
  return z
    .array(wordpressAdvisorySchema)
    .parse(value)
    .map((advisory) => ({
      caseId: advisory.advisoryId,
      allowedLocations: advisory.allowedLocations,
      publishedAt: advisory.publishedAt,
      matches(selectionId: string) {
        const target = /^wporg:([a-z0-9][a-z0-9-]*)@(.+)$/.exec(selectionId);
        return (
          target?.[1] === advisory.slug &&
          advisory.affectedVersions.some((interval) =>
            intervalContains(interval, target[2]!),
          )
        );
      },
    }));
}
