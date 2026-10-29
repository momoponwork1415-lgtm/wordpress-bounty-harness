import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
  openRecordedWordPressReviewLab,
  openWordPressReviewLab,
  wordPressReviewLabDown,
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
function fakeLab(
  options: {
    readonly setupDigest?: string;
    /** `port-80-busy`: another process holds 80; `none`: no port binds at all. */
    readonly exposure?: "free" | "port-80-busy" | "none";
    readonly labId?: string;
  } = {},
) {
  const calls: string[] = [];
  const exposures: unknown[] = [];
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
      const fresh = {
        ...handle,
        id: options.labId ?? `lab-${provisioned.length}`,
      };
      provisionedIds.push(fresh.id);
      return { status: "ready", handle: fresh };
    },
    reviewAdministrator() {
      return { username: "harness-admin", password: "admin-pass" };
    },
    reviewReceiverIp() {
      return "172.20.0.5";
    },
    async exposeToHost(_handle, input) {
      calls.push("expose");
      exposures.push(input);
      const exposure = options.exposure ?? "free";
      return exposure === "none" ||
        (exposure === "port-80-busy" && input.httpPort === 80)
        ? { status: "unavailable", diagnostic: "no loopback port" }
        : {
            status: "exposed",
            container: "wbh-lab-1-host",
            httpPort: input.httpPort === 0 ? 49153 : input.httpPort,
            databasePort: null,
          };
    },
    async withdrawFromHost() {
      calls.push("withdraw");
      return true;
    },
    async teardown() {
      calls.push("teardown");
      return { status: "removed" };
    },
  };
  return { lab, calls, exposures, provisioned, provisionedIds, handle };
}

