import { z } from "zod";

import {
  canonicalDigest,
  canonicalJson,
} from "../../../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import type {
  Judge,
  JudgeObservation,
  JudgeSet,
} from "../../../verification/index.js";
import {
  capturedExchangeSchema,
  type CaptureDefect,
} from "../../../lab/capture.js";
import type { WordPressFinding } from "../discovery/finding.js";
import { wordpressVictimRouteSchema } from "../lab/index.js";
import type {
  WordPressCanaryLedger,
  WordPressLab,
  WordPressLabHandle,
} from "../lab/index.js";
import {
  AUTHORED_HTTP_FILE,
  PROXY_CAPTURE_FILE,
  SETUP_BOUNDARY_FILE,
} from "./http-evidence.js";
import { wordpressReproductionStepSchema } from "./reproduction-package.js";
import { createWordPressStandardReproducer } from "./standard-reproducer.js";
import { requestContainsSecret } from "./request-secret.js";
import {
  bindSmokeReferenceRoute,
  smokeReplayRecipeSchema,
} from "./smoke-replay-recipe.js";

type JudgeLab = Pick<
  WordPressLab,
  | "canaryLedger"
  | "observeSessionUser"
  | "observeAccountRoles"
  | "observeCanaryTable"
  | "observeExecution"
  | "observeCanaryFiles"
  | "observeOptions"
  | "observeStoredScript"
  | "readCapture"
  | "issuedScriptNonces"
>;
type Options = {
  readonly store: PrivateArtifactStore;
  readonly lab: JudgeLab &
    Partial<Pick<WordPressLab, "markCapture" | "runStandardScript">>;
};

const sessionSchema = z.strictObject({ cookie: z.string().min(1).max(4096) });
const routeFieldsSchema = z.looseObject({});
const scriptNonceSchema = z.string().regex(/^[A-Za-z0-9-]{1,100}$/);
const routeDefinitionSchema = z.looseObject({
  role: z.enum(["unauthenticated", "subscriber", "customer"]),
  account: z.string().min(1).max(128),
  defaultSettings: z.boolean(),
  configurationChanges: z.array(z.string()).max(30),
  steps: z.array(wordpressReproductionStepSchema).min(1).max(30),
  victim: wordpressVictimRouteSchema.optional(),
});
const capturedRequestSchema = z.strictObject({
  method: z.string(),
  path: z.string(),
  body: z.string(),
  headers: z.record(z.string(), z.string()),
  statusCode: z.number().int().min(200).max(299),
});
const capturedRouteSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scenario: z
    .strictObject({ id: z.string().min(1), digest: z.string().min(1) })
    .nullable(),
  issuedScriptNonces: z.array(scriptNonceSchema).max(10),
  requests: z.array(capturedRequestSchema).min(1).max(30),
});
const referenceRouteSchema = z.looseObject({
  ...routeDefinitionSchema.shape,
  capturedRoute: capturedRouteSchema,
  comparisonKind: z.enum(["latest-version", "fixed-version"]).optional(),
});
const routeConditionsSchema = z.looseObject({
  role: z.string().min(1).max(64),
  defaultSettings: z.boolean(),
});
/** The Verifier's HTTP record; only responses can carry what the Lab held back. */
const httpRecordSchema = z.looseObject({
  // The recorder bounds bytes and reports dropped exchanges. A count cap here
  // would hide post-setup requests from the attacker-principal check.
  exchanges: z
    .array(
      z.looseObject({
        request: z.unknown(),
        response: z.looseObject({ body: z.string() }),
      }),
    )
    .min(1),
});
type HttpRecord = z.infer<typeof httpRecordSchema>;
type HttpEvidence = {
  readonly capture: "harness-captured" | "agent-authored";
  readonly http: HttpRecord | null;
  readonly captureBytes?: Buffer;
};

type CapturedRequest = z.infer<typeof capturedRequestSchema>;
const authenticationHeader = /(?:cookie|auth|token|nonce|api.?key|session)/i;
/** Unknown cookies may hold form state; these names claim an authentication role. */
const unknownAuthenticationCookie =
  /(?:^|[_-])(?:admin|auth|authentication|jwt|bearer|credential|login|logged[_-]?in)(?:$|[_-])/i;

function headerValue(
  headers: Record<string, unknown>,
  name: string,
): string | null {
  const matches = Object.entries(headers).filter(
    ([candidate]) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return matches.length === 1 && typeof matches[0]?.[1] === "string"
    ? matches[0][1]
    : null;
}

/** Captured body bytes must be representable without loss before comparison. */
function capturedRequest(
  exchange: unknown,
): z.infer<typeof capturedExchangeSchema>["request"] | null {
  const parsed = capturedExchangeSchema.safeParse(exchange);
  if (!parsed.success || parsed.data.request.truncated) return null;
  const { body, bodyBase64 } = parsed.data.request;
  if (Buffer.from(body, "utf8").toString("base64") !== bodyBase64) return null;
  return parsed.data.request;
}

/** An HTTP 200 response can still be an explicit application rejection. */
function explicitApplicationFailure(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "success" in parsed &&
      parsed.success === false
    );
  } catch {
    return false;
  }
}

/** A redirect can complete a write while keeping the browser inside this Lab. */
function completedCanaryResponse(
  statusCode: number,
  body: string,
  responseHeaders: Record<string, unknown>,
  requestHeaders: Record<string, unknown>,
): boolean {
  if (explicitApplicationFailure(body)) return false;
  if (statusCode >= 200 && statusCode < 300) return true;
  if (![301, 302, 303, 307, 308].includes(statusCode)) return false;
  const location = headerValue(responseHeaders, "location");
  const host = headerValue(requestHeaders, "host");
  if (
    location === null ||
    host === null ||
    /[\r\n\0\\]/.test(location) ||
    !/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(host)
  )
    return false;
  if (
    !(location.startsWith("/") && !location.startsWith("//")) &&
    !location.startsWith("http://")
  )
    return false;
  try {
    const target = new URL(location, `http://${host}`);
    return (
      target.protocol === "http:" &&
      target.host.toLowerCase() === host.toLowerCase() &&
      target.username === "" &&
      target.password === "" &&
      target.pathname !== "/wp-login.php"
    );
  } catch {
    return false;
  }
}

/** Every captured exchange must be declared and return 2xx. */
function capturedAttackRequests(
  http: HttpRecord,
  steps: z.infer<typeof wordpressReproductionStepSchema>[],
): CapturedRequest[] | null {
  const httpSteps = steps.filter((step) => step.kind === "http");
  if (httpSteps.length === 0 || httpSteps.length !== http.exchanges.length)
    return null;
  const requests: CapturedRequest[] = [];
  for (const [index, step] of httpSteps.entries()) {
    const exchange = http.exchanges[index];
    const parsed = capturedExchangeSchema.safeParse(exchange);
    const request = capturedRequest(exchange);
    if (!parsed.success || request === null) return null;
    if (
      request.method !== step.method ||
      request.path !== step.path ||
      request.body !== (step.body ?? "") ||
      parsed.data.response.statusCode < 200 ||
      parsed.data.response.statusCode >= 300 ||
      explicitApplicationFailure(parsed.data.response.body)
    )
      return null;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      const key = name.toLowerCase();
      if (
        authenticationHeader.test(key) ||
        Object.hasOwn(headers, key) ||
        typeof value !== "string"
      )
        return null;
      headers[key] = value;
    }
    for (const [name, value] of Object.entries(step.headers ?? {}))
      if (headerValue(request.headers, name) !== value) return null;
    requests.push({
      method: request.method,
      path: request.path,
      body: request.body,
      headers,
      statusCode: parsed.data.response.statusCode,
    });
  }
  return requests;
}

