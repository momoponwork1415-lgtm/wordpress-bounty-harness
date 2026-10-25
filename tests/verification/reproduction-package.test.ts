import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { openReproductionPackage } from "../../src/review/reproduction-package.js";
import { verificationResultV1Schema } from "../../src/verification/reproduction-package.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function storeFixture() {
  const directory = await mkdtemp(join(tmpdir(), "reproduction-"));
  directories.push(directory);
  return new PrivateArtifactStore({
    rootDirectory: join(directory, "private-evidence"),
    maxEntries: 10,
    maxBytes: 100_000,
  });
}

// The judges that sealed these packages were deleted (#525); the recorded ones stay readable.
it("opens a package an earlier judge sealed for a recorded runtime-confirmed result", async () => {
  const store = await storeFixture();
  const evidenceDigest = await store.putFiles({
    "confirmed-route.json": "{}",
  });
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

it("opens no package for a result that waits for a human observation", async () => {
  const store = await storeFixture();
  const result = verificationResultV1Schema.parse({
    status: "incomplete",
    reason: "awaiting-human-observation",
    nextStep: "Record the human observation",
  });
  expect(await openReproductionPackage(store, result)).toEqual({
    status: "unavailable",
  });
});
