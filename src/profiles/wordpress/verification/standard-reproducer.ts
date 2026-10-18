import { createHash } from "node:crypto";

import { z } from "zod";

import type { CapturedExchange } from "../../../lab/capture.js";
import { canonicalJson } from "../../../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import type {
  Reproducer,
  ReproducerObservation,
} from "../../../verification/index.js";
import type { WordPressFinding } from "../discovery/finding.js";
import type { WordPressLab, WordPressLabHandle } from "../lab/index.js";
import { PROXY_CAPTURE_FILE } from "./http-evidence.js";
import { wordpressReproductionStepSchema } from "./reproduction-package.js";
import { requestContainsSecret } from "./request-secret.js";
import {
  STANDARD_REPRODUCER_ID,
  STANDARD_REPRODUCER_SCRIPT,
} from "../lab/standard-script.js";

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
      const file = await options.store.readJson(
        recipeDigest,
        "route.json",
        routeSchema,
        1024 * 1024,
      );
      if (file.status === "malformed" && file.reason === "json")
        return incomplete("recipe", "The standard HTTP route is unreadable");
      if (file.status === "malformed")
        return incomplete("recipe", "The route role or shape is invalid");
      if (file.status !== "resolved")
        return incomplete("recipe", "The standard HTTP route is missing");
      const route = file.value;
      if (route.role !== finding.attackerPosition)
        return incomplete("recipe", "The route role or shape is invalid");
      const allowed = expectedCanaries(finding, lab, options.lab);
      if (allowed.length === 0)
        return incomplete(
          "observation",
          "This category needs a Harness-owned effect observer beyond HTTP response matching",
        );
      if (route.steps.some((step) => step.kind !== "http"))
        return incomplete(
          "recipe",
          "The standard Python route must use HTTP steps only",
        );
      const account =
        route.role === "unauthenticated"
          ? null
          : lab.attackerAccounts[route.role];
      if (
        (account === null && route.account !== "none") ||
        (account !== null && account?.username !== route.account)
      )
        return incomplete("recipe", "The route account differs from the Lab");
      const marker = await options.lab.markCapture(lab);
      if (marker === null)
        return incomplete(
          "observation",
          "The Lab HTTP recorder is unavailable",
        );
      const scriptInput = canonicalJson({
        role: route.role,
        canaries: allowed,
        ...(account === null
          ? {}
          : { username: account.username, password: account.password }),
        steps: route.steps,
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
        output.stepResults.length !== route.steps.length ||
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
      // Every line must be a complete exchange; a truncated body cannot be hashed.
      if (capture.defects.length > 0)
        return incomplete("observation", "The Lab HTTP capture is unreadable");
      const { exchanges } = capture;
      const routeExchanges: CapturedExchange[] = [];
      let cursor = 0;
      for (const [index, step] of route.steps.entries()) {
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
      const observed = route.steps.findIndex((step, index) => {
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
          reference.data.role !== route.role ||
          reference.data.account !== route.account ||
          reference.data.defaultSettings !== route.defaultSettings ||
          canonicalJson(reference.data.configurationChanges) !==
            canonicalJson(route.configurationChanges) ||
          reference.data.steps.length !== route.steps.length ||
          reference.data.steps.some(
            (step, index) =>
              step.kind !== "http" ||
              route.steps[index]?.kind !== "http" ||
              step.method !== route.steps[index]?.method ||
              step.path !== route.steps[index]?.path ||
              canonicalJson({
                headers: step.headers ?? {},
                body: step.body ?? null,
              }) !==
                canonicalJson({
                  headers: route.steps[index]?.headers ?? {},
                  body: route.steps[index]?.body ?? null,
                }),
          )
        )
          return incomplete(
            "observation",
            "The comparison did not replay the same HTTP route",
          );
      }
      const evidenceDigest = await options.store.putFiles({
        [PROXY_CAPTURE_FILE]: capture.bytes,
        "structured-output.json": canonicalJson(output),
        "standard-reproduce.py": STANDARD_REPRODUCER_SCRIPT,
        "reproduced-route.json": canonicalJson({
          schemaVersion: 1,
          snapshotDigest: finding.snapshotDigest,
          labSetupDigest: lab.setupDigest,
          role: route.role,
          account: route.account,
          defaultSettings: route.defaultSettings,
          configurationChanges: route.configurationChanges,
          steps: route.steps,
          ...(route.victim === undefined ? {} : { victim: route.victim }),
          evidence: [
            {
              kind: "http",
              path: PROXY_CAPTURE_FILE,
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
          attackerRole: route.role,
          observedStep: String(observed),
          defaultSettings: route.defaultSettings ? "true" : "false",
        },
      };
    },
  };
}
