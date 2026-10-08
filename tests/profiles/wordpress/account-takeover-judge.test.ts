import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import type { WordPressFinding } from "../../../src/profiles/wordpress/discovery/finding.js";
import type {
  WordPressCanaryLedger,
  WordPressLabHandle,
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
  brokenProperty: "Account ownership",
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
      expected: "Synthetic observation",
    },
  ],
};

async function fixture(options: {
  readonly session?: string;
  readonly observation: WordPressSessionObservation;
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
        return options.observation;
      },
    },
  });
  const recipeDigest = await store.putFiles({
    "route.json": JSON.stringify(route),
    "http.json": JSON.stringify([{ status: 200 }]),
    ...(options.session === undefined
      ? {}
      : { "session.json": JSON.stringify({ cookie: options.session }) }),
  });
  return { store, judges, recipeDigest, presented };
}

describe("WordPress account-takeover judge", () => {
  it("observes only a session that the Lab authenticates as the canary user", async () => {
    const { judges, store, recipeDigest, presented } = await fixture({
      session: "synthetic-session",
      observation: { status: "user", login: canaries.user },
    });
    const judge = judges.for(finding("account-takeover"));
    expect(judge?.id).toBe("wordpress-account-takeover-canary-user");
    const observed = await judge!.observe({
      finding: finding("account-takeover"),
      lab: handle,
      recipeDigest,
    });
    expect(observed.status).toBe("observed");
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
        judgeId: judge!.id,
        proofKind: "nonce-canary",
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
    const canaryFile = await store.readFile(
      observed.evidenceDigest,
      "canary-observation.json",
      10_000,
    );
    expect(
      canaryFile.status === "resolved" &&
        JSON.parse(canaryFile.bytes.toString("utf8")),
    ).toMatchObject({
      expectedUser: canaries.user,
      observedUser: canaries.user,
    });
  });

  it("does not observe the attacker's own session", async () => {
    const { judges, recipeDigest } = await fixture({
      session: "synthetic-session",
      observation: { status: "user", login: "lab-subscriber" },
    });
    expect(
      await judges.for(finding("account-takeover"))!.observe({
        finding: finding("account-takeover"),
        lab: handle,
        recipeDigest,
      }),
    ).toEqual({ status: "not-observed" });
  });

  it("ignores a recipe that claims success without presenting a session", async () => {
    const { judges, recipeDigest, presented } = await fixture({
      observation: { status: "user", login: canaries.user },
    });
    expect(
      await judges.for(finding("account-takeover"))!.observe({
        finding: finding("account-takeover"),
        lab: handle,
        recipeDigest,
      }),
    ).toEqual({ status: "not-observed" });
    expect(presented).toEqual([]);
  });

  it("reports an unavailable Lab observation as incomplete", async () => {
    const { judges, recipeDigest } = await fixture({
      session: "synthetic-session",
      observation: { status: "unavailable" },
    });
    expect(
      await judges.for(finding("account-takeover"))!.observe({
        finding: finding("account-takeover"),
        lab: handle,
        recipeDigest,
      }),
    ).toMatchObject({ status: "incomplete", reason: "observation" });
  });

  it("requires seeded canaries", async () => {
    const { judges, recipeDigest } = await fixture({
      session: "synthetic-session",
      observation: { status: "user", login: canaries.user },
      seeded: false,
    });
    expect(
      await judges.for(finding("account-takeover"))!.observe({
        finding: finding("account-takeover"),
        lab: handle,
        recipeDigest,
      }),
    ).toMatchObject({ status: "incomplete", reason: "precondition" });
  });

  it("has no judge for impacts outside the first slice", () => {
    const judges = createWordPressJudges({
      store: new PrivateArtifactStore({
        rootDirectory: "/nonexistent-wbh-store",
        maxEntries: 1,
        maxBytes: 1,
      }),
      lab: {
        canaryLedger: () => canaries,
        observeSessionUser: async () => ({ status: "none" }),
      },
    });
    expect(judges.for(finding("sqli"))).toBeNull();
  });
});
