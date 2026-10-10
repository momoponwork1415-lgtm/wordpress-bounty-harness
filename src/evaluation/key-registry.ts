import { z } from "zod";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** Public references to private Answer Keys; no answer fields belong here. */
export const keyDigestManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    keys: z.array(z.strictObject({ caseId: identifier, digest })).min(1),
  })
  .superRefine((manifest, context) => {
    const seen = new Set<string>();
    for (const [index, key] of manifest.keys.entries()) {
      if (seen.has(key.caseId)) {
        context.addIssue({
          code: "custom",
          message: "Duplicate case ID",
          path: ["keys", index],
        });
      }
      seen.add(key.caseId);
    }
  });

export type KeyDigestManifest = z.infer<typeof keyDigestManifestSchema>;
