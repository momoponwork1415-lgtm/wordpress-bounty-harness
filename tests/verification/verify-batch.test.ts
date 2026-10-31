import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyNextFinding } from "../../src/cli/pipeline.js";
import { canonicalJson } from "../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import type { LabHandle, LabProvisioner } from "../../src/lab/index.js";
import { Ledger } from "../../src/ledger/index.js";
import type { Snapshot } from "../../src/snapshot/index.js";
import {
  Verification,
  type HeldVerificationLab,
  type Verifier,
} from "../../src/verification/index.js";

// #699: 同じ plugin・同じ Snapshot の Finding を 1 つの Lab で順に回す。

const digestOf = (c: string) => `sha256:${c.repeat(64)}`;
const SNAPSHOT = digestOf("a");
const OTHER = digestOf("c");
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

type Finding = { readonly findingId: string; readonly snapshotDigest: string };

async function fixture(
  options: {
    readonly snapshots?: Readonly<Record<string, string>>;
    /** The verifier's answer for each Finding; default a finished attempt. */
    readonly attempt?: Verifier<Finding, LabHandle>["attempt"];
    /** False makes the Lab untrusted before the given Finding's turn. */
    readonly ready?: (findingId: string) => boolean;
    readonly hold?: boolean;
    /** The Lab started but its baseline did not read back. */
    readonly seedFailure?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "wbh-verify-batch-"));
  directories.push(root);
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 50,
    maxBytes: 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: store,
  });
  const ids = ["finding-a", "finding-b", "finding-c"];
  for (const findingId of ids) {
    const snapshotDigest = options.snapshots?.[findingId] ?? SNAPSHOT;
    const digest = await store.putFiles({
      "finding.json": canonicalJson({ findingId, snapshotDigest }),
    });
    await ledger.append({
      schemaVersion: 1,
      identity: findingId,
      campaignId: "campaign-1",
      snapshotDigest,
      occurredAt: "2026-10-31T00:00:00Z",
      type: "finding-recorded",
      findingId,
      runId: "run-1",
      category: "stored-xss",
      artifacts: [{ kind: "finding", digest }],
    });
  }
  const calls = {
    provision: 0,
    teardown: 0,
    attempts: [] as { findingId: string; position?: number; size?: number }[],
    ready: [] as string[],
  };
  const lab: LabProvisioner<{ readonly name: string }, LabHandle> = {
    async provision(snapshot) {
      calls.provision++;
      if (options.seedFailure === true)
        return {
          status: "incomplete",
          reason: "provision",
          nextStep: "Read the Lab diagnostic",
          stage: "seed",
          labId: "lab-seed",
          baseline: { id: "synthetic-baseline-v1", digest: digestOf("e") },
        };
      return {
        status: "ready",
        handle: {
          id: `lab-${calls.provision}`,
          snapshotDigest: (snapshot as { digest: string }).digest,
          setupDigest: digestOf("b"),
          endpoint: "http://lab",
          baseline: { id: "synthetic-baseline-v1", digest: digestOf("e") },
        },
      };
    },
    async teardown() {
      calls.teardown++;
      return { status: "removed" };
    },
  };
  const verifier: Verifier<Finding, LabHandle> = {
    async attempt(input) {
      calls.attempts.push({
        findingId: input.finding.findingId,
        ...(input.batch === undefined
          ? {}
          : { position: input.batch.position, size: input.batch.size }),
      });
      if (options.attempt !== undefined) return options.attempt(input);
      return {
        status: "attempted",
        recipeDigest: await store.putFiles({
          "recipe.json": canonicalJson({ finding: input.finding.findingId }),
        }),
      };
    },
    async readyForNextAttempt(_lab, next) {
      calls.ready.push(next.findingId);
      return options.ready?.(next.findingId) ?? true;
    },
  };
  const verification = new Verification<Finding, { name: string }, LabHandle>({
    ledger,
    store,
    lab,
    verifier,
    observer: {
      async observe({ recipeDigest }) {
        return {
          status: "recorded",
          evidenceDigest: await store.putFiles({
            "proxy-capture.jsonl": `${canonicalJson({ recipeDigest })}\n`,
          }),
        };
      },
    },
    readFinding: (value) => value as Finding,
    promptVersion: "skill/v1",
    clock: () => new Date("2026-10-31T01:00:00Z"),
  });
  const held: HeldVerificationLab<LabHandle>[] = [];
  let next = 0;
  const run = (findingIds: readonly string[]) =>
    verifyNextFinding({
      campaignId: "campaign-1",
      only: { findingIds },
      ledger,
      newId: () => `verification-${++next}`,
      loadSnapshot: async (digest) => ({ digest }) as unknown as Snapshot,
      setupFor: () => ({ name: "synthetic" }),
      verification,
      ...(options.hold === true
        ? {
            hold: async (lab: HeldVerificationLab<LabHandle>) => {
              held.push(lab);
            },
          }
        : {}),
    });
  return { ledger, calls, run, held };
}

