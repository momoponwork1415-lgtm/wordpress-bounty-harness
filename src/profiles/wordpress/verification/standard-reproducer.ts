import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "../../../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import type {
  Reproducer,
  ReproducerObservation,
} from "../../../verification/index.js";
import type { WordPressFinding } from "../discovery/finding.js";
import type { WordPressLab, WordPressLabHandle } from "../lab/index.js";
import { wordpressReproductionStepSchema } from "./reproduction-package.js";
import { requestContainsSecret } from "./request-secret.js";
import {
  STANDARD_REPRODUCER_ID,
  STANDARD_REPRODUCER_SCRIPT,
} from "./standard-script.js";

const routeSchema = z.looseObject({
  role: z.enum(["unauthenticated", "subscriber", "customer"]),
  account: z.string().min(1).max(128),
  defaultSettings: z.boolean(),
  configurationChanges: z.array(z.string().min(1).max(500)).max(30),
  steps: z.array(wordpressReproductionStepSchema).min(1).max(30),
});
const outputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  stepResults: z.array(
    z.strictObject({
      index: z.number().int().nonnegative(),
      statusCode: z.number().int().min(100).max(599),
      bodySha256: z.string().regex(/^[a-f0-9]{64}$/),
      containsExpected: z.boolean(),
    }),
  ),
});
const capturedExchangeSchema = z.strictObject({
  request: z.looseObject({
    method: z.string(),
    path: z.string(),
    headers: z.record(z.string(), z.unknown()),
    body: z.string(),
    truncated: z.literal(false),
  }),
  response: z.looseObject({
    statusCode: z.number().int().min(100).max(599),
    body: z.string(),
    bodyBase64: z.string(),
    truncated: z.literal(false),
  }),
});

type ReproducerLab = Pick<
  WordPressLab,
  "markCapture" | "readCapture" | "runStandardScript" | "canaryLedger"
>;

function expectedCanaries(
  finding: WordPressFinding,
  lab: WordPressLabHandle,
  provider: ReproducerLab,
): readonly string[] {
  const canaries = provider.canaryLedger(lab);
  if (canaries === null) return [];
  switch (finding.impact) {
    case "sqli":
      return [canaries.sqlCanary.value];
    case "sensitive-object-access":
      return canaries.sensitiveCanaries.map((item) => item.value);
    case "arbitrary-file-read":
    case "arbitrary-file-download":
    case "lfi":
      return canaries.fileCanaries.map((item) => item.value);
    default:
      // Browser execution, state changes, or authorization cannot be proven by
      // an arbitrary response string, even when the script reports success.
      return [];
  }
}

const incomplete = (
  reason: "recipe" | "observation" | "evidence",
  nextStep: string,
): ReproducerObservation => ({ status: "incomplete", reason, nextStep });

