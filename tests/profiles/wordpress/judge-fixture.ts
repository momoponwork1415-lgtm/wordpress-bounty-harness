import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach } from "vitest";

import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import type { WordPressFinding } from "../../../src/profiles/wordpress/discovery/finding.js";
import type {
  WordPressCanaryLedger,
  WordPressLab,
  WordPressLabHandle,
} from "../../../src/profiles/wordpress/lab/index.js";
import { createWordPressJudges } from "../../../src/profiles/wordpress/verification/judges.js";

/** Shared synthetic Lab for judge tests; every value is harmless and made up. */
export const snapshotDigest = `sha256:${"a".repeat(64)}`;
export const setupDigest = `sha256:${"b".repeat(64)}`;

export const handle: WordPressLabHandle = {
  id: "lab-1",
  snapshotDigest,
  setupDigest,
  endpoint: "http://wordpress",
  networkName: "wbh-lab-net",
  internalIp: "172.20.0.2",
  recorderIp: "172.20.0.4",
  attackerAccounts: {
    subscriber: { username: "lab-subscriber", password: "lab-only" },
  },
};

export const canaries: WordPressCanaryLedger = {
  nonce: "synthetic-nonce",
  option: "wbh_canary_synthetic-nonce",
  postId: "7",
  postMeta: "wbh_canary_synthetic-nonce",
  file: "/var/www/html/wp-content/wbh-canary-synthetic-nonce.txt",
  user: "wbh-canary-synthetic-nonce",
  adminUser: "wbh-canary-admin-synthetic-nonce",
  roleBaseline: { "lab-subscriber": ["subscriber"] },
  sqlCanary: { table: "wbh_canary", value: "c".repeat(32) },
  fileCanaries: [
    { kind: "outside-webroot", path: "/etc/wbh-canary", value: "d".repeat(32) },
    {
      kind: "php-source",
      path: "/var/www/html/wbh-canary.php",
      value: "e".repeat(32),
    },
  ],
};

export const finding = (
  impact: WordPressFinding["impact"],
): WordPressFinding => ({
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

export const route = {
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

export type JudgeLab = Parameters<typeof createWordPressJudges>[0]["lab"];

/** A Lab where nothing changed; tests override only what they observe. */
export function quietLab(overrides: Partial<JudgeLab> = {}): JudgeLab {
  return {
    async readCapture() {
      return { status: "unavailable" };
    },
    canaryLedger: () => canaries,
    async observeSessionUser() {
      return { status: "none" };
    },
    async observeAccountRoles() {
      return { status: "roles", roles: ["subscriber"] };
    },
    async observeCanaryTable() {
      return { status: "intact" };
    },
    async observeExecution() {
      return { status: "not-executed" };
    },
    async observeCanaryFiles() {
      return { status: "observed", deleted: [] };
    },
    async observeOptions() {
      return { status: "observed", changed: [] };
    },
    async observeStoredScript() {
      return { status: "observed", contexts: [] };
    },
    ...overrides,
  } satisfies Partial<WordPressLab>;
}

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

/** Stores the Verifier's files and asks the judge for `impact` once. */
export async function judgeOnce(options: {
  readonly impact: WordPressFinding["impact"];
  readonly lab: JudgeLab;
  readonly files: Readonly<Record<string, string>>;
}) {
  const root = await mkdtemp(join(tmpdir(), "wbh-judge-"));
  directories.push(root);
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 10,
    maxBytes: 1024 * 1024,
  });
  const judge = createWordPressJudges({ store, lab: options.lab }).for(
    finding(options.impact),
  );
  if (judge === null) return { judgeId: null, store, observed: null };
  const recipeDigest = await store.putFiles(options.files);
  return {
    judgeId: judge.id,
    store,
    observed: await judge.observe({
      finding: finding(options.impact),
      lab: handle,
      recipeDigest,
    }),
  };
}
