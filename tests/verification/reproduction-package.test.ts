import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { measureCanonicalSourceTree } from "../../src/infrastructure/canonical-source-tree.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { openReproductionPackage } from "../../src/review/reproduction-package.js";
import {
  publishReproductionPackage,
  verificationResultV1Schema,
} from "../../src/verification/reproduction-package.js";
import { wordpressReproductionRenderer } from "../../src/profiles/wordpress/verification/reproduction-package.js";

const snapshot = `sha256:${"a".repeat(64)}`;
const other = `sha256:${"b".repeat(64)}`;
const setup = `sha256:${"c".repeat(64)}`;
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(route: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "reproduction-"));
  directories.push(directory);
  const store = new PrivateArtifactStore({
    rootDirectory: join(directory, "private-evidence"),
    maxEntries: 10,
    maxBytes: 100_000,
  });
  const stage = await store.stage();
  await writeFile(
    join(stage.contentDirectory, "confirmed-route.json"),
    JSON.stringify(route),
  );
  await writeFile(
    join(stage.contentDirectory, "http.txt"),
    "GET /demo -> canary observed",
  );
  await writeFile(
    join(stage.contentDirectory, "canary.txt"),
    "nonce recovered",
  );
  await writeFile(
    join(stage.contentDirectory, "screen.png"),
    "synthetic screenshot fixture",
  );
  const measured = await measureCanonicalSourceTree(stage.contentDirectory, {
    maxEntries: 10,
    maxBytes: 100_000,
  });
  const committed = await store.commit(measured.digest, stage);
  if (committed.status === "conflict") throw new Error("fixture conflict");
  return { store, evidenceDigest: committed.artifact.digest, directory };
}

const route = {
  schemaVersion: 1,
  snapshotDigest: snapshot,
  labSetupDigest: setup,
  role: "subscriber",
  account: "lab-subscriber",
  defaultSettings: true,
  configurationChanges: [],
  victim: {
    role: "administrator",
    paths: ["/wp-admin/admin.php?page=fixture"],
  },
  steps: [
    {
      kind: "http",
      method: "GET",
      path: "/demo?case=1",
      expected: "nonce canary appears in the response",
    },
    {
      kind: "browser",
      path: "/demo?case=1",
      expected: "nonce canary is shown in the browser",
    },
  ],
  evidence: [
    { kind: "http", path: "http.txt" },
    { kind: "canary", path: "canary.txt" },
    { kind: "screenshot", path: "screen.png" },
  ],
};
const reconstruction = {
  wordpressVersion: "6.8",
  target: { identity: "example", version: "1.0", sourceDigest: snapshot },
  enabledSettings: [],
  roles: ["subscriber"],
};

it("publishes a confirmed judge route to Private Evidence and opens it for review", async () => {
  const { store, evidenceDigest, directory } = await fixture(route);
  const result = await publishReproductionPackage({
    store,
    renderer: wordpressReproductionRenderer,
    category: "stored-xss",
    findingSnapshotDigest: snapshot,
    labSnapshotDigest: snapshot,
    labSetupDigest: setup,
    judgeResult: {
      status: "runtime-confirmed",
      judgeId: "canary-judge",
      proofKind: "nonce-canary",
      evidenceDigest,
    },
    reconstruction,
  });
  expect(result.status).toBe("runtime-confirmed");
  if (result.status !== "runtime-confirmed") return;
  const opened = await openReproductionPackage(store, result);
  expect(opened.status).toBe("opened");
  if (opened.status !== "opened") return;
  const headings = [
    "## 1. 受理基準の充足",
    "## 2. 期待する観測と実際の観測",
    "## 3. 修正版での負の対照",
    "## 4. 再現手順",
  ];
  expect(headings.map((heading) => opened.manual.indexOf(heading))).toEqual(
    [...headings.map((heading) => opened.manual.indexOf(heading))].sort(
      (left, right) => left - right,
    ),
  );
  for (const heading of headings) expect(opened.manual).toContain(heading);
  expect(opened.manual).toContain("[agent-authored]");
  expect(opened.manual).toContain("agent-authored.json");
  expect(opened.agentAuthored).toMatchObject({
    role: "subscriber",
    defaultSettings: true,
    victim: {
      role: "administrator",
      paths: ["/wp-admin/admin.php?page=fixture"],
    },
    steps: expect.arrayContaining([
      expect.objectContaining({ method: "GET", path: "/demo?case=1" }),
    ]),
  });
  expect(opened.script).toContain("import requests");
  expect(opened.script).toContain("agent-authored.json");
  expect(opened.reconstruction).toMatchObject({
    wordpressVersion: "6.8",
    labSetupDigest: setup,
  });
  expect(opened.evidence).toMatchObject({
    judgeEvidenceDigest: evidenceDigest,
  });
  expect(result.reproductionPackageDigest).toMatch(/^sha256:/);
  expect(directory).not.toContain("wordpress-bounty-harness");
});