/** A Verifier route is input data; the executable Python is always Harness-owned. */
export function createWordPressStandardReproducer(options: {
  readonly store: PrivateArtifactStore;
  readonly lab: ReproducerLab;
}): Reproducer<WordPressFinding, WordPressLabHandle> {
  return {
    id: STANDARD_REPRODUCER_ID,
    async observe({ finding, lab, recipeDigest, referenceRoute }) {
      if (finding.snapshotDigest !== lab.snapshotDigest)
        return incomplete("evidence", "Repeat on the Finding snapshot");
      const file = await options.store.readFile(
        recipeDigest,
        "route.json",
        1024 * 1024,
      );
      if (file.status !== "resolved")
        return incomplete("recipe", "The standard HTTP route is missing");
      let parsed: unknown;
      try {
        parsed = JSON.parse(file.bytes.toString("utf8")) as unknown;
      } catch {
        return incomplete("recipe", "The standard HTTP route is unreadable");
      }
      const route = routeSchema.safeParse(parsed);
      if (!route.success || route.data.role !== finding.attackerPosition)
        return incomplete("recipe", "The route role or shape is invalid");
      const allowed = expectedCanaries(finding, lab, options.lab);
      if (allowed.length === 0)
        return incomplete(
          "observation",
          "This category needs a Harness-owned effect observer beyond HTTP response matching",
        );
      if (route.data.steps.some((step) => step.kind !== "http"))
        return incomplete(
          "recipe",
          "The standard Python route must use HTTP steps only",
        );
      const account =
        route.data.role === "unauthenticated"
          ? null
          : lab.attackerAccounts[route.data.role];
      if (
        (account === null && route.data.account !== "none") ||
        (account !== null && account?.username !== route.data.account)
      )
        return incomplete("recipe", "The route account differs from the Lab");
      const marker = await options.lab.markCapture(lab);
      if (marker === null)
        return incomplete(
          "observation",
          "The Lab HTTP recorder is unavailable",
        );
      const scriptInput = canonicalJson({
        role: route.data.role,
        canaries: allowed,
        ...(account === null
          ? {}
          : { username: account.username, password: account.password }),
        steps: route.data.steps,
      });
      const executed = await options.lab.runStandardScript(lab, scriptInput);
      if (executed.status !== "completed")
        return incomplete(
          "recipe",
          "The isolated standard script did not finish",
        );
      let output: z.infer<typeof outputSchema>;
      try {
        output = outputSchema.parse(JSON.parse(executed.output) as unknown);
      } catch {
        return incomplete("recipe", "The standard script output is malformed");
      }
      if (
        output.stepResults.length !== route.data.steps.length ||
        output.stepResults.some((result, index) => result.index !== index)
      )
        return incomplete("recipe", "The standard script output omits a step");
      const capture = await options.lab.readCapture(lab, marker);
      if (
        capture.status !== "captured" ||
        capture.dropped !== 0 ||
        capture.bytes.length === 0
      )
        return incomplete(
          "observation",
          "The Lab HTTP capture is missing or dropped",
        );
      const exchanges: z.infer<typeof capturedExchangeSchema>[] = [];
      try {
        for (const line of capture.bytes.toString("utf8").trimEnd().split("\n"))
          exchanges.push(
            capturedExchangeSchema.parse(JSON.parse(line) as unknown),
          );
      } catch {
        return incomplete("observation", "The Lab HTTP capture is unreadable");
      }
      const routeExchanges: typeof exchanges = [];
      let cursor = 0;
      for (const [index, step] of route.data.steps.entries()) {
        if (step.kind !== "http") return incomplete("recipe", "Invalid step");
        const match = exchanges.findIndex(
          (exchange, offset) =>
            offset >= cursor &&
            exchange.request.method === step.method &&
            exchange.request.path === step.path &&
            exchange.response.statusCode ===
              output.stepResults[index]?.statusCode &&
            createHash("sha256")
              .update(Buffer.from(exchange.response.bodyBase64, "base64"))
              .digest("hex") === output.stepResults[index]?.bodySha256,
        );
        if (match < 0)
          return incomplete(
            "observation",
            "The script output has no matching captured HTTP response",
          );
        routeExchanges.push(exchanges[match]!);
        cursor = match + 1;
      }
      const observed = route.data.steps.findIndex((step, index) => {
        if (step.kind !== "http") return false;
        const response = routeExchanges[index]?.response.body ?? "";
        return (
          output.stepResults[index]?.containsExpected === true &&
          allowed.some(
            (canary) =>
              response.includes(canary) &&
              !exchanges.some((exchange) =>
                requestContainsSecret(exchange.request, canary),
              ),
          )
        );
      });
      if (observed < 0 && referenceRoute === undefined)
        return incomplete(
          "observation",
          "No Harness canary appeared in both script output and captured response without being submitted by the request",
        );
      if (referenceRoute !== undefined) {
        const reference = routeSchema.safeParse(referenceRoute);
        if (
          !reference.success ||
          reference.data.role !== route.data.role ||
          reference.data.account !== route.data.account ||
          reference.data.defaultSettings !== route.data.defaultSettings ||
          canonicalJson(reference.data.configurationChanges) !==
            canonicalJson(route.data.configurationChanges) ||
          reference.data.steps.length !== route.data.steps.length ||
          reference.data.steps.some(
            (step, index) =>
              step.kind !== "http" ||
              route.data.steps[index]?.kind !== "http" ||
              step.method !== route.data.steps[index]?.method ||
              step.path !== route.data.steps[index]?.path ||
              canonicalJson({
                headers: step.headers ?? {},
                body: step.body ?? null,
              }) !==
                canonicalJson({
                  headers: route.data.steps[index]?.headers ?? {},
                  body: route.data.steps[index]?.body ?? null,
                }),
          )
        )
          return incomplete(
            "observation",
            "The comparison did not replay the same HTTP route",
          );
      }
      const evidenceDigest = await options.store.putFiles({
        "proxy-capture.jsonl": capture.bytes,
        "structured-output.json": canonicalJson(output),
        "standard-reproduce.py": STANDARD_REPRODUCER_SCRIPT,
        "reproduced-route.json": canonicalJson({
          schemaVersion: 1,
          snapshotDigest: finding.snapshotDigest,
          labSetupDigest: lab.setupDigest,
          role: route.data.role,
          account: route.data.account,
          defaultSettings: route.data.defaultSettings,
          configurationChanges: route.data.configurationChanges,
          steps: route.data.steps,
          ...(route.data.victim === undefined
            ? {}
            : { victim: route.data.victim }),
          evidence: [
            {
              kind: "http",
              path: "proxy-capture.jsonl",
              capture: "harness-captured",
            },
            {
              kind: "structured-output",
              path: "structured-output.json",
              capture: "harness-captured",
            },
          ],
        }),
      });
      if (observed < 0) return { status: "not-observed", evidenceDigest };
      return {
        status: "observed",
        evidenceDigest,
        conditions: {
          observedVia:
            finding.impact === "sqli"
              ? "canary-row-read"
              : finding.impact === "sensitive-object-access"
                ? "sensitive-canary-access"
                : "canary-file-read",
          reproductionMethod: STANDARD_REPRODUCER_ID,
          attackerRole: route.data.role,
          observedStep: String(observed),
          defaultSettings: route.data.defaultSettings ? "true" : "false",
        },
      };
    },
  };
}
