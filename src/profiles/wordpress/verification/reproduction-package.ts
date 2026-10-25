import { z } from "zod";

const path = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (value) =>
      value.startsWith("/") &&
      !value.startsWith("//") &&
      !/[\r\n\0]/.test(value),
  );
/**
 * One step of a WordPress route. The package renderer that sealed routes for
 * the deleted judges is gone (#525); the Verifier still records its route in
 * this shape, and the sealed packages stay readable in Private Evidence.
 */
export const wordpressReproductionStepSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("http"),
    method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
    path,
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
    expected: z.string().min(1).max(2000),
  }),
  z.strictObject({
    kind: z.literal("browser"),
    path,
    expected: z.string().min(1).max(2000),
  }),
]);
