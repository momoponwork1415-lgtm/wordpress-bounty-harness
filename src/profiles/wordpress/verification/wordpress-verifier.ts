import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "../../../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import type { Ledger } from "../../../ledger/index.js";
import {
  recordVerifierRun,
  VerifierTransportIncompleteError,
  type RecordedFinding,
  type Verifier,
  type VerifierAttempt,
  type VerifierRunReceipt,
} from "../../../verification/index.js";
import type { WordPressFinding } from "../discovery/finding.js";
import {
  wordpressVictimRouteSchema,
  type WordPressLab,
  type WordPressLabHandle,
} from "../lab/index.js";
import { nextWordPressScenario } from "../lab/scenarios.js";
import {
  classifyWordPressPrecondition,
  type ClassifiedPrecondition,
} from "./precondition-class.js";
import { wordpressReproductionStepSchema } from "./reproduction-package.js";

/** The canary a Finding's impact needs, issued fresh for one attempt; only the Lab observes it. */
export type WordPressVerifierCanary =
  | { readonly kind: "execution"; readonly php: string }
  | {
      readonly kind: "script";
      readonly beaconUrl: string;
      readonly javascript: string;
      readonly loaderJavascript: string;
    }
  | { readonly kind: "principal"; readonly username: string }
  | { readonly kind: "sql"; readonly table: string };

export type WordPressLowPrivilegeAccounts = Readonly<{
  subscriber: Readonly<{ username: string; password: string }>;
  customer?: Readonly<{ username: string; password: string }>;
}>;

/**
 * The Lab as a Verifier transport may see it: named fields only, low-privilege
 * accounts only, and the database only when the impact allows it.
 */
export type WordPressVerifierLab = Readonly<{
  id: string;
  snapshotDigest: string;
  setupDigest: string;
  endpoint: string;
  networkName: string;
  internalIp: string;
  recorderIp: string;
  scenario?: WordPressLabHandle["scenario"];
  secondaryLocale?: string;
  database?: WordPressLabHandle["database"];
  attackerAccounts: WordPressLowPrivilegeAccounts;
}>;

/** The judge-owned earlier route, already validated, for a version comparison. */
export type WordPressVerifierReferenceRoute = Readonly<{
  role: "unauthenticated" | "subscriber" | "customer";
  defaultSettings: boolean;
  steps: readonly z.infer<typeof wordpressReproductionStepSchema>[];
  victim?: z.infer<typeof wordpressVictimRouteSchema>;
}>;

/** One Verifier run as a transport receives it. */
export type WordPressVerifierRun = Readonly<{
  runId: string;
  finding: WordPressFinding;
  lab: WordPressVerifierLab;
  canary?: WordPressVerifierCanary;
  referenceRoute?: WordPressVerifierReferenceRoute;
  /**
   * Restarts the Harness-owned HTTP capture and Lab state baseline from now.
   * A transport whose precondition setup precedes the attacker steps calls it
   * once setup is done; the Codex transport never does.
   */
  restartObservation: () => Promise<void>;
}>;

export const WORDPRESS_VERIFIER_FILE_NAMES = [
  "http.json",
  "steps.md",
  "route.json",
  "session.json",
  "refutation.md",
  "precondition",
] as const;
export type WordPressVerifierFileName =
  (typeof WORDPRESS_VERIFIER_FILE_NAMES)[number];
/** The files a transport hands back verbatim; absent files are absent, never null. */
export type WordPressVerifierFiles = Readonly<
  Partial<Record<WordPressVerifierFileName, string>>
>;

export type WordPressVerifierTransportResult = Readonly<{
  /** Digest of the fixed instructions this run received. */
  promptDigest: string;
  /** Recorded as `verifier-run-finished` before any file is read. */
  receipt: VerifierRunReceipt;
  outcome:
    | { readonly status: "files"; readonly files: WordPressVerifierFiles }
    | {
        readonly status: "transport-failed";
        readonly reason: "provider" | "sandbox";
      }
    | {
        readonly status: "incomplete";
        readonly nextStep: string;
        /** Optional unmet setup detail, retained in Private Evidence only. */
        readonly precondition?: string;
      };
}>;

