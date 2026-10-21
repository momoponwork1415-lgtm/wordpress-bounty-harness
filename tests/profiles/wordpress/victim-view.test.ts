import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { canonicalJson } from "../../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../../src/ledger/index.js";
import type { WordPressLabHandle } from "../../../src/profiles/wordpress/lab/index.js";
import { createWordPressVictimViewObserver } from "../../../src/profiles/wordpress/verification/victim-view.js";
import { exportReviewBundle } from "../../../src/review/index.js";

const snapshot = `sha256:${"a".repeat(64)}`;
const labSetup = `sha256:${"b".repeat(64)}`;
const png = Buffer.from("89504e470d0a1a0a76696374696d", "hex");
const webm = Buffer.from("1a45dfa3766964656f", "hex");
const sha256 = (bytes: Buffer) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it("keeps victim screenshots and WebM with their sha256 and review export lists them (#439)", async () => {
  const root = await mkdtemp(join(tmpdir(), "wbh-victim-view-"));
  directories.push(root);
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "private-evidence"),
    maxEntries: 20,
    maxBytes: 1024 * 1024,
  });
  const asked: unknown[] = [];
  const observer = createWordPressVictimViewObserver({
    store,
    lab: {
      async recordVictimView(_lab, victim) {
        asked.push(victim);
        return {
          status: "recorded",
          role: "administrator",
          visits: [
            { status: "recorded", path: "/?p=8", screenshot: png, video: webm },
            {
              status: "unavailable",
              path: "/?p=9",
              failureCode: "victim-login",
            },
          ],
        };
      },
    },
  });
  const lab = {
    snapshotDigest: snapshot,
    setupDigest: labSetup,
  } as WordPressLabHandle;
  const victim = { role: "administrator", paths: ["/?p=8", "/?p=9"] };
  const plain = await store.putFiles({ "route.json": canonicalJson({}) });
  expect(await observer.record(lab, plain)).toEqual([]);

  const recipe = await store.putFiles({
    "route.json": canonicalJson({ steps: [], victim }),
  });
  const artifacts = await observer.record(lab, recipe);
  expect(asked).toEqual([victim]);
  expect(artifacts).toEqual([
    { kind: "victim-view", digest: expect.any(String) },
  ]);
  const directory = store.contentPath(artifacts[0]!.digest);
  expect(await readdir(directory)).toHaveLength(3);
  expect(await readFile(join(directory, "victim-1.webm"))).toEqual(webm);
  expect(
    JSON.parse(await readFile(join(directory, "victim-view.json"), "utf8")),
  ).toMatchObject({
    purpose: "review-material",
    recipeDigest: recipe,
    role: "administrator",
    visits: [
      {
        path: "/?p=8",
        screenshot: { file: "victim-1.png", sha256: sha256(png) },
        video: { file: "victim-1.webm", sha256: sha256(webm) },
      },
      { status: "unavailable", path: "/?p=9", failureCode: "victim-login" },
    ],
  });

  // The artifact rides on verification-finished; review export gives its path.
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: store,
  });
  const base = {
    schemaVersion: 1 as const,
    campaignId: "campaign-1",
    snapshotDigest: snapshot,
    findingId: "finding-1",
  };
  await ledger.append({
    ...base,
    identity: "finding-1",
    occurredAt: "2026-10-21T00:00:00Z",
    type: "finding-recorded",
    runId: "run-1",
    category: "stored-xss",
  });
  await ledger.append({
    ...base,
    identity: "verification-1",
    occurredAt: "2026-10-21T01:00:00Z",
    type: "verification-finished",
    verificationId: "verification-1",
    labSetupDigest: labSetup,
    result: { status: "incomplete", reason: "observation", nextStep: "-" },
    artifacts: [...artifacts],
  });
  const bundle = await exportReviewBundle({
    ledger,
    store,
    campaignId: "campaign-1",
    findingId: "finding-1",
  });
  expect(bundle.privateEvidence.artifacts).toContainEqual({
    kind: "victim-view",
    digest: artifacts[0]!.digest,
    path: directory,
  });
});
