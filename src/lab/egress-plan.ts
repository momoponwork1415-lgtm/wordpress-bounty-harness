import { readFile } from "node:fs/promises";

import { z } from "zod";

/**
 * ADR 0046 条件 2: a verification Lab that needs an external service reaches
 * it only through a Harness relay bound to fixed destinations. The plan names
 * those destinations; it carries no credential and no wildcard. The
 * Harness never reads the plan's reason; it is for the record.
 */
export const MAX_LAB_EGRESS_DESTINATIONS = 4;

const HOSTNAME =
  /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/u;

export const labEgressDestinationSchema = z.strictObject({
  /** A lowercase DNS name with at least one dot; no wildcard, no address literal. */
  host: z
    .string()
    .regex(HOSTNAME, "A destination host is a lowercase DNS name")
    .refine((host) => !/^[0-9.]+$/u.test(host), {
      message: "A destination host is a name, not an address",
    }),
  port: z.union([z.literal(443), z.literal(80)]),
});
export type LabEgressDestination = z.infer<typeof labEgressDestinationSchema>;

/** What the Lab provisioner receives: the destinations alone. */
export type LabEgressPlan = {
  readonly destinations: readonly LabEgressDestination[];
};

/** The operator's plan file (OPERATIONS 第 3 節); strict, so a key or token field is refused. */
export const labEgressPlanFileSchema = z
  .strictObject({
    schema: z.literal("wbh-egress-plan/v1"),
    campaignId: z.string().min(1).max(200),
    findingId: z.string().min(1).max(200),
    destinations: z
      .array(labEgressDestinationSchema)
      .min(1)
      .max(MAX_LAB_EGRESS_DESTINATIONS),
    reason: z.string().min(1).max(500),
  })
  .superRefine((plan, context) => {
    const seen = new Set<string>();
    for (const { host, port } of plan.destinations) {
      const key = `${host}:${port}`;
      if (seen.has(key))
        context.addIssue({
          code: "custom",
          path: ["destinations"],
          message: `Destination ${key} is listed twice`,
        });
      seen.add(key);
    }
  });
export type LabEgressPlanFile = z.infer<typeof labEgressPlanFileSchema>;

export async function readLabEgressPlanFile(
  path: string,
): Promise<LabEgressPlanFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error: unknown) {
    throw new Error(
      `The egress plan could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = labEgressPlanFileSchema.safeParse(parsed);
  if (!result.success)
    throw new Error(
      `The egress plan is invalid: ${result.error.issues.map((issue) => `${issue.path.join(".") || "plan"}: ${issue.message}`).join("; ")}`,
    );
  return result.data;
}
