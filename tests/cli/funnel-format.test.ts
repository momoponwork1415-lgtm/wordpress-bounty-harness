import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { formatFunnel } from "../../src/cli/index.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function common(identity: string) {
  return {
    schemaVersion: 1 as const,
    identity,
    campaignId: "campaign-1",
    snapshotDigest: `sha256:${"a".repeat(64)}`,
    occurredAt: "2026-10-23T00:00:00Z",
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wbh-funnel-format-"));
  roots.push(root);
  const artifactStore = new PrivateArtifactStore({
    rootDirectory: join(root, "artifacts"),
    maxEntries: 4,
    maxBytes: 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore,
  });
  await ledger.append({
    ...common("start-current"),
    type: "discovery-run-started",
    runId: "current",
    labAttached: false,
    history: { mode: "none" },
    configuration: { promptVariant: "wp2shell-bounty-v8" },
  });
  await ledger.append({
    ...common("lab-failed"),
    type: "verification-lab-failed",
    findingId: "finding-1",
    verificationId: "verification-1",
    reason: "provision",
  });
  return ledger;
}

describe("funnel display of retired metrics", () => {
  it("keeps current Lab failures visible without empty historical classifications", async () => {
    const ledger = await fixture();
    const output = formatFunnel(ledger.funnel("campaign-1")).join("\n");

    expect(output).toContain("verification Lab failed 1");
    expect(output).not.toContain("incomplete(depth)");
    expect(output).not.toContain("by Lab:");
    expect(output).not.toContain("by arm:");
  });

  it("still displays depth, attached Labs and ablation arms when recorded history exists", async () => {
    const ledger = await fixture();
    await ledger.append({
      ...common("start-historical"),
      type: "discovery-run-started",
      runId: "historical",
      labId: "historical-lab",
      labAttached: true,
      history: { mode: "none" },
      configuration: {
        promptVariant: "wp2shell-bounty-v6",
        axis: "history",
        arm: "a",
      },
    });
    await ledger.append({
      ...common("finish-historical"),
      type: "discovery-run-finished",
      runId: "historical",
      outcome: "failed",
      reason: "depth",
      costUsd: "unavailable",
      wallTimeMs: 1,
    });
    const output = formatFunnel(ledger.funnel("campaign-1")).join("\n");

    expect(output).toContain("incomplete(depth) 1");
    expect(output).toContain(
      "by Lab: attached runs 1 findings 0 confirmed 0; none runs 1 findings 0 confirmed 0; verification Lab failed 1",
    );
    expect(output).toContain("by arm:\n  history:a: runs 1");
  });
});
