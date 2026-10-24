import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { runCli, type CliProfile } from "../../src/cli/index.js";
import { openState } from "../../src/cli/state.js";
import {
  Review,
  MANUAL_OBSERVATION_EVIDENCE_FILE,
} from "../../src/review/index.js";

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
  throw new Error("The fixture only exercises the review CLI");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wbh-manual-result-"));
  roots.push(root);
  const stateDirectory = join(root, "state");
  const state = await openState(stateDirectory, { clock: () => new Date(at) });
  const packageDigest = await state.store.putFiles({
    "lab.json": "Synthetic reconstruction",
  });
  const observationDigest = await state.store.putFiles({
    "browser-dialog-observation.json": "Observed",
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
      nextStep: "Review in a new Lab",
      evidenceDigest: observationDigest,
    },
    evidenceCapture: "harness-captured",
    artifacts: [{ kind: "review-lab-reconstruction", digest: packageDigest }],
  });
  let selectedPackage = packageDigest;
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
      packageDigest: selectedPackage,
      recipeDigest: observationDigest,
      evidenceDigest: observationDigest,
    }),
    reviewLab: async () => ({
      endpoint: "http://wordpress",
      networkName: "fresh-runsc-network",
      recorderIp: "172.20.0.2",
      receiverIp: "172.20.0.5",
      attackerAccounts: {},
      administrator: {},
      canaries: {},
      browserImage: "browser@sha256:test",
      async close() {},
    }),
  } as unknown as CliProfile;
  const evidencePath = join(root, "manual-note.txt");
  await writeFile(evidencePath, "Human observed the dialog in the fresh Lab");
  const run = async (...args: string[]) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(
      args,
      { stateDirectory, profile, clock: () => new Date(at) },
      {
        stdout(line) {
          stdout.push(line);
          if (line.startsWith("review Lab ready")) process.emit("SIGINT");
        },
        stderr: (line) => stderr.push(line),
      },
    );
    return { code, stdout, stderr };
  };
  const lab = () =>
    run(
      "lab",
      "up",
      "--for-review",
      "--campaign",
      "campaign-1",
      "--finding",
      "finding-1",
    );
  const observe = (receipt: string, result: string, by = "owner") =>
    run(
      "review",
      "observe",
      "--campaign",
      "campaign-1",
      "--finding",
      "finding-1",
      "--receipt",
      receipt,
      "--result",
      result,
      "--evidence",
      evidencePath,
      "--by",
      by,
    );
  return {
    state,
    base,
    packageDigest,
    evidencePath,
    run,
    lab,
    observe,
    selectPackage: (digest: string) => {
      selectedPackage = digest;
    },
  };
}

function receiptOf(lines: readonly string[]): string {
  const receipt = /^manual observation receipt: (sha256:[a-f0-9]{64}) \(/m.exec(
    lines.join("\n"),
  )?.[1];
  if (receipt === undefined) throw new Error("Ready receipt missing");
  return receipt;
}

it.each(["match", "mismatch", "unavailable"] as const)(
  "records human %s independently from the incomplete judge verdict",
  async (result) => {
    const f = await fixture();
    const receipt = receiptOf((await f.lab()).stdout);
    const recorded = await f.observe(receipt, result);
    expect(recorded.code).toBe(0);
    const event = f.state.ledger.readAll({
      type: "manual-observation-recorded",
    })[0]?.event;
    if (event?.type !== "manual-observation-recorded")
      throw new Error("Result event missing");
    expect(event).toMatchObject({
      result,
      recordedBy: "owner",
      verificationId: "verification-1",
      snapshotDigest: snapshot,
      labSetupDigest: setup,
      packageDigest: f.packageDigest,
      sessionReceiptDigest: receipt,
    });
    expect(
      (
        await f.state.store.readFile(
          event.evidenceDigest,
          MANUAL_OBSERVATION_EVIDENCE_FILE,
          10_000,
        )
      ).status,
    ).toBe("resolved");
    expect(
      f.state.ledger.readAll({ type: "human-reproduction-recorded" }),
    ).toHaveLength(0);
    const judge = f.state.ledger.readAll({ type: "verification-finished" })[0]
      ?.event;
    expect(judge?.type === "verification-finished" && judge.result.status).toBe(
      "incomplete",
    );
  },
);

it("rejects an invented artifact without a ready ledger event and a nonhuman actor", async () => {
  const f = await fixture();
  const invented = await f.state.store.putFiles({
    "manual-lab-session.json": "invented",
  });
  expect((await f.observe(invented, "match")).code).not.toBe(0);
  const receipt = receiptOf((await f.lab()).stdout);
  expect((await f.observe(receipt, "match", "ai")).code).not.toBe(0);
  expect(
    f.state.ledger.readAll({ type: "manual-observation-recorded" }),
  ).toHaveLength(0);
});

it("binds a result to the latest ready receipt and rejects an older session", async () => {
  const f = await fixture();
  const first = receiptOf((await f.lab()).stdout);
  expect((await f.observe(first, "match")).code).toBe(0);
  const second = receiptOf((await f.lab()).stdout);
  expect(second).not.toBe(first);
  expect((await f.observe(first, "match")).code).not.toBe(0);
  expect((await f.observe(second, "mismatch")).code).toBe(0);
  expect(
    f.state.ledger.readAll({ type: "manual-observation-recorded" }),
  ).toHaveLength(2);
});

it("rejects a changed selected package and a receipt from a prior verification attempt", async () => {
  const f = await fixture();
  const receipt = receiptOf((await f.lab()).stdout);
  const other = await f.state.store.putFiles({
    "lab.json": "Unrelated package",
  });
  f.selectPackage(other);
  expect((await f.observe(receipt, "match")).code).not.toBe(0);
  f.selectPackage(f.packageDigest);
  await f.state.ledger.append({
    ...f.base,
    identity: "verification-2",
    type: "verification-finished",
    findingId: "finding-1",
    verificationId: "verification-2",
    labSetupDigest: setup,
    result: {
      status: "incomplete",
      reason: "observation",
      nextStep: "Try again",
    },
  });
  expect((await f.observe(receipt, "match")).code).not.toBe(0);
  expect(
    f.state.ledger.readAll({ type: "manual-observation-recorded" }),
  ).toHaveLength(0);
});
