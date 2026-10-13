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
  type Judge,
  type LabStateObserver,
  type Verifier,
} from "../../src/verification/index.js";

const snapshotDigest = `sha256:${"a".repeat(64)}`;
const otherDigest = `sha256:${"c".repeat(64)}`;
const setupDigest = `sha256:${"b".repeat(64)}`;
const fixedReferenceRoute = {
  role: "subscriber",
  defaultSettings: true,
  steps: [
    {
      kind: "http",
      method: "GET",
      path: "/same-route",
      expected: "The canary fires",
    },
  ],
};
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
    readonly provision?: "ready" | "incomplete";
    readonly verifier?: Verifier<SyntheticFinding, LabHandle>["attempt"];
    readonly judge?:
      | "observed"
      | "not-observed"
      | "incomplete"
      | "incomplete-captured"
      | "throws";
    readonly reproducer?: "observed" | "incomplete" | "not-observed";
    /** A false effect visible only in the Lab changed by the agent. */
    readonly agentOnlyEffect?: boolean;
    readonly replaySetupMismatch?: boolean;
    readonly teardown?: "removed" | "incomplete";
    readonly refute?: boolean;
    /** A Finding rebound to a separately frozen version for a negative control. */
    readonly fixedVersion?: boolean;
    /** Claim a fixed-version basis with an ordinary Finding. */
    readonly omitFixedLineage?: boolean;
    /** Exercise a malformed fixed-version control without the earlier route. */
    readonly omitReferenceRoute?: boolean;
    readonly omitOriginObserved?: boolean;
    /** The Harness recorder captured the rerun even though the canary did not fire. */
    readonly negativeCapture?: boolean;
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
    if (
      options.reproducer === "not-observed" &&
      options.omitOriginObserved !== true
    ) {
      const observedRouteDigest = await store.putFiles({
        "confirmed-route.json": canonicalJson(fixedReferenceRoute),
      });
      await ledger.append({
        schemaVersion: 1,
        identity: "verification-origin",
        campaignId: "campaign-1",
        snapshotDigest,
        occurredAt: "2026-10-08T00:15:00Z",
        type: "verification-finished",
        findingId: "finding-1",
        verificationId: "verification-origin",
        labSetupDigest: setupDigest,
        result: {
          status: "runtime-confirmed",
          judgeId: "synthetic-canary",
          proofKind: "nonce-canary",
          evidenceDigest: observedRouteDigest,
          reproductionPackageDigest: observedRouteDigest,
        },
      });
    }
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
  const calls = { provision: 0, verifier: 0, teardown: 0 };
  const agentTouched = new Set<string>();
  const replayedLabIds: string[] = [];
  let rendered:
    | {
        readonly category: string;
        readonly judgeId: string;
        readonly conditions: Readonly<Record<string, string>>;
      }
    | undefined;
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
      const fresh = {
        ...handle,
        id: `lab-${calls.provision}`,
        setupDigest:
          options.replaySetupMismatch === true && calls.provision > 1
            ? otherDigest
            : handle.setupDigest,
      };
      return options.provision === "incomplete"
        ? { status: "incomplete", reason: "provision", nextStep: "Retry" }
        : { status: "ready", handle: fresh };
    },
    async seedCanaries() {
      return { status: "seeded", digest: setupDigest };
    },
    async teardown() {
      calls.teardown++;
      return options.teardown === "incomplete"
        ? { status: "incomplete", reason: "cleanup", nextStep: "Remove" }
        : { status: "removed" };
    },
  };
  const verifier: Verifier<SyntheticFinding, LabHandle> = {
    async attempt(input) {
      calls.verifier++;
      if (options.agentOnlyEffect === true) agentTouched.add(input.lab.id);
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
  const negativeCaptureDigest =
    options.negativeCapture === true
      ? await store.putFiles({
          "proxy-capture.jsonl": `${canonicalJson({
            request: { method: "GET", path: "/same-route" },
            response: { status: 200, body: "Canary absent" },
          })}\n`,
        })
      : undefined;
  const judge: Judge<SyntheticFinding, LabHandle> = {
    id: "synthetic-canary",
    async observe({ lab: observed }) {
      if (options.judge === "throws") throw new Error("Lab unreachable");
      if (options.judge === "incomplete")
        return {
          status: "incomplete",
          reason: "observation",
          nextStep: "No canary was observed",
        };
      if (options.judge === "incomplete-captured")
        return {
          status: "incomplete",
          reason: "observation",
          nextStep: "Replay every step on the fixed version",
          ...(negativeCaptureDigest === undefined
            ? {}
            : {
                evidenceCapture: "harness-captured" as const,
                evidenceDigest: negativeCaptureDigest,
              }),
        };
      if (options.judge === "not-observed")
        return negativeCaptureDigest === undefined
          ? { status: "not-observed" }
          : {
              status: "not-observed",
              evidenceCapture: "harness-captured",
              evidenceDigest: negativeCaptureDigest,
            };
      return {
        status: "observed",
        conditions: { attackerRole: "subscriber", reachedRole: "synthetic" },
        evidenceDigest: await store.putFiles({
          "confirmed-route.json": canonicalJson({
            snapshotDigest: observed.snapshotDigest,
            labSetupDigest: observed.setupDigest,
          }),
          "canary.json": "{}",
        }),
      };
    },
  };
  const verification = new Verification<
    SyntheticFinding,
    { readonly name: string },
    LabHandle,
    { readonly note: string }
  >({
    ledger,
    store,
    lab,
    verifier,
    ...(options.promptVersion === undefined
      ? {}
      : { promptVersion: options.promptVersion }),
    judges: {
      for: (candidate) =>
        candidate.impact === "account-takeover" ? judge : null,
      ...(options.reproducer === undefined
        ? {}
        : {
            reproducer: {
              id: "synthetic-standard-v1",
              async observe({ lab: replayLab }) {
                replayedLabIds.push(replayLab.id);
                if (options.reproducer === "incomplete")
                  return {
                    status: "incomplete" as const,
                    reason: "observation" as const,
                    nextStep: "Capture the effect",
                  };
                const evidenceDigest = await store.putFiles({
                  "reproduced-route.json": canonicalJson({
                    snapshotDigest: findingSnapshotDigest,
                    labSetupDigest: setupDigest,
                  }),
                  "proxy-capture.jsonl": "synthetic captured response\n",
                  "structured-output.json": "{}",
                });
                return options.agentOnlyEffect === true &&
                  !agentTouched.has(replayLab.id)
                  ? {
                      status: "incomplete" as const,
                      reason: "observation" as const,
                      nextStep: "The effect was present only in the agent Lab",
                    }
                  : options.reproducer === "observed"
                    ? {
                        status: "observed" as const,
                        evidenceDigest,
                        conditions: { observedVia: "synthetic" },
                      }
                    : { status: "not-observed" as const, evidenceDigest };
              },
            },
          }),
    },
    readFinding: (value) => value as SyntheticFinding,
    renderer: {
      async render(input) {
        rendered = {
          category: input.category,
          judgeId: input.judgeId,
          conditions: input.conditions,
        };
        return {
          manual: "Synthetic manual\n",
          script: "print('synthetic')\n",
          reconstruction: {},
          evidence: {},
          reproductionTemplate: {
            id: "synthetic-reproduction",
            version: 1,
            digest: setupDigest,
          },
        };
      },
    },
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
    reconstruction: { note: "synthetic" },
    ...(options.fixedVersion === true && options.omitReferenceRoute !== true
      ? {
          referenceRoute: fixedReferenceRoute,
        }
      : {}),
  });
  return {
    result,
    calls,
    ledger,
    negativeCaptureDigest,
    store,
    rendered,
    replayedLabIds,
  };
}

describe("verification public interface", () => {
  it("returns the newly recorded verdict after more than 1,000 older attempts", async () => {
    const { result } = await fixture({ preexistingVerifications: 1000 });
    expect(result.status).toBe("runtime-confirmed");
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

  it("keeps a sandbox transport failure incomplete with its own reason", async () => {
    const { result } = await fixture({
      verifier: async () => {
        throw new VerifierTransportIncompleteError("sandbox");
      },
    });
    expect(result).toMatchObject({ status: "incomplete", reason: "sandbox" });
  });
  it("confirms only from the judge observation and records a reproduction package", async () => {
    const { result, calls, ledger, rendered } = await fixture();
    expect(result).toMatchObject({
      status: "runtime-confirmed",
      judgeId: "synthetic-canary",
      proofKind: "nonce-canary",
    });
    expect(result).toMatchObject({
      conditions: { attackerRole: "subscriber", reachedRole: "synthetic" },
      reproductionTemplate: {
        id: "synthetic-reproduction",
        version: 1,
        digest: setupDigest,
      },
    });
    expect(calls).toEqual({ provision: 1, verifier: 1, teardown: 1 });
    expect(rendered).toEqual({
      category: "account-takeover",
      judgeId: "synthetic-canary",
      conditions: { attackerRole: "subscriber", reachedRole: "synthetic" },
    });
    expect(ledger.read({ type: "lab-provisioned" })[0]?.event).toMatchObject({
      purpose: "verification",
      status: "ready",
      snapshotDigest,
    });
    expect(
      ledger.read({ type: "verification-finished" })[0]?.event,
    ).toMatchObject({
      result: {
        reproductionTemplate: {
          id: "synthetic-reproduction",
          version: 1,
          digest: setupDigest,
        },
      },
    });
    expect(ledger.funnel("campaign-1")).toMatchObject({
      raw: 1,
      verified: 1,
      confirmed: 1,
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

  it("keeps a Verifier success claim without a judge observation incomplete", async () => {
    const { result } = await fixture({ judge: "not-observed" });
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "observation",
    });
  });

  it.each([false, true])(
    "keeps an original Finding incomplete when the Verifier refutes without a canary (captured: %s)",
    async (negativeCapture) => {
      const { result, ledger, negativeCaptureDigest } = await fixture({
        judge: "not-observed",
        refute: true,
        negativeCapture,
      });
      expect(result).toMatchObject({
        status: "incomplete",
        reason: "observation",
        refutationDigest: expect.stringMatching(/^sha256:/),
        ...(negativeCapture ? { evidenceDigest: negativeCaptureDigest } : {}),
      });
      expect(
        ledger.read({ type: "verification-finished" })[0]?.event,
      ).toMatchObject({
        result,
        ...(negativeCapture ? { evidenceCapture: "harness-captured" } : {}),
      });
    },
  );

  it("rejects a self-declared fixed-version basis on an ordinary Finding", async () => {
    const { result, calls, ledger } = await fixture({
      fixedVersion: true,
      omitFixedLineage: true,
      judge: "not-observed",
      refute: true,
      negativeCapture: true,
    });
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "precondition",
    });
    expect(calls).toEqual({ provision: 0, verifier: 0, teardown: 0 });
    expect(
      ledger.read({ type: "verification-finished" })[0]?.event,
    ).toMatchObject({ basis: { kind: "fixed-version" }, result });
  });

  it("contradicts a fixed-version control only with a Harness-captured negative rerun", async () => {
    const { result, ledger, negativeCaptureDigest, store } = await fixture({
      fixedVersion: true,
      judge: "not-observed",
      refute: true,
      negativeCapture: true,
    });
    expect(result).toMatchObject({
      status: "contradicted",
      judgeId: "synthetic-canary",
      evidenceDigest: negativeCaptureDigest,
    });
    if (negativeCaptureDigest === undefined)
      throw new Error("The fixture did not store its negative capture");
    expect(
      await store.readFile(negativeCaptureDigest, "proxy-capture.jsonl", 1024),
    ).toMatchObject({ status: "resolved" });
    expect(
      ledger.read({ type: "verification-finished" })[0]?.event,
    ).toMatchObject({
      basis: { kind: "fixed-version", findingSnapshotDigest: otherDigest },
      evidenceCapture: "harness-captured",
      result,
    });
    expect(
      ledger.read({ type: "finding-recorded", findingId: "finding-fixed" })[0]
        ?.event,
    ).toMatchObject({
      snapshotDigest: otherDigest,
      derivedFromFindingId: "finding-1",
      derivationKind: "fixed-version-control",
    });
  });

  it("keeps a fixed-version control incomplete when its negative rerun was not captured", async () => {
    const { result, ledger } = await fixture({
      fixedVersion: true,
      judge: "not-observed",
      refute: true,
    });
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "observation",
      refutationDigest: expect.stringMatching(/^sha256:/),
    });
    expect(
      ledger.read({ type: "verification-finished" })[0]?.event,
    ).toMatchObject({
      basis: { kind: "fixed-version" },
      result,
    });
  });

  it("keeps a partial fixed-version replay incomplete and records its capture digest", async () => {
    const { result, ledger, store, negativeCaptureDigest } = await fixture({
      fixedVersion: true,
      judge: "incomplete-captured",
      refute: true,
      negativeCapture: true,
    });
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "observation",
      evidenceDigest: negativeCaptureDigest,
      refutationDigest: expect.stringMatching(/^sha256:/),
    });
    if (negativeCaptureDigest === undefined)
      throw new Error("The fixture did not store its captured prefix");
    expect(
      await store.readFile(negativeCaptureDigest, "proxy-capture.jsonl", 1024),
    ).toMatchObject({ status: "resolved" });
    expect(
      ledger.read({ type: "verification-finished" })[0]?.event,
    ).toMatchObject({
      result,
      evidenceCapture: "harness-captured",
    });
  });

  it("keeps a captured fixed-version control incomplete without the earlier confirmed route", async () => {
    const { result, ledger, negativeCaptureDigest } = await fixture({
      fixedVersion: true,
      omitReferenceRoute: true,
      judge: "not-observed",
      refute: true,
      negativeCapture: true,
    });
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "observation",
      evidenceDigest: negativeCaptureDigest,
      refutationDigest: expect.stringMatching(/^sha256:/),
    });
    expect(
      ledger.read({ type: "verification-finished" })[0]?.event,
    ).toMatchObject({
      basis: { kind: "fixed-version" },
      evidenceCapture: "harness-captured",
      result,
    });
  });

  it("confirms from the judge even when the Verifier wrote a refutation", async () => {
    const { result } = await fixture({ refute: true });
    expect(result.status).toBe("runtime-confirmed");
  });

  it("returns incomplete no-judge when no runner exists", async () => {
    const { result, calls } = await fixture({ impact: "other" });
    expect(result).toMatchObject({ status: "incomplete", reason: "no-judge" });
    expect(calls).toEqual({ provision: 0, verifier: 0, teardown: 0 });
  });

  it("records reproduced separately from a judge confirmation", async () => {
    const { result, calls, ledger, replayedLabIds } = await fixture({
      impact: "other",
      reproducer: "observed",
    });
    expect(result).toMatchObject({
      status: "reproduced",
      reproducerId: "synthetic-standard-v1",
      proofKind: "captured-script-observation",
      negativeControl: "pending-fixed-version",
    });
    expect(calls).toEqual({ provision: 2, verifier: 1, teardown: 2 });
    expect(replayedLabIds).toEqual(["lab-2"]);
    expect(ledger.read({ type: "lab-provisioned" })).toHaveLength(2);
    expect(ledger.funnel("campaign-1")).toMatchObject({
      confirmed: 0,
      reproduced: 1,
    });
  });

  it("cannot reproduce an effect left by the agent in its own Lab", async () => {
    const { result, calls, replayedLabIds, ledger } = await fixture({
      impact: "other",
      reproducer: "observed",
      agentOnlyEffect: true,
    });
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "observation",
    });
    expect(calls).toEqual({ provision: 2, verifier: 1, teardown: 2 });
    expect(replayedLabIds).toEqual(["lab-2"]);
    expect(ledger.funnel("campaign-1")).toMatchObject({ reproduced: 0 });
  });

  it("rejects a replay Lab with a different setup digest and tears it down", async () => {
    const { result, calls, replayedLabIds } = await fixture({
      impact: "other",
      reproducer: "observed",
      replaySetupMismatch: true,
    });
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "digest-mismatch",
    });
    expect(calls).toEqual({ provision: 2, verifier: 1, teardown: 2 });
    expect(replayedLabIds).toEqual([]);
  });

  it("does not promote an incomplete standard observation", async () => {
    const { result } = await fixture({
      impact: "other",
      reproducer: "incomplete",
    });
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "observation",
    });
  });

  it("does not contradict a fixed-version control without a nonce judge", async () => {
    const { result } = await fixture({
      impact: "other",
      reproducer: "not-observed",
      fixedVersion: true,
    });
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "observation",
    });
  });

  it("does not use script absence to contradict after the nonce judge is incomplete", async () => {
    const { result } = await fixture({
      judge: "incomplete",
      reproducer: "not-observed",
      fixedVersion: true,
    });
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "observation",
    });
  });

  it("keeps a fixed snapshot incomplete even without an observed original route", async () => {
    const { result } = await fixture({
      impact: "other",
      reproducer: "not-observed",
      fixedVersion: true,
      omitOriginObserved: true,
    });
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "observation",
    });
  });

  it("maps provision failure to incomplete provision", async () => {
    const { result, calls } = await fixture({ provision: "incomplete" });
    expect(result).toMatchObject({ status: "incomplete", reason: "provision" });
    expect(calls.verifier).toBe(0);
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
    const { result } = await fixture({
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

  it("maps a judge failure to incomplete observation", async () => {
    const { result } = await fixture({ judge: "throws" });
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "observation",
    });
  });

  it("does not confirm when the Lab is not removed", async () => {
    const { result } = await fixture({ teardown: "incomplete" });
    expect(result).toMatchObject({ status: "incomplete", reason: "cleanup" });
  });

  it("rejects a cross-snapshot verdict even when a version basis is declared", async () => {
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

  it("does not judge a Lab built from another snapshot", async () => {
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
    expect(result.status).toBe("runtime-confirmed");
    expect(order).toEqual([
      "before:lab-1",
      "verifier",
      `after:lab-1:${digests[0]}`,
    ]);
    // The Verifier sees the campaign, the Finding and the Lab handle only.
    expect(Object.keys(verifierInputs[0] as object).sort()).toEqual([
      "campaignId",
      "finding",
      "lab",
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

  it("downgrades a failed capture to a missing artifact with its stage and leaves the verdict alone", async () => {
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
    expect(first.result.status).toBe("runtime-confirmed");
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
    expect(second.result.status).toBe("runtime-confirmed");
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
