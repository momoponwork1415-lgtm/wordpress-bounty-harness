import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import type { LabHandle, LabProvisioner } from "../../src/lab/index.js";
import { Ledger } from "../../src/ledger/index.js";
import {
  Verification,
  VerifierTransportIncompleteError,
  type AttemptObserver,
  type LabStateObserver,
  type Verifier,
} from "../../src/verification/index.js";

const snapshotDigest = `sha256:${"a".repeat(64)}`;
const otherDigest = `sha256:${"c".repeat(64)}`;
const setupDigest = `sha256:${"b".repeat(64)}`;
/** A finished attempt waits for a person; no Harness code confirms it (#525). */
const AWAITING = {
  status: "incomplete",
  reason: "awaiting-human-observation",
} as const;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

type SyntheticFinding = {
  readonly findingId: string;
  readonly snapshotDigest: string;
  readonly impact: string;
};

async function fixture(
  options: {
    readonly attempt?: number;
    readonly retryOf?: string;
    readonly promptVersion?: string;
    readonly preexistingVerifications?: number;
    readonly impact?: string;
    readonly labSnapshotDigest?: string;
    readonly provision?: "ready" | "incomplete" | "throws";
    readonly verifier?: Verifier<SyntheticFinding, LabHandle>["attempt"];
    /** What the Harness attempt observer reports after a finished attempt. */
    readonly observer?: "recorded" | "missing-capture" | "throws";
    readonly teardown?: "removed" | "incomplete";
    readonly refute?: boolean;
    /** A Finding rebound to a separately frozen version for a negative control. */
    readonly fixedVersion?: boolean;
    /** Claim a fixed-version basis with an ordinary Finding. */
    readonly omitFixedLineage?: boolean;
    /** Attempt a comparison against another frozen snapshot. */
    readonly latestVersion?: boolean;
    readonly scenario?: { readonly id: string; readonly digest: string };
    /** Whole-Lab before / after capture around the Verifier run (#186); receives the fixture's store. */
    readonly stateObserver?: (
      store: PrivateArtifactStore,
    ) => LabStateObserver<LabHandle>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "wbh-verify-"));
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
  if (options.latestVersion === true || options.fixedVersion === true)
    await ledger.append({
      schemaVersion: 1,
      identity: "comparison-frozen",
      campaignId: "campaign-1",
      snapshotDigest: otherDigest,
      occurredAt: "2026-10-08T00:30:00Z",
      type: "snapshot-frozen",
      sourceDigest: otherDigest,
    });
  const derivedFixedVersion =
    options.fixedVersion === true && options.omitFixedLineage !== true;
  const findingSnapshotDigest =
    options.fixedVersion === true ? otherDigest : snapshotDigest;
  const finding: SyntheticFinding = {
    findingId: derivedFixedVersion ? "finding-fixed" : "finding-1",
    snapshotDigest: findingSnapshotDigest,
    impact: options.impact ?? "account-takeover",
  };
  if (derivedFixedVersion) {
    const original: SyntheticFinding = {
      ...finding,
      findingId: "finding-1",
      snapshotDigest,
    };
    const originalDigest = await store.putFiles({
      "finding.json": canonicalJson(original),
    });
    await ledger.append({
      schemaVersion: 1,
      identity: "finding-1",
      campaignId: "campaign-1",
      snapshotDigest,
      occurredAt: "2026-10-08T00:00:00Z",
      type: "finding-recorded",
      findingId: "finding-1",
      runId: "run-1",
      category: original.impact,
      artifacts: [{ kind: "finding", digest: originalDigest }],
    });
  }
  const findingDigest = await store.putFiles({
    "finding.json": canonicalJson(finding),
  });
  await ledger.append({
    schemaVersion: 1,
    identity: finding.findingId,
    campaignId: "campaign-1",
    snapshotDigest: findingSnapshotDigest,
    occurredAt: "2026-10-08T00:00:00Z",
    type: "finding-recorded",
    findingId: finding.findingId,
    runId: "run-1",
    category: finding.impact,
    ...(derivedFixedVersion
      ? {
          derivedFromFindingId: "finding-1",
          derivationKind: "fixed-version-control" as const,
        }
      : {}),
    artifacts: [{ kind: "finding", digest: findingDigest }],
  });
  for (let i = 0; i < (options.preexistingVerifications ?? 0); i++)
    await ledger.append({
      schemaVersion: 1,
      identity: `old-verification-${i}`,
      campaignId: "campaign-1",
      snapshotDigest: findingSnapshotDigest,
      occurredAt: "2026-10-08T00:15:00Z",
      type: "verification-finished",
      findingId: finding.findingId,
      verificationId: `old-verification-${i}`,
      labSetupDigest: setupDigest,
      result: { status: "incomplete", reason: "evidence", nextStep: "Inspect" },
    });
  const calls = { provision: 0, verifier: 0, teardown: 0, observer: 0 };
  const handle: LabHandle = {
    id: "lab-1",
    snapshotDigest: options.labSnapshotDigest ?? findingSnapshotDigest,
    setupDigest,
    endpoint: "http://lab",
    ...(options.scenario === undefined ? {} : { scenario: options.scenario }),
  };
  const lab: LabProvisioner<{ readonly name: string }, LabHandle> = {
    async provision() {
      calls.provision++;
      if (options.provision === "incomplete")
        return { status: "incomplete", reason: "provision", nextStep: "Retry" };
      if (options.provision === "throws")
        throw new RangeError("synthetic provision exception");
      return {
        status: "ready",
        handle: { ...handle, id: `lab-${calls.provision}` },
      };
    },
    async teardown() {
      calls.teardown++;
      if (options.teardown === "incomplete")
        return { status: "incomplete", reason: "cleanup", nextStep: "Remove" };
      return { status: "removed" };
    },
  };
  const verifier: Verifier<SyntheticFinding, LabHandle> = {
    async attempt(input) {
      calls.verifier++;
      if (options.verifier !== undefined) return options.verifier(input);
      return {
        status: "attempted",
        recipeDigest: await store.putFiles({ "recipe.json": "{}" }),
        ...(options.refute === true
          ? {
              refutationDigest: await store.putFiles({
                "refutation.md": "Synthetic refutation\n",
              }),
            }
          : {}),
      };
    },
  };
  let observationDigest: string | undefined;
  const observer: AttemptObserver<SyntheticFinding, LabHandle> = {
    async observe({ lab: observed, recipeDigest }) {
      calls.observer++;
      if (options.observer === "throws") throw new Error("Lab unreachable");
      if (options.observer === "missing-capture")
        return {
          status: "incomplete",
          reason: "evidence",
          nextStep: "The Harness captured no HTTP after setup",
        };
      observationDigest = await store.putFiles({
        "proxy-capture.jsonl": `${canonicalJson({
          lab: observed.id,
          recipe: recipeDigest,
        })}\n`,
      });
      return { status: "recorded", evidenceDigest: observationDigest };
    },
  };
  const verification = new Verification<
    SyntheticFinding,
    { readonly name: string },
    LabHandle
  >({
    ledger,
    store,
    lab,
    verifier,
    observer,
    ...(options.promptVersion === undefined
      ? {}
      : { promptVersion: options.promptVersion }),
    readFinding: (value) => value as SyntheticFinding,
    clock: () => new Date("2026-10-08T01:00:00Z"),
    ...(options.stateObserver === undefined
      ? {}
      : { stateObserver: options.stateObserver(store) }),
  });
  const basisKind =
    options.fixedVersion === true
      ? ("fixed-version" as const)
      : ("latest-version" as const);
  const result = await verification.verify({
    campaignId: "campaign-1",
    findingId: finding.findingId,
    verificationId: "verification-1",
    ...(options.attempt === undefined ? {} : { attempt: options.attempt }),
    ...(options.retryOf === undefined ? {} : { retryOf: options.retryOf }),
    snapshot: {
      digest:
        options.latestVersion === true || options.fixedVersion === true
          ? otherDigest
          : snapshotDigest,
    },
    ...(options.latestVersion === true || options.fixedVersion === true
      ? {
          basis: {
            kind: basisKind,
            findingSnapshotDigest,
          },
        }
      : {}),
    setup: { name: "synthetic" },
    campaignLabSetupDigest: setupDigest,
  });
  return { result, calls, ledger, store, observationDigest };
}