describe("one Lab for several Findings of one Snapshot (#699)", () => {
  it("provisions once and records each Finding's verification on the same Lab", async () => {
    const { ledger, calls, run } = await fixture();
    const summary = await run(["finding-a", "finding-b"]);
    expect(calls.provision).toBe(1);
    expect(calls.teardown).toBe(1);
    expect(calls.attempts).toEqual([
      { findingId: "finding-a", position: 1, size: 2 },
      { findingId: "finding-b", position: 2, size: 2 },
    ]);
    // Only the second Finding needs the Lab readied after another's attempt.
    expect(calls.ready).toEqual(["finding-b"]);
    const finished = ledger
      .readAll({ type: "verification-finished" })
      .map(({ event }) => event);
    expect(
      finished.map((event) =>
        event.type === "verification-finished"
          ? [event.findingId, event.verificationId]
          : [],
      ),
    ).toEqual([
      ["finding-a", "verification-1"],
      ["finding-b", "verification-2"],
    ]);
    const labs = ledger
      .readAll({ type: "lab-provisioned" })
      .map(({ event }) => event);
    expect(labs).toHaveLength(2);
    for (const [index, event] of labs.entries())
      expect(event).toMatchObject({
        identity: `verification-lab-verification-${index + 1}`,
        labId: "lab-1",
        status: "ready",
        purpose: "verification",
        setupDigest: digestOf("b"),
        baseline: { id: "synthetic-baseline-v1", digest: digestOf("e") },
      });
    expect(summary).toMatchObject({
      findingId: "finding-a",
      verificationId: "verification-1",
      batch: [
        {
          findingId: "finding-a",
          verificationId: "verification-1",
          status: "incomplete",
        },
        {
          findingId: "finding-b",
          verificationId: "verification-2",
          status: "incomplete",
        },
      ],
    });
  });

  it("stops before any Lab or ledger write when the Snapshots differ", async () => {
    const { ledger, calls, run } = await fixture({
      snapshots: { "finding-b": OTHER },
    });
    const before = ledger.readAll({}).length;
    await expect(run(["finding-a", "finding-b"])).rejects.toThrow(
      /same Snapshot/,
    );
    expect(calls.provision).toBe(0);
    expect(ledger.readAll({}).length).toBe(before);
  });

  it("refuses more than five Findings and a repeated Finding", async () => {
    const { calls, run } = await fixture();
    await expect(
      run(["finding-a", "finding-b", "finding-c", "x", "y", "z"]),
    ).rejects.toThrow(/at most 5/);
    await expect(run(["finding-a", "finding-a"])).rejects.toThrow(/twice/);
    expect(calls.provision).toBe(0);
  });

  it("moves on after one Finding's incomplete attempt", async () => {
    const { ledger, calls, run } = await fixture({
      attempt: async (input) =>
        input.finding.findingId === "finding-a"
          ? { status: "incomplete", reason: "recipe", nextStep: "abort" }
          : { status: "attempted", recipeDigest: digestOf("f") },
    });
    await run(["finding-a", "finding-b"]);
    expect(calls.attempts.map((item) => item.findingId)).toEqual([
      "finding-a",
      "finding-b",
    ]);
    expect(
      ledger
        .readAll({ type: "verification-finished" })
        .map(({ event }) =>
          event.type === "verification-finished" &&
          event.result.status === "incomplete"
            ? event.result.reason
            : null,
        ),
    ).toEqual(["recipe", "awaiting-human-observation"]);
  });

  it("tries no further Finding once the Lab is untrusted and writes nothing for them", async () => {
    const { ledger, calls, run } = await fixture({
      ready: (findingId) => findingId !== "finding-b",
    });
    const summary = await run(["finding-a", "finding-b", "finding-c"]);
    expect(calls.attempts.map((item) => item.findingId)).toEqual(["finding-a"]);
    expect(
      ledger
        .readAll({ type: "verification-finished" })
        .map(({ event }) =>
          event.type === "verification-finished" ? event.findingId : null,
        ),
    ).toEqual(["finding-a"]);
    expect(summary?.batch?.map((item) => item.status)).toEqual([
      "incomplete",
      "not-attempted",
      "not-attempted",
    ]);
    expect(calls.teardown).toBe(1);
  });

  it("stops after an attempt that leaves the Lab untrusted", async () => {
    const { calls, run } = await fixture({
      attempt: async () => ({
        status: "incomplete",
        reason: "recipe",
        nextStep: "setup-boundary",
        labUntrusted: true,
      }),
    });
    const summary = await run(["finding-a", "finding-b"]);
    expect(calls.attempts.map((item) => item.findingId)).toEqual(["finding-a"]);
    expect(summary?.batch?.map((item) => item.status)).toEqual([
      "incomplete",
      "not-attempted",
    ]);
  });

  it("holds the one Lab once for every attempt waiting for a person", async () => {
    const { calls, run, held } = await fixture({ hold: true });
    await run(["finding-a", "finding-b"]);
    expect(held).toHaveLength(1);
    expect(held[0]?.lab.id).toBe("lab-1");
    expect(held[0]?.ref.findingId).toBe("finding-a");
    expect(held[0]?.batch?.map((ref) => ref.findingId)).toEqual([
      "finding-a",
      "finding-b",
    ]);
    expect(calls.teardown).toBe(1);
  });

  it("keeps a single named Finding on the one-Finding path", async () => {
    const { ledger, calls, run } = await fixture();
    const summary = await run(["finding-a"]);
    expect(calls.attempts).toEqual([{ findingId: "finding-a" }]);
    expect(calls.ready).toEqual([]);
    expect(summary).toEqual({
      campaignId: "campaign-1",
      findingId: "finding-a",
      verificationId: "verification-1",
      status: "incomplete",
    });
    expect(ledger.readAll({ type: "lab-provisioned" })).toHaveLength(1);
  });

  it("records a baseline that did not read back as a failed seed and leaves each Finding incomplete (#699 受入 3)", async () => {
    const { ledger, calls, run } = await fixture({ seedFailure: true });
    await run(["finding-a", "finding-b"]);
    expect(calls.provision).toBe(1);
    expect(calls.attempts).toEqual([]);
    const labs = ledger
      .readAll({ type: "lab-provisioned" })
      .map(({ event }) => event);
    expect(labs).toHaveLength(2);
    for (const event of labs)
      expect(event).toMatchObject({
        labId: "lab-seed",
        status: "failed",
        purpose: "verification",
        failureStage: "seed",
        reason: "provision",
        baseline: { id: "synthetic-baseline-v1", digest: digestOf("e") },
        artifacts: [{ kind: "lab-diagnostic" }],
      });
    expect(
      ledger
        .readAll({ type: "verification-finished" })
        .map(({ event }) =>
          event.type === "verification-finished" ? event.result : null,
        ),
    ).toEqual([
      expect.objectContaining({ status: "incomplete", reason: "provision" }),
      expect.objectContaining({ status: "incomplete", reason: "provision" }),
    ]);
    expect(ledger.readAll({ type: "verification-lab-failed" })).toHaveLength(2);
  });
});