const HANDOFF_ABORT_CODES = new Set([
  "precondition-unavailable",
  "route-unavailable",
  "observer-unavailable",
  "handoff-interrupted",
  "unspecified",
]);
const HANDOFF_RECEIPT_CODES = new Set([
  "directory-in-use",
  "stale-directory",
  "administrator",
  "attacker-account",
  "exposure",
  "abort",
  "timeout",
]);

/** Whitelist transport control codes; never copy an agent or Lab diagnostic into the result. */
function handoffIncompleteCode(
  nextStep: string,
  receipt: VerifierRunReceipt,
): string {
  const abortCode = nextStep.startsWith("handoff:")
    ? nextStep.slice("handoff:".length)
    : "";
  if (HANDOFF_ABORT_CODES.has(abortCode)) return `abort-${abortCode}`;
  const receiptReason = "reason" in receipt ? receipt.reason : undefined;
  return typeof receiptReason === "string" &&
    HANDOFF_RECEIPT_CODES.has(receiptReason)
    ? receiptReason
    : "handoff-incomplete";
}

function unmetPreconditionCode(classification: ClassifiedPrecondition): string {
  switch (classification.preconditionClass) {
    case "admin-configuration":
      return "admin-configuration-precondition";
    case "common-usage":
      return "common-usage-precondition";
    case "default":
      return "unmet-default-precondition";
    case "unknown":
      return "unclassified-precondition";
  }
}

/**
 * Runs one Verifier against the Lab it is given and returns the agent's files.
 * It never reads the Finding record, issues canaries, classifies preconditions
 * or writes the ledger; `WordPressVerifier` does that for every transport.
 */
export interface WordPressVerifierTransport {
  /** The transport can prepare ordinary Lab state before attacker observation starts. */
  readonly preconditionSetup?: "transport";
  run(input: WordPressVerifierRun): Promise<WordPressVerifierTransportResult>;
}

const httpSchema = z.looseObject({
  exchanges: z
    .array(
      z.looseObject({
        request: z.unknown(),
        response: z.looseObject({ body: z.string() }),
      }),
    )
    .min(1)
    .max(500),
});
/** The same cookie shape the Lab accepts when it resolves a session. */
const sessionSchema = z.strictObject({
  cookie: z.string().regex(/^[A-Za-z0-9%|._@+-]{1,4096}$/),
});
const routeSchema = z.looseObject({
  role: z.enum(["unauthenticated", "subscriber", "customer"]),
  defaultSettings: z.boolean(),
  steps: z.unknown().optional(),
  victim: wordpressVictimRouteSchema.optional(),
});
const referenceRouteSchema = z.looseObject({
  role: z.enum(["unauthenticated", "subscriber", "customer"]),
  defaultSettings: z.boolean(),
  steps: z.array(wordpressReproductionStepSchema).min(1).max(30),
  victim: wordpressVictimRouteSchema.optional(),
});
const recordedRequestSchema = z.looseObject({
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
  url: z.string().min(1).max(4096).optional(),
  path: z.string().min(1).max(4096).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
});

function routeStepsFromHttp(
  http: z.infer<typeof httpSchema>,
  labEndpoint: string,
): z.infer<typeof wordpressReproductionStepSchema>[] | null {
  if (http.exchanges.length > 30) return null;
  const origin = new URL(labEndpoint).origin;
  const steps: z.infer<typeof wordpressReproductionStepSchema>[] = [];
  for (const exchange of http.exchanges) {
    const request = recordedRequestSchema.safeParse(exchange.request);
    if (!request.success) return null;
    const address = request.data.url ?? request.data.path;
    if (address === undefined) return null;
    let url: URL;
    try {
      url = new URL(address, labEndpoint);
    } catch {
      return null;
    }
    if (url.origin !== origin) return null;
    const step = wordpressReproductionStepSchema.safeParse({
      kind: "http",
      method: request.data.method,
      path: `${url.pathname}${url.search}`,
      ...(request.data.headers === undefined
        ? {}
        : { headers: request.data.headers }),
      ...(request.data.body === undefined ? {} : { body: request.data.body }),
      expected: "Observe the response recorded in http.json",
    });
    if (!step.success) return null;
    steps.push(step.data);
  }
  return steps;
}

