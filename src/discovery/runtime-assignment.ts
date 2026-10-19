import { createHash } from "node:crypto";

import { z } from "zod";

/**
 * How a campaign splits its targets between the two discovery runtimes, as
 * whole-number weights. Absent, every target runs on Codex.
 */
export const runtimeShareSchema = z
  .strictObject({
    codex: z.number().int().min(0).max(100),
    claude: z.number().int().min(0).max(100),
  })
  .refine((share) => share.codex + share.claude > 0, {
    message: "A runtime share needs a positive weight",
  });
export type RuntimeShare = z.infer<typeof runtimeShareSchema>;
export type DiscoveryRuntime = "codex" | "claude";

/**
 * Harness control only: the target's identity alone picks its runtime, so a
 * retried, resumed or re-planned target always lands on the same one.
 */
export function assignDiscoveryRuntime(
  targetIdentity: string,
  share: RuntimeShare | undefined,
): DiscoveryRuntime {
  if (share === undefined || share.claude === 0) return "codex";
  const bucket =
    Number.parseInt(
      createHash("sha256").update(targetIdentity).digest("hex").slice(0, 8),
      16,
    ) %
    (share.codex + share.claude);
  return bucket < share.claude ? "claude" : "codex";
}
