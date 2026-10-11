import { z } from "zod";

import { canonicalDigest } from "../../../infrastructure/canonical-json.js";
import type { ReplayHttpInput } from "../lab/index.js";

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

type Exchange = z.infer<typeof exchangeSchema>;
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

function matchedExchanges(
  route: readonly HttpStep[],
  captured: unknown,
): { readonly exchanges: Exchange[]; readonly indices: number[] } {
  const exchanges = z.array(exchangeSchema).min(8).max(100).parse(captured);
  const indices: number[] = [];
  let at = 0;
  for (const step of route) {
    while (
      at < exchanges.length &&
      !(
        exchanges[at]?.request.method === step.method &&
        exchanges[at]?.request.path === step.path &&
        (step.body === undefined ||
          exchanges[at]?.request.body === step.body) &&
        (step.headers === undefined ||
          Object.entries(step.headers).every(
            ([name, value]) =>
              Object.entries(exchanges[at]?.request.headers ?? {}).filter(
                ([other]) => other.toLowerCase() === name.toLowerCase(),
              )[0]?.[1] === value,
          ))
      )
    )
      at++;
    if (at === exchanges.length)
      throw new Error("A confirmed route has no complete Harness capture");
    indices.push(at++);
  }
  return { exchanges, indices };
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

function sharedDelimiter(input: {
  readonly sourceBody: string;
  readonly sourceValue: string;
  readonly comparisonBody: string;
  readonly comparisonValue: string;
  readonly name: Binding["name"];
  readonly pattern: Binding["pattern"];
  readonly occurrence: Binding["occurrence"];
}): Binding {
  const sourceAt = input.sourceBody.indexOf(input.sourceValue);
  const comparisonAt = input.comparisonBody.lastIndexOf(input.comparisonValue);
  if (sourceAt < 0 || comparisonAt < 0)
    throw new Error("The dynamic value is absent from a prior response");
  let leftLength = 0;
  let rightLength = 0;
  while (
    leftLength < 128 &&
    sourceAt - leftLength > 0 &&
    comparisonAt - leftLength > 0 &&
    input.sourceBody[sourceAt - leftLength - 1] ===
      input.comparisonBody[comparisonAt - leftLength - 1]
  )
    leftLength++;
  while (
    rightLength < 128 &&
    sourceAt + input.sourceValue.length + rightLength <
      input.sourceBody.length &&
    comparisonAt + input.comparisonValue.length + rightLength <
      input.comparisonBody.length &&
    input.sourceBody[sourceAt + input.sourceValue.length + rightLength] ===
      input.comparisonBody[
        comparisonAt + input.comparisonValue.length + rightLength
      ]
  )
    rightLength++;
  const binding = bindingSchema.parse({
    name: input.name,
    left: input.sourceBody.slice(sourceAt - Math.min(leftLength, 32), sourceAt),
    right: input.sourceBody.slice(
      sourceAt + input.sourceValue.length,
      sourceAt + input.sourceValue.length + Math.min(rightLength, 32),
    ),
    pattern: input.pattern,
    occurrence: input.occurrence,
  });
  if (
    extractReplayBinding(input.sourceBody, binding) !== input.sourceValue ||
    extractReplayBinding(input.comparisonBody, binding) !==
      input.comparisonValue
  )
    throw new Error("The dynamic value has no stable response binding");
  return binding;
}

function pathValues(step: HttpStep): Map<string, string> {
  const values = new Map<string, string>();
  for (const [key, value] of new URL(step.path, "http://wordpress")
    .searchParams) {
    if (values.has(key)) throw new Error("Repeated query keys are ambiguous");
    values.set(key, value);
  }
  return values;
}

function responseAt(
  capture: ReturnType<typeof matchedExchanges>,
  index: number,
): string {
  const exchange = capture.exchanges[capture.indices[index] ?? -1];
  if (exchange === undefined) throw new Error("Missing route response");
  return exchange.response.body;
}

/** Derive private replay bytes only after two independent positive captures agree. */
export function createSmokeReplayRecipe(input: {
  readonly sourceRoute: unknown;
  readonly sourceCapture: unknown;
  readonly comparisonRoute: unknown;
  readonly comparisonCapture: unknown;
  readonly findingSnapshotDigest: string;
}): SmokeReplayRecipe {
  const sourceRoute = httpSteps(input.sourceRoute);
  const comparisonRoute = httpSteps(input.comparisonRoute);
  const source = matchedExchanges(sourceRoute, input.sourceCapture);
  const comparison = matchedExchanges(comparisonRoute, input.comparisonCapture);
  const sourceQuery = pathValues(sourceRoute[3]!);
  const comparisonQuery = pathValues(comparisonRoute[3]!);
  const differing = [...sourceQuery].filter(
    ([key, value]) => comparisonQuery.get(key) !== value,
  );
  if (
    sourceQuery.size !== comparisonQuery.size ||
    differing.length !== 2 ||
    [...sourceQuery.keys()].some(
      (key, index) => key !== [...comparisonQuery.keys()][index],
    )
  )
    throw new Error("The two positive routes have unrelated query structure");
  const user = differing.find(
    ([, value]) => value.startsWith("wbh-canary-admin-") && value.length <= 60,
  );
  const reset = differing.find(([, value]) => /^[A-Za-z0-9]{20}$/.test(value));
  if (user === undefined || reset === undefined || user[0] === reset[0])
    throw new Error("The positive routes have no typed dynamic query values");
  const sourceAdminUser = user[1];
  const comparisonAdminUser = comparisonQuery.get(user[0]);
  const sourceResetKey = reset[1];
  const comparisonResetKey = comparisonQuery.get(reset[0]);
  if (
    comparisonAdminUser === undefined ||
    !comparisonAdminUser.startsWith("wbh-canary-admin-") ||
    comparisonResetKey === undefined ||
    !/^[A-Za-z0-9]{20}$/.test(comparisonResetKey)
  )
    throw new Error("The comparison route has invalid dynamic values");
  for (let index = 0; index < 8; index++) {
    const original = sourceRoute[index]!;
    const current = comparisonRoute[index]!;
    if (
      original.method !== current.method ||
      original.path
        .replaceAll(sourceAdminUser, comparisonAdminUser)
        .replaceAll(sourceResetKey, comparisonResetKey) !== current.path
    )
      throw new Error("The two positive routes do not share the same path");
  }
  const sourceBody = source.exchanges[source.indices[2]!]!.request.body;
  const comparisonBody =
    comparison.exchanges[comparison.indices[2]!]!.request.body;
  const sourceParams = [...new URLSearchParams(sourceBody)];
  const comparisonParams = [...new URLSearchParams(comparisonBody)];
  const securityPair = sourceParams
    .map(([name, value], index) => ({
      name,
      value,
      comparison: comparisonParams[index],
    }))
    .filter(
      ({ name, value, comparison: other }) =>
        other?.[0] === name &&
        value !== other[1] &&
        /^[A-Za-z0-9]{10}$/.test(value) &&
        /^[A-Za-z0-9]{10}$/.test(other[1]) &&
        responseAt(source, 0).includes(value) &&
        responseAt(comparison, 0).includes(other[1]),
    );
  if (securityPair.length !== 1)
    throw new Error("The two positive routes have no unique security binding");
  const sourceSecurity = securityPair[0]!.value;
  const comparisonSecurity = securityPair[0]!.comparison![1];
  const securityBinding = sharedDelimiter({
    sourceBody: responseAt(source, 0),
    sourceValue: sourceSecurity,
    comparisonBody: responseAt(comparison, 0),
    comparisonValue: comparisonSecurity,
    name: "security",
    pattern: "[A-Za-z0-9]{10}",
    occurrence: "unique",
  });
  const sourceResetResponse = responseAt(source, 2);
  const comparisonResetResponse = comparison.exchanges
    .slice(comparison.indices[2]!, comparison.indices[3]!)
    .filter((exchange) => exchange.response.body.includes(comparisonResetKey))
    .at(-1)?.response.body;
  if (comparisonResetResponse === undefined)
    throw new Error("The comparison reset key lacks a prior response");
  const resetKeyBinding = sharedDelimiter({
    sourceBody: sourceResetResponse,
    sourceValue: sourceResetKey,
    comparisonBody: comparisonResetResponse,
    comparisonValue: comparisonResetKey,
    name: "resetKey",
    pattern: "[A-Za-z0-9]{20}",
    occurrence: "last",
  });
  const steps = sourceRoute.map((step, index) => {
    const captured = source.exchanges[source.indices[index]!]!.request;
    const substitute = (value: string) =>
      value
        .replaceAll(sourceAdminUser, "{{adminUser}}")
        .replaceAll(sourceSecurity, "{{security}}")
        .replaceAll(sourceResetKey, "{{resetKey}}");
    const contentType = Object.entries(captured.headers).find(
      ([name]) => name.toLowerCase() === "content-type",
    )?.[1];
    const headers =
      typeof contentType === "string"
        ? { "content-type": contentType }
        : undefined;
    return {
      method: z.enum(["GET", "POST"]).parse(step.method),
      path: substitute(captured.path),
      ...(headers === undefined ? {} : { headers }),
      ...(captured.body === "" ? {} : { body: substitute(captured.body) }),
      ...(index === 0
        ? { bindingsAfter: [securityBinding] }
        : index === 2
          ? { bindingsAfter: [resetKeyBinding] }
          : {}),
    };
  });
  if (
    !steps[1]?.body?.includes("{{adminUser}}") ||
    !steps[2]?.body?.includes("{{security}}") ||
    !steps[3]?.path.includes("{{adminUser}}") ||
    !steps[3]?.path.includes("{{resetKey}}") ||
    !steps[5]?.body?.includes("{{resetKey}}") ||
    !steps[6]?.body?.includes("{{adminUser}}")
  )
    throw new Error("The captured requests do not use the typed bindings");
  return smokeReplayRecipeSchema.parse({
    schemaVersion: 1,
    findingSnapshotDigest: input.findingSnapshotDigest,
    sourceRouteDigest: canonicalDigest(input.sourceRoute),
    sourceAdminUser,
    sourceResetKey,
    securityBinding,
    resetKeyBinding,
    steps,
  });
}

/** The runner receives the fresh canary name; old cookies and tokens stay private. */
export function replayInputFor(
  recipe: SmokeReplayRecipe,
  adminUser: string,
): ReplayHttpInput {
  return {
    steps: recipe.steps.map((step) => ({
      method: step.method,
      path: step.path,
      ...(step.headers === undefined ? {} : { headers: step.headers }),
      ...(step.body === undefined ? {} : { body: step.body }),
      ...(step.bindingsAfter === undefined
        ? {}
        : { bindingsAfter: step.bindingsAfter }),
    })),
    initialBindings: { adminUser },
  };
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
