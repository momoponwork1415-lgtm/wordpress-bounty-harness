import { z } from "zod";

import { canonicalJson } from "../../../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import type {
  Judge,
  JudgeObservation,
  JudgeSet,
} from "../../../verification/index.js";
import type { WordPressFinding } from "../discovery/finding.js";
import type {
  WordPressCanaryLedger,
  WordPressLab,
  WordPressLabHandle,
} from "../lab/index.js";

type JudgeLab = Pick<
  WordPressLab,
  | "canaryLedger"
  | "observeSessionUser"
  | "observeAccountRoles"
  | "observeCanaryTable"
>;
type Options = { readonly store: PrivateArtifactStore; readonly lab: JudgeLab };

const sessionSchema = z.strictObject({ cookie: z.string().min(1).max(4096) });
const routeFieldsSchema = z.looseObject({});
const routeConditionsSchema = z.looseObject({
  role: z.string().min(1).max(64),
  defaultSettings: z.boolean(),
});
/** The Verifier's HTTP record; only responses can carry what the Lab held back. */
const httpRecordSchema = z.looseObject({
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
/** Highest first; a role gained beyond the seeded baseline counts as escalation. */
const ELEVATED_ROLES = ["administrator", "editor", "author", "contributor"];

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
  { readonly conditions: Readonly<Record<string, string>> } | null | Incomplete;
type DecideInput = {
  readonly lab: WordPressLabHandle;
  readonly recipeDigest: string;
  readonly canaries: WordPressCanaryLedger;
};

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
  recipeDigest: string,
  observation: Record<string, unknown>,
): Promise<string | null> {
  const route = routeFieldsSchema.safeParse(
    await readJson(options.store, recipeDigest, "route.json"),
  );
  const http = await options.store.readFile(
    recipeDigest,
    "http.json",
    5 * 1024 * 1024,
  );
  if (!route.success || http.status !== "resolved") return null;
  return options.store.putFiles({
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
    "canary-observation.json": canonicalJson(observation),
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
    async observe({ lab, recipeDigest }) {
      const canaries = options.lab.canaryLedger(lab);
      if (canaries === null)
        return {
          status: "incomplete",
          reason: "precondition",
          nextStep: "Seed canaries in the Lab before judging",
        };
      const decision = await decide({ lab, recipeDigest, canaries });
      if (decision === null) return { status: "not-observed" };
      if ("status" in decision) return decision;
      const { conditions } = decision;
      const evidenceDigest = await recordEvidence(options, lab, recipeDigest, {
        judgeId: id,
        ...conditions,
      });
      if (evidenceDigest === null)
        return {
          status: "incomplete",
          reason: "evidence",
          nextStep:
            "The canary state was observed but the route or HTTP record is missing; repeat with a recorded route",
        };
      return { status: "observed", evidenceDigest, conditions };
    },
  };
}

function principalJudge(
  options: Options,
  id: string,
  decide: (facts: PrincipalFacts) => Record<string, string> | null,
) {
  return canaryJudge(options, id, async (input) => {
    const facts = await observePrincipals(options, input);
    if ("status" in facts) return facts;
    const conditions = decide(facts);
    return conditions === null ? null : { conditions };
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
    async ({ lab, recipeDigest, canaries }) => {
      const route = routeConditionsSchema.safeParse(
        await readJson(options.store, recipeDigest, "route.json"),
      );
      const http = httpRecordSchema.safeParse(
        await readJson(options.store, recipeDigest, "http.json"),
      );
      if (!route.success || !http.success)
        return {
          status: "incomplete",
          reason: "evidence",
          nextStep:
            "Record the route and every HTTP exchange with its response body; then repeat",
        };
      const table = await options.lab.observeCanaryTable(lab);
      if (table.status === "unavailable") return unavailable;
      const secret = canaries.sqlCanary.value;
      const read =
        http.data.exchanges.some((entry) =>
          entry.response.body.includes(secret),
        ) &&
        !http.data.exchanges.some((entry) =>
          JSON.stringify(entry.request ?? null).includes(secret),
        );
      if (table.status !== "changed" && !read) return null;
      return {
        conditions: {
          observedVia:
            table.status === "changed"
              ? "canary-table-write"
              : "canary-row-read",
          attackerRole: route.data.role,
          defaultSettings: String(route.data.defaultSettings),
          // The Lab never touches wp_magic_quotes.
          magicQuotes: "wordpress-default",
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
  return {
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
        default:
          return null;
      }
    },
  };
}
