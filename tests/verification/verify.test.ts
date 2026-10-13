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
  type Verifier,
} from "../../src/verification/index.js";

const snapshotDigest = `sha256:${"a".repeat(64)}`;
const otherDigest = `sha256:${"c".repeat(64)}`;
const setupDigest = `sha256:${"b".repeat(64)}`;
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
    readonly impact?: string;
    readonly labSnapshotDigest?: string;
    readonly provision?: "ready" | "incomplete";
    readonly verifier?: Verifier<SyntheticFinding, LabHandle>["attempt"];
    readonly judge?:
      "observed" | "not-observed" | "incomplete-captured" | "throws";
    readonly teardown?: "removed" | "incomplete";
    readonly refute?: boolean;
    /** A Finding rebound to a separately frozen version for a negative control. */
    readonly fixedVersion?: boolean;
    /** Claim a fixed-version basis with an ordinary Finding. */
    readonly omitFixedLineage?: boolean;
    /** Exercise a malformed fixed-version control without the earlier route. */
    readonly omitReferenceRoute?: boolean;
    /** The Harness recorder captured the rerun even though the canary did not fire. */
    readonly negativeCapture?: boolean;
    /** Attempt a comparison against another frozen snapshot. */
    readonly latestVersion?: boolean;
    readonly scenario?: { readonly id: string; readonly digest: string };
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
  const calls = { provision: 0, verifier: 0, teardown: 0 };
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
      return options.provision === "incomplete"
        ? { status: "incomplete", reason: "provision", nextStep: "Retry" }
        : { status: "ready", handle };
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
    judges: {
      for: (candidate) =>
        candidate.impact === "account-takeover" ? judge : null,
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
  });
  const basisKind =
    options.fixedVersion === true
      ? ("fixed-version" as const)
      : ("latest-version" as const);
  const result = await verification.verify({
    campaignId: "campaign-1",
    findingId: finding.findingId,
    verificationId: "verification-1",
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
          referenceRoute: {
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
          },
        }
      : {}),
  });
  return { result, calls, ledger, negativeCaptureDigest, store, rendered };
}

describe("verification public interface", () => {
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

  it("returns no-judge without provisioning a Lab or calling the Verifier", async () => {
    const { result, calls } = await fixture({ impact: "other" });
    expect(result).toMatchObject({ status: "incomplete", reason: "no-judge" });
    expect(calls).toEqual({ provision: 0, verifier: 0, teardown: 0 });
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