/** A reported login cookie is only a candidate; the Lab validates its owner. */
function sessionFromHttp(http: z.infer<typeof httpSchema>): string | undefined {
  for (const exchange of http.exchanges) {
    const response = exchange.response as Record<string, unknown>;
    const headers = response.headers;
    if (headers === null || typeof headers !== "object") continue;
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() !== "set-cookie") continue;
      for (const line of typeof value === "string"
        ? [value]
        : Array.isArray(value)
          ? value
          : []) {
        if (typeof line !== "string") continue;
        const matched =
          /(?:^|,\s*)wordpress_logged_in_[A-Za-z0-9_-]+=([^;,\s]+)/i.exec(line);
        const cookie = matched?.[1];
        if (cookie !== undefined && sessionSchema.safeParse({ cookie }).success)
          return canonicalJson({ cookie });
      }
    }
  }
  return undefined;
}

/** Copy named low-privilege fields only, including when an untyped handle has extras. */
function lowPrivilegeAccounts(
  handle: WordPressLabHandle,
): WordPressLowPrivilegeAccounts {
  const { subscriber, customer } = handle.attackerAccounts;
  return {
    subscriber: {
      username: subscriber.username,
      password: subscriber.password,
    },
    ...(customer === undefined
      ? {}
      : {
          customer: {
            username: customer.username,
            password: customer.password,
          },
        }),
  };
}

/** The Lab view a transport receives: named fields, low-privilege accounts, allowed database. */
function verifierLabView(
  lab: WordPressLabHandle,
  finding: WordPressFinding,
): WordPressVerifierLab {
  // Protected-object values live in ordinary WordPress tables. The Verifier
  // must use HTTP only, even when this Lab also has a read-only DB account.
  const database =
    finding.impact === "sensitive-object-access" ? undefined : lab.database;
  return {
    id: lab.id,
    snapshotDigest: lab.snapshotDigest,
    setupDigest: lab.setupDigest,
    endpoint: lab.endpoint,
    networkName: lab.networkName,
    internalIp: lab.internalIp,
    recorderIp: lab.recorderIp,
    ...(lab.scenario === undefined ? {} : { scenario: lab.scenario }),
    ...(lab.secondaryLocale === undefined
      ? {}
      : { secondaryLocale: lab.secondaryLocale }),
    ...(database === undefined ? {} : { database }),
    attackerAccounts: lowPrivilegeAccounts(lab),
  };
}

const CANARY_IMPACTS: ReadonlySet<WordPressFinding["impact"]> = new Set([
  "rce",
  "php-file-write",
  "stored-xss",
  "auth-bypass-to-admin",
  "account-takeover",
  "sqli",
]);

/**
 * The Harness-owned half of every Verifier attempt: precondition gate, canary
 * issuance, Lab view, run recording and recipe assembly. The transport only
 * runs the agent and returns its files.
 */
export class WordPressVerifier implements Verifier<
  WordPressFinding,
  WordPressLabHandle