it("seals template references and a private agent sidecar for the Finding category", async () => {
  const { store, evidenceDigest } = await fixture(route);
  const document = {
    id: "acceptance-stored-xss",
    version: 1,
    digest: snapshot,
  };
  let renderedCategory: string | undefined;
  const result = await publishReproductionPackage({
    store,
    category: "stored-xss",
    renderer: {
      async render(input) {
        renderedCategory = input.category;
        return {
          manual: "Review the criteria before the steps\n",
          script: "print('reproduce')\n",
          reconstruction: {},
          evidence: { judgeEvidenceDigest: input.evidenceDigest },
          acceptanceCriteria: document,
          reproductionTemplate: {
            id: "reproduction-package",
            version: 1,
            digest: other,
          },
          auxiliaryFiles: {
            "agent-authored.json": JSON.stringify({
              steps: [{ expected: "agent observation" }],
            }),
          },
        };
      },
    },
    findingSnapshotDigest: snapshot,
    labSnapshotDigest: snapshot,
    labSetupDigest: setup,
    judgeResult: {
      status: "runtime-confirmed",
      judgeId: "canary-judge",
      proofKind: "nonce-canary",
      evidenceDigest,
    },
    reconstruction,
  });
  expect(renderedCategory).toBe("stored-xss");
  expect(result).toMatchObject({
    status: "runtime-confirmed",
    acceptanceCriteria: document,
    reproductionTemplate: { id: "reproduction-package", version: 1 },
  });
  const opened = await openReproductionPackage(store, result);
  expect(opened).toMatchObject({
    status: "opened",
    acceptanceCriteria: document,
    agentAuthored: { steps: [{ expected: "agent observation" }] },
  });
});

it("opens an older four-file package without template metadata or a sidecar", async () => {
  const { store, evidenceDigest } = await fixture(route);
  const reproductionPackageDigest = await store.putFiles({
    "manual.md": "Legacy manual\n",
    "reproduce.py": "print('legacy')\n",
    "lab.json": "{}",
    "evidence.json": JSON.stringify({ judgeEvidenceDigest: evidenceDigest }),
  });
  const result = verificationResultV1Schema.parse({
    status: "runtime-confirmed",
    judgeId: "canary-judge",
    proofKind: "nonce-canary",
    conditions: {},
    evidenceDigest,
    reproductionPackageDigest,
  });
  expect(await openReproductionPackage(store, result)).toMatchObject({
    status: "opened",
    manual: "Legacy manual\n",
    agentAuthored: null,
  });
});

it("leaves confirmation incomplete when a new package has no template reference", async () => {
  const { store, evidenceDigest } = await fixture(route);
  const result = await publishReproductionPackage({
    store,
    category: "stored-xss",
    renderer: {
      async render(input) {
        return {
          manual: "Unversioned manual\n",
          script: "print('unversioned')\n",
          reconstruction: {},
          evidence: { judgeEvidenceDigest: input.evidenceDigest },
        };
      },
    },
    findingSnapshotDigest: snapshot,
    labSnapshotDigest: snapshot,
    labSetupDigest: setup,
    judgeResult: {
      status: "runtime-confirmed",
      judgeId: "canary-judge",
      proofKind: "nonce-canary",
      evidenceDigest,
    },
    reconstruction,
  });
  expect(result).toMatchObject({ status: "incomplete", reason: "evidence" });
});

it("returns incomplete and writes no package for digest mismatch or unconfirmed result", async () => {
  const { store, evidenceDigest } = await fixture(route);
  for (const [findingSnapshotDigest, judgeResult] of [
    [
      other,
      {
        status: "runtime-confirmed",
        judgeId: "judge",
        proofKind: "nonce-canary",
        evidenceDigest,
      },
    ],
    [snapshot, { status: "contradicted", judgeId: "judge", evidenceDigest }],
  ] as const) {
    const result = await publishReproductionPackage({
      store,
      renderer: wordpressReproductionRenderer,
      category: "stored-xss",
      findingSnapshotDigest,
      labSnapshotDigest: snapshot,
      labSetupDigest: setup,
      judgeResult,
      reconstruction,
    });
    expect(result.status).toBe("incomplete");
  }
});

it("refuses a route with server-side commands or unavailable judge evidence", async () => {
  const { store, evidenceDigest } = await fixture({
    ...route,
    steps: [{ kind: "server", command: "wp option get" }],
  });
  const result = await publishReproductionPackage({
    store,
    renderer: wordpressReproductionRenderer,
    category: "stored-xss",
    findingSnapshotDigest: snapshot,
    labSnapshotDigest: snapshot,
    labSetupDigest: setup,
    judgeResult: {
      status: "runtime-confirmed",
      judgeId: "judge",
      proofKind: "nonce-canary",
      evidenceDigest,
    },
    reconstruction,
  });
  expect(result).toMatchObject({ status: "incomplete", reason: "evidence" });
});

it("treats a judge route from a different snapshot as incomplete", async () => {
  const { store, evidenceDigest } = await fixture({
    ...route,
    snapshotDigest: other,
  });
  const result = await publishReproductionPackage({
    store,
    renderer: wordpressReproductionRenderer,
    category: "stored-xss",
    findingSnapshotDigest: snapshot,
    labSnapshotDigest: snapshot,
    labSetupDigest: setup,
    judgeResult: {
      status: "runtime-confirmed",
      judgeId: "judge",
      proofKind: "nonce-canary",
      evidenceDigest,
    },
    reconstruction,
  });
  expect(result).toMatchObject({
    status: "incomplete",
    reason: "digest-mismatch",
  });
});
