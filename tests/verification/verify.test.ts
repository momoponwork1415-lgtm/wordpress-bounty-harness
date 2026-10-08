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
    readonly judge?: "observed" | "not-observed" | "throws";
    readonly teardown?: "removed" | "incomplete";
    readonly refute?: boolean;
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
  const finding: SyntheticFinding = {
    findingId: "finding-1",
    snapshotDigest,
    impact: options.impact ?? "account-takeover",
  };
  const findingDigest = await store.putFiles({
    "finding.json": canonicalJson(finding),
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
    category: finding.impact,
    artifacts: [{ kind: "finding", digest: findingDigest }],
  });
  const calls = { provision: 0, verifier: 0, teardown: 0 };
  const handle: LabHandle = {
    id: "lab-1",
    snapshotDigest: options.labSnapshotDigest ?? snapshotDigest,
    setupDigest,
    endpoint: "http://lab",
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
  const judge: Judge<SyntheticFinding, LabHandle> = {
    id: "synthetic-canary",
    async observe({ lab: observed }) {
      if (options.judge === "throws") throw new Error("Lab unreachable");
      if (options.judge === "not-observed") return { status: "not-observed" };
      return {
        status: "observed",
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
      async render() {
        return {
          manual: "Synthetic manual\n",
          script: "print('synthetic')\n",
          reconstruction: {},
          evidence: {},
        };
      },
    },
    clock: () => new Date("2026-10-08T01:00:00Z"),
  });
  const result = await verification.verify({
    campaignId: "campaign-1",
    findingId: "finding-1",
    verificationId: "verification-1",
    snapshot: { digest: snapshotDigest },
    setup: { name: "synthetic" },
    campaignLabSetupDigest: setupDigest,
    reconstruction: { note: "synthetic" },
  });
  return { result, calls, ledger };
}

describe("verification public interface", () => {
  it("confirms only from the judge observation and records a reproduction package", async () => {
    const { result, calls, ledger } = await fixture();
    expect(result).toMatchObject({
      status: "runtime-confirmed",
      judgeId: "synthetic-canary",
      proofKind: "nonce-canary",
    });
    expect(calls).toEqual({ provision: 1, verifier: 1, teardown: 1 });
    expect(ledger.funnel("campaign-1")).toMatchObject({
      raw: 1,
      verified: 1,
      confirmed: 1,
    });
  });

  it("keeps a Verifier success claim without a judge observation incomplete", async () => {
    const { result } = await fixture({ judge: "not-observed" });
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "observation",
    });
  });

  it("records contradicted only when the Verifier refutes and the judge sees no canary", async () => {
    const { result } = await fixture({ judge: "not-observed", refute: true });
    expect(result).toMatchObject({
      status: "contradicted",
      judgeId: "synthetic-canary",
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
