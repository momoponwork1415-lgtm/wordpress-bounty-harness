import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  runCli,
  runForegroundReviewLab,
  type CliProfile,
} from "../../../src/cli/index.js";
import {
  canonicalDigest,
  canonicalJson,
} from "../../../src/infrastructure/canonical-json.js";
import { measureCanonicalSourceTree } from "../../../src/infrastructure/canonical-source-tree.js";
import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../../src/ledger/index.js";
import type {
  WordPressLabHandle,
  WordPressLabSetup,
} from "../../../src/profiles/wordpress/lab/index.js";
import { observedReviewLabPackage } from "../../../src/profiles/wordpress/lab/observed-review-lab.js";
import {
  openWordPressReviewLab,
  type WordPressReviewLabProvisioner,
} from "../../../src/profiles/wordpress/lab/review-lab.js";
import { Review } from "../../../src/review/index.js";
import type { Snapshot, SnapshotReader } from "../../../src/snapshot/index.js";
import { Verification } from "../../../src/verification/index.js";

const sha = (value: string) => `sha256:${value.repeat(64)}`;
const snapshotBody = {
  kind: "source-snapshot" as const,
  schemaVersion: 1 as const,
  target: { identity: "example", version: "1.0", sourceDigest: sha("a") },
  dependencies: [],
};
const snapshot: Snapshot = {
  ...snapshotBody,
  digest: canonicalDigest(snapshotBody),
};
const setup: WordPressLabSetup = {
  schemaVersion: 1,
  snapshotDigest: snapshot.digest,
  siteTitle: "Review fixture",
  initialPosts: ["Welcome"],
  customerRole: false,
};
const labSetupDigest = sha("5");
const browserImage = `verification-browser@${sha("4")}`;

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function privateStore() {
  const root = await mkdtemp(join(tmpdir(), "wbh-review-lab-"));
  directories.push(root);
  return new PrivateArtifactStore({
    rootDirectory: join(root, "private-evidence"),
    maxEntries: 10,
    maxBytes: 100_000,
  });
}

/** Seals a package whose only relevant file is `lab.json`, as the publisher writes it. */
async function sealedPackage(
  store: PrivateArtifactStore,
  reconstruction: unknown,
): Promise<string> {
  const staging = await store.stage();
  await writeFile(
    join(staging.contentDirectory, "lab.json"),
    JSON.stringify(reconstruction),
  );
  // The publisher names the artifact by its content digest; the store resolves by that name.
  const measured = await measureCanonicalSourceTree(staging.contentDirectory, {
    maxEntries: 5,
    maxBytes: 100_000,
  });
  const committed = await store.commit(measured.digest, staging);
  if (committed.status === "conflict") throw new Error("package conflict");
  return committed.artifact.artifactId;
}

const reconstruction = {
  wordpressVersion: "6.8",
  target: snapshot.target,
  enabledSettings: [],
  roles: ["subscriber"],
  setup,
  snapshot,
  labSetupDigest,
  snapshotDigest: snapshot.digest,
};

const frozenSnapshots: SnapshotReader = {
  async load(digest) {
    return digest === snapshot.digest
      ? { status: "loaded", snapshot }
      : { status: "unavailable", reason: "missing" };
  },
};

/** Records the Lab calls instead of running docker; the handle carries the chosen setup digest. */
function fakeLab(options: { readonly setupDigest?: string } = {}) {
  const calls: string[] = [];
  const provisioned: { snapshot: unknown; setup: unknown }[] = [];
  const provisionedIds: string[] = [];
  const handle: WordPressLabHandle = {
    id: "lab-1",
    snapshotDigest: snapshot.digest,
    setupDigest: options.setupDigest ?? labSetupDigest,
    endpoint: "http://wordpress",
    networkName: "wbh-lab-1-net",
    internalIp: "172.20.0.2",
    recorderIp: "172.20.0.4",
    attackerAccounts: {
      subscriber: { username: "attacker", password: "attacker-pass" },
    },
  };
  const lab: WordPressReviewLabProvisioner = {
    async provision(candidateSnapshot, candidateSetup) {
      calls.push("provision");
      provisioned.push({ snapshot: candidateSnapshot, setup: candidateSetup });
      const fresh = { ...handle, id: `lab-${provisioned.length}` };
      provisionedIds.push(fresh.id);
      return { status: "ready", handle: fresh };
    },
    async seedCanaries() {
      calls.push("seedCanaries");
      return { status: "seeded", digest: sha("d") };
    },
    reviewAdministrator() {
      return { username: "harness-admin", password: "admin-pass" };
    },
    reviewReceiverIp() {
      return "172.20.0.5";
    },
    canaryLedger() {
      return null;
    },
    prepareScriptCanary() {
      return {
        nonce: "fixed-nonce",
        beaconUrl: "http://canary/b/fixed-nonce",
        javascript: "fetch('http://canary/b/fixed-nonce')",
        loaderJavascript: "x()",
      };
    },
    async teardown() {
      calls.push("teardown");
      return { status: "removed" };
    },
  };
  return { lab, calls, provisioned, provisionedIds, handle };
}