/** Only Lab-issued tokens may change between otherwise identical attack bytes. */
function withFreshScriptNonces(
  value: string,
  oldNonces: readonly string[],
  freshNonces: readonly string[],
): string | null {
  if (oldNonces.length !== freshNonces.length) return null;
  let translated = value;
  for (let index = 0; index < oldNonces.length; index++) {
    const oldNonce = oldNonces[index];
    const freshNonce = freshNonces[index];
    if (
      oldNonce === undefined ||
      freshNonce === undefined ||
      !scriptNonceSchema.safeParse(oldNonce).success ||
      !scriptNonceSchema.safeParse(freshNonce).success
    )
      return null;
    if (oldNonce !== freshNonce && oldNonce.length < 16) return null;
    // URL-encoded form fields may escape some nonce bytes (including hyphens).
    // Preserve exactly which bytes were escaped; do not decode and reserialize
    // the surrounding attack body.
    if (oldNonce.length === freshNonce.length) {
      const pattern = [...oldNonce]
        .map((character) => {
          const literal = character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
          const hex = character.charCodeAt(0).toString(16).padStart(2, "0");
          return `(?:${literal}|%${hex}|%${hex.toUpperCase()})`;
        })
        .join("");
      translated = translated.replace(new RegExp(pattern, "g"), (match) => {
        const units = match.match(/%[0-9a-fA-F]{2}|./g) ?? [];
        return units
          .map((unit, position) => {
            const next = freshNonce[position];
            if (next === undefined) return unit;
            if (!unit.startsWith("%")) return next;
            const hex = next.charCodeAt(0).toString(16).padStart(2, "0");
            return `%${/[A-F]/.test(unit) ? hex.toUpperCase() : hex}`;
          })
          .join("");
      });
    } else {
      translated = translated.replaceAll(oldNonce, freshNonce);
    }
  }
  return translated;
}

function sameRouteSteps(
  oldSteps: z.infer<typeof wordpressReproductionStepSchema>[],
  newSteps: z.infer<typeof wordpressReproductionStepSchema>[],
  oldNonces: readonly string[],
  freshNonces: readonly string[],
): boolean {
  if (oldSteps.length !== newSteps.length) return false;
  const comparable = (
    step: z.infer<typeof wordpressReproductionStepSchema>,
  ) => {
    const { expected: _expected, ...rest } = step;
    return rest;
  };
  for (let index = 0; index < oldSteps.length; index++) {
    const oldStep = oldSteps[index];
    const newStep = newSteps[index];
    if (oldStep === undefined || newStep === undefined) return false;
    const translated = withFreshScriptNonces(
      canonicalJson(comparable(oldStep)),
      oldNonces,
      freshNonces,
    );
    if (
      translated === null ||
      translated !== canonicalJson(comparable(newStep))
    )
      return false;
  }
  return true;
}

/** A negative control needs a bound prior capture, the same setup, and the same attack. */
function matchesReferenceRoute(
  http: HttpRecord,
  currentRoute: unknown,
  referenceRoute: unknown,
  lab: WordPressLabHandle,
  freshNonces: readonly string[] | null,
): boolean {
  const reference = referenceRouteSchema.safeParse(referenceRoute);
  const current = routeDefinitionSchema.safeParse(currentRoute);
  if (!reference.success || !current.success || freshNonces === null)
    return false;
  const baseline = reference.data.capturedRoute;
  const oldNonces = baseline.issuedScriptNonces;
  if (
    canonicalJson(baseline.scenario) !== canonicalJson(lab.scenario ?? null) ||
    reference.data.role !== "unauthenticated" ||
    reference.data.role !== current.data.role ||
    reference.data.account !== current.data.account ||
    reference.data.defaultSettings !== current.data.defaultSettings ||
    canonicalJson(reference.data.configurationChanges) !==
      canonicalJson(current.data.configurationChanges) ||
    canonicalJson(reference.data.victim ?? null) !==
      canonicalJson(current.data.victim ?? null) ||
    !sameRouteSteps(
      reference.data.steps,
      current.data.steps,
      oldNonces,
      freshNonces,
    )
  )
    return false;
  const replay = capturedAttackRequests(http, current.data.steps);
  if (replay === null || replay.length !== baseline.requests.length)
    return false;
  return baseline.requests.every((oldRequest, index) => {
    const freshRequest = replay[index];
    if (freshRequest === undefined) return false;
    return (
      (["method", "path", "body"] as const).every((field) => {
        const oldValue = oldRequest[field];
        const freshValue = freshRequest[field];
        return (
          withFreshScriptNonces(oldValue, oldNonces, freshNonces) === freshValue
        );
      }) &&
      Object.keys(oldRequest.headers).length ===
        Object.keys(freshRequest.headers).length &&
      Object.entries(oldRequest.headers).every(
        ([name, value]) =>
          withFreshScriptNonces(value, oldNonces, freshNonces) ===
          freshRequest.headers[name],
      )
    );
  });
}

/** Routes without a Harness-bound capture: every HTTP step must appear in order. */
function matchesReferenceRouteSteps(
  http: HttpRecord,
  referenceRoute: unknown,
): boolean {
  const route = referenceRouteSchema.safeParse(referenceRoute);
  if (!route.success) return false;
  const steps = route.data.steps.filter((step) => step.kind === "http");
  if (steps.length === 0) return false;
  let matched = 0;
  for (const exchange of http.exchanges) {
    const captured = capturedExchangeSchema.safeParse(exchange);
    if (!captured.success) return false;
    const step = steps[matched];
    const headersMatch =
      step === undefined ||
      step.headers === undefined ||
      Object.entries(step.headers).every(([name, value]) => {
        const sameName = Object.entries(captured.data.request.headers).filter(
          ([capturedName]) => capturedName.toLowerCase() === name.toLowerCase(),
        );
        return sameName.length === 1 && sameName[0]?.[1] === value;
      });
    if (
      step !== undefined &&
      captured.data.request.method === step.method &&
      captured.data.request.path === step.path &&
      headersMatch &&
      (step.body === undefined || captured.data.request.body === step.body)
    )
      matched++;
    if (matched === steps.length) return true;
  }
  return false;
}

/** A Lab-held value came back in a response that no request carried. */
function returnedOnly(http: HttpRecord, secret: string): boolean {
  return (
    http.exchanges.some((entry) => entry.response.body.includes(secret)) &&
    !http.exchanges.some((entry) =>
      requestContainsSecret(entry.request, secret),
    )
  );
}

