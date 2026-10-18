import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";
import { createVerificationConsumer } from "../../src/verification/consumer.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wbh-consumer-"));
  roots.push(root);
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: new PrivateArtifactStore({
      rootDirectory: join(root, "evidence"),
      maxEntries: 4,
      maxBytes: 1024,
    }),
  });
  const snapshotDigest = `sha256:${"a".repeat(64)}`;
  const finding = async (findingId: string) =>
    ledger.append({
      schemaVersion: 1,
      identity: `finding-${findingId}`,
      campaignId: "campaign-1",
      snapshotDigest,
      occurredAt: "2026-10-18T00:00:00.000Z",
      type: "finding-recorded",
      findingId,
      runId: "run-1",
      category: "stored-xss",
    });
  return { ledger, snapshotDigest, finding };
}

it("pulls one unverified Finding from the ledger and skips parked Findings", async () => {
  const { ledger, snapshotDigest, finding } = await fixture();
  for (const findingId of ["parked", "pending"]) {
    await finding(findingId);
  }
  await ledger.append({
    schemaVersion: 1,
    identity: "parked-1",
    campaignId: "campaign-1",
    snapshotDigest,
    occurredAt: "2026-10-18T00:00:01.000Z",
    type: "finding-parked",
    findingId: "parked",
    runId: "run-1",
    category: "stored-xss",
    reason: "outside-programme-boundary",
  });

  const consumer = createVerificationConsumer({
    ledger,
    promptVersion: "verifier-v7",
  });
  const pulled = await consumer.pullNext({
    campaignId: "campaign-1",
    snapshotDigest,
  });
  expect(pulled?.finding.findingId).toBe("pending");
  expect(
    await consumer.pullNext({ campaignId: "campaign-1", snapshotDigest }),
  ).toBeNull();
  pulled?.release();
});

it("retries only bounded incomplete verifications on the same Finding", async () => {
  const { ledger, snapshotDigest, finding } = await fixture();
  await finding("retry");
  const appendVerification = async (attempt: number) =>
    ledger.append({
      schemaVersion: 1,
      identity: `verification-${attempt}`,
      campaignId: "campaign-1",
      snapshotDigest,
      occurredAt: `2026-10-18T00:00:0${attempt}.000Z`,
      type: "verification-finished",
      verificationId: `verify-${attempt}`,
      findingId: "retry",
      labSetupDigest: `sha256:${"b".repeat(64)}`,
      promptVersion: "verifier-v7",
      attempt,
      result: {
        status: "incomplete" as const,
        reason: "recipe" as const,
        nextStep: "Retry",
      },
    });
  await appendVerification(1);
  const consumer = createVerificationConsumer({
    ledger,
    promptVersion: "verifier-v7",
  });
  const first = await consumer.pullNext({ campaignId: "campaign-1" });
  expect(first?.history).toHaveLength(1);
  first?.release();
  await appendVerification(2);
  const second = await consumer.pullNext({ campaignId: "campaign-1" });
  expect(second?.history).toHaveLength(2);
  second?.release();
  await appendVerification(3);
  expect(await consumer.pullNext({ campaignId: "campaign-1" })).toBeNull();
});

it("does not retry a failed precondition Lab solely because a scenario is configured", async () => {
  const { ledger, snapshotDigest, finding } = await fixture();
  await finding("failed-lab");
  await ledger.append({
    schemaVersion: 1,
    identity: "verification-lab-verify-1",
    campaignId: "campaign-1",
    snapshotDigest,
    occurredAt: "2026-10-18T00:00:01.000Z",
    type: "lab-provisioned",
    labId: "verify-1",
    status: "failed",
    purpose: "verification",
    failureStage: "provision",
    reason: "precondition",
  });
  await ledger.append({
    schemaVersion: 1,
    identity: "verify-1",
    campaignId: "campaign-1",
    snapshotDigest,
    occurredAt: "2026-10-18T00:00:02.000Z",
    type: "verification-finished",
    verificationId: "verify-1",
    findingId: "failed-lab",
    labSetupDigest: `sha256:${"b".repeat(64)}`,
    promptVersion: "verifier-v7",
    attempt: 1,
    result: { status: "incomplete", reason: "precondition", nextStep: "Retry" },
  });
  const consumer = createVerificationConsumer({
    ledger,
    promptVersion: "verifier-v7",
    currentScenarioId: async () => "ordinary-v1",
  });
  expect(await consumer.pullNext({ campaignId: "campaign-1" })).toBeNull();
});

it("keeps an attached reservation unavailable to another consumer", async () => {
  const { ledger, finding } = await fixture();
  await finding("shared");
  const attached = createVerificationConsumer({ ledger, promptVersion: "v7" });
  const background = createVerificationConsumer({
    ledger,
    promptVersion: "v7",
  });
  const release = attached.reserve({
    campaignId: "campaign-1",
    findingId: "shared",
  });
  expect(release).not.toBeNull();
  expect(await background.pullNext({ campaignId: "campaign-1" })).toBeNull();
  release?.();
  const ticket = await background.pullNext({ campaignId: "campaign-1" });
  expect(ticket?.finding.findingId).toBe("shared");
  ticket?.release();
});