describe("WordPress review Lab", () => {
  it("opens a fresh manual Lab from a sealed, current incomplete dialog observation", async () => {
    const root = await mkdtemp(join(tmpdir(), "wbh-observed-review-"));
    directories.push(root);
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory);
    const store = new PrivateArtifactStore({
      rootDirectory: join(stateDirectory, "private-evidence"),
      maxEntries: 64,
      maxBytes: 1024 * 1024,
    });
    const ledger = new Ledger({
      databasePath: join(stateDirectory, "ledger.sqlite"),
      artifactStore: store,
    });
    const finding = {
      findingId: "finding-1",
      snapshotDigest: snapshot.digest,
      impact: "stored-xss",
    };
    const findingDigest = await store.putFiles({
      "finding.json": canonicalJson(finding),
    });
    await ledger.append({
      schemaVersion: 1,
      identity: "finding-1",
      campaignId: "campaign-1",
      snapshotDigest: snapshot.digest,
      occurredAt: "2026-10-24T00:00:00Z",
      type: "finding-recorded",
      findingId: finding.findingId,
      runId: "run-1",
      category: finding.impact,
      artifacts: [{ kind: "finding", digest: findingDigest }],
    });
    const marker = "5837294610";
    const recipeDigest = await store.putFiles({
      "steps.md": "Synthetic attacker and victim steps",
      "route.json": canonicalJson({
        victim: {
          role: "administrator",
          paths: ["/wp-admin/"],
          dialogMarker: marker,
        },
      }),
    });
    const dialog = {
      judgeId: "wordpress-stored-script",
      kind: "numeric-dialog",
      status: "dialog-observed",
      marker,
      dialogEvent: {
        type: "alert",
        message: marker,
        topLevelPageUrlAtEvent: "http://wordpress/wp-admin/",
        topLevelPageOriginAtEvent: "http://wordpress",
        frameUrlsAtEvent: ["http://wordpress/wp-admin/"],
      },
      victimRole: "administrator",
      victimPrincipal: "separate",
      snapshotDigest: snapshot.digest,
      labSetupDigest,
      capturedAttackerRequestMarkerMatch: true,
      verificationSequence: "post-setup-request-before-victim-visit",
      requiresHumanPreexistingContentCheck: true,
    } as const;
    const evidenceDigest = await store.putFiles({
      "browser-dialog-observation.json": canonicalJson(dialog),
    });
    const { lab, calls, provisionedIds } = fakeLab();
    const result = await new Verification({
      ledger,
      store,
      lab,
      verifier: {
        attempt: async () => ({ status: "attempted", recipeDigest }),
      },
      judges: {
        for: () => ({
          id: "wordpress-stored-script",
          observe: async () => ({
            status: "incomplete",
            reason: "observation",
            nextStep: "Human reproduction needed",
            evidenceCapture: "harness-captured",
            evidenceDigest,
          }),
        }),
      },
      readFinding: (value) => value as typeof finding,
      renderer: {
        render: async () => {
          throw new Error("No proof package");
        },
      },
    }).verify({
      campaignId: "campaign-1",
      findingId: finding.findingId,
      verificationId: "verification-1",
      snapshot,
      setup,
      campaignLabSetupDigest: labSetupDigest,
      reconstruction: {},
    });
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "observation",
    });
    const first = ledger
      .readAll({
        campaignId: "campaign-1",
        findingId: finding.findingId,
        type: "verification-finished",
      })
      .at(-1)?.event;
    if (first?.type !== "verification-finished")
      throw new Error("Missing attempt");
    expect(first.result.status).toBe("incomplete");
    expect(first.artifacts.map((artifact) => artifact.kind)).toContain(
      "review-lab-reconstruction",
    );
    const ref = {
      campaignId: "campaign-1",
      findingId: finding.findingId,
      verificationId: first.verificationId,
      snapshotDigest: snapshot.digest,
    };
    const manual = await observedReviewLabPackage({
      ledger,
      store,
      ref,
    });
    if (manual === null) throw new Error("Missing sealed review Lab");
    expect(manual.recipeDigest).toBe(recipeDigest);
    expect(manual.evidenceDigest).toBe(evidenceDigest);
    const lines: string[] = [];
    const profile = {
      review: (state) =>
        new Review({
          ledger: state.ledger,
          artifactStore: state.store,
          scopeEvaluator: {
            programmeIds: ["synthetic"],
            policyDigest: labSetupDigest,
            assess: async () => [],
          },
          factsProvider: { load: async () => ({}) },
        }),
      reviewLabPackage: (state, candidate) =>
        observedReviewLabPackage({
          ledger: state.ledger,
          store: state.store,
          ref: candidate,
        }),
      reviewLab: (state, input) =>
        openWordPressReviewLab({
          ...input,
          store: state.store,
          snapshots: frozenSnapshots,
          lab,
          browserImage,
        }),
    } as CliProfile;
    const errors: string[] = [];
    const command =
      "lab up --for-review --campaign campaign-1 --finding finding-1".split(
        " ",
      );
    const exitCode = await runCli(
      command,
      { stateDirectory, profile },
      {
        stdout(line) {
          lines.push(line);
          if (line.startsWith("Run the private"))
            queueMicrotask(() => process.emit("SIGINT"));
        },
        stderr: (line) => errors.push(line),
      },
    );
    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(provisionedIds).toEqual(["lab-1", "lab-2"]);
    expect(calls).toEqual([
      "provision",
      "seedCanaries",
      "teardown",
      "provision",
      "seedCanaries",
      "teardown",
    ]);
    expect(lines).toContain(
      "review Lab ready on http://wordpress (network wbh-lab-1-net, recorder 172.20.0.4)",
    );
    expect(lines).toContain(
      'attacker accounts: {"subscriber":{"username":"attacker","password":"attacker-pass"}}',
    );
    expect(lines).toContain(
      `private recipe steps: ${store.contentPath(recipeDigest)}/steps.md`,
    );
    expect(lines).toContain(
      `private victim route: ${store.contentPath(recipeDigest)}/route.json`,
    );
    expect(lines).toContain(
      `private browser observation: ${store.contentPath(evidenceDigest)}/browser-dialog-observation.json`,
    );
    expect(
      lines.some(
        (line) =>
          line.includes("--runtime=runsc") && line.includes("--network"),
      ),
    ).toBe(true);

    const mismatchedEvidence = await store.putFiles({
      "browser-dialog-observation.json": canonicalJson({
        ...dialog,
        capturedAttackerRequestMarkerMatch: false,
        verificationSequence: "not-established",
      }),
    });
    await ledger.append({
      schemaVersion: 1,
      identity: "verification-2",
      campaignId: "campaign-1",
      snapshotDigest: snapshot.digest,
      occurredAt: "2026-10-24T00:01:00Z",
      type: "verification-finished",
      findingId: finding.findingId,
      verificationId: "verification-2",
      labSetupDigest,
      result: {
        status: "incomplete",
        reason: "observation",
        nextStep: "Human reproduction needed",
        evidenceDigest: mismatchedEvidence,
      },
      evidenceCapture: "harness-captured",
      artifacts: first.artifacts,
    });
    const eventsBefore = ledger.readAll({ campaignId: "campaign-1" }).length;
    expect(await observedReviewLabPackage({ ledger, store, ref })).toBeNull();
    expect(
      await observedReviewLabPackage({
        ledger,
        store,
        ref: { ...ref, verificationId: "verification-2" },
      }),
    ).toBeNull();
    const rejectedOutput: string[] = [];
    const rejectedErrors: string[] = [];
    expect(
      await runCli(
        command,
        { stateDirectory, profile },
        {
          stdout: (line) => rejectedOutput.push(line),
          stderr: (line) => rejectedErrors.push(line),
        },
      ),
    ).toBe(2);
    expect(rejectedOutput).toEqual([]);
    expect(rejectedErrors.join("\n")).toContain(
      "An evidence-bound review Lab package is required",
    );
    expect(ledger.readAll({ campaignId: "campaign-1" })).toHaveLength(
      eventsBefore,
    );
    expect(provisionedIds).toEqual(["lab-1", "lab-2"]);
  });

  it("rebuilds the Lab from the package's reconstruction and the frozen Snapshot, then removes it on close", async () => {
    const store = await privateStore();
    const packageDigest = await sealedPackage(store, reconstruction);
    const { lab, calls, provisioned } = fakeLab();

    const session = await openWordPressReviewLab({
      packageDigest,
      category: "stored-xss",
      store,
      snapshots: frozenSnapshots,
      lab,
      browserImage,
    });

    expect(calls).toEqual(["provision", "seedCanaries"]);
    expect(provisioned).toEqual([
      { snapshot, setup: { ...setup, databaseAccess: "none" } },
    ]);
    expect(session).toMatchObject({
      endpoint: "http://wordpress",
      networkName: "wbh-lab-1-net",
      recorderIp: "172.20.0.4",
      receiverIp: "172.20.0.5",
      attackerAccounts: {
        subscriber: { username: "attacker", password: "attacker-pass" },
      },
      administrator: { username: "harness-admin", password: "admin-pass" },
      canaries: { script: { nonce: "fixed-nonce" } },
      browserImage,
    });

    await session.close();
    await session.close();
    expect(calls).toEqual(["provision", "seedCanaries", "teardown"]);
  });

  it("issues no script canary outside stored-xss", async () => {
    const store = await privateStore();
    const packageDigest = await sealedPackage(store, reconstruction);
    const { lab } = fakeLab();
    const session = await openWordPressReviewLab({
      packageDigest,
      category: "sqli",
      store,
      snapshots: frozenSnapshots,
      lab,
      browserImage,
    });
    expect(session.canaries).toEqual({});
    await session.close();
  });

  it("refuses a missing package before touching the Lab", async () => {
    const store = await privateStore();
    const { lab, calls } = fakeLab();
    await expect(
      openWordPressReviewLab({
        packageDigest: sha("f"),
        category: "stored-xss",
        store,
        snapshots: frozenSnapshots,
        lab,
        browserImage,
      }),
    ).rejects.toThrow("Review Lab reconstruction is unavailable: missing");
    expect(calls).toEqual([]);
  });

  it("refuses a package whose lab.json lacks the Lab digests", async () => {
    const store = await privateStore();
    const packageDigest = await sealedPackage(store, {
      setup,
      snapshot,
    });
    const { lab, calls } = fakeLab();
    await expect(
      openWordPressReviewLab({
        packageDigest,
        category: "stored-xss",
        store,
        snapshots: frozenSnapshots,
        lab,
        browserImage,
      }),
    ).rejects.toThrow("Review Lab reconstruction is unavailable: malformed");
    expect(calls).toEqual([]);
  });

  it("refuses a package whose setup names a different Snapshot before provisioning", async () => {
    const store = await privateStore();
    const packageDigest = await sealedPackage(store, {
      ...reconstruction,
      setup: { ...setup, snapshotDigest: sha("e") },
    });
    const { lab, calls } = fakeLab();
    await expect(
      openWordPressReviewLab({
        packageDigest,
        category: "stored-xss",
        store,
        snapshots: frozenSnapshots,
        lab,
        browserImage,
      }),
    ).rejects.toThrow(
      "Review Lab setup Snapshot digest differs from the package",
    );
    expect(calls).toEqual([]);
  });

  it("refuses a package whose Snapshot digest names no frozen Snapshot", async () => {
    const store = await privateStore();
    const otherBody = {
      ...snapshotBody,
      target: { ...snapshotBody.target, version: "1.1" },
    };
    const other = { ...otherBody, digest: canonicalDigest(otherBody) };
    const packageDigest = await sealedPackage(store, {
      ...reconstruction,
      snapshot: other,
      snapshotDigest: other.digest,
      setup: { ...setup, snapshotDigest: other.digest },
    });
    const { lab, calls } = fakeLab();
    await expect(
      openWordPressReviewLab({
        packageDigest,
        category: "stored-xss",
        store,
        snapshots: frozenSnapshots,
        lab,
        browserImage,
      }),
    ).rejects.toThrow(
      "Frozen Snapshot artifact differs from the package: missing",
    );
    expect(calls).toEqual([]);
  });

  it("tears the Lab down when its setup digest differs from the package", async () => {
    const store = await privateStore();
    const packageDigest = await sealedPackage(store, reconstruction);
    const { lab, calls } = fakeLab({ setupDigest: sha("e") });
    await expect(
      openWordPressReviewLab({
        packageDigest,
        category: "stored-xss",
        store,
        snapshots: frozenSnapshots,
        lab,
        browserImage,
      }),
    ).rejects.toThrow("Review Lab setup digest differs from the package");
    expect(calls).toEqual(["provision", "teardown"]);
  });

  it("tears the Lab down when the foreground runner receives SIGINT", async () => {
    const store = await privateStore();
    const packageDigest = await sealedPackage(store, reconstruction);
    const { lab, calls } = fakeLab();
    const signals = new EventEmitter();
    const lines: string[] = [];
    const running = runForegroundReviewLab(
      () =>
        openWordPressReviewLab({
          packageDigest,
          category: "stored-xss",
          store,
          snapshots: frozenSnapshots,
          lab,
          browserImage,
        }),
      {
        stdout(line) {
          lines.push(line);
          if (line.startsWith("Run the private")) {
            expect(calls).toEqual(["provision", "seedCanaries"]);
            // The Lab is live; the human interrupts the command.
            queueMicrotask(() => signals.emit("SIGINT"));
          }
        },
        stderr: () => undefined,
      },
      signals,
    );
    await running;
    expect(calls).toEqual(["provision", "seedCanaries", "teardown"]);
    expect(lines.at(-1)).toBe("review Lab removed");
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });
});
