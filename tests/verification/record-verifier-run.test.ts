import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";
import {
  recordVerifierRun,
  type VerifierRunReceipt,
} from "../../src/verification/index.js";

const snapshotDigest = `sha256:${"a".repeat(64)}`;
const receiptDigest = `sha256:${"b".repeat(64)}`;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wbh-verifier-run-"));
  directories.push(root);
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 10,
    maxBytes: 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: store,
  });
  return { store, ledger };
}

describe("recordVerifierRun", () => {
  it("stores the whole receipt privately and appends a verifier-run-finished event by digest", async () => {
    const { store, ledger } = await fixture();
    // A transport may hand over more than the ledger needs; only named fields reach the event.
    const receipt = {
      digest: receiptDigest,
      runId: "verify-finding-1-run",
      targetSnapshotDigest: snapshotDigest,
      terminal: "incomplete",
      providerLimit: "quota",
      transcript: "private detail that must not reach the ledger",
    } satisfies VerifierRunReceipt & { transcript: string };
    await recordVerifierRun({
      ledger,
      store,
      clock: () => new Date("2026-10-08T01:00:00Z"),
      campaignId: "campaign-1",
      findingId: "finding-1",
      promptDigest: snapshotDigest,
      receipt,
    });
    const events = ledger.read({ type: "verifier-run-finished" });
    expect(events).toHaveLength(1);
    const event = events[0]?.event;
    if (event?.type !== "verifier-run-finished") throw new Error("missing");
    expect(event).toMatchObject({
      identity: `verifier-${receiptDigest}`,
      campaignId: "campaign-1",
      snapshotDigest,
      occurredAt: "2026-10-08T01:00:00.000Z",
      findingId: "finding-1",
      runId: "verify-finding-1-run",
      promptDigest: snapshotDigest,
      terminal: "incomplete",
      providerLimit: "quota",
      artifacts: [{ kind: "native-run-receipt", digest: event.receiptDigest }],
    });
    expect(JSON.stringify(event)).not.toContain("private detail");
    const saved = await store.readFile(
      event.receiptDigest,
      "receipt.json",
      4096,
    );
    expect(saved.status).toBe("resolved");
    if (saved.status !== "resolved") return;
    expect(JSON.parse(saved.bytes.toString("utf8"))).toEqual(receipt);
  });

  it("omits optional fields it was not given and refuses a second run with the same receipt", async () => {
    const { store, ledger } = await fixture();
    const input = {
      ledger,
      store,
      clock: () => new Date("2026-10-08T01:00:00Z"),
      campaignId: "campaign-1",
      findingId: "finding-1",
      promptDigest: snapshotDigest,
      receipt: {
        digest: receiptDigest,
        runId: "verify-finding-1-run",
        targetSnapshotDigest: snapshotDigest,
        terminal: "completed" as const,
      },
    };
    await recordVerifierRun(input);
    const event = ledger.read({ type: "verifier-run-finished" })[0]?.event;
    if (event?.type !== "verifier-run-finished") throw new Error("missing");
    // Canaries were removed with the judges (ADR 0040); old events keep the field.
    expect(event).not.toHaveProperty("canaryIssued");
    expect(event.providerLimit).toBeUndefined();
    await expect(
      recordVerifierRun({ ...input, promptDigest: receiptDigest }),
    ).rejects.toThrow("Verifier run identity conflict");
  });
});
