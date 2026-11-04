import { z } from "zod";

/** An AI child's statement about one exact draft. It is never human confirmation. */
export const wordPressAuditCheckSchema = z.strictObject({
  kind: z.enum(["finding", "lead"]),
  candidate: z.unknown(),
  verdict: z.enum(["verified", "replace", "refuted", "blocked"]),
  explanation: z.string().min(1).max(4000),
});

export type WordPressAuditCheck = z.infer<typeof wordPressAuditCheckSchema>;