> {
  constructor(
    readonly options: {
      readonly transport: WordPressVerifierTransport;
      readonly store: PrivateArtifactStore;
      readonly ledger: Ledger;
      /** Issues the canary a Finding's impact needs; only the Lab can observe it. */
      readonly lab: Pick<
        WordPressLab,
        | "prepareExecutionCanary"
        | "prepareScriptCanary"
        | "canaryLedger"
        | "markCapture"
      >;
      readonly clock: () => Date;
    },
  ) {}

  async #recordPrecondition(
    campaignId: string,
    finding: WordPressFinding,
    record: RecordedFinding,
    classification: ClassifiedPrecondition,
    identitySuffix: string,
  ): Promise<void> {
    const classifiedIdentity = createHash("sha256")
      .update(
        `${campaignId}\0${finding.findingId}\0${identitySuffix}\0${classification.preconditionClass}`,
      )
      .digest("hex");
    const parkedIdentity = createHash("sha256")
      .update(`${campaignId}\0${finding.findingId}\0parked`)
      .digest("hex");
    const classified = await this.options.ledger.append({
      schemaVersion: 1,
      identity: `precondition-${classifiedIdentity}`,
      campaignId,
      snapshotDigest: finding.snapshotDigest,
      occurredAt: this.options.clock().toISOString(),
      type: "finding-precondition-classified",
      findingId: finding.findingId,
      preconditionClass: classification.preconditionClass,
    });
    if (classified.status === "conflict")
      throw new Error("Finding precondition classification conflict");
    if (classification.preconditionClass !== "admin-configuration") return;
    const parked = await this.options.ledger.append({
      schemaVersion: 1,
      identity: `parked-${parkedIdentity}`,
      campaignId,
      snapshotDigest: finding.snapshotDigest,
      occurredAt: this.options.clock().toISOString(),
      type: "finding-parked",
      findingId: finding.findingId,
      runId: record.runId,
      category: record.category,
      reason: "admin-configuration-precondition",
      preconditionClass: "admin-configuration",
      artifacts: record.artifacts,
    });
    if (parked.status === "conflict")
      throw new Error("Finding precondition parking conflict");
  }

  /** The canary the Finding's impact needs, issued fresh for this attempt. */
  #canaryFor(
    finding: WordPressFinding,
    lab: WordPressLabHandle,
  ): WordPressVerifierCanary | undefined {
    switch (finding.impact) {
      case "rce":
      case "php-file-write": {
        const canary = this.options.lab.prepareExecutionCanary(lab);
        return canary === null
          ? undefined
          : { kind: "execution", php: canary.php };
      }
      case "stored-xss": {
        const canary = this.options.lab.prepareScriptCanary(lab);
        return canary === null
          ? undefined
          : {
              kind: "script",
              beaconUrl: canary.beaconUrl,
              javascript: canary.javascript,
              loaderJavascript: canary.loaderJavascript,
            };
      }
      case "auth-bypass-to-admin":
      case "account-takeover": {
        const canaries = this.options.lab.canaryLedger(lab);
        return canaries === null
          ? undefined
          : { kind: "principal", username: canaries.adminUser };
      }
      case "sqli": {
        const canaries = this.options.lab.canaryLedger(lab);
        return canaries === null || canaries.sqlCanary.table.length === 0
          ? undefined
          : { kind: "sql", table: canaries.sqlCanary.table };
      }
      default:
        return undefined;
    }
  }

  async attempt({
    campaignId,
    finding,
    lab,
    record,
    referenceRoute,
    restartObservation,
  }: {
    readonly campaignId: string;
    readonly finding: WordPressFinding;
    readonly lab: WordPressLabHandle;
    readonly record: RecordedFinding;
    readonly referenceRoute?: unknown;
    readonly restartObservation?: () => Promise<void>;
  }): Promise<VerifierAttempt> {
    // Verification reloaded the Finding and matched its digest to the Lab
    // (invariant 5); this guard only keeps a direct caller honest.
    if (
      record.findingId !== finding.findingId ||
      lab.snapshotDigest !== finding.snapshotDigest
    )
      return {
        status: "incomplete",
        reason: "precondition",
        nextStep:
          "catalogue に無い前提: Use the Finding recorded for this Lab snapshot",
      };

    const initialPrecondition = classifyWordPressPrecondition({
      configurationPrecondition: finding.configurationPrecondition,
      currentScenarioId: lab.scenario?.id,
      secondaryLocaleConfigured: lab.secondaryLocale !== undefined,
    });
    if (
      record.preconditionClass !== initialPrecondition.preconditionClass ||
      initialPrecondition.preconditionClass === "admin-configuration"
    )
      await this.#recordPrecondition(
        campaignId,
        finding,
        record,
        initialPrecondition,
        "finding",
      );
    if (initialPrecondition.preconditionClass === "admin-configuration")
      return {
        status: "incomplete",
        reason: "precondition",
        nextStep: "admin-configuration-precondition",
      };
    const transportSetsUpPreconditions =
      this.options.transport.preconditionSetup === "transport";
    if (
      !transportSetsUpPreconditions &&
      initialPrecondition.nextScenarioId !== undefined
    )
      return {
        status: "incomplete",
        reason: "precondition",
        nextStep: nextWordPressScenario(
          finding.configurationPrecondition,
          lab.scenario?.id,
          { secondaryLocaleConfigured: lab.secondaryLocale !== undefined },
        ),
        nextScenarioId: initialPrecondition.nextScenarioId,
      };
    if (
      !transportSetsUpPreconditions &&
      initialPrecondition.reasonCode !== undefined
    )
      return {
        status: "incomplete",
        reason: "precondition",
        nextStep: initialPrecondition.reasonCode,
      };

    const routeReference =
      referenceRoute === undefined
        ? undefined
        : referenceRouteSchema.safeParse(referenceRoute);
    if (routeReference !== undefined && !routeReference.success)
      return {
        status: "incomplete",
        reason: "precondition",
        nextStep:
          "catalogue に無い前提: Restore the judge-owned route for the version comparison",
      };
    const canary = this.#canaryFor(finding, lab);
    if (CANARY_IMPACTS.has(finding.impact) && canary === undefined)
      return {
        status: "incomplete",
        reason: "precondition",
        nextStep:
          "catalogue に無い前提: Issue a canary from a fresh Lab and repeat",
      };

    const runId = `verify-${finding.findingId}-${randomUUID()}`;
    let captureMarker = await this.options.lab.markCapture(lab);
    const result = await this.options.transport.run({
      runId,
      finding,
      lab: verifierLabView(lab, finding),
      // Precondition setup before this call is neither captured nor judged.
      restartObservation: async () => {
        captureMarker = await this.options.lab.markCapture(lab);
        await restartObservation?.();
      },
      ...(canary === undefined ? {} : { canary }),
      ...(routeReference?.success
        ? {
            referenceRoute: {
              role: routeReference.data.role,
              defaultSettings: routeReference.data.defaultSettings,
              steps: routeReference.data.steps,
              ...(routeReference.data.victim === undefined
                ? {}
                : { victim: routeReference.data.victim }),
            },
          }
        : {}),
    });
    if (
      result.receipt.runId !== runId ||
      result.receipt.targetSnapshotDigest !== finding.snapshotDigest
    )
      throw new Error("Verifier receipt does not match its run");
    await recordVerifierRun({
      ledger: this.options.ledger,
      store: this.options.store,
      clock: this.options.clock,
      campaignId,
      findingId: finding.findingId,
      promptDigest: result.promptDigest,
      receipt: result.receipt,
      ...(canary === undefined ? {} : { canaryIssued: canary.kind }),
    });
    if (result.outcome.status === "transport-failed")
      throw new VerifierTransportIncompleteError(result.outcome.reason);
    if (result.outcome.status === "incomplete") {
      if (!transportSetsUpPreconditions)
        return {
          status: "incomplete",
          reason: "recipe",
          nextStep: result.outcome.nextStep,
        };
      const detailDigest = await this.options.store.putFiles({
        "transport-detail.txt": result.outcome.nextStep,
        ...(result.outcome.precondition?.trim()
          ? { precondition: result.outcome.precondition }
          : {}),
      });
      const code = handoffIncompleteCode(
        result.outcome.nextStep,
        result.receipt,
      );
      return {
        status: "incomplete",
        reason:
          code === "abort-precondition-unavailable" ? "precondition" : "recipe",
        nextStep: `${code}:${detailDigest}`,
      };
    }
    const data = result.outcome.files;

    if (
      data.precondition !== undefined &&
      data.precondition.trim().length > 0
    ) {
      const detailDigest = transportSetsUpPreconditions
        ? await this.options.store.putFiles({ precondition: data.precondition })
        : undefined;
      const classified = classifyWordPressPrecondition({
        configurationPrecondition: finding.configurationPrecondition,
        attachmentPrecondition: data.precondition,
        currentScenarioId: lab.scenario?.id,
        secondaryLocaleConfigured: lab.secondaryLocale !== undefined,
      });
      await this.#recordPrecondition(
        campaignId,
        finding,
        record,
        classified,
        runId,
      );
      return {
        status: "incomplete",
        reason: "precondition",
        nextStep:
          detailDigest === undefined
            ? classified.preconditionClass === "admin-configuration"
              ? "admin-configuration-precondition"
              : (classified.reasonCode ??
                (classified.nextScenarioId === undefined
                  ? "catalogue に無い前提"
                  : nextWordPressScenario(
                      `${finding.configurationPrecondition} ${data.precondition}`,
                      lab.scenario?.id,
                      {
                        secondaryLocaleConfigured:
                          lab.secondaryLocale !== undefined,
                      },
                    )))
            : `${unmetPreconditionCode(classified)}:${detailDigest}`,
        ...(classified.nextScenarioId === undefined
          ? {}
          : { nextScenarioId: classified.nextScenarioId }),
      };
    }
    if (
      !transportSetsUpPreconditions &&
      initialPrecondition.preconditionClass === "unknown"
    )
      return {
        status: "incomplete",
        reason: "precondition",
        nextStep: "catalogue に無い前提",
      };
    if (
      data["http.json"] === undefined ||
      data["steps.md"] === undefined ||
      !data["steps.md"].trim()
    )
      return {
        status: "incomplete",
        reason: "recipe",
        nextStep: "Record http.json and steps.md, then repeat",
      };
    let http: z.infer<typeof httpSchema>;
    try {
      http = httpSchema.parse(JSON.parse(data["http.json"]) as unknown);
    } catch {
      return {
        status: "incomplete",
        reason: "recipe",
        nextStep: "Repair the http.json exchanges schema and repeat",
      };
    }
    let route: string | undefined;
    if (data["route.json"] !== undefined) {
      try {
        const parsed = routeSchema.parse(
          JSON.parse(data["route.json"]) as unknown,
        );
        if (parsed.role !== finding.attackerPosition)
          throw new Error("Route role differs from Finding");
        const suppliedSteps = z
          .array(wordpressReproductionStepSchema)
          .min(1)
          .max(30)
          .safeParse(parsed.steps);
        const steps = suppliedSteps.success
          ? suppliedSteps.data
          : routeStepsFromHttp(http, lab.endpoint);
        if (steps === null) throw new Error("Route steps are unavailable");
        const account =
          parsed.role === "unauthenticated"
            ? "none"
            : lab.attackerAccounts[parsed.role]?.username;
        if (account === undefined) throw new Error("Route account is missing");
        const changes = parsed.defaultSettings
          ? []
          : (finding.configurationPrecondition.match(/[\s\S]{1,500}/g) ?? []);
        route = canonicalJson({
          role: parsed.role,
          account,
          defaultSettings: parsed.defaultSettings,
          configurationChanges: changes,
          steps,
          ...(parsed.victim === undefined ? {} : { victim: parsed.victim }),
        });
      } catch {
        return {
          status: "incomplete",
          reason: "recipe",
          nextStep: "Repair the route.json role and settings, then repeat",
        };
      }
    }
    let session: string | undefined;
    // An empty file explicitly says that no separate principal's session was
    // observed. This applies to every attacker role; judges still verify the
    // actual attacker principal from Harness-captured HTTP when required.
    const explicitlyEmptySession =
      data["session.json"] !== undefined &&
      data["session.json"].trim().length === 0;
    if (data["session.json"] !== undefined) {
      if (!explicitlyEmptySession) {
        try {
          session = canonicalJson(
            sessionSchema.parse(JSON.parse(data["session.json"]) as unknown),
          );
        } catch {
          return {
            status: "incomplete",
            reason: "recipe",
            nextStep: "Repair the session.json cookie record, then repeat",
          };
        }
      }
    }
    if (!explicitlyEmptySession) session ??= sessionFromHttp(http);
    const recipeDigest = await this.options.store.putFiles({
      "http.json": data["http.json"],
      "steps.md": data["steps.md"],
      ...(captureMarker === null
        ? {}
        : { "capture-marker.json": canonicalJson({ marker: captureMarker }) }),
      ...(route === undefined ? {} : { "route.json": route }),
      ...(session === undefined ? {} : { "session.json": session }),
    });

    const refutationDigest =
      data["refutation.md"] !== undefined && data["refutation.md"].trim()
        ? await this.options.store.putFiles({
            "refutation.md": data["refutation.md"],
          })
        : undefined;
    return {
      status: "attempted",
      recipeDigest,
      ...(refutationDigest === undefined ? {} : { refutationDigest }),
    };
  }
}