describe("WordPress review Lab", () => {
  it("opens a fresh manual Lab from a sealed result awaiting a human observation (#525)", async () => {
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
    // A judge-era dialog record, as old `incomplete(observation)` events reference it.
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
      "proxy-capture.jsonl": '{"method":"GET","path":"/synthetic"}\n',
    });
    const { lab, calls, provisionedIds } = fakeLab();
    const result = await new Verification({
      ledger,
      store,
      lab,
      verifier: {
        attempt: async () => ({ status: "attempted", recipeDigest }),
      },
      observer: {
        observe: async () => ({ status: "recorded", evidenceDigest }),
      },
      readFinding: (value) => value as typeof finding,
    }).verify({
      campaignId: "campaign-1",
      findingId: finding.findingId,
      verificationId: "verification-1",
      snapshot,
      setup,
      campaignLabSetupDigest: labSetupDigest,
    });
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "awaiting-human-observation",
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
    } as Partial<CliProfile> as CliProfile;
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
    // The verification Lab is never published; the review Lab is (#586).
    expect(calls).toEqual([
      ...["provision", "teardown"],
      ...["provision", "expose", "withdraw", "teardown"],
    ]);
    expect(lines).toContain(
      "review Lab ready on http://wordpress (network wbh-lab-1-net, recorder 172.20.0.4)",
    );
    expect(lines).toContain("lab id: lab-2; stop with lab down --lab lab-2");
    const accessLine = lines.find((line) =>
      line.startsWith("attacker accounts: private Lab access file "),
    );
    expect(accessLine).toBeDefined();
    const accessPath = accessLine!.slice(
      "attacker accounts: private Lab access file ".length,
    );
    expect(JSON.parse(await readFile(accessPath, "utf8"))).toMatchObject({
      attackerAccounts: { subscriber: { password: "attacker-pass" } },
      administrator: { password: "admin-pass" },
    });
    expect((await stat(accessPath)).mode & 0o777).toBe(0o600);
    expect(lines.join("\n")).not.toContain("attacker-pass");
    expect(lines.join("\n")).not.toContain("admin-pass");
    expect(lines).toContain(
      "host loopback: http://127.0.0.1:80 (Host header: wordpress)",
    );
    expect(lines).toContain(
      'browser: add the hosts line "127.0.0.1 wordpress" once, then open http://wordpress/',
    );
    expect(lines).toContain(
      `private recipe steps: ${store.contentPath(recipeDigest)}/steps.md`,
    );
    expect(lines).toContain(
      `private victim route: ${store.contentPath(recipeDigest)}/route.json`,
    );
    expect(lines).toContain(
      `private Lab observation: ${store.contentPath(evidenceDigest)}`,
    );
    expect(
      lines.some(
        (line) =>
          line.includes("--runtime=runsc") && line.includes("--network"),
      ),
    ).toBe(true);

    // An old `incomplete(observation)` event still needs its bound dialog record.
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
    const { lab, calls, exposures, provisioned } = fakeLab();

    const session = await openWordPressReviewLab({
      packageDigest,
      store,
      snapshots: frozenSnapshots,
      lab,
      browserImage,
    });

    expect(calls).toEqual(["provision", "expose"]);
    // Port 80 through the recorder, so the site's own redirects keep working (#592).
    expect(exposures).toEqual([{ httpPort: 80, via: "recorder" }]);
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
      browserImage,
      labId: "lab-1",
      host: {
        url: "http://127.0.0.1:80",
        hostHeader: "wordpress",
        port: 80,
      },
    });

    await session.close();
    await session.close();
    expect(calls).toEqual(["provision", "expose", "withdraw", "teardown"]);
    expect(session).not.toHaveProperty("canaries");
  });

  it("refuses a missing package before touching the Lab", async () => {
    const store = await privateStore();
    const { lab, calls } = fakeLab();
    await expect(
      openWordPressReviewLab({
        packageDigest: sha("f"),
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
        store,
        snapshots: frozenSnapshots,
        lab,
        browserImage,
      }),
    ).rejects.toThrow("Review Lab setup digest differs from the package");
    expect(calls).toEqual(["provision", "withdraw", "teardown"]);
  });

  it("tears the Lab down when it cannot be published on the host (#586)", async () => {
    const store = await privateStore();
    const packageDigest = await sealedPackage(store, reconstruction);
    const { lab, calls } = fakeLab({ exposure: "none" });
    await expect(
      openWordPressReviewLab({
        packageDigest,
        store,
        snapshots: frozenSnapshots,
        lab,
        browserImage,
      }),
    ).rejects.toThrow(
      "The review Lab could not be published on the host: no loopback port",
    );
    expect(calls).toEqual([
      ...["provision", "expose", "expose"],
      ...["withdraw", "teardown"],
    ]);
  });

  it("falls back to a free port when 80 is taken and says the browser needs a resolver rule (#592)", async () => {
    const store = await privateStore();
    const packageDigest = await sealedPackage(store, reconstruction);
    const { lab, exposures } = fakeLab({ exposure: "port-80-busy" });
    const signals = new EventEmitter();
    const lines: string[] = [];
    await runForegroundReviewLab(
      () =>
        openWordPressReviewLab({
          packageDigest,
          store,
          snapshots: frozenSnapshots,
          lab,
          browserImage,
        }),
      {
        stdout(line) {
          lines.push(line);
          if (line.startsWith("Run the private"))
            queueMicrotask(() => signals.emit("SIGINT"));
        },
        stderr: () => undefined,
      },
      signals,
    );
    expect(exposures).toEqual([
      { httpPort: 80, via: "recorder" },
      { httpPort: 0, via: "recorder" },
    ]);
    expect(lines).toContain(
      "host loopback: http://127.0.0.1:49153 (Host header: wordpress)",
    );
    expect(lines).toContain(
      'browser: port 80 is in use, so http://wordpress/ is not reachable through a hosts line; start Chrome with --host-resolver-rules="MAP wordpress 127.0.0.1:49153" and open http://wordpress/',
    );
  });

  it("records the review Lab so lab down closes it through its foreground owner (#592)", async () => {
    const store = await privateStore();
    const stateDirectory = await mkdtemp(join(tmpdir(), "wbh-review-state-"));
    directories.push(stateDirectory);
    const packageDigest = await sealedPackage(store, reconstruction);
    const labId = "0f0e0d0c-0b0a-4908-8706-050403020100";
    const { lab, calls } = fakeLab({ labId });
    const open = () =>
      openRecordedWordPressReviewLab({
        packageDigest,
        store,
        snapshots: frozenSnapshots,
        lab,
        browserImage,
        stateDirectory,
        clock: () => new Date("2026-10-26T00:00:00Z"),
      });
    const session = await open();
    expect(
      JSON.parse(
        await readFile(
          join(stateDirectory, "review-labs", `${labId}.json`),
          "utf8",
        ),
      ),
    ).toEqual({
      schemaVersion: 1,
      labId,
      network: "wbh-lab-1-net",
      gateway: `wbh-${labId}-host`,
      httpPort: 80,
      startedAt: "2026-10-26T00:00:00.000Z",
    });
    // The provisioner returned the same Lab id; an existing record cannot be replaced.
    await expect(open()).rejects.toThrow("already recorded");
    expect(calls).toEqual([
      "provision",
      "expose",
      "provision",
      "expose",
      "withdraw",
      "teardown",
    ]);

    let owner: number | null = 4242;
    const signalled: number[] = [];
    const cleanups: unknown[] = [];
    const summary = await wordPressReviewLabDown({
      stateDirectory,
      lab: {
        async cleanupLeftovers(input) {
          cleanups.push(input);
          return { containers: [], networks: [], volumes: [] };
        },
      },
      ownerOf: async (id) => (id === labId ? owner : null),
      // The foreground process closes its session on SIGTERM.
      signal(pid) {
        signalled.push(pid);
        void session.close().then(() => {
          owner = null;
        });
      },
    });
    expect(signalled).toEqual([4242]);
    expect(calls).toEqual([
      "provision",
      "expose",
      "provision",
      "expose",
      "withdraw",
      "teardown",
      "withdraw",
      "teardown",
    ]);
    expect(summary).toEqual({
      labId,
      ownerStopped: 4242,
      removed: { containers: [], networks: [], volumes: [] },
      remaining: { containers: [], networks: [], volumes: [] },
    });
    expect(cleanups).toEqual([
      { remove: true, labId },
      { remove: false, labId },
    ]);
    await expect(
      readFile(join(stateDirectory, "review-labs", `${labId}.json`)),
    ).rejects.toThrow();
    expect(
      await wordPressReviewLabDown({
        stateDirectory,
        lab: {
          cleanupLeftovers: async () => {
            throw new Error("nothing to remove");
          },
        },
      }),
    ).toBeNull();
  });

  it("removes a review Lab whose owner died by its Lab id, gateway included (#592)", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "wbh-review-state-"));
    directories.push(stateDirectory);
    const labId = "0f0e0d0c-0b0a-4908-8706-050403020100";
    await writeFile(
      join(stateDirectory, "review-lab.json"),
      JSON.stringify({
        schemaVersion: 1,
        labId,
        network: `wbh-${labId}-net`,
        gateway: `wbh-${labId}-host`,
        httpPort: 80,
        startedAt: "2026-10-26T00:00:00.000Z",
      }),
    );
    const live = {
      containers: [`wbh-${labId}-host`, `wbh-${labId}-wp`, `wbh-${labId}-db`],
      networks: [`wbh-${labId}-net`],
      volumes: [`wbh-${labId}-site`],
    };
    const signalled: number[] = [];
    const summary = await wordPressReviewLabDown({
      stateDirectory,
      lab: {
        async cleanupLeftovers({ remove, labId: only }) {
          expect(only).toBe(labId);
          const found = structuredClone(live);
          if (remove)
            for (const kind of ["containers", "networks", "volumes"] as const)
              live[kind] = [];
          return found;
        },
      },
      ownerOf: async () => null,
      signal: (pid) => signalled.push(pid),
    });
    expect(signalled).toEqual([]);
    expect(summary).toMatchObject({
      labId,
      removed: {
        containers: [`wbh-${labId}-host`, `wbh-${labId}-wp`, `wbh-${labId}-db`],
      },
      remaining: { containers: [], networks: [], volumes: [] },
    });
    expect(summary).not.toHaveProperty("ownerStopped");
    await expect(
      readFile(join(stateDirectory, "review-lab.json")),
    ).rejects.toThrow();
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
          store,
          snapshots: frozenSnapshots,
          lab,
          browserImage,
        }),
      {
        stdout(line) {
          lines.push(line);
          if (line.startsWith("Run the private")) {
            expect(calls).toEqual(["provision", "expose"]);
            // The Lab is live; the human interrupts the command.
            queueMicrotask(() => signals.emit("SIGINT"));
          }
        },
        stderr: () => undefined,
      },
      signals,
    );
    await running;
    expect(calls).toEqual(["provision", "expose", "withdraw", "teardown"]);
    expect(lines.at(-1)).toBe("review Lab removed");
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });
});