describe("verification public interface", () => {
  it("returns the newly recorded result after more than 1,000 older attempts", async () => {
    const { result } = await fixture({ preexistingVerifications: 1000 });
    expect(result).toMatchObject(AWAITING);
  }, 15_000);

  it("records retry lineage while returning the incomplete reason to its caller", async () => {
    const { result, ledger } = await fixture({
      attempt: 2,
      retryOf: "verification-previous",
      promptVersion: "verifier-v7",
      verifier: async () => ({
        status: "incomplete",
        reason: "recipe",
        nextStep: "Repair the route",
      }),
    });
    expect(result).toEqual({
      status: "incomplete",
      reason: "recipe",
      nextStep: "Repair the route",
    });
    expect(
      ledger.read({ type: "verification-finished" })[0]?.event,
    ).toMatchObject({
      verificationId: "verification-1",
      attempt: 2,
      retryOf: "verification-previous",
      promptVersion: "verifier-v7",
      result: { status: "incomplete", reason: "recipe" },
    });
  });

  it("hands the Verifier the reloaded Finding with its campaign's finding-recorded event", async () => {
    const inputs: Parameters<
      Verifier<SyntheticFinding, LabHandle>["attempt"]
    >[0][] = [];
    const { result } = await fixture({
      verifier: async (input) => {
        inputs.push(input);
        return { status: "attempted", recipeDigest: setupDigest };
      },
    });
    expect(result).toMatchObject(AWAITING);
    expect(inputs).toHaveLength(1);
    const input = inputs[0]!;
    expect(input.finding).toEqual({
      findingId: "finding-1",
      snapshotDigest,
      impact: "account-takeover",
    });
    expect(input.record).toMatchObject({
      type: "finding-recorded",
      campaignId: "campaign-1",
      findingId: "finding-1",
      snapshotDigest,
      runId: "run-1",
      category: "account-takeover",
    });
    // The record carries digest references only; the Finding body stays in Private Evidence.
    expect(input.record.artifacts).toEqual([
      { kind: "finding", digest: expect.stringMatching(/^sha256:/) },
    ]);
    expect(input.lab.snapshotDigest).toBe(input.finding.snapshotDigest);
  });

  it("keeps a sandbox transport failure incomplete with its own reason", async () => {
    const { result, calls } = await fixture({
      verifier: async () => {
        throw new VerifierTransportIncompleteError("sandbox");
      },
    });
    expect(result).toMatchObject({ status: "incomplete", reason: "sandbox" });
    expect(calls.observer).toBe(0);
  });

  it("records a finished attempt as awaiting a human observation, with the Harness record and a review Lab package (#525)", async () => {
    const { result, calls, ledger, store, observationDigest } = await fixture();
    expect(result).toEqual({
      ...AWAITING,
      nextStep:
        "Open a fresh review Lab, read the Harness capture and browser record, and record the human observation",
      evidenceDigest: observationDigest,
    });
    expect(calls).toEqual({
      provision: 1,
      verifier: 1,
      teardown: 1,
      observer: 1,
    });
    const finished = ledger.read({ type: "verification-finished" })[0]?.event;
    if (finished?.type !== "verification-finished")
      throw new Error("missing event");
    expect(finished.evidenceCapture).toBe("harness-captured");
    expect(finished.artifacts.map((artifact) => artifact.kind)).toEqual([
      "review-lab-reconstruction",
      "recipe",
    ]);
    const reconstruction = finished.artifacts.find(
      (artifact) => artifact.kind === "review-lab-reconstruction",
    );
    expect(
      await store.readJson(
        reconstruction!.digest,
        "lab.json",
        (await import("zod")).z.looseObject({}),
        4096,
      ),
    ).toMatchObject({
      status: "resolved",
      value: {
        schema: "review-lab-reconstruction/v1",
        snapshotDigest,
        labSetupDigest: setupDigest,
      },
    });
    // Nothing reaches confirmed or reproduced without a judge.
    expect(ledger.funnel("campaign-1")).toMatchObject({
      raw: 1,
      verified: 1,
      confirmed: 0,
      reproduced: 0,
      contradicted: 0,
    });
  });

  it("records the digest-pinned scenario on a verification Lab event", async () => {
    const scenario = { id: "ordinary-v1", digest: setupDigest };
    const { ledger } = await fixture({ scenario });
    expect(ledger.read({ type: "lab-provisioned" })[0]?.event).toMatchObject({
      purpose: "verification",
      scenario,
    });
  });

  it("keeps the Verifier's refutation beside the record without deciding from it", async () => {
    const { result } = await fixture({ refute: true });
    expect(result).toMatchObject({
      ...AWAITING,
      refutationDigest: expect.stringMatching(/^sha256:/),
    });
  });

  it.each(["other", "stored-xss", "sqli"])(
    "verifies a %s Finding without any impact-specific runner",
    async (impact) => {
      const { result, calls } = await fixture({ impact });
      expect(result).toMatchObject(AWAITING);
      expect(calls.verifier).toBe(1);
    },
  );

  it("never emits no-judge, contradicted, reproduced or runtime-confirmed for a new attempt", async () => {
    for (const options of [
      {},
      { impact: "other" },
      { fixedVersion: true, refute: true },
    ]) {
      const { result } = await fixture(options);
      expect(result).toMatchObject(AWAITING);
    }
  });

  it("keeps an attempt incomplete(evidence) when the Harness capture is missing", async () => {
    const { result, ledger } = await fixture({
      observer: "missing-capture",
      refute: true,
    });
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "evidence",
      nextStep: "The Harness captured no HTTP after setup",
      refutationDigest: expect.stringMatching(/^sha256:/),
    });
    const finished = ledger.read({ type: "verification-finished" })[0]?.event;
    if (finished?.type !== "verification-finished")
      throw new Error("missing event");
    expect(finished.evidenceCapture).toBeUndefined();
    expect(finished.artifacts.map((artifact) => artifact.kind)).toEqual([
      "recipe",
    ]);
  });

  it("maps an observer failure to incomplete evidence and still tears down", async () => {
    const { result, calls } = await fixture({ observer: "throws" });
    expect(result).toMatchObject({ status: "incomplete", reason: "evidence" });
    expect(calls.teardown).toBe(1);
  });

  it("rejects a self-declared fixed-version basis on an ordinary Finding", async () => {
    const { result, calls, ledger } = await fixture({
      fixedVersion: true,
      omitFixedLineage: true,
      refute: true,
    });
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "precondition",
    });
    expect(calls).toEqual({
      provision: 0,
      verifier: 0,
      teardown: 0,
      observer: 0,
    });
    expect(
      ledger.read({ type: "verification-finished" })[0]?.event,
    ).toMatchObject({ basis: { kind: "fixed-version" }, result });
  });

  it("records a fixed-version control like any attempt: a person compares it (#525)", async () => {
    const { result, ledger } = await fixture({
      fixedVersion: true,
      refute: true,
    });
    expect(result).toMatchObject(AWAITING);
    expect(
      ledger.read({ type: "verification-finished" })[0]?.event,
    ).toMatchObject({
      basis: { kind: "fixed-version", findingSnapshotDigest: otherDigest },
      evidenceCapture: "harness-captured",
      result,
    });
  });

  it("maps provision failure to incomplete provision", async () => {
    const { result, calls } = await fixture({ provision: "incomplete" });
    expect(result).toMatchObject({ status: "incomplete", reason: "provision" });
    expect(calls.verifier).toBe(0);
  });

  it("keeps a thrown provision exception in a lab-diagnostic artifact (#284)", async () => {
    const { result, calls, ledger, store } = await fixture({
      provision: "throws",
    });
    expect(result).toMatchObject({ status: "incomplete", reason: "provision" });
    expect(calls.verifier).toBe(0);
    const failed = ledger.read({ type: "verification-lab-failed" })[0]?.event;
    expect(failed).toMatchObject({
      reason: "provision",
      artifacts: [{ kind: "lab-diagnostic" }],
    });
    const file = await store.readFile(
      failed!.artifacts[0]!.digest,
      "lab-diagnostic.json",
      1024 * 1024,
    );
    if (file.status !== "resolved") throw new Error(file.status);
    expect(JSON.parse(file.bytes.toString("utf8"))).toEqual({
      failureStage: "provision",
      reason: "provision",
      nextStep: "Read the Lab diagnostic, then provision a fresh Lab",
      exception: {
        className: "RangeError",
        message: "synthetic provision exception",
      },
    });
  });

  it("maps a Verifier failure to incomplete recipe and still tears down", async () => {
    const { result, calls } = await fixture({
      verifier: async () => {
        throw new Error("provider failed");
      },
    });
    expect(result).toMatchObject({ status: "incomplete", reason: "recipe" });
    expect(calls.teardown).toBe(1);
  });

  it("passes the Verifier's own incomplete reason and next step", async () => {
    const { result, calls } = await fixture({
      verifier: async () => ({
        status: "incomplete",
        reason: "precondition",
        nextStep: "Enable the synthetic setting",
      }),
    });
    expect(result).toEqual({
      status: "incomplete",
      reason: "precondition",
      nextStep: "Enable the synthetic setting",
    });
    expect(calls.observer).toBe(0);
  });

  it("records a known next scenario for the retry queue", async () => {
    const { result, ledger } = await fixture({
      verifier: async () => ({
        status: "incomplete",
        reason: "precondition",
        nextStep: "Try the ordinary private post scenario",
        nextScenarioId: "private-post-v1",
      }),
    });
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "precondition",
      nextScenarioId: "private-post-v1",
    });
    expect(
      ledger.read({ type: "verification-finished" })[0]?.event,
    ).toMatchObject({
      result,
    });
  });

  it("does not wait for a human when the Lab is not removed", async () => {
    const { result } = await fixture({ teardown: "incomplete" });
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "cleanup",
      cleanupLabIds: ["lab-1"],
    });
  });

  it("rejects a cross-snapshot result even when a version basis is declared", async () => {
    const { result, ledger, calls } = await fixture({
      latestVersion: true,
      labSnapshotDigest: otherDigest,
    });
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "digest-mismatch",
    });
    expect(calls.verifier).toBe(0);
    expect(
      ledger.read({ findingId: "finding-1", type: "verification-finished" })[0]
        ?.event,
    ).toMatchObject({
      snapshotDigest: otherDigest,
      basis: { kind: "latest-version", findingSnapshotDigest: snapshotDigest },
      result: { status: "incomplete", reason: "digest-mismatch" },
    });
  });

  it("does not run a Verifier in a Lab built from another snapshot", async () => {
    const { result, calls } = await fixture({ labSnapshotDigest: otherDigest });
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "digest-mismatch",
    });
    expect(calls.verifier).toBe(0);
    expect(calls.teardown).toBe(1);
  });
});

