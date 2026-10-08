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
  | "observeExecution"
  | "observeCanaryFiles"
  | "observeOptions"
  | "observeStoredScript"
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
type HttpRecord = z.infer<typeof httpRecordSchema>;

/** A Lab-held value came back in a response that no request carried. */
function returnedOnly(http: HttpRecord, secret: string): boolean {
  return (
    http.exchanges.some((entry) => entry.response.body.includes(secret)) &&
    !http.exchanges.some((entry) =>
      JSON.stringify(entry.request ?? null).includes(secret),
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
    async ({ lab, recipeDigest, canaries }) => {
      const route = await routeConditions(options.store, recipeDigest);
      const http = httpRecordSchema.safeParse(
        await readJson(options.store, recipeDigest, "http.json"),
      );
      if (route === null || !http.success) return missingHttp;
      const table = await options.lab.observeCanaryTable(lab);
      if (table.status === "unavailable") return unavailable;
      const read = returnedOnly(http.data, canaries.sqlCanary.value);
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
    async ({ recipeDigest, canaries }) => {
      const route = await routeConditions(options.store, recipeDigest);
      const http = httpRecordSchema.safeParse(
        await readJson(options.store, recipeDigest, "http.json"),
      );
      if (route === null || !http.success) return missingHttp;
      const read = canaries.fileCanaries
        .filter((file) => returnedOnly(http.data, file.value))
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
  steps: z
    .array(z.looseObject({ kind: z.string(), path: z.string().optional() }))
    .max(30),
});

/**
 * Stored XSS: an issued script canary reached the Lab receiver while the Lab's
 * own browser opened the front page or every admin screen. Alerts and strings never count.
 */
function storedScriptJudge(options: Options) {
  return canaryJudge(
    options,
    "wordpress-stored-script",
    async ({ lab, recipeDigest }) => {
      const route = await routeConditions(options.store, recipeDigest);
      const steps = browserStepsSchema.safeParse(
        await readJson(options.store, recipeDigest, "route.json"),
      );
      if (route === null || !steps.success) return missingRoute;
      const routePaths = steps.data.steps
        .filter((step) => step.kind === "browser" && step.path !== undefined)
        .map((step) => step.path!)
        .slice(0, 5);
      const script = await options.lab.observeStoredScript(lab, { routePaths });
      switch (script.status) {
        case "unavailable":
          return unavailable;
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
      if (script.contexts.length === 0) return null;
      const siteWide = script.contexts.some(
        (context) => context === "front" || context === "admin-all",
      );
      if (!siteWide)
        return {
          status: "incomplete",
          reason: "observation",
          nextStep: `The beacon arrived only from ${script.contexts.join(", ")}, not site-wide; a human decides whether it qualifies`,
        };
      return {
        conditions: {
          observedVia: "canary-beacon",
          firedContexts: script.contexts.join(","),
          siteWide: "yes",
          ...route,
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
        default:
          return null;
      }
    },
  };
}
