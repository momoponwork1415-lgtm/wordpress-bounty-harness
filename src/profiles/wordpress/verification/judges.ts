import { z } from "zod";

import { canonicalJson } from "../../../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import type { Judge, JudgeSet } from "../../../verification/index.js";
import type { WordPressFinding } from "../discovery/finding.js";
import type { WordPressLab, WordPressLabHandle } from "../lab/index.js";

const sessionSchema = z.strictObject({ cookie: z.string().min(1).max(4096) });
const routeFieldsSchema = z.looseObject({});

async function readJson(
  store: PrivateArtifactStore,
  digest: string,
  name: string,
): Promise<unknown> {
  const file = await store.readFile(digest, name, 1024 * 1024);
  if (file.status !== "resolved") return undefined;
  try {
    return JSON.parse(file.bytes.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Account takeover: the Lab itself decides which user a presented session
 * authenticates as. The Verifier's narrative is never read.
 */
function accountTakeoverJudge(options: {
  readonly store: PrivateArtifactStore;
  readonly lab: Pick<WordPressLab, "canaryLedger" | "observeSessionUser">;
}): Judge<WordPressFinding, WordPressLabHandle> {
  const id = "wordpress-account-takeover-canary-user";
  return {
    id,
    async observe({ lab, recipeDigest }) {
      const canaries = options.lab.canaryLedger(lab);
      if (canaries === null)
        return {
          status: "incomplete",
          reason: "precondition",
          nextStep: "Seed canaries in the Lab before judging",
        };
      const session = sessionSchema.safeParse(
        await readJson(options.store, recipeDigest, "session.json"),
      );
      if (!session.success) return { status: "not-observed" };
      const observed = await options.lab.observeSessionUser(
        lab,
        session.data.cookie,
      );
      if (observed.status === "unavailable")
        return {
          status: "incomplete",
          reason: "observation",
          nextStep:
            "The Lab could not resolve the session; repeat in a fresh Lab",
        };
      if (observed.status !== "user" || observed.login !== canaries.user)
        return { status: "not-observed" };
      const route = routeFieldsSchema.safeParse(
        await readJson(options.store, recipeDigest, "route.json"),
      );
      const http = await options.store.readFile(
        recipeDigest,
        "http.json",
        5 * 1024 * 1024,
      );
      if (!route.success || http.status !== "resolved")
        return {
          status: "incomplete",
          reason: "evidence",
          nextStep:
            "The canary session was observed but the route or HTTP record is missing; repeat with a recorded route",
        };
      const evidenceDigest = await options.store.putFiles({
        "confirmed-route.json": canonicalJson({
          ...route.data,
          schemaVersion: 1,
          snapshotDigest: lab.snapshotDigest,
          labSetupDigest: lab.setupDigest,
          evidence: [
            { kind: "http", path: "http.json" },
            { kind: "canary", path: "canary-observation.json" },
          ],
        }),
        "http.json": http.bytes,
        "canary-observation.json": canonicalJson({
          judgeId: id,
          expectedUser: canaries.user,
          observedUser: observed.login,
        }),
      });
      return {
        status: "observed",
        evidenceDigest,
        conditions: { reachedPrincipal: "canary-user" },
      };
    },
  };
}

/** Only the judges this slice needs; other impacts stay incomplete(no-judge). */
export function createWordPressJudges(options: {
  readonly store: PrivateArtifactStore;
  readonly lab: Pick<WordPressLab, "canaryLedger" | "observeSessionUser">;
}): JudgeSet<WordPressFinding, WordPressLabHandle> {
  const accountTakeover = accountTakeoverJudge(options);
  return {
    for: (finding) =>
      finding.impact === "account-takeover" ? accountTakeover : null,
  };
}