describe("Lab state observer around the Verifier run", () => {
  const beforeDigest = `sha256:${"d".repeat(64)}`;

  it("captures before and after the Verifier, never hands the capture to the Verifier, and records digests by kind", async () => {
    const order: string[] = [];
    const verifierInputs: unknown[] = [];
    const digests: string[] = [];
    let store!: PrivateArtifactStore;
    const { result, ledger } = await fixture({
      stateObserver: (fixtureStore) => ({
        async before(lab) {
          store = fixtureStore;
          order.push(`before:${lab.id}`);
          digests.push(await store.putFiles({ "lab-state.json": '{"n":1}' }));
          return { digest: digests[0]!, state: { n: 1 } };
        },
        async after(lab, before) {
          order.push(`after:${lab.id}:${before.digest}`);
          digests.push(await store.putFiles({ "lab-state.json": '{"n":2}' }));
          digests.push(await store.putFiles({ "lab-state-diff.json": "{}" }));
          return {
            status: "captured",
            artifacts: [
              { kind: "lab-state-before", digest: before.digest },
              { kind: "lab-state-after", digest: digests[1]! },
              { kind: "lab-state-diff", digest: digests[2]! },
            ],
          };
        },
      }),
      verifier: async (input) => {
        order.push("verifier");
        verifierInputs.push(input);
        return {
          status: "attempted",
          recipeDigest: await store.putFiles({ "recipe.json": "{}" }),
        };
      },
    });
    expect(result).toMatchObject(AWAITING);
    expect(order).toEqual([
      "before:lab-1",
      "verifier",
      `after:lab-1:${digests[0]}`,
    ]);
    // The Verifier sees the campaign, the Finding, its ledger record, the Lab
    // handle and a way to restart the baseline; never the capture itself.
    expect(Object.keys(verifierInputs[0] as object).sort()).toEqual([
      "campaignId",
      "finding",
      "lab",
      "record",
      "restartObservation",
    ]);
    expect(JSON.stringify(verifierInputs[0])).not.toContain(digests[0]);
    const finished = ledger.read({ type: "verification-finished" })[0]?.event;
    if (finished?.type !== "verification-finished")
      throw new Error("missing event");
    expect(finished.labStateDiff).toEqual({ status: "captured" });
    expect(
      finished.artifacts.filter((a) => a.kind.startsWith("lab-state-")),
    ).toEqual([
      { kind: "lab-state-before", digest: digests[0] },
      { kind: "lab-state-after", digest: digests[1] },
      { kind: "lab-state-diff", digest: digests[2] },
    ]);
  });

  it("retakes the baseline when the Verifier restarts observation after its setup (#352)", async () => {
    const order: string[] = [];
    let captures = 0;
    let store!: PrivateArtifactStore;
    const { result, ledger } = await fixture({
      stateObserver: (fixtureStore) => ({
        async before() {
          store = fixtureStore;
          captures++;
          order.push(`before:${captures}`);
          const digest = await store.putFiles({
            "lab-state.json": `{"n":${captures}}`,
          });
          return { digest, state: { n: captures } };
        },
        async after(_lab, before) {
          order.push(
            `after:${before.state === null ? "" : JSON.stringify(before.state)}`,
          );
          return {
            status: "captured",
            artifacts: [
              { kind: "lab-state-before", digest: before.digest },
              {
                kind: "lab-state-after",
                digest: await store.putFiles({ "lab-state.json": '{"n":9}' }),
              },
              {
                kind: "lab-state-diff",
                digest: await store.putFiles({ "lab-state-diff.json": "{}" }),
              },
            ],
          };
        },
      }),
      verifier: async (input) => {
        order.push("setup");
        await input.restartObservation?.();
        order.push("route");
        return {
          status: "attempted",
          recipeDigest: await store.putFiles({ "recipe.json": "{}" }),
        };
      },
    });
    expect(result).toMatchObject(AWAITING);
    // Setup happens between the two baselines; the diff starts from the second.
    expect(order).toEqual([
      "before:1",
      "setup",
      "before:2",
      "route",
      'after:{"n":2}',
    ]);
    const finished = ledger.read({ type: "verification-finished" })[0]?.event;
    if (finished?.type !== "verification-finished")
      throw new Error("missing event");
    expect(finished.labStateDiff).toEqual({ status: "captured" });
  });

  it("downgrades a failed capture to a missing artifact with its stage and leaves the result alone", async () => {
    const first = await fixture({
      stateObserver: () => ({
        async before() {
          throw new Error("database unreachable");
        },
        async after() {
          throw new Error("unreachable");
        },
      }),
    });
    expect(first.result).toMatchObject(AWAITING);
    const event = first.ledger.read({ type: "verification-finished" })[0]
      ?.event;
    if (event?.type !== "verification-finished") throw new Error("missing");
    expect(event.labStateDiff).toEqual({
      status: "missing",
      reason: "before-capture",
    });
    expect(event.artifacts.some((a) => a.kind.startsWith("lab-state"))).toBe(
      false,
    );

    const second = await fixture({
      stateObserver: () => ({
        async before() {
          return { digest: beforeDigest, state: {} };
        },
        async after() {
          throw new Error("database unreachable");
        },
      }),
    });
    expect(second.result).toMatchObject(AWAITING);
    const other = second.ledger.read({ type: "verification-finished" })[0]
      ?.event;
    if (other?.type !== "verification-finished") throw new Error("missing");
    expect(other.labStateDiff).toEqual({
      status: "missing",
      reason: "after-capture",
    });

    // An observer that reports no capture at all leaves the event as before #186.
    const third = await fixture();
    const plain = third.ledger.read({ type: "verification-finished" })[0]
      ?.event;
    if (plain?.type !== "verification-finished") throw new Error("missing");
    expect(plain.labStateDiff).toBeUndefined();
  });

  it("captures the after state even when the Verifier throws", async () => {
    let afterCalls = 0;
    const { result } = await fixture({
      stateObserver: () => ({
        async before() {
          return { digest: beforeDigest, state: {} };
        },
        async after() {
          afterCalls++;
          return { status: "missing", reason: "after-capture" };
        },
      }),
      verifier: async () => {
        throw new VerifierTransportIncompleteError("sandbox");
      },
    });
    expect(result).toMatchObject({ status: "incomplete", reason: "sandbox" });
    expect(afterCalls).toBe(1);
  });
});
