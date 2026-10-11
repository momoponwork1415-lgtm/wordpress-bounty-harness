import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, expect, test } from "vitest";

import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";

const script = fileURLToPath(
  new URL("../../scripts/report-wordpress-preconditions.mjs", import.meta.url),
);
const snapshotDigest = `sha256:${"a".repeat(64)}`;
let state: string;
let database: DatabaseSync;
let store: PrivateArtifactStore;
let sequence: number;

beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), "wbh-preconditions-"));
  database = new DatabaseSync(join(state, "ledger.sqlite"));
  database.exec(`CREATE TABLE ledger_events (
    sequence INTEGER PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_json TEXT NOT NULL
  )`);
  store = new PrivateArtifactStore({
    rootDirectory: join(state, "private-evidence"),
    maxEntries: 64,
    maxBytes: 1024 * 1024,
  });
  sequence = 0;
});

afterEach(async () => {
  database.close();
  await rm(state, { recursive: true, force: true });
});

function event(value: Record<string, unknown>, campaignId = "campaign-a") {
  database
    .prepare("INSERT INTO ledger_events VALUES (?, ?, ?, ?)")
    .run(
      ++sequence,
      campaignId,
      value.type as string,
      JSON.stringify({ campaignId, ...value }),
    );
}

async function finding(
  findingId: string,
  precondition: string,
  campaignId = "campaign-a",
): Promise<string> {
  const digest = await store.putFiles({
    "finding.json": JSON.stringify({
      findingId,
      snapshotDigest,
      configurationPrecondition: precondition,
    }),
  });
  event(
    {
      type: "finding-recorded",
      findingId,
      snapshotDigest,
      artifacts: [{ kind: "finding", digest }],
    },
    campaignId,
  );
  return digest;
}

function verification(
  findingId: string,
  result: Record<string, unknown>,
  campaignId = "campaign-a",
) {
  event(
    { type: "verification-finished", findingId, snapshotDigest, result },
    campaignId,
  );
}

function report(...args: string[]) {
  const stdout = execFileSync(
    process.execPath,
    [script, "--state", state, ...args],
    { encoding: "utf8" },
  );
  return { stdout, value: JSON.parse(stdout) as Record<string, unknown> };
}

test("ranks next steps and open private prerequisites without printing their text", async () => {
  await finding(
    "private-post-finding",
    "A private post is viewed by an authorized user in a secondary language",
  );
  await finding("notification-finding", "A notification has been prepared");
  verification("private-post-finding", {
    status: "incomplete",
    reason: "precondition",
    nextStep: "catalogue に無い前提: private post requires secret example text",
  });
  verification("private-post-finding", {
    status: "incomplete",
    reason: "precondition",
    nextStep: "catalogue に無い前提",
  });
  verification("notification-finding", {
    status: "incomplete",
    reason: "precondition",
    nextStep: "approved-comment-v1: 承認済みコメント",
  });
  verification("notification-finding", { status: "runtime-confirmed" });

  const { stdout, value } = report();
  expect(value).toMatchObject({
    verificationEvents: 4,
    preconditionAttempts: 3,
    preconditionFindings: 2,
    openPreconditionFindings: 1,
    unavailablePrivateFindings: 0,
    verifierObservedPreconditions: "not-inspected",
    nextSteps: [
      { kind: "catalogue-missing-unspecified", attempts: 2, findings: 1 },
      { kind: "scenario:approved-comment-v1", attempts: 1, findings: 1 },
    ],
    openFindingDeclaredPrerequisites: [
      { kind: "language-or-translation", attempts: 2, findings: 1 },
      { kind: "private-post", attempts: 2, findings: 1 },
    ],
  });
  expect(value).not.toHaveProperty("nextStepPrerequisites");
  expect(value).not.toHaveProperty("openPrerequisites");
  expect(stdout).not.toContain("secret example text");
  expect(stdout).not.toContain("authorized user");
  expect(stdout).not.toContain("承認済みコメント");
});

test("filters one campaign and marks tampered Private Evidence unavailable", async () => {
  const digest = await finding("finding-a", "A private page exists");
  verification("finding-a", {
    status: "incomplete",
    reason: "precondition",
    nextStep: "catalogue に無い前提",
  });
  await finding("finding-b", "A comment is displayed", "campaign-b");
  verification(
    "finding-b",
    {
      status: "incomplete",
      reason: "precondition",
      nextStep: "catalogue に無い前提",
    },
    "campaign-b",
  );
  const artifact = join(
    state,
    "private-evidence",
    digest,
    "content",
    "finding.json",
  );
  const original = await readFile(artifact, "utf8");
  await writeFile(artifact, original.replace("private page", "public page"));

  expect(report("--campaign", "campaign-a").value).toMatchObject({
    campaign: "campaign-a",
    verificationEvents: 1,
    preconditionAttempts: 1,
    openPreconditionFindings: 1,
    unavailablePrivateFindings: 1,
    openFindingDeclaredPrerequisites: [
      { kind: "private-evidence-unavailable", attempts: 1, findings: 1 },
    ],
  });
  expect(report("--campaign", "campaign-b").value).toMatchObject({
    campaign: "campaign-b",
    verificationEvents: 1,
    unavailablePrivateFindings: 0,
    openFindingDeclaredPrerequisites: [
      { kind: "comment", attempts: 1, findings: 1 },
    ],
  });
});

test("a scenario display name does not become another prerequisite", async () => {
  await finding("scenario-finding", "A notification exists");
  verification("scenario-finding", {
    status: "incomplete",
    reason: "precondition",
    nextStep: "approved-comment-v1: 承認済みコメント",
  });
  expect(report().value).toMatchObject({
    nextSteps: [
      { kind: "scenario:approved-comment-v1", attempts: 1, findings: 1 },
    ],
    openFindingDeclaredPrerequisites: [
      { kind: "notification-state", attempts: 1, findings: 1 },
    ],
  });
});

test("separates a declared private page from unspecified private content", async () => {
  await finding("page-finding", "A private page is viewed by a reader");
  await finding("content-finding", "Private content is available");
  verification("page-finding", {
    status: "incomplete",
    reason: "precondition",
    nextStep: "catalogue に無い前提: unrelated prose about comments",
  });
  verification("content-finding", {
    status: "incomplete",
    reason: "precondition",
    nextStep: "catalogue に無い前提",
  });
  expect(report().value).toMatchObject({
    nextSteps: [
      { kind: "catalogue-missing-unspecified", attempts: 2, findings: 2 },
    ],
    openFindingDeclaredPrerequisites: [
      { kind: "private-content-unspecified", attempts: 1, findings: 1 },
      { kind: "private-page", attempts: 1, findings: 1 },
    ],
  });
});
