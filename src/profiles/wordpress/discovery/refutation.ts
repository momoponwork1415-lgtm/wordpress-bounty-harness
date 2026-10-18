import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "../../../infrastructure/canonical-json.js";
import { refutationReportSchema } from "../../../discovery/refutation-report.js";

export const wordPressRefutationSchema = refutationReportSchema;
export type WordPressRefutation =
  import("../../../discovery/refutation-report.js").RefutationReport;

/** Contract content is derived from the same schema used to admit the report. */
export function wordPressRefutationOutputContract() {
  const text = canonicalJson(
    z.toJSONSchema(wordPressRefutationSchema, { io: "output" }),
  );
  return {
    id: "wordpress-refutation-contract-v1" as const,
    text,
    digest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
  };
}
