// Retained only because the frozen canary judges (judges.ts) read a legacy
// `smoke-binding.json` through `smokeReplayRecipeSchema` and
// `bindSmokeReferenceRoute`. The recipe writer, the replay runner and the
// weekly smoke script (#126) were removed on 2026-10-18; nothing writes these
// files any more.
import { z } from "zod";

import { canonicalDigest } from "../../../infrastructure/canonical-json.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const path = z
  .string()
  .max(2048)
  .regex(/^\/(?!\/)[^\s\0\\]*$/);
const httpStep = z.looseObject({
  kind: z.literal("http"),
  method: z.string().min(1).max(12),
  path,
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
});
const routeSchema = z.looseObject({ steps: z.array(z.unknown()).min(8) });
const exchangeSchema = z.strictObject({
  request: z.looseObject({
    method: z.string(),
    path,
    headers: z.record(z.string(), z.unknown()),
    body: z.string(),
    truncated: z.literal(false),
  }),
  response: z.looseObject({
    statusCode: z.number().int(),
    headers: z.record(z.string(), z.unknown()),
    body: z.string(),
    truncated: z.literal(false),
  }),
});
const bindingSchema = z.strictObject({
  name: z.enum(["security", "resetKey"]),
  left: z.string().min(4).max(128),
  right: z.string().min(8).max(128),
  pattern: z.enum(["[A-Za-z0-9]{10}", "[A-Za-z0-9]{20}"]),
  occurrence: z.enum(["unique", "last"]),
});
export const smokeReplayRecipeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  findingSnapshotDigest: digest,
  sourceRouteDigest: digest,
  sourceAdminUser: z.string().min(1).max(60),
  sourceResetKey: z.string().regex(/^[A-Za-z0-9]{20}$/),
  securityBinding: bindingSchema,
  resetKeyBinding: bindingSchema,
  steps: z
    .array(
      z.strictObject({
        method: z.enum(["GET", "POST"]),
        path,
        headers: z.record(z.string(), z.string()).optional(),
        body: z
          .string()
          .max(1024 * 1024)
          .optional(),
        bindingsAfter: z.array(bindingSchema).optional(),
      }),
    )
    .length(8),
});
export type SmokeReplayRecipe = z.infer<typeof smokeReplayRecipeSchema>;

type HttpStep = z.infer<typeof httpStep>;
type Binding = z.infer<typeof bindingSchema>;

function httpSteps(route: unknown): HttpStep[] {
  const parsed = routeSchema.parse(route);
  const steps = parsed.steps
    .filter(
      (step): step is Record<string, unknown> =>
        typeof step === "object" && step !== null && "kind" in step,
    )
    .filter((step) => step.kind === "http")
    .map((step) => httpStep.parse(step));
  if (steps.length !== 8)
    throw new Error("The ATO route needs eight HTTP steps");
  return steps;
}

export function extractReplayBinding(
  body: string,
  binding: Binding,
): string | null {
  const values: string[] = [];
  const pattern = new RegExp(`^${binding.pattern}$`);
  let cursor = 0;
  while (cursor < body.length) {
    const left = body.indexOf(binding.left, cursor);
    if (left < 0) break;
    const start = left + binding.left.length;
    const end = body.indexOf(binding.right, start);
    if (
      end < 0 ||
      (body.indexOf(binding.left, start) >= 0 &&
        body.indexOf(binding.left, start) < end)
    )
      return null;
    values.push(body.slice(start, end));
    cursor = end + binding.right.length;
  }
  if (
    values.length === 0 ||
    (binding.occurrence === "unique" && values.length !== 1)
  )
    return null;
  const value = values.at(-1);
  return value !== undefined && pattern.test(value) ? value : null;
}

/** Bind only the two proven query values from this Lab's captured responses. */
export function bindSmokeReferenceRoute(input: {
  readonly recipe: SmokeReplayRecipe;
  readonly sourceRoute: unknown;
  readonly capture: unknown;
  readonly adminUser: string;
}): unknown | null {
  if (
    canonicalDigest(input.sourceRoute) !== input.recipe.sourceRouteDigest ||
    !input.adminUser.startsWith("wbh-canary-admin-") ||
    input.adminUser === input.recipe.sourceAdminUser
  )
    return null;
  const parsedRoute = routeSchema.safeParse(input.sourceRoute);
  const captured = z
    .array(exchangeSchema)
    .min(1)
    .max(100)
    .safeParse(input.capture);
  if (!parsedRoute.success || !captured.success) return null;
  const steps = httpSteps(parsedRoute.data);
  const first = captured.data.find(
    (exchange) =>
      exchange.request.method === steps[0]?.method &&
      exchange.request.path === steps[0]?.path,
  );
  if (first === undefined) return null;
  const security = extractReplayBinding(
    first.response.body,
    input.recipe.securityBinding,
  );
  if (security === null) return null;
  const third = captured.data.find(
    (exchange) =>
      exchange.request.method === steps[2]?.method &&
      exchange.request.path === steps[2]?.path &&
      exchange.request.body.includes(security),
  );
  if (third === undefined) return null;
  const resetKey = extractReplayBinding(
    third.response.body,
    input.recipe.resetKeyBinding,
  );
  if (resetKey === null) return null;
  const fourth = steps[3];
  if (
    fourth === undefined ||
    !fourth.path.includes(input.recipe.sourceAdminUser) ||
    !fourth.path.includes(input.recipe.sourceResetKey)
  )
    return null;
  let httpIndex = 0;
  return {
    ...parsedRoute.data,
    steps: parsedRoute.data.steps.map((raw) => {
      const parsed = httpStep.safeParse(raw);
      if (!parsed.success) return raw;
      const index = httpIndex++;
      return index === 3
        ? {
            ...parsed.data,
            path: parsed.data.path
              .replaceAll(input.recipe.sourceAdminUser, input.adminUser)
              .replaceAll(input.recipe.sourceResetKey, resetKey),
          }
        : parsed.data;
    }),
  };
}
