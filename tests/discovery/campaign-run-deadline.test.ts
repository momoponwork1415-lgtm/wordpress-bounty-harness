import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import {
  createNativeRunReceipt,
  defineAgentRuntimeProfile,
  ProviderAttachmentStore,
  runDiscoveryCampaign,
} from "../../src/discovery/index.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";
import { admitWordPressFinding } from "../../src/profiles/wordpress/discovery/finding.js";

const digest = `sha256:${"a".repeat(64)}`;
const profile = defineAgentRuntimeProfile({
  id: "synthetic",
  transportKind: "codex-native/v1",
  sandboxImageDigest: digest,
  requestedModelId: "gpt-6.1-sol",
  requestedEffort: "high",
  codexCliVersion: "0.161.0",
  bundledCatalogDigest: digest,
  authenticationMethod: "host-private-bearer",
  cyberAccessProgram: "standard",
  serviceTier: "priority",
  subagent: { modelId: "unavailable", effort: "unavailable" },
});
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

/** Each run takes ten minutes of wall time on a clock the campaign owns. */
async function campaign(options: { readonly runDeadlineMs?: number }) {
  const root = await mkdtemp(join(tmpdir(), "wbh-deadline-"));
  directories.push(root);
  const attachments = new ProviderAttachmentStore(join(root, "reports"));
  const evidence = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 10,
    maxBytes: 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: evidence,
  });
  let now = Date.parse("2026-10-08T07:00:00Z");
  const seen: { startedAt: string; expiresAt: string }[] = [];
  await runDiscoveryCampaign({
    campaignId: "campaign-1",
    labId: "lab-1",
    input: {
      schemaVersion: 1,
      snapshotDigest: digest,
      trustBoundary: { version: "v1", text: "Low privilege only" },
      programmeBoundary: { version: "v1", text: "Synthetic boundary" },
      modelProfileDigest: profile.digest,
      promptDigest: digest,
      stopRules: { maxRuns: 3, noFindingRuns: 3 },
      lab: { setupDigest: digest },
      history: { mode: "none" },
    },
    historyFraction: 0,
    ledger,
    attachments,
    evidence,
    admitFinding: admitWordPressFinding,
    ...(options.runDeadlineMs === undefined
      ? {}
      : { runDeadlineMs: options.runDeadlineMs }),
    executor: {
      async execute(run) {
        const startedAt = new Date(now).toISOString();
        seen.push({ startedAt, expiresAt: run.expiresAt });
        now += 10 * 60_000;
        const attachment = await attachments.put(
          "findings",
          Buffer.from(
            JSON.stringify({ findings: [], examined: "s", unexamined: "n" }),
          ),
        );
        return {
          attachment,
          receipt: createNativeRunReceipt({
            runId: run.runId,
            targetSnapshotDigest: run.targetSnapshotDigest,
            profile: run.profile,
            terminal: "completed",
            reason: "unavailable",
            startedAt,
            completedAt: new Date(now).toISOString(),
            reportArtifactDigest: attachment.digest,
          }),
        };
      },
    },
    plannedRuns: Array.from({ length: 3 }, (_, index) => ({
      configuration: {
        promptVariant: "short-objective",
        assignmentUnit: "plugin",
      },
      run: {
        runId: `run-${index}`,
        targetSnapshotDigest: digest,
        profile,
        prompt: "Synthetic objective",
        sourceDirectory: "/private/source",
        sourceTree: { digest, entries: 1, bytes: 1 },
        lab: {
          endpoint: "http://wordpress",
          networkName: "lab-internal",
          internalIp: "172.20.0.2",
        },
        // Planned once for the whole campaign, as the CLI does today.
        expiresAt: "2026-10-08T07:30:00Z",
      },
    })),
    clock: () => new Date(now),
  });
  return seen;
}

it("gives every run a deadline measured from its own start, so late runs are not born expired", async () => {
  const seen = await campaign({ runDeadlineMs: 30 * 60_000 });
  expect(seen.map((run) => run.expiresAt)).toEqual([
    "2026-10-08T07:30:00.000Z",
    "2026-10-08T07:40:00.000Z",
    "2026-10-08T07:50:00.000Z",
  ]);
  for (const run of seen)
    expect(Date.parse(run.expiresAt) - Date.parse(run.startedAt)).toBe(
      30 * 60_000,
    );
});

it("keeps the planned deadline when the campaign is given none", async () => {
  const seen = await campaign({});
  expect(new Set(seen.map((run) => run.expiresAt))).toEqual(
    new Set(["2026-10-08T07:30:00Z"]),
  );
});

it("rejects a deadline that is not a positive whole number of milliseconds", async () => {
  await expect(campaign({ runDeadlineMs: 0 })).rejects.toThrow(
    "Invalid run deadline",
  );
});
