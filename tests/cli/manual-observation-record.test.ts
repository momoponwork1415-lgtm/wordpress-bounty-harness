import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { runCli, type CliProfile } from "../../src/cli/index.js";
import { openState } from "../../src/cli/state.js";
import {
  Review,
  MANUAL_OBSERVATION_CONFIGURATION_FILE,
  MANUAL_OBSERVATION_EVIDENCE_FILE,
  manualObservationConfigurationSchema,
  reviewExportV1Schema,
  reviewExportV2Schema,
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
  let observeLatestVersion:
    (() => Promise<{ version: string; observedAt: string } | null>) | null =
    null;
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
    stateDiffReader: () => ({ read: async () => null }),
    httpEvidenceReader: () => ({ read: async () => null }),
    verifierRecordReader: () => ({ read: unused }),
    latestVersion: async () =>
      observeLatestVersion === null ? null : observeLatestVersion(),
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
  const observe = (
    receipt: string,
    result: string,
    by = "owner",
    ...extra: string[]
  ) =>
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
      ...extra,
    );
  return {
    state,
    base,
    packageDigest,
    observationDigest,
    evidencePath,
    run,
    lab,
    observe,
    selectPackage: (digest: string) => {
      selectedPackage = digest;
    },
    onLatestVersion: (
      observe: () => Promise<{ version: string; observedAt: string } | null>,
    ) => {
      observeLatestVersion = observe;
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

it("records the observer's typed statement about the configuration (#578)", async () => {
  const f = await fixture();
  const receipt = receiptOf((await f.lab()).stdout);
  // Either flag alone, another value, or an empty reason is refused.
  for (const extra of [
    ["--ordinary-site", "yes"],
    ["--ordinary-site-reason", "Defaults"],
    ["--ordinary-site", "maybe", "--ordinary-site-reason", "Defaults"],
    ["--ordinary-site", "yes", "--ordinary-site-reason", "  "],
    ["--ordinary-site", "yes", "--ordinary-site-reason", "x".repeat(501)],
  ])
    expect(
      (await f.observe(receipt, "match", "owner", ...extra)).code,
    ).not.toBe(0);
  expect(
    f.state.ledger.readAll({ type: "manual-observation-recorded" }),
  ).toHaveLength(0);

  const recorded = await f.observe(
    receipt,
    "match",
    "owner",
    "--ordinary-site",
    "no",
    "--ordinary-site-reason",
    " Needs a developer-only debug setting ",
  );
  expect(recorded.code).toBe(0);
  expect(recorded.stdout.join("\n")).toContain("ordinary public site no");
  const event = f.state.ledger.readAll({
    type: "manual-observation-recorded",
  })[0]?.event;
  if (event?.type !== "manual-observation-recorded")
    throw new Error("Result event missing");
  // The ledger keeps the boolean and a digest; the reason is Private Evidence.
  expect(event.configuration).toEqual({
    ordinaryPublicSite: false,
    recordDigest: expect.stringMatching(/^sha256:/),
  });
  expect(event.artifacts).toContainEqual({
    kind: "manual-observation-configuration",
    digest: event.configuration!.recordDigest,
  });
  expect(JSON.stringify(event)).not.toContain("debug setting");
  const statement = await f.state.store.readJson(
    event.configuration!.recordDigest,
    MANUAL_OBSERVATION_CONFIGURATION_FILE,
    manualObservationConfigurationSchema,
    10_000,
  );
  expect(statement).toMatchObject({
    status: "resolved",
    value: {
      schemaVersion: 1,
      ordinaryPublicSite: false,
      reason: "Needs a developer-only debug setting",
    },
  });

  // Without the flags the statement is absent, not false.
  const second = receiptOf((await f.lab()).stdout);
  expect((await f.observe(second, "match")).code).toBe(0);
  const unstated = f.state.ledger
    .readAll({ type: "manual-observation-recorded" })
    .at(-1)?.event;
  expect(unstated).not.toHaveProperty("configuration");
});

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

async function exportBundle(
  f: Awaited<ReturnType<typeof fixture>>,
  version = "2",
) {
  const exported = await f.run(
    "review",
    "export",
    "--campaign",
    "campaign-1",
    "--finding",
    "finding-1",
    "--version",
    version,
  );
  expect(exported.code).toBe(0);
  return reviewExportV2Schema.parse(JSON.parse(exported.stdout.join("\n")));
}

it("shows the current result in the queue and opt-in v2 export while v1 remains strict", async () => {
  const f = await fixture();
  const receipt = receiptOf((await f.lab()).stdout);
  expect((await f.observe(receipt, "match")).code).toBe(0);
  const queue = await f.run("review", "--campaign", "campaign-1");
  expect(queue.stdout.join("\n")).toContain(
    "manual observation: match (evidence available;",
  );
  expect(queue.stdout.join("\n")).toContain("incomplete");
  expect(queue.stdout.join("\n")).not.toContain("runtime-confirmed");
  const v2 = await exportBundle(f);
  expect(v2.schema).toBe("review-export/v2");
  expect(v2.review.manualObservation).toMatchObject({
    result: "match",
    evidenceStatus: "available",
    sessionReceipt: { digest: receipt },
  });
  const legacy = await f.run(
    "review",
    "export",
    "--campaign",
    "campaign-1",
    "--finding",
    "finding-1",
  );
  expect(legacy.code).toBe(0);
  const v1 = reviewExportV1Schema.parse(JSON.parse(legacy.stdout.join("\n")));
  expect(v1.schema).toBe("review-export/v1");
  expect(v1.review).not.toHaveProperty("manualObservation");
});

it("hides the prior result when a second Lab is ready or verification is retried", async () => {
  const f = await fixture();
  const first = receiptOf((await f.lab()).stdout);
  expect((await f.observe(first, "match")).code).toBe(0);
  const second = receiptOf((await f.lab()).stdout);
  expect((await exportBundle(f)).review.manualObservation).toBeNull();
  expect(
    (await f.run("review", "--campaign", "campaign-1")).stdout.join("\n"),
  ).not.toContain("manual observation: match");
  expect((await f.observe(second, "mismatch")).code).toBe(0);
  expect((await exportBundle(f)).review.manualObservation?.result).toBe(
    "mismatch",
  );
  await f.state.ledger.append({
    ...f.base,
    identity: "verification-2",
    type: "verification-finished",
    findingId: "finding-1",
    verificationId: "verification-2",
    labSetupDigest: setup,
    result: { status: "incomplete", reason: "observation", nextStep: "Retry" },
  });
  expect((await exportBundle(f)).review.manualObservation).toBeNull();
});

it("marks a result unavailable when private evidence is missing", async () => {
  const f = await fixture();
  const receipt = receiptOf((await f.lab()).stdout);
  expect((await f.observe(receipt, "match")).code).toBe(0);
  const event = f.state.ledger.readAll({
    type: "manual-observation-recorded",
  })[0]?.event;
  if (event?.type !== "manual-observation-recorded")
    throw new Error("Result event missing");
  await rm(f.state.store.contentPath(event.evidenceDigest), {
    recursive: true,
  });
  expect((await exportBundle(f)).review.manualObservation).toMatchObject({
    result: "match",
    evidenceStatus: "unavailable",
  });
  expect(
    (await f.run("review", "--campaign", "campaign-1")).stdout.join("\n"),
  ).toContain("manual observation: match (evidence unavailable;");
});

it("hides an old Snapshot's result after a latest-version Finding is recorded", async () => {
  const f = await fixture();
  const receipt = receiptOf((await f.lab()).stdout);
  expect((await f.observe(receipt, "match")).code).toBe(0);
  await f.state.ledger.append({
    ...f.base,
    identity: "finding-latest",
    snapshotDigest: `sha256:${"c".repeat(64)}`,
    occurredAt: "2026-10-24T12:02:00Z",
    type: "finding-recorded",
    findingId: "finding-latest",
    runId: "synthetic-run-latest",
    category: "stored-xss",
    derivedFromFindingId: "finding-1",
    derivationKind: "latest-version",
  });
  expect((await exportBundle(f)).review.manualObservation).toBeNull();
  expect(
    (await f.run("review", "--campaign", "campaign-1")).stdout.join("\n"),
  ).not.toContain("manual observation: match");
});

it("does not attach a later attempt's result to an export assembled before it", async () => {
  const f = await fixture();
  await f.state.ledger.append({
    ...f.base,
    identity: "selection-1",
    type: "target-selected",
    selectionId: "plugin@1.0",
  });
  const first = receiptOf((await f.lab()).stdout);
  expect((await f.observe(first, "match")).code).toBe(0);
  f.onLatestVersion(async () => {
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
        nextStep: "Review again",
        evidenceDigest: f.observationDigest,
      },
      evidenceCapture: "harness-captured",
      artifacts: [
        { kind: "review-lab-reconstruction", digest: f.packageDigest },
      ],
    });
    const second = receiptOf((await f.lab()).stdout);
    expect((await f.observe(second, "mismatch")).code).toBe(0);
    return { version: "1.1", observedAt: at };
  });
  const bundle = await exportBundle(f);
  expect(bundle.verification?.verificationId).toBe("verification-1");
  expect(bundle.review.manualObservation).toBeNull();
});
