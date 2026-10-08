import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import type { WordPressFinding } from "../../../src/profiles/wordpress/discovery/finding.js";
import type {
  WordPressCanaryLedger,
  WordPressLabHandle,
  WordPressRoleObservation,
  WordPressSessionObservation,
} from "../../../src/profiles/wordpress/lab/index.js";
import { createWordPressJudges } from "../../../src/profiles/wordpress/verification/judges.js";
import { wordpressReproductionRenderer } from "../../../src/profiles/wordpress/verification/reproduction-package.js";
import { publishReproductionPackage } from "../../../src/verification/index.js";

const snapshotDigest = `sha256:${"a".repeat(64)}`;
const setupDigest = `sha256:${"b".repeat(64)}`;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const handle: WordPressLabHandle = {
  id: "lab-1",
  snapshotDigest,
  setupDigest,
  endpoint: "http://wordpress",
  networkName: "wbh-lab-net",
  internalIp: "172.20.0.2",
  attackerAccounts: {
    subscriber: { username: "lab-subscriber", password: "lab-only" },
  },
};
const canaries: WordPressCanaryLedger = {
  nonce: "synthetic-nonce",
  option: "wbh_canary_synthetic-nonce",
  postId: "7",
  postMeta: "wbh_canary_synthetic-nonce",
  file: "/var/www/html/wp-content/wbh-canary-synthetic-nonce.txt",
  user: "wbh-canary-synthetic-nonce",
  adminUser: "wbh-canary-admin-synthetic-nonce",
  roleBaseline: { "lab-subscriber": ["subscriber"] },
  sqlCanary: { table: "wbh_canary", value: "0".repeat(32) },
};
const finding = (impact: WordPressFinding["impact"]): WordPressFinding => ({
  findingId: "finding-1",
  discoveryRunId: "run-1",
  snapshotDigest,
  recipeRef: { kind: "provider-report", digest: snapshotDigest },
  claim: "Synthetic claim",
  attackerPosition: "subscriber",
  impact,
  configurationPrecondition: "default",
  brokenProperty: "Synthetic property",
  sourceTrace: [{ file: "includes/example.php", function: "fixture", line: 1 }],
  existingControls: "Synthetic control",
  labObservations: "Synthetic observation",
});
const route = {
  role: "subscriber",
  account: "lab-subscriber",
  defaultSettings: true,
  configurationChanges: [],
  steps: [
    {
      kind: "http",
      method: "GET",
      path: "/synthetic",
      expected: "Administrator access obtained",
    },
  ],
};

async function fixture(options: {
  readonly sessionUser?: string;
  readonly session?: WordPressSessionObservation["status"];
  readonly roles?: readonly string[] | "unavailable";
  readonly seeded?: boolean;
}) {
  const root = await mkdtemp(join(tmpdir(), "wbh-judge-"));
  directories.push(root);
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 10,
    maxBytes: 1024 * 1024,
  });
  const presented: string[] = [];
  const judges = createWordPressJudges({
    store,
    lab: {
      canaryLedger: () => (options.seeded === false ? null : canaries),
      async observeSessionUser(_lab, cookie) {
        presented.push(cookie);
        if (options.session === "unavailable") return { status: "unavailable" };
        return options.sessionUser === undefined
          ? { status: "none" }
          : { status: "user", login: options.sessionUser };
      },
      async observeCanaryTable() {
        return { status: "intact" };
      },
      async observeExecution() {
        return { status: "not-executed" };
      },
      async observeAccountRoles(): Promise<WordPressRoleObservation> {
        return options.roles === "unavailable"
          ? { status: "unavailable" }
          : { status: "roles", roles: options.roles ?? ["subscriber"] };
      },
    },
  });
  const recipeDigest = await store.putFiles({
    "route.json": JSON.stringify(route),
    "http.json": JSON.stringify([{ status: 200 }]),
    // Narrative that a judge must never read.
    "notes.md":
      "The Verifier reports that administrator access was obtained.\n",
    ...(options.sessionUser === undefined && options.session === undefined
      ? {}
      : { "session.json": JSON.stringify({ cookie: "synthetic-session" }) }),
  });
  const observe = (impact: WordPressFinding["impact"]) =>
    judges.for(finding(impact))!.observe({
      finding: finding(impact),
      lab: handle,
      recipeDigest,
    });
  return { store, judges, observe, presented };
}