const missingHttp: Incomplete = {
  status: "incomplete",
  reason: "evidence",
  nextStep:
    "Record the route and every HTTP exchange with its response body; then repeat",
};

/** Highest first; a role gained beyond the seeded baseline counts as escalation. */
const ELEVATED_ROLES = ["administrator", "editor", "author", "contributor"];

async function readJson(
  store: PrivateArtifactStore,
  digest: string,
  name: string,
  maxBytes = 1024 * 1024,
): Promise<unknown> {
  const file = await store.readFile(digest, name, maxBytes);
  if (file.status !== "resolved") return undefined;
  try {
    return JSON.parse(file.bytes.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

type PrincipalFacts = {
  readonly canaries: WordPressCanaryLedger;
  /** Who the presented session authenticates as, if a session was presented. */
  readonly sessionLogin: string | null;
  readonly gained: readonly {
    readonly baseline: readonly string[];
    readonly roles: readonly string[];
  }[];
};
type Incomplete = Extract<JudgeObservation, { status: "incomplete" }>;
type Decision =
  | {
      readonly conditions: Readonly<Record<string, string>>;
      readonly screenshot?: Buffer;
    }
  | null
  | Incomplete;
type DecideInput = {
  readonly finding: WordPressFinding;
  readonly lab: WordPressLabHandle;
  readonly recipeDigest: string;
  readonly canaries: WordPressCanaryLedger;
  readonly httpEvidence: HttpEvidence;
};

async function readHttpEvidence(
  options: Options,
  lab: WordPressLabHandle,
  recipeDigest: string,
): Promise<HttpEvidence | Incomplete> {
  const authored = await options.store.readFile(
    recipeDigest,
    AUTHORED_HTTP_FILE,
    5 * 1024 * 1024,
  );
  const fallback = (): HttpEvidence => {
    let parsed: unknown;
    try {
      parsed =
        authored.status === "resolved"
          ? (JSON.parse(authored.bytes.toString("utf8")) as unknown)
          : undefined;
    } catch {
      parsed = undefined;
    }
    const http = httpRecordSchema.safeParse(parsed);
    return { capture: "agent-authored", http: http.success ? http.data : null };
  };
  const marker = z
    .strictObject({ marker: z.string().regex(/^\d+$/) })
    .safeParse(
      await readJson(options.store, recipeDigest, "capture-marker.json"),
    );
  if (!marker.success) return fallback();
  const capture = await options.lab.readCapture(lab, marker.data.marker);
  if (capture.status !== "captured" || capture.bytes.length === 0)
    return fallback();
  if (capture.dropped > 0)
    return {
      status: "incomplete",
      reason: "evidence",
      nextStep: "The proxy dropped HTTP records; repeat in a fresh Lab",
    };
  // The first defective line decides, as the line-by-line read did.
  const defect: CaptureDefect | undefined = capture.defects[0];
  if (defect?.kind === "unreadable")
    return {
      status: "incomplete",
      reason: "evidence",
      nextStep: "The proxy HTTP record is unreadable; repeat",
    };
  if (defect !== undefined)
    return {
      status: "incomplete",
      reason: "evidence",
      nextStep: "The proxy HTTP record is incomplete; repeat",
    };
  const http = httpRecordSchema.safeParse({ exchanges: capture.exchanges });
  if (!http.success)
    return {
      status: "incomplete",
      reason: "evidence",
      nextStep: "The proxy HTTP record has no valid exchange; repeat",
    };
  return {
    capture: "harness-captured",
    http: http.data,
    captureBytes: capture.bytes,
  };
}

const unavailable: Incomplete = {
  status: "incomplete",
  reason: "observation",
  nextStep: "The Lab could not report its state; repeat in a fresh Lab",
};

/** Reads only Lab state and the presented session; never the Verifier's narrative. */
async function observePrincipals(
  options: Options,
  { lab, recipeDigest, canaries }: DecideInput,
): Promise<PrincipalFacts | Incomplete> {
  let sessionLogin: string | null = null;
  const session = sessionSchema.safeParse(
    await readJson(options.store, recipeDigest, "session.json"),
  );
  if (session.success) {
    const observed = await options.lab.observeSessionUser(
      lab,
      session.data.cookie,
    );
    if (observed.status === "unavailable") return unavailable;
    if (observed.status === "user") sessionLogin = observed.login;
  }
  const gained: { baseline: readonly string[]; roles: string[] }[] = [];
  for (const [username, baseline] of Object.entries(canaries.roleBaseline)) {
    const current = await options.lab.observeAccountRoles(lab, username);
    if (current.status !== "roles") return unavailable;
    const roles = current.roles.filter((role) => !baseline.includes(role));
    if (roles.length > 0) gained.push({ baseline, roles });
  }
  return { canaries, sessionLogin, gained };
}

/** Binds the Verifier's structured route to this Lab and adds the judge's own record. */
async function recordEvidence(
  options: Options,
  lab: WordPressLabHandle,
  finding: WordPressFinding,
  recipeDigest: string,
  observation: Record<string, unknown>,
  httpEvidence: HttpEvidence,
  screenshot?: Buffer,
): Promise<string | null> {
  const route = routeFieldsSchema.safeParse(
    await readJson(options.store, recipeDigest, "route.json"),
  );
  const http = await options.store.readFile(
    recipeDigest,
    AUTHORED_HTTP_FILE,
    5 * 1024 * 1024,
  );
  if (!route.success || http.status !== "resolved") return null;
  const definition = routeDefinitionSchema.safeParse(route.data);
  const issuedScriptNonces = options.lab.issuedScriptNonces(lab);
  const requests =
    httpEvidence.capture === "harness-captured" &&
    httpEvidence.http !== null &&
    definition.success &&
    definition.data.role === finding.attackerPosition &&
    definition.data.role === "unauthenticated"
      ? capturedAttackRequests(httpEvidence.http, definition.data.steps)
      : null;
  const capturedRoute =
    requests === null || issuedScriptNonces === null
      ? null
      : {
          schemaVersion: 1 as const,
          scenario: lab.scenario ?? null,
          issuedScriptNonces,
          requests,
        };
  return options.store.putFiles({
    "confirmed-route.json": canonicalJson({
      ...route.data,
      // Always overwrite a Verifier-supplied field: only the Lab may bind it.
      capturedRoute,
      schemaVersion: 1,
      snapshotDigest: lab.snapshotDigest,
      labSetupDigest: lab.setupDigest,
      evidence: [
        ...(httpEvidence.capture === "harness-captured"
          ? [
              {
                kind: "http",
                path: PROXY_CAPTURE_FILE,
                capture: "harness-captured",
              },
            ]
          : [
              {
                kind: "http",
                path: AUTHORED_HTTP_FILE,
                capture: "agent-authored",
              },
            ]),
        { kind: "canary", path: "canary-observation.json" },
        ...(screenshot === undefined
          ? []
          : [{ kind: "screenshot", path: "victim-screen.png" }]),
      ],
    }),
    [AUTHORED_HTTP_FILE]: http.bytes,
    ...(httpEvidence.captureBytes === undefined
      ? {}
      : { [PROXY_CAPTURE_FILE]: httpEvidence.captureBytes }),
    "canary-observation.json": canonicalJson({
      ...observation,
      capturedRouteDigest:
        capturedRoute === null ? null : canonicalDigest(capturedRoute),
    }),
    ...(screenshot === undefined ? {} : { "victim-screen.png": screenshot }),
  });
}

/** Seeded canaries are the only ground truth; each judge decides from what it observes of them. */
function canaryJudge(
  options: Options,
  id: string,
  decide: (input: DecideInput) => Promise<Decision>,
): Judge<WordPressFinding, WordPressLabHandle> {
  return {
    id,
    async observe({ finding, lab, recipeDigest, referenceRoute }) {
      const canaries = options.lab.canaryLedger(lab);
      if (canaries === null)
        return {
          status: "incomplete",
          reason: "precondition",
          nextStep: "Seed canaries in the Lab before judging",
        };
      const httpEvidence = await readHttpEvidence(options, lab, recipeDigest);
      if ("status" in httpEvidence) return httpEvidence;
      const unattributed = await postSetupAttribution(options, {
        finding,
        lab,
        recipeDigest,
        canaries,
        httpEvidence,
      });
      if (unattributed !== null) return unattributed;
      const smokeBindingFile = await options.store.readFile(
        recipeDigest,
        "smoke-binding.json",
        8192,
      );
      let strictRoute = referenceRoute;
      if (smokeBindingFile.status === "resolved") {
        const binding = z
          .strictObject({
            recipeDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
            sourceRouteDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
            replayStatus: z.enum(["completed", "incomplete", "unavailable"]),
            completedSteps: z.number().int().nonnegative(),
            replayReason: z
              .enum([
                "invalid-input",
                "missing-binding",
                "ambiguous-binding",
                "binding-pattern",
                "request-failed",
                "response-too-large",
              ])
              .optional(),
            bound: z.boolean(),
          })
          .safeParse(
            await readJson(options.store, recipeDigest, "smoke-binding.json"),
          );
        const privateRecipe = binding.success
          ? smokeReplayRecipeSchema.safeParse(
              await readJson(
                options.store,
                binding.data.recipeDigest,
                "replay-recipe.json",
                12 * 1024 * 1024,
              ),
            )
          : null;
        const bound =
          binding?.success &&
          privateRecipe?.success &&
          referenceRoute !== undefined &&
          httpEvidence.capture === "harness-captured" &&
          httpEvidence.http !== null &&
          canonicalDigest(referenceRoute) === binding.data.sourceRouteDigest &&
          privateRecipe.data.sourceRouteDigest ===
            binding.data.sourceRouteDigest &&
          binding.data.replayStatus === "completed" &&
          binding.data.completedSteps === 8 &&
          binding.data.bound
            ? bindSmokeReferenceRoute({
                recipe: privateRecipe.data,
                sourceRoute: referenceRoute,
                capture: httpEvidence.http.exchanges,
                adminUser: canaries.adminUser,
              })
            : null;
        if (
          bound === null ||
          httpEvidence.http === null ||
          !matchesReferenceRouteSteps(httpEvidence.http, bound)
        ) {
          const evidenceDigest =
            httpEvidence.captureBytes === undefined
              ? undefined
              : await options.store.putFiles({
                  [PROXY_CAPTURE_FILE]: httpEvidence.captureBytes,
                  "route-observation.json": canonicalJson({
                    judgeId: id,
                    status: "incomplete",
                    reason: "smoke-route-mismatch",
                    snapshotDigest: lab.snapshotDigest,
                    labSetupDigest: lab.setupDigest,
                    recipeDigest,
                    completedSteps: binding.success
                      ? binding.data.completedSteps
                      : null,
                    replayReason: binding.success
                      ? (binding.data.replayReason ?? null)
                      : null,
                  }),
                });
          return {
            status: "incomplete",
            reason: "observation",
            nextStep:
              "The bounded replay did not complete the same eight captured HTTP steps",
            ...(evidenceDigest === undefined
              ? {}
              : {
                  evidenceCapture: "harness-captured" as const,
                  evidenceDigest,
                }),
          };
        }
        strictRoute = bound;
      }
      const boundReference = referenceRouteSchema.safeParse(referenceRoute);
      // Harness-bound reference routes (#127) are compared byte-for-byte. A route
      // without a bound capture counts as matched only through a verified smoke
      // binding (#126); any other unbound route stays incomplete.
      const routeMatched =
        referenceRoute === undefined ||
        (httpEvidence.capture === "harness-captured" &&
          httpEvidence.http !== null &&
          (boundReference.success
            ? matchesReferenceRoute(
                httpEvidence.http,
                await readJson(options.store, recipeDigest, "route.json"),
                referenceRoute,
                lab,
                options.lab.issuedScriptNonces(lab),
              )
            : strictRoute !== referenceRoute));
      const fixedVersion = z
        .looseObject({ comparisonKind: z.literal("fixed-version") })
        .safeParse(referenceRoute).success;
      if (fixedVersion && !routeMatched)
        return {
          status: "incomplete",
          reason: "observation",
          nextStep:
            "The captured rerun did not match the earlier confirmed HTTP route; repeat the same route",
        };
      const decision = await decide({
        finding,
        lab,
        recipeDigest,
        canaries,
        httpEvidence,
      });
      if (decision === null) {
        if (!routeMatched) {
          const evidenceDigest =
            httpEvidence.captureBytes === undefined
              ? undefined
              : await options.store.putFiles({
                  [PROXY_CAPTURE_FILE]: httpEvidence.captureBytes,
                  "route-observation.json": canonicalJson({
                    judgeId: id,
                    status: "incomplete",
                    reason: "route-mismatch",
                    snapshotDigest: lab.snapshotDigest,
                    labSetupDigest: lab.setupDigest,
                  }),
                });
          return {
            status: "incomplete",
            reason: "observation",
            nextStep:
              "The captured rerun did not match the earlier confirmed HTTP route; repeat the same route",
            ...(evidenceDigest === undefined
              ? {}
              : {
                  evidenceCapture: "harness-captured" as const,
                  evidenceDigest,
                }),
          };
        }
        if (
          httpEvidence.capture !== "harness-captured" ||
          httpEvidence.captureBytes === undefined
        )
          return { status: "not-observed" };
        // A matching captured route cannot show that the application accepted it.
        const processingUnproven = boundReference.success;
        const evidenceDigest = await options.store.putFiles({
          [PROXY_CAPTURE_FILE]: httpEvidence.captureBytes,
          "canary-observation.json": canonicalJson({
            judgeId: id,
            status: processingUnproven ? "incomplete" : "not-observed",
            ...(processingUnproven
              ? {
                  canaryObserved: false,
                  processingWitness: "unavailable",
                }
              : {}),
            snapshotDigest: lab.snapshotDigest,
            labSetupDigest: lab.setupDigest,
            ...(boundReference.success && httpEvidence.http !== null
              ? {
                  referenceResponseStatuses:
                    boundReference.data.capturedRoute.requests.map(
                      (request) => request.statusCode,
                    ),
                  capturedResponseStatuses: httpEvidence.http.exchanges.map(
                    (exchange) =>
                      capturedExchangeSchema.parse(exchange).response
                        .statusCode,
                  ),
                }
              : {}),
          }),
        });
        if (processingUnproven)
          return {
            status: "incomplete",
            reason: "observation",
            nextStep:
              "The fixed route returned no canary, but the Lab has no independent witness that the application processed it; verify processing before treating this as a negative control",
            evidenceDigest,
          };
        return {
          status: "not-observed",
          evidenceCapture: "harness-captured",
          evidenceDigest,
        };
      }
      if ("status" in decision) return decision;
      const { conditions } = decision;
      const evidenceDigest = await recordEvidence(
        options,
        lab,
        finding,
        recipeDigest,
        {
          judgeId: id,
          ...conditions,
        },
        httpEvidence,
        decision.screenshot,
      );
      if (evidenceDigest === null)
        return {
          status: "incomplete",
          reason: "evidence",
          nextStep:
            "The canary state was observed but the route or HTTP record is missing; repeat with a recorded route",
        };
      return {
        status: "observed",
        evidenceDigest,
        conditions,
        evidenceCapture: httpEvidence.capture,
      };
    },
  };
}

/** Only a captured response to an actual low-privilege HTTP request can prove disclosure. */
function sensitiveObjectJudge(options: Options) {
  return canaryJudge(
    options,
    "wordpress-sensitive-object-canary",
    async ({ lab, recipeDigest, canaries, httpEvidence }) => {
      if (canaries.sensitiveCanaries.length === 0)
        return {
          status: "incomplete",
          reason: "precondition",
          nextStep: "Provision protected objects in a verification Lab",
        };
      if (
        httpEvidence.capture !== "harness-captured" ||
        httpEvidence.http === null
      )
        return missingHttp;
      const route = await routeConditions(options.store, recipeDigest);
      if (route === null) return missingRoute;
      for (const canary of canaries.sensitiveCanaries) {
        if (!returnedOnly(httpEvidence.http, canary.value)) continue;
        for (const exchange of httpEvidence.http.exchanges) {
          if (!exchange.response.body.includes(canary.value)) continue;
          const captured = capturedExchangeSchema.safeParse(exchange);
          if (!captured.success) return missingHttp;
          const headers = Object.fromEntries(
            Object.entries(captured.data.request.headers).map(
              ([name, value]) => [name.toLowerCase(), value],
            ),
          );
          if (
            Object.keys(headers).some((name) =>
              /authorization|api.?key|token|nonce/.test(name),
            )
          )
            return {
              status: "incomplete",
              reason: "evidence",
              nextStep: "Repeat without an unverified authentication header",
            };
          const cookie = headers.cookie;
          if (cookie !== undefined && typeof cookie !== "string")
            return missingHttp;
          let attackerRole = "unauthenticated";
          if (typeof cookie === "string") {
            const logins: string[] = [];
            for (const part of cookie.split(";").map((value) => value.trim())) {
              if (
                /^wordpress_test_cookie=/.test(part) ||
                /^wp-settings-\d+=/.test(part)
              )
                continue;
              const match =
                /^(wordpress_logged_in_|wordpress_sec_|wordpress_[a-f0-9]+)([^=]*)=([A-Za-z0-9%|._@+-]+)$/.exec(
                  part,
                );
              if (match === null) return missingHttp;
              const scheme =
                match[1] === "wordpress_logged_in_"
                  ? "logged_in"
                  : match[1] === "wordpress_sec_"
                    ? "secure_auth"
                    : "auth";
              const session = await options.lab.observeSessionUser(
                lab,
                match[3]!,
                scheme,
              );
              if (session.status === "unavailable") return unavailable;
              if (session.status === "user") logins.push(session.login);
            }
            const subscriber = lab.attackerAccounts.subscriber.username;
            const customer = lab.attackerAccounts.customer?.username;
            if (
              logins.length > 0 &&
              logins.every((login) => login === subscriber)
            )
              attackerRole = "subscriber";
            else if (
              customer !== undefined &&
              logins.length > 0 &&
              logins.every((login) => login === customer)
            )
              attackerRole = "customer";
            else if (logins.length > 0) continue;
          }
          return {
            conditions: {
              ...route,
              observedVia: "sensitive-canary-access",
              objectKind: canary.kind,
              attackerRole,
            },
          };
        }
      }
      return null;
    },
  );
}

function principalJudge(
  options: Options,
  id: string,
  decide: (facts: PrincipalFacts) => Record<string, string> | null,
) {
  return canaryJudge(options, id, async (input) => {
    const route = await routeConditions(options.store, input.recipeDigest);
    if (route === null) return missingRoute;
    const facts = await observePrincipals(options, input);
    if ("status" in facts) return facts;
    const conditions = decide(facts);
    return conditions === null
      ? null
      : { conditions: { ...conditions, ...route } };
  });
}

function highestGained(
  facts: PrincipalFacts,
  admitted: readonly string[],
): { role: string; baseline: readonly string[] } | null {
  for (const role of admitted)
    for (const account of facts.gained)
      if (account.roles.includes(role))
        return { role, baseline: account.baseline };
  return null;
}

/** Administrator: the session is the administrator canary, or an attacker account became administrator. */
function administratorJudge(options: Options) {
  return principalJudge(
    options,
    "wordpress-administrator-principal",
    (facts) => {
      if (facts.sessionLogin === facts.canaries.adminUser)
        return { reachedRole: "administrator", observedVia: "session" };
      const gained = highestGained(facts, ["administrator"]);
      return gained === null
        ? null
        : {
            reachedRole: "administrator",
            observedVia: "role-change",
            attackerBaselineRoles: gained.baseline.join(","),
          };
    },
  );
}

/** Non-administrator: another principal's session, or contributor-level roles gained. */
function nonAdministratorJudge(options: Options) {
  return principalJudge(
    options,
    "wordpress-non-administrator-principal",
    (facts) => {
      if (facts.sessionLogin === facts.canaries.adminUser)
        return { reachedRole: "administrator", observedVia: "session" };
      if (facts.sessionLogin === facts.canaries.user)
        return { reachedRole: "subscriber", observedVia: "session" };
      const gained = highestGained(facts, ELEVATED_ROLES);
      return gained === null
        ? null
        : {
            reachedRole: gained.role,
            observedVia: "role-change",
            attackerBaselineRoles: gained.baseline.join(","),
          };
    },
  );
}

/**
 * SQL: the seeded row changed, or its value (held nowhere else) came back in a
 * response that no request carried. Timing differences never count.
 */
function sqlCanaryJudge(options: Options) {
  return canaryJudge(
    options,
    "wordpress-sql-canary",
    async ({ lab, recipeDigest, canaries, httpEvidence }) => {
      const route = await routeConditions(options.store, recipeDigest);
      if (route === null || httpEvidence.http === null) return missingHttp;
      const table = await options.lab.observeCanaryTable(lab);
      if (table.status === "unavailable") return unavailable;
      const read = returnedOnly(httpEvidence.http, canaries.sqlCanary.value);
      if (table.status !== "changed" && !read) return null;
      return {
        conditions: {
          observedVia:
            table.status === "changed"
              ? "canary-table-write"
              : "canary-row-read",
          ...route,
          // The Lab never touches wp_magic_quotes.
          magicQuotes: "wordpress-default",
        },
      };
    },
  );
}

/** The route's attacker role and settings, as recorded by the Verifier. */
async function routeConditions(
  store: PrivateArtifactStore,
  recipeDigest: string,
): Promise<Readonly<Record<string, string>> | null> {
  const route = routeConditionsSchema.safeParse(
    await readJson(store, recipeDigest, "route.json"),
  );
  return route.success
    ? {
        attackerRole: route.data.role,
        defaultSettings: String(route.data.defaultSettings),
      }
    : null;
}

const missingRoute: Incomplete = {
  status: "incomplete",
  reason: "evidence",
  nextStep: "Record the route with its role and settings; then repeat",
};

/**
 * RCE / PHP file write: only an issued Execution Canary that ran inside the Lab
 * counts. Stored-but-inert code (`.php.png`, SVG, safe extensions) leaves no marker.
 */
function executionCanaryJudge(options: Options) {
  return canaryJudge(
    options,
    "wordpress-execution-canary",
    async ({ lab, recipeDigest }) => {
      const route = await routeConditions(options.store, recipeDigest);
      if (route === null) return missingRoute;
      const execution = await options.lab.observeExecution(lab);
      switch (execution.status) {
        case "unavailable":
          return unavailable;
        case "not-prepared":
          return {
            status: "incomplete",
            reason: "precondition",
            nextStep:
              "Issue an Execution Canary from this Lab and place it through the route; then repeat",
          };
        case "not-executed":
          return null;
        case "executed":
          return {
            conditions: {
              observedVia: "execution-canary",
              canaryFiles:
                execution.files.length === 0
                  ? "none-on-disk"
                  : execution.files.join(","),
              ...route,
            },
          };
      }
    },
  );
}

/** Both canary files sit in different directories with different extensions. */
function fileControl(reached: readonly string[]): Record<string, string> {
  return {
    pathAndExtension:
      new Set(reached).size >= 2 ? "attacker-chosen" : "partial",
  };
}

/** File read / download / LFI: a canary file's value came back in a response. */
function fileReadJudge(options: Options) {
  return canaryJudge(
    options,
    "wordpress-file-canary-read",
    async ({ recipeDigest, canaries, httpEvidence }) => {
      const route = await routeConditions(options.store, recipeDigest);
      const http = httpEvidence.http;
      if (route === null || http === null) return missingHttp;
      const read = canaries.fileCanaries
        .filter((file) => returnedOnly(http, file.value))
        .map((file) => file.kind);
      if (read.length === 0) return null;
      return {
        conditions: {
          observedVia: "canary-file-read",
          canaryFilesRead: read.join(","),
          ...fileControl(read),
          ...route,
        },
      };
    },
  );
}

/** File delete: a seeded canary file no longer exists inside the Lab. */
function fileDeleteJudge(options: Options) {
  return canaryJudge(
    options,
    "wordpress-file-canary-delete",
    async ({ lab, recipeDigest }) => {
      const route = await routeConditions(options.store, recipeDigest);
      if (route === null) return missingRoute;
      const files = await options.lab.observeCanaryFiles(lab);
      if (files.status === "unavailable") return unavailable;
      if (files.deleted.length === 0) return null;
      return {
        conditions: {
          observedVia: "canary-file-deleted",
          canaryFilesDeleted: files.deleted.join(","),
          ...fileControl(files.deleted),
          ...route,
        },
      };
    },
  );
}

/** Options update: the seeded canary option or a critical option moved from its baseline. */
function optionJudge(options: Options) {
  return canaryJudge(
    options,
    "wordpress-option-canary",
    async ({ lab, recipeDigest, canaries }) => {
      const route = await routeConditions(options.store, recipeDigest);
      if (route === null) return missingRoute;
      const watched = await options.lab.observeOptions(lab);
      if (watched.status === "unavailable") return unavailable;
      if (watched.changed.length === 0) return null;
      return {
        conditions: {
          observedVia: "option-change",
          changedOptions: watched.changed.join(","),
          optionClass: watched.changed.every((name) => name === canaries.option)
            ? "canary"
            : "critical",
          ...route,
        },
      };
    },
  );
}

const browserStepsSchema = z.looseObject({
  victim: wordpressVictimRouteSchema.optional(),
  steps: z
    .array(z.looseObject({ kind: z.string(), path: z.string().optional() }))
    .max(30),
});

/**
 * Who authenticated one captured request: only the Lab attacker account, or a
 * login in `reached` (a principal the attack itself obtained). Any other
 * session, a stale one included, and any header the Lab cannot resolve to a
 * principal are defects.
 */
async function requestPrincipal(
  options: Options,
  finding: WordPressFinding,
  lab: WordPressLabHandle,
  request: NonNullable<ReturnType<typeof capturedRequest>>,
  reached: readonly string[],
): Promise<{ readonly defect: string } | { readonly authenticated: boolean }> {
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(request.headers)) {
    const key = name.toLowerCase();
    if (headers.has(key) || typeof value !== "string")
      return {
        defect: "The captured HTTP authentication headers are ambiguous",
      };
    headers.set(key, value);
    if (
      (key.startsWith("x-") &&
        key !== "x-requested-with" &&
        key !== "x-wp-nonce") ||
      (/(?:auth|sess|token|jwt|api.?key|credential|nonce)/i.test(key) &&
        key !== "x-wp-nonce")
    )
      return {
        defect:
          "The captured HTTP request has an unsupported authentication header",
      };
  }
  const attacker =
    finding.attackerPosition === "unauthenticated"
      ? null
      : lab.attackerAccounts[finding.attackerPosition];
  if (attacker === null && headers.has("x-wp-nonce"))
    return {
      defect: "The unauthenticated attack used an authentication nonce header",
    };

  const cookieHeader = headers.get("cookie") ?? "";
  const cookies: { name: string; value: string }[] = [];
  const seenCookies = new Set<string>();
  for (const field of cookieHeader === "" ? [] : cookieHeader.split(";")) {
    const separator = field.indexOf("=");
    const name = field.slice(0, separator).trim();
    const value = field.slice(separator + 1).trim();
    if (
      separator <= 0 ||
      !/^[A-Za-z0-9_-]+$/.test(name) ||
      value === "" ||
      seenCookies.has(name)
    )
      return { defect: "The captured HTTP cookie header is ambiguous" };
    seenCookies.add(name);
    cookies.push({ name, value });
  }
  const authenticationCookies: {
    value: string;
    scheme: "logged_in" | "auth" | "secure_auth";
  }[] = [];
  for (const cookie of cookies) {
    const scheme = /^wordpress_logged_in_[A-Za-z0-9_-]+$/.test(cookie.name)
      ? "logged_in"
      : /^wordpress_sec_[A-Za-z0-9_-]+$/.test(cookie.name)
        ? "secure_auth"
        : /^wordpress_[A-Za-z0-9_-]+$/.test(cookie.name) &&
            cookie.name !== "wordpress_test_cookie"
          ? "auth"
          : null;
    if (scheme !== null) {
      authenticationCookies.push({ value: cookie.value, scheme });
    } else if (
      (cookie.name.startsWith("wordpress_") &&
        cookie.name !== "wordpress_test_cookie") ||
      unknownAuthenticationCookie.test(cookie.name)
    ) {
      return {
        defect:
          "The captured HTTP request has an unsupported authentication cookie",
      };
    }
  }
  if (
    attacker === null &&
    reached.length === 0 &&
    authenticationCookies.length > 0
  )
    return {
      defect: "A post-setup request used a logged-in WordPress session",
    };
  for (const cookie of authenticationCookies) {
    const actor = await options.lab.observeSessionUser(
      lab,
      cookie.value,
      cookie.scheme,
    );
    if (
      actor.status !== "user" ||
      (actor.login !== attacker?.username && !reached.includes(actor.login))
    )
      return {
        defect: "A post-setup request session differs from the Lab attacker",
      };
  }
  return { authenticated: authenticationCookies.length > 0 };
}

/**
 * After handoff setup (#430, ADR 0035) the capture starts at `setup-done`. It
 * must be the Harness's own; each request in it may authenticate only as the
 * Lab attacker or a canary principal the attack reached; and the attacker
 * account's role baseline must be exactly its declared role. Otherwise no
 * judge may confirm.
 */
async function postSetupAttribution(
  options: Options,
  { finding, lab, recipeDigest, canaries, httpEvidence }: DecideInput,
): Promise<Incomplete | null> {
  const boundary = await options.store.readFile(
    recipeDigest,
    SETUP_BOUNDARY_FILE,
    4096,
  );
  if (boundary.status === "missing") return null;
  const missing = (nextStep: string): Incomplete => ({
    status: "incomplete",
    reason: "evidence",
    nextStep,
  });
  if (httpEvidence.capture !== "harness-captured" || httpEvidence.http === null)
    return missing(
      "The post-setup HTTP capture is unavailable; repeat in a fresh Lab",
    );
  if (finding.attackerPosition !== "unauthenticated") {
    const account = lab.attackerAccounts[finding.attackerPosition];
    const baseline =
      account === undefined
        ? undefined
        : canaries.roleBaseline[account.username];
    if (baseline?.length !== 1 || baseline[0] !== finding.attackerPosition)
      return missing(
        "The Lab attacker account's role baseline is not its declared role; repeat in a fresh Lab",
      );
  }
  for (const exchange of httpEvidence.http.exchanges) {
    const request = capturedRequest(exchange);
    if (request === null)
      return missing("A captured post-setup HTTP request is incomplete");
    const principal = await requestPrincipal(options, finding, lab, request, [
      canaries.adminUser,
      canaries.user,
    ]);
    if ("defect" in principal) return missing(principal.defect);
  }
  return null;
}

/** A script receipt is attributable only to a captured, correctly positioned attack. */
async function capturedScriptAttack(
  options: Options,
  input: DecideInput,
): Promise<Incomplete | { readonly attackerRole: string }> {
  const { finding, lab, recipeDigest, canaries, httpEvidence } = input;
  const missing = (nextStep: string): Incomplete => ({
    status: "incomplete",
    reason: "evidence",
    nextStep,
  });
  if (httpEvidence.capture !== "harness-captured" || httpEvidence.http === null)
    return missing(
      "The attacker HTTP capture is unavailable; repeat in a fresh Lab",
    );
  const nonces = options.lab.issuedScriptNonces(lab);
  if (nonces === null || nonces.length === 0)
    return missing(
      "The issued script canary cannot be bound to the attack capture",
    );
  const route = routeDefinitionSchema.safeParse(
    await readJson(options.store, recipeDigest, "route.json"),
  );
  if (!route.success || route.data.role !== finding.attackerPosition)
    return missing(
      "The captured attack route does not match the Finding's attacker position",
    );
  const expectedAccount =
    finding.attackerPosition === "unauthenticated"
      ? null
      : lab.attackerAccounts[finding.attackerPosition];
  if (
    (expectedAccount === null && route.data.account !== "none") ||
    (expectedAccount !== null &&
      route.data.account !== expectedAccount?.username)
  )
    return missing(
      "The captured attack account differs from the Lab attacker account",
    );
  const steps = route.data.steps.filter((step) => step.kind === "http");
  if (steps.length === 0)
    return missing("The captured attack has no declared HTTP step");
  let bearingRequests = 0;
  for (const exchange of httpEvidence.http.exchanges) {
    const request = capturedRequest(exchange);
    if (request === null)
      return missing("The captured attacker HTTP request is incomplete");
    const bearsCanary = nonces.some((nonce) =>
      requestContainsSecret(request, nonce),
    );
    if (bearsCanary) {
      bearingRequests++;
      const parsed = capturedExchangeSchema.safeParse(exchange);
      if (
        !parsed.success ||
        !completedCanaryResponse(
          parsed.data.response.statusCode,
          parsed.data.response.body,
          parsed.data.response.headers,
          request.headers,
        ) ||
        !steps.some(
          (step) =>
            step.method === request.method &&
            step.path === request.path &&
            request.body === (step.body ?? "") &&
            Object.entries(step.headers ?? {}).every(
              ([name, value]) => headerValue(request.headers, name) === value,
            ),
        )
      )
        return missing(
          "A canary-bearing HTTP request does not match a completed attacker route step",
        );
    }

    // The capture begins after setup-done and ends before the Lab browser
    // visits any victim page. A canary-free administrator request in this
    // interval could have planted the script that the browser later sees.
    const principal = await requestPrincipal(
      options,
      finding,
      lab,
      request,
      [],
    );
    if ("defect" in principal) return missing(principal.defect);
    if (
      finding.attackerPosition !== "unauthenticated" &&
      bearsCanary &&
      !principal.authenticated
    )
      return missing(
        "The canary-bearing request has no verifiable attacker session",
      );
  }
  if (bearingRequests === 0)
    return missing(
      "No captured attacker HTTP request carried the issued script canary",
    );
  if (expectedAccount !== null && expectedAccount !== undefined) {
    const baseline = canaries.roleBaseline[expectedAccount.username];
    const roles = await options.lab.observeAccountRoles(
      lab,
      expectedAccount.username,
    );
    if (
      baseline?.length !== 1 ||
      baseline[0] !== finding.attackerPosition ||
      roles.status !== "roles" ||
      roles.roles.length !== 1 ||
      roles.roles[0] !== finding.attackerPosition
    )
      return missing(
        "The Lab attacker account no longer has only its declared low privilege role",
      );
  }
  return { attackerRole: finding.attackerPosition };
}

/**
 * Stored XSS: an issued script canary reached the Lab receiver while the Lab's
 * own browser opened an affected page. Scope decides whether the observed
 * context qualifies for each programme. Alerts and strings never count.
 */
function storedScriptJudge(options: Options) {
  return canaryJudge(
    options,
    "wordpress-stored-script",
    async ({ finding, lab, recipeDigest, canaries, httpEvidence }) => {
      const route = await routeConditions(options.store, recipeDigest);
      const steps = browserStepsSchema.safeParse(
        await readJson(options.store, recipeDigest, "route.json"),
      );
      if (route === null || !steps.success) return missingRoute;
      const routePaths = steps.data.steps
        .filter((step) => step.kind === "browser" && step.path !== undefined)
        .map((step) => step.path!)
        .slice(0, 5);
      const victim = steps.data.victim;
      if (
        victim?.role === "customer" &&
        lab.attackerAccounts.customer === undefined
      )
        return {
          status: "incomplete",
          reason: "precondition",
          nextStep:
            "Provision a Lab scenario with the declared victim role and repeat",
        };
      const script = await options.lab.observeStoredScript(lab, {
        routePaths,
        ...(victim === undefined ? {} : { victim }),
      });
      switch (script.status) {
        case "unavailable": {
          const evidenceDigest =
            script.privateDiagnostic === undefined
              ? undefined
              : await options.store.putFiles({
                  "observer-diagnostic.json": canonicalJson({
                    judgeId: "wordpress-stored-script",
                    status: "unavailable",
                    phase: script.phase ?? "unknown",
                    failureCode: script.failureCode ?? "browser-visit",
                    snapshotDigest: lab.snapshotDigest,
                    labSetupDigest: lab.setupDigest,
                  }),
                  "browser-stderr.txt": script.privateDiagnostic,
                });
          const incomplete: Incomplete =
            script.phase === undefined
              ? unavailable
              : {
                  status: "incomplete",
                  reason: "observation",
                  nextStep:
                    script.phase === "victim-page"
                      ? `Stored-script observation failed at victim-page${script.failureCode === undefined ? "" : ` (${script.failureCode})`}; inspect the saved victim route/actions in Private Evidence and repeat`
                      : `Stored-script observation failed at ${script.phase}${script.failureCode === undefined ? "" : ` (${script.failureCode})`}; inspect the Lab observer and repeat`,
                };
          return evidenceDigest === undefined
            ? incomplete
            : { ...incomplete, evidenceDigest };
        }
        case "not-prepared":
          return {
            status: "incomplete",
            reason: "precondition",
            nextStep:
              "Issue a script canary from this Lab and store it through the route; then repeat",
          };
        case "observed":
          break;
      }
      const independentContexts = script.contexts.filter(
        (context) => context !== "victim-route-page",
      );
      const victimContextVerified =
        script.contexts.includes("victim-route-page") &&
        script.victimRole !== undefined &&
        script.victimRole !== "self";
      const qualifyingContexts = [
        ...independentContexts,
        ...(victimContextVerified ? (["victim-route-page"] as const) : []),
      ];
      if (qualifyingContexts.length === 0) {
        if (script.victimRole === "self") {
          const evidenceDigest = await options.store.putFiles({
            "canary-observation.json": canonicalJson({
              judgeId: "wordpress-stored-script",
              status: "self-observed",
              victimRole: "self",
              contexts: script.contexts,
              snapshotDigest: lab.snapshotDigest,
              labSetupDigest: lab.setupDigest,
            }),
          });
          return {
            status: "incomplete",
            reason: "precondition",
            nextStep:
              "victimRole: self; repeat with a separate Lab victim account",
            evidenceDigest,
          };
        }
        if (script.contexts.includes("victim-route-page"))
          return {
            status: "incomplete",
            reason: "evidence",
            nextStep:
              "Record the Lab browser principal for the victim page and repeat",
          };
        if (victim !== undefined && script.screenshot !== undefined) {
          const evidenceDigest = await options.store.putFiles({
            "canary-observation.json": canonicalJson({
              judgeId: "wordpress-stored-script",
              status: "victim-visited-without-beacon",
              phase: "victim-page",
              victimRole: victim.role,
              completedVictimVisits: victim.paths.length,
              screenshotVisit: victim.paths.length,
              snapshotDigest: lab.snapshotDigest,
              labSetupDigest: lab.setupDigest,
            }),
            "victim-screen-diagnostic.png": script.screenshot,
            ...(script.victimBrowserDiagnostic === undefined
              ? {}
              : {
                  "victim-browser-diagnostic.json": canonicalJson(
                    script.victimBrowserDiagnostic,
                  ),
                }),
          });
          return {
            status: "incomplete",
            reason: "observation",
            nextStep:
              "The Lab browser visited the declared victim page without a canary receipt; inspect the diagnostic screenshot, browser counts, and route in Private Evidence, then repeat",
            evidenceDigest,
          };
        }
        return null;
      }
      if (script.screenshot === undefined)
        return {
          status: "incomplete",
          reason: "evidence",
          nextStep:
            "Capture the victim page screenshot with the Lab observer and repeat",
        };
      const attack = await capturedScriptAttack(options, {
        finding,
        lab,
        recipeDigest,
        canaries,
        httpEvidence,
      });
      if ("status" in attack) return attack;
      const siteWide = qualifyingContexts.some(
        (context) => context === "front" || context === "admin-all",
      );
      return {
        screenshot: script.screenshot,
        conditions: {
          observedVia: "canary-beacon",
          firedContexts: qualifyingContexts.join(","),
          siteWide: siteWide ? "yes" : "no",
          ...(!victimContextVerified
            ? {}
            : { victimRole: script.victimRole, victimPrincipal: "separate" }),
          ...route,
          attackerRole: attack.attackerRole,
        },
      };
    },
  );
}

/** Judges built so far; other impacts stay incomplete(no-judge). */
export function createWordPressJudges(
  options: Options,
): JudgeSet<WordPressFinding, WordPressLabHandle> {
  const administrator = administratorJudge(options);
  const nonAdministrator = nonAdministratorJudge(options);
  const sql = sqlCanaryJudge(options);
  const execution = executionCanaryJudge(options);
  const fileRead = fileReadJudge(options);
  const fileDelete = fileDeleteJudge(options);
  const option = optionJudge(options);
  const storedScript = storedScriptJudge(options);
  const sensitiveObject = sensitiveObjectJudge(options);
  return {
    ...(options.lab.markCapture === undefined ||
    options.lab.runStandardScript === undefined
      ? {}
      : {
          reproducer: createWordPressStandardReproducer({
            store: options.store,
            lab: {
              canaryLedger: options.lab.canaryLedger,
              readCapture: options.lab.readCapture,
              markCapture: options.lab.markCapture,
              runStandardScript: options.lab.runStandardScript,
            },
          }),
        }),
    for(finding) {
      switch (finding.impact) {
        case "privesc-to-admin":
        case "auth-bypass-to-admin":
        case "account-takeover":
          return administrator;
        case "privesc-to-contributor+":
        case "auth-bypass-non-admin":
          return nonAdministrator;
        case "sqli":
          return sql;
        case "rce":
        case "php-file-write":
          return execution;
        case "arbitrary-file-read":
        case "arbitrary-file-download":
        case "lfi":
          return fileRead;
        case "arbitrary-file-delete":
          return fileDelete;
        case "options-update":
          return option;
        case "stored-xss":
          return storedScript;
        case "sensitive-object-access":
          return sensitiveObject;
        default:
          return null;
      }
    },
  };
}
