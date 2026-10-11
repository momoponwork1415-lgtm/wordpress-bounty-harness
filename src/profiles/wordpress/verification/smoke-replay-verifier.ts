import { z } from "zod";

import {
  canonicalDigest,
  canonicalJson,
} from "../../../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import type { Verifier, VerifierAttempt } from "../../../verification/index.js";
import type { WordPressFinding } from "../discovery/finding.js";
import type { WordPressLab, WordPressLabHandle } from "../lab/index.js";
import {
  bindSmokeReferenceRoute,
  replayInputFor,
  smokeReplayRecipeSchema,
} from "./smoke-replay-recipe.js";

const routeSchema = z.looseObject({
  snapshotDigest: z.string(),
  steps: z.array(z.unknown()).length(8),
});
const captureSchema = z
  .array(
    z.strictObject({
      request: z.looseObject({
        method: z.string(),
        path: z.string(),
        truncated: z.literal(false),
      }),
      response: z.looseObject({
        headers: z.record(z.string(), z.unknown()),
        truncated: z.literal(false),
      }),
    }),
  )
  .min(1)
  .max(100);

function sessionCookie(capture: z.infer<typeof captureSchema>): string | null {
  for (const exchange of capture) {
    const headers = Object.entries(exchange.response.headers);
    for (const [name, value] of headers) {
      if (name.toLowerCase() !== "set-cookie") continue;
      for (const line of typeof value === "string"
        ? [value]
        : Array.isArray(value)
          ? value
          : []) {
        if (typeof line !== "string") continue;
        const cookie =
          /(?:^|,\s*)wordpress_logged_in_[A-Za-z0-9_-]+=([^;,\s]+)/i.exec(
            line,
          )?.[1];
        if (cookie !== undefined && /^[A-Za-z0-9%|._@+-]{1,4096}$/.test(cookie))
          return cookie;
      }
    }
  }
  return null;
}

/** A bounded, private replay used only by the weekly known Finding smoke. */
export class SmokeReplayVerifier implements Verifier<
  WordPressFinding,
  WordPressLabHandle
> {
  constructor(
    readonly options: {
      readonly lab: Pick<
        WordPressLab,
        "canaryLedger" | "markCapture" | "readCapture" | "replayHttp"
      >;
      readonly store: PrivateArtifactStore;
      readonly recipeDigest: string;
    },
  ) {}

  async attempt(input: {
    readonly campaignId: string;
    readonly finding: WordPressFinding;
    readonly lab: WordPressLabHandle;
    readonly referenceRoute?: unknown;
  }): Promise<VerifierAttempt> {
    const unavailable = (nextStep: string): VerifierAttempt => ({
      status: "incomplete",
      reason: "recipe",
      nextStep,
    });
    if (
      input.finding.impact !== "account-takeover" ||
      input.referenceRoute === undefined
    )
      return unavailable("A confirmed account-takeover route is required");
    const saved = await this.options.store.readFile(
      this.options.recipeDigest,
      "replay-recipe.json",
      12 * 1024 * 1024,
    );
    if (saved.status !== "resolved")
      return unavailable("The private replay recipe is unavailable");
    let candidate: unknown;
    try {
      candidate = JSON.parse(saved.bytes.toString("utf8")) as unknown;
    } catch {
      return unavailable("The private replay recipe is unreadable");
    }
    const parsed = smokeReplayRecipeSchema.safeParse(candidate);
    const source = routeSchema.safeParse(input.referenceRoute);
    if (
      !parsed.success ||
      !source.success ||
      parsed.data.sourceRouteDigest !== canonicalDigest(input.referenceRoute) ||
      parsed.data.findingSnapshotDigest !== source.data.snapshotDigest
    )
      return unavailable(
        "The replay recipe does not match the confirmed route",
      );
    const canaries = this.options.lab.canaryLedger(input.lab);
    if (
      canaries === null ||
      !canaries.adminUser.startsWith("wbh-canary-admin-")
    )
      return {
        status: "incomplete",
        reason: "precondition",
        nextStep: "Seed this Lab's principal canary",
      };
    const marker = await this.options.lab.markCapture(input.lab);
    if (marker === null) return unavailable("The Lab recorder is unavailable");
    const replay = await this.options.lab.replayHttp(
      input.lab,
      replayInputFor(parsed.data, canaries.adminUser),
    );
    const observed = await this.options.lab.readCapture(input.lab, marker);
    const capture =
      observed.status === "captured" && observed.dropped === 0
        ? observed.bytes.toString("utf8").trimEnd().split("\n")
        : [];
    let raw: unknown[] = [];
    try {
      raw = capture.map((line) => JSON.parse(line) as unknown);
    } catch {
      raw = [];
    }
    const valid = captureSchema.safeParse(raw);
    const bound = valid.success
      ? bindSmokeReferenceRoute({
          recipe: parsed.data,
          sourceRoute: input.referenceRoute,
          capture: valid.data,
          adminUser: canaries.adminUser,
        })
      : null;
    const route = bound === null ? input.referenceRoute : bound;
    const cookie = valid.success ? sessionCookie(valid.data) : null;
    const files: Record<string, string | Buffer> = {
      "capture-marker.json": canonicalJson({ marker }),
      // The judge reads the recorder via capture-marker. An empty authored
      // fallback cannot be mistaken for evidence if the recorder is lost.
      "http.json": canonicalJson({ exchanges: [] }),
      "route.json": canonicalJson({
        ...(route as Record<string, unknown>),
        snapshotDigest: input.lab.snapshotDigest,
        labSetupDigest: input.lab.setupDigest,
      }),
      "smoke-binding.json": canonicalJson({
        recipeDigest: this.options.recipeDigest,
        sourceRouteDigest: parsed.data.sourceRouteDigest,
        replayStatus: replay.status,
        completedSteps:
          replay.status === "unavailable" ? 0 : replay.completedSteps,
        ...(replay.status === "incomplete"
          ? { replayReason: replay.reason }
          : {}),
        bound: bound !== null,
      }),
      ...(cookie === null ? {} : { "session.json": canonicalJson({ cookie }) }),
    };
    const recipeDigest = await this.options.store.putFiles(files);
    const refutationDigest = await this.options.store.putFiles({
      "refutation.md":
        "The bounded replay completed only when all eight captured HTTP steps and dynamic bindings were available. The judge independently checks the exact route and Lab canary state.",
    });
    return { status: "attempted", recipeDigest, refutationDigest };
  }
}