describe("WordPress principal judges", () => {
  it("maps impact classes to the administrator and non-administrator judges only", async () => {
    const { judges } = await fixture({});
    for (const impact of [
      "privesc-to-admin",
      "auth-bypass-to-admin",
      "account-takeover",
    ] as const)
      expect(judges.for(finding(impact))?.id).toBe(
        "wordpress-administrator-principal",
      );
    for (const impact of [
      "privesc-to-contributor+",
      "auth-bypass-non-admin",
    ] as const)
      expect(judges.for(finding(impact))?.id).toBe(
        "wordpress-non-administrator-principal",
      );
    for (const impact of ["reflected-xss", "csrf-to-write", "idor"] as const)
      expect(judges.for(finding(impact))).toBeNull();
  });

  it("observes a session that the Lab authenticates as the administrator canary", async () => {
    const { observe, store, presented } = await fixture({
      sessionUser: canaries.adminUser,
    });
    const observed = await observe("account-takeover");
    expect(observed).toMatchObject({
      status: "observed",
      conditions: { reachedRole: "administrator", observedVia: "session" },
    });
    expect(presented).toEqual(["synthetic-session"]);
    if (observed.status !== "observed") return;
    const published = await publishReproductionPackage({
      store,
      renderer: wordpressReproductionRenderer,
      findingSnapshotDigest: snapshotDigest,
      labSnapshotDigest: snapshotDigest,
      labSetupDigest: setupDigest,
      judgeResult: {
        status: "runtime-confirmed",
        judgeId: "wordpress-administrator-principal",
        proofKind: "nonce-canary",
        conditions: observed.conditions,
        evidenceDigest: observed.evidenceDigest,
      },
      reconstruction: {
        wordpressVersion: "6.8",
        target: {
          identity: "example",
          version: "1.0",
          sourceDigest: snapshotDigest,
        },
        enabledSettings: [],
        roles: ["subscriber"],
      },
    });
    expect(published.status).toBe("runtime-confirmed");
    const notes = await store.readFile(
      observed.evidenceDigest,
      "notes.md",
      10_000,
    );
    expect(notes.status).not.toBe("resolved");
  });

  it("observes an attacker account that gained the administrator role since the baseline", async () => {
    const { observe, presented } = await fixture({
      roles: ["administrator", "subscriber"],
    });
    expect(await observe("privesc-to-admin")).toMatchObject({
      status: "observed",
      conditions: {
        reachedRole: "administrator",
        observedVia: "role-change",
        attackerBaselineRoles: "subscriber",
      },
    });
    expect(presented).toEqual([]);
  });

  it("does not count a subscriber canary session as administrator access", async () => {
    const { observe } = await fixture({ sessionUser: canaries.user });
    expect(await observe("account-takeover")).toEqual({
      status: "not-observed",
    });
  });

  it("observes another principal or contributor-level roles for the non-administrator judge", async () => {
    expect(
      await (
        await fixture({ sessionUser: canaries.user })
      ).observe("auth-bypass-non-admin"),
    ).toMatchObject({
      status: "observed",
      conditions: { reachedRole: "subscriber", observedVia: "session" },
    });
    expect(
      await (
        await fixture({ roles: ["editor"] })
      ).observe("privesc-to-contributor+"),
    ).toMatchObject({
      status: "observed",
      conditions: { reachedRole: "editor", observedVia: "role-change" },
    });
  });

  it("stays silent in a Lab where nothing changed (negative control)", async () => {
    for (const impact of [
      "account-takeover",
      "privesc-to-admin",
      "auth-bypass-non-admin",
      "privesc-to-contributor+",
    ] as const) {
      // The session is the attacker's own; roles match the baseline; the notes claim success.
      const { observe } = await fixture({ sessionUser: "lab-subscriber" });
      expect(await observe(impact)).toEqual({ status: "not-observed" });
    }
    const { observe } = await fixture({});
    expect(await observe("account-takeover")).toEqual({
      status: "not-observed",
    });
  });

  it("reports unavailable Lab observations and missing canaries as incomplete", async () => {
    expect(
      await (
        await fixture({ session: "unavailable" })
      ).observe("account-takeover"),
    ).toMatchObject({ status: "incomplete", reason: "observation" });
    expect(
      await (
        await fixture({ roles: "unavailable" })
      ).observe("account-takeover"),
    ).toMatchObject({ status: "incomplete", reason: "observation" });
    expect(
      await (await fixture({ seeded: false })).observe("account-takeover"),
    ).toMatchObject({ status: "incomplete", reason: "precondition" });
  });
});
