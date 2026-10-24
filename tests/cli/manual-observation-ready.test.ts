import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { runCli, type CliProfile } from "../../src/cli/index.js";
import { openState } from "../../src/cli/state.js";
import { Review, MANUAL_LAB_RECEIPT_FILE } from "../../src/review/index.js";

const snapshot = `sha256:${"a".repeat(64)}`;
const setup = `sha256:${"b".repeat(64)}`;
const at = "2026-10-24T12:00:00.000Z";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function unused(): never {
  throw new Error("This fixture only exercises the review Lab CLI");
}

async function fixture(
  options: {
    launchFails?: boolean;
    mismatchPackage?: boolean;
    uncaptured?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "wbh-manual-ready-"));
  roots.push(root);
  const stateDirectory = join(root, "state");
  const state = await openState(stateDirectory, { clock: () => new Date(at) });
  const packageDigest = await state.store.putFiles({
    "reconstruction.json": "Synthetic captured observation package",
  });
  const selectedPackageDigest = options.mismatchPackage
    ? await state.store.putFiles({
        "reconstruction.json": "Unrelated Lab package",
      })
    : packageDigest;
  const observationDigest = await state.store.putFiles({
    "browser-dialog-observation.json": "Synthetic observer receipt",
  });
  const base = {
    schemaVersion: 1 as const,
    campaignId: "campaign-1",
    snapshotDigest: snapshot,
    occurredAt: "2026-10-24T11:00:00Z",
  };
  await state.ledger.append({
    ...base,
    identity: "finding-1",
    type: "finding-recorded",
    findingId: "finding-1",
    runId: "synthetic-run",
    category: "stored-xss",
  });
  await state.ledger.append({
    ...base,
    identity: "verification-1",
    type: "verification-finished",
    findingId: "finding-1",
    verificationId: "verification-1",
    labSetupDigest: setup,
    result: {
      status: "incomplete",
      reason: "observation",
      nextStep: "Review the captured dialog in a fresh Lab",
      evidenceDigest: observationDigest,
    },
    ...(options.uncaptured
      ? {}
      : { evidenceCapture: "harness-captured" as const }),
    artifacts: [{ kind: "review-lab-reconstruction", digest: packageDigest }],
  });
  let launchedPackage: string | null = null;
  let closed = false;
  const profile = {
    review: (current: typeof state) =>
      new Review({
        ledger: current.ledger,
        artifactStore: current.store,
        scopeEvaluator: {
          programmeIds: ["synthetic"],
          policyDigest: snapshot,
          assess: unused,
        },
        factsProvider: { load: unused },
        clock: current.clock,
      }),
    reviewLabPackage: async () => ({
      packageDigest: selectedPackageDigest,
      recipeDigest: observationDigest,
      evidenceDigest: observationDigest,
    }),
    reviewLab: async (
      _current: typeof state,
      input: { packageDigest: string },
    ) => {
      launchedPackage = input.packageDigest;
      if (options.launchFails) throw new Error("Lab could not reach ready");
      return {
        endpoint: "http://wordpress",
        networkName: "fresh-runsc-network",
        recorderIp: "172.20.0.2",
        receiverIp: "172.20.0.5",
        attackerAccounts: {},
        administrator: { password: "fixture-secret" },
        canaries: {},
        browserImage: "browser@sha256:test",
        async close() {
          closed = true;
        },
      };
    },
  } as unknown as CliProfile;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(
    [
      "lab",
      "up",
      "--for-review",
      "--campaign",
      "campaign-1",
      "--finding",
      "finding-1",
    ],
    { stateDirectory, profile, clock: () => new Date(at) },
    {
      stdout(line) {
        stdout.push(line);
        if (line.startsWith("review Lab ready")) process.emit("SIGINT");
      },
      stderr: (line) => stderr.push(line),
    },
  );
  return {
    state,
    packageDigest,
    launchedPackage,
    closed,
    code,
    stdout,
    stderr,
  };
}

it("seals a receipt only after the selected captured-observation Lab reaches ready", async () => {
  const f = await fixture();
  expect(f.code).toBe(0);
  expect(f.closed).toBe(true);
  expect(f.launchedPackage).toBe(f.packageDigest);
  const ready = f.state.ledger.readAll({
    type: "manual-observation-lab-ready",
  });
  expect(ready).toHaveLength(1);
  const event = ready[0]?.event;
  if (event?.type !== "manual-observation-lab-ready")
    throw new Error("Ready event missing");
  expect(event).toMatchObject({
    findingId: "finding-1",
    verificationId: "verification-1",
    snapshotDigest: snapshot,
    labSetupDigest: setup,
    packageDigest: f.packageDigest,
  });
  const receiptLine = f.stdout.find((line) =>
    line.startsWith("manual observation receipt: "),
  );
  expect(receiptLine).toContain(event.sessionReceiptDigest);
  expect(receiptLine).toContain(MANUAL_LAB_RECEIPT_FILE);
  expect(receiptLine).not.toContain("fixture-secret");
  const stored = await f.state.store.readFile(
    event.sessionReceiptDigest,
    MANUAL_LAB_RECEIPT_FILE,
    10_000,
  );
  expect(stored.status).toBe("resolved");
  if (stored.status !== "resolved") return;
  expect(JSON.parse(stored.bytes.toString())).toMatchObject({
    ref: {
      campaignId: "campaign-1",
      findingId: "finding-1",
      verificationId: "verification-1",
      snapshotDigest: snapshot,
    },
    packageDigest: f.packageDigest,
    sessionLabel: "fresh-runsc-network",
  });
  expect(stored.bytes.toString()).not.toContain("fixture-secret");
});

it("does not mint a receipt when Lab startup fails", async () => {
  const f = await fixture({ launchFails: true });
  expect(f.code).not.toBe(0);
  expect(
    f.state.ledger.readAll({ type: "manual-observation-lab-ready" }),
  ).toHaveLength(0);
  expect(f.stdout.join("\n")).not.toContain("manual observation receipt:");
});

it.each([{ mismatchPackage: true }, { uncaptured: true }])(
  "rejects an unbound or uncaptured package after Lab ready: %j",
  async (options) => {
    const f = await fixture(options);
    expect(f.code).not.toBe(0);
    expect(f.closed).toBe(true);
    expect(
      f.state.ledger.readAll({ type: "manual-observation-lab-ready" }),
    ).toHaveLength(0);
  },
);
