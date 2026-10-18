import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runForegroundReviewLab } from "../../../src/cli/index.js";
import { canonicalDigest } from "../../../src/infrastructure/canonical-json.js";
import { measureCanonicalSourceTree } from "../../../src/infrastructure/canonical-source-tree.js";
import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import type {
  WordPressLabHandle,
  WordPressLabSetup,
} from "../../../src/profiles/wordpress/lab/index.js";
import {
  openWordPressReviewLab,
  type WordPressReviewLabProvisioner,
} from "../../../src/profiles/wordpress/lab/review-lab.js";
import type { Snapshot, SnapshotReader } from "../../../src/snapshot/index.js";

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
      return { status: "ready", handle };
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
  return { lab, calls, provisioned, handle };
}

describe("WordPress review Lab", () => {
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
          if (line.startsWith("Run the package")) {
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
