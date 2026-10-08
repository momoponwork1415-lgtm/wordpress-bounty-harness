import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import type { WordPressFinding } from "../../../src/profiles/wordpress/discovery/finding.js";
import type {
  WordPressCanaryLedger,
  WordPressCanaryTableObservation,
  WordPressLabHandle,
} from "../../../src/profiles/wordpress/lab/index.js";
import { createWordPressJudges } from "../../../src/profiles/wordpress/verification/judges.js";

const snapshotDigest = `sha256:${"a".repeat(64)}`;
const setupDigest = `sha256:${"b".repeat(64)}`;
const rowValue = "c".repeat(32);
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
  sqlCanary: { table: "wbh_canary", value: rowValue },
};
const finding: WordPressFinding = {
  findingId: "finding-1",
  discoveryRunId: "run-1",
  snapshotDigest,
  recipeRef: { kind: "provider-report", digest: snapshotDigest },
  claim: "Synthetic claim",
  attackerPosition: "subscriber",
  impact: "sqli",
  configurationPrecondition: "default",
  brokenProperty: "Synthetic property",
  sourceTrace: [{ file: "includes/example.php", function: "fixture", line: 1 }],
  existingControls: "Synthetic control",
  labObservations: "Synthetic observation",
};
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
      expected: "Canary row in the response",
    },
  ],
};
const exchange = (request: string, response: string) => ({
  request: { method: "GET", path: `/synthetic?q=${request}` },
  response: { status: 200, body: response },
});

async function observe(options: {
  readonly table?: WordPressCanaryTableObservation["status"];
  readonly http?: unknown;
  readonly seeded?: boolean;
}) {
  const root = await mkdtemp(join(tmpdir(), "wbh-sql-judge-"));
  directories.push(root);
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 10,
    maxBytes: 1024 * 1024,
  });
  const judges = createWordPressJudges({
    store,
    lab: {
      canaryLedger: () => (options.seeded === false ? null : canaries),
      async observeSessionUser() {
        return { status: "none" };
      },
      async observeAccountRoles() {
        return { status: "roles", roles: ["subscriber"] };
      },
      async observeCanaryTable() {
        return { status: options.table ?? "intact" };
      },
    },
  });
  const judge = judges.for(finding);
  const recipeDigest = await store.putFiles({
    "route.json": JSON.stringify(route),
    "http.json": JSON.stringify(
      options.http ?? { exchanges: [exchange("1", "nothing")] },
    ),
    "notes.md": `The Verifier reports that ${rowValue} was read.\n`,
  });
  return {
    judgeId: judge?.id,
    store,
    observed: await judge!.observe({ finding, lab: handle, recipeDigest }),
  };
}

describe("WordPress SQL canary judge", () => {
  it("observes the canary row value in a response that no request carried", async () => {
    const { judgeId, observed, store } = await observe({
      http: {
        exchanges: [
          exchange("1", "unrelated"),
          exchange("2", `<td>${rowValue}</td>`),
        ],
      },
    });
    expect(judgeId).toBe("wordpress-sql-canary");
    expect(observed).toEqual({
      status: "observed",
      evidenceDigest: expect.stringMatching(/^sha256:/),
      conditions: {
        observedVia: "canary-row-read",
        attackerRole: "subscriber",
        defaultSettings: "true",
        magicQuotes: "wordpress-default",
      },
    });
    if (observed.status !== "observed") return;
    for (const name of [
      "confirmed-route.json",
      "http.json",
      "canary-observation.json",
    ])
      expect(
        (await store.readFile(observed.evidenceDigest, name, 100_000)).status,
      ).toBe("resolved");
  });

  it("observes a write to the canary table inside the Lab", async () => {
    const { observed } = await observe({ table: "changed" });
    expect(observed).toMatchObject({
      status: "observed",
      conditions: { observedVia: "canary-table-write" },
    });
  });

  it.each([
    [
      "the value only reflected from a request",
      { exchanges: [exchange(rowValue, `echo ${rowValue}`)] },
    ],
    [
      "the public canary nonce instead of the row value",
      { exchanges: [exchange("1", canaries.nonce)] },
    ],
    [
      "a slow response without the row value",
      {
        exchanges: [
          { ...exchange("1", "same page"), elapsedMs: 10_000 },
          { ...exchange("2", "same page"), elapsedMs: 5 },
        ],
      },
    ],
  ])("does not fire on %s", async (_label, http) => {
    const { observed } = await observe({ http });
    expect(observed).toEqual({ status: "not-observed" });
  });

  it("stays incomplete when the Lab or the HTTP record cannot be read", async () => {
    expect((await observe({ seeded: false })).observed).toMatchObject({
      status: "incomplete",
      reason: "precondition",
    });
    expect((await observe({ table: "unavailable" })).observed).toMatchObject({
      status: "incomplete",
      reason: "observation",
    });
    expect((await observe({ http: [{ status: 200 }] })).observed).toMatchObject(
      { status: "incomplete", reason: "evidence" },
    );
  });
});
