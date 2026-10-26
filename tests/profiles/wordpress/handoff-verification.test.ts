import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { measureCanonicalSourceTree } from "../../../src/infrastructure/canonical-source-tree.js";
import {
  canonicalDigest,
  canonicalJson,
} from "../../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../../src/ledger/index.js";
import {
  admitWordPressFinding,
  readWordPressFinding,
  type WordPressFinding,
} from "../../../src/profiles/wordpress/discovery/finding.js";
import { readLabOwners } from "../../../src/infrastructure/lab-owner-record.js";
import { openWordPressLab } from "../../../src/profiles/wordpress/lab/index.js";
import { wordPressScenario } from "../../../src/profiles/wordpress/lab/scenarios.js";
import { createWordPressScopeFacts } from "../../../src/profiles/wordpress/scope-facts.js";
import {
  createWordpressScopeEvaluator,
  loadWordpressScopePolicy,
} from "../../../src/profiles/wordpress/scope-policy.js";
import { observedReviewLabPackage } from "../../../src/profiles/wordpress/lab/observed-review-lab.js";
import { createWordPressAttemptObserver } from "../../../src/profiles/wordpress/verification/attempt-observer.js";
import { victimFile } from "../../../src/profiles/wordpress/lab/victim-files.js";
import {
  HandoffVerifier,
  WBH_VERIFY_SKILL_ID,
} from "../../../src/profiles/wordpress/verification/handoff-verifier.js";
import { createWordPressVerifierRecordReader } from "../../../src/profiles/wordpress/verification/verifier-record.js";
import { WordPressVerifier } from "../../../src/profiles/wordpress/verification/wordpress-verifier.js";
import {
  currentManualObservation,
  recordManualObservation,
  recordManualObservationLabReady,
} from "../../../src/review/manual-observation.js";
import type { Snapshot } from "../../../src/snapshot/index.js";
import { Review } from "../../../src/review/index.js";
import { exportReviewBundleV2 } from "../../../src/review/manual-observation-export.js";
import { Verification } from "../../../src/verification/index.js";

const sha = (value: string) => `sha256:${value.repeat(64)}`;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

/** The fake Docker host: sessions (cookie → login), the recorder's bytes and browser visits. */
type LabState = {
  attacker: string;
  readonly sessions: Map<string, string>;
  capture: Buffer;
  readonly revoked: string[];
  readonly visits: string[];
};
const PNG = Buffer.concat([
  Buffer.from("89504e470d0a1a0a", "hex"),
  Buffer.from("synthetic screen"),
]);
const MARKER = "4815162342";

/** One recorder line for a host request carrying `cookie`. */
function send(state: LabState, cookie: string, path: string): void {
  const part = (text: string) => ({
    body: text,
    bodyBase64: Buffer.from(text).toString("base64"),
    truncated: false,
  });
  const line = JSON.stringify({
    request: {
      method: "GET",
      path,
      headers: { cookie: `wordpress_logged_in_lab=${cookie}` },
      ...part(""),
    },
    response: { statusCode: 200, headers: {}, ...part("ok") },
  });
  state.capture = Buffer.concat([state.capture, Buffer.from(`${line}\n`)]);
}

async function until(path: string): Promise<string> {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
    const text = await readFile(path, "utf8").catch(() => null);
    if (text !== null) return text;
    await sleep(5);
  }
  throw new Error(`${path} did not appear`);
}

/** The fake Docker daemon that several Labs share: its objects and the ports it bound. */
type DockerHost = {
  readonly containers: Set<string>;
  readonly networks: Set<string>;
  readonly volumes: Set<string>;
  readonly ports: Map<string, number>;
  nextPort: number;
};
const dockerHost = (): DockerHost => ({
  containers: new Set(),
  networks: new Set(),
  volumes: new Set(),
  ports: new Map(),
  nextPort: 32768,
});

/** Keeps the fake daemon's objects; answers listings and `docker port`, else null. */
function daemon(host: DockerHost, args: readonly string[]) {
  const [verb, object] = args;
  const named = args[args.indexOf("--name") + 1] ?? "";
  const operands = args.filter((arg) => !arg.startsWith("-"));
  const listing = (names: Set<string>) => ({
    exitCode: 0,
    stdout: [...names].join("\n"),
    stderr: "",
  });
  if ((verb === "run" && args.includes("--detach")) || verb === "create") {
    host.containers.add(named);
    args.forEach((arg, index) => {
      const published = /^127\.0\.0\.1:(\d*):(\d+)$/.exec(arg);
      if (args[index - 1] === "--publish" && published !== null)
        host.ports.set(
          `${named} ${published[2]}/tcp`,
          published[1] === "" ? host.nextPort++ : Number(published[1]),
        );
    });
  }
  if (verb === "rm")
    for (const name of operands.slice(1)) host.containers.delete(name);
  if (verb === "network" && object === "create")
    host.networks.add(args.at(-1)!);
  if (verb === "network" && object === "rm")
    for (const name of operands.slice(2)) host.networks.delete(name);
  if (verb === "volume" && object === "create") host.volumes.add(args.at(-1)!);
  if (verb === "volume" && object === "rm")
    for (const name of operands.slice(2)) host.volumes.delete(name);
  if (verb === "ps") return listing(host.containers);
  if (verb === "network" && object === "ls") return listing(host.networks);
  if (verb === "volume" && object === "ls") return listing(host.volumes);
  if (verb === "port") {
    const bound = host.ports.get(`${args[1]} ${args[2]}`);
    return bound === undefined
      ? { exitCode: 1, stdout: "", stderr: "no public port" }
      : { exitCode: 0, stdout: `127.0.0.1:${bound}\n`, stderr: "" };
  }
  return null;
}

type Scenario = {
  readonly impact?: WordPressFinding["impact"];
  /** The skill sends no attacker request after `setup-done`. */
  readonly silent?: boolean;
  /** The victim pages `route.json` declares for the Lab browser. */
  readonly victim?: unknown;
  /** Runs after `attack.json` with the connection `lab.json` named, before the six files. */
  readonly beforeFiles?: (lab: { readonly url: string }) => Promise<void>;
  /** A latest-version attempt on a pinned ordinary Lab scenario, as scope needs. */
  readonly ordinaryLatestVersion?: boolean;
};

/** The skill's side: setup as the administrator, `setup-done`, then the attacker route. */
async function skill(directory: string, state: LabState, scenario: Scenario) {
  const lab = JSON.parse(await until(join(directory, "lab.json"))) as {
    administrator: { username: string };
    host: { url: string };
  };
  state.sessions.set("admin-session", lab.administrator.username);
  send(state, "admin-session", "/wp-admin/options-general.php");
  await writeFile(join(directory, "setup-done"), "");
  const attack = JSON.parse(
    await until(join(directory, "attack.json")),
  ) as Record<string, unknown>;
  const revokedBeforeAttack = [...state.revoked];
  state.sessions.set("attacker-session", state.attacker);
  if (scenario.silent !== true) send(state, "attacker-session", "/synthetic");
  await scenario.beforeFiles?.({ url: lab.host.url });
  for (const [name, text] of Object.entries({
    "route.json": JSON.stringify({
      role: "subscriber",
      defaultSettings: true,
      steps: [
        {
          kind: "http",
          method: "GET",
          path: "/synthetic",
          expected: "The claimed effect",
        },
      ],
      ...(scenario.victim === undefined ? {} : { victim: scenario.victim }),
    }),
    "http.json":
      '{"exchanges":[{"request":{"method":"GET","path":"/synthetic"},"response":{"body":"ok"}}]}',
    "session.json": "",
    "steps.md": "Synthetic steps",
    "refutation.md": "",
    precondition: "",
  }))
    await writeFile(join(directory, name), text);
  return { revokedBeforeAttack, attack };
}

/** Real Lab code over a fake Docker host, the real handoff transport and the real observer. */
async function verifyThroughHandoff(
  scenario: Scenario,
  shared: {
    readonly host: DockerHost;
    readonly ownerDirectory?: string;
    readonly ports: { readonly http: number; readonly database: number };
  } = { host: dockerHost(), ports: { http: 18080, database: 13307 } },
) {
  const root = await mkdtemp(join(tmpdir(), "wbh-handoff-e2e-"));
  directories.push(root);
  const sourceDirectory = join(root, "source");
  await mkdir(sourceDirectory);
  await writeFile(join(sourceDirectory, "example.php"), "<?php // harmless\n");
  const tree = await measureCanonicalSourceTree(sourceDirectory, {
    maxEntries: 10,
    maxBytes: 1000,
  });
  const body = {
    kind: "source-snapshot" as const,
    schemaVersion: 1 as const,
    target: { identity: "example", version: "1.0", sourceDigest: tree.digest },
    dependencies: [],
  };
  const snapshot: Snapshot = { ...body, digest: canonicalDigest(body) };
  const state: LabState = {
    attacker: "",
    sessions: new Map(),
    capture: Buffer.alloc(0),
    revoked: [],
    visits: [],
  };
  const ok = (stdout = "ok") => ({ exitCode: 0, stdout, stderr: "" });
  const lab = openWordPressLab({
    dockerExecutablePath: "/usr/bin/docker",
    ownerDirectory: shared.ownerDirectory ?? join(root, "lab-owners"),
    images: {
      database: `mariadb@${sha("1")}`,
      wordpress: `wordpress@${sha("2")}`,
      wordpressCli: `wordpress-cli@${sha("3")}`,
      browser: `verification-browser@${sha("4")}`,
      recorder: `node-recorder@${sha("5")}`,
    },
    source: {
      resolve: async () => ({
        target: {
          kind: "plugin",
          pluginSlug: "example",
          sourceDirectory,
          sourceTree: tree,
        },
        dependencies: [],
      }),
    },
    runner: {
      async run({ args }) {
        const answered = daemon(shared.host, args);
        if (answered !== null) return answered;
        const at = (word: string) => args[args.indexOf(word) + 1] ?? "";
        const env = (name: string) =>
          args
            .find((arg) => arg.startsWith(`${name}=`))
            ?.slice(name.length + 1);
        if (args[0] === "info") return ok('{"runsc":{}}');
        if (args[0] === "inspect") return ok("172.20.0.2");
        if (args[0] === "exec" && args[1]?.endsWith("-proxy"))
          return args[2] === "wc"
            ? ok(`${state.capture.length} capture\n`)
            : args[2] === "tail"
              ? ok(
                  state.capture
                    .subarray(Number(args[4]?.slice(1)) - 1)
                    .toString(),
                )
              : ok("0");
        if (at("create").startsWith("wbh-subscriber-"))
          state.attacker = at("create");
        const principals = env("WBH_SETUP_PRINCIPALS");
        if (principals !== undefined) {
          const logins = (JSON.parse(principals) as string[][]).map(
            ([login]) => login!,
          );
          for (const [cookie, login] of state.sessions)
            if (logins.includes(login)) state.sessions.delete(cookie);
          state.revoked.push(...logins);
          return ok();
        }
        const visit = env("WBH_VISIT_PATH");
        if (visit !== undefined) {
          // The Lab browser: one victim visit, with a dialog when a marker is declared.
          state.visits.push(visit);
          const marker = env("WBH_DIALOG_MARKER");
          return ok(
            JSON.stringify({
              screenshotBase64: PNG.toString("base64"),
              ...(marker === undefined
                ? {}
                : {
                    dialogEvent: {
                      type: "alert",
                      message: marker,
                      topLevelPageUrlAtEvent: "http://wordpress/?p=1",
                      topLevelPageOriginAtEvent: "http://wordpress",
                      frameUrlsAtEvent: ["http://wordpress/?p=1"],
                    },
                  }),
            }),
          );
        }
        return ok(args.includes("--porcelain") ? "7" : "ok");
      },
    },
    healthAttempts: 1,
  });
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 20,
    maxBytes: 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: store,
  });
  const finding = admitWordPressFinding(
    {
      claim: "Synthetic subscriber escalation claim",
      attackerPosition: "subscriber",
      impact: scenario.impact ?? "privesc-to-admin",
      configurationPrecondition: "default",
      brokenProperty: "Synthetic property",
      sourceTrace: [{ file: "example.php", function: "fixture", line: 1 }],
      existingControls: "Synthetic control",
      labObservations: "Synthetic observation",
    },
    {
      runId: "run-1",
      snapshotDigest: snapshot.digest,
      reportArtifactDigest: sha("f"),
    },
  );
  const findingDigest = await store.putFiles({
    "finding.json": canonicalJson(finding),
  });
  await ledger.append({
    schemaVersion: 1,
    identity: "finding",
    campaignId: "campaign-1",
    snapshotDigest: snapshot.digest,
    occurredAt: "2026-10-21T00:00:00Z",
    type: "finding-recorded",
    findingId: finding.findingId,
    runId: "run-1",
    category: finding.impact,
    artifacts: [{ kind: "finding", digest: findingDigest }],
  });
  if (scenario.ordinaryLatestVersion === true)
    // The latest stable version frozen in this campaign, as `review reverify` records it.
    await ledger.append({
      schemaVersion: 1,
      identity: "snapshot-frozen",
      campaignId: "campaign-1",
      snapshotDigest: snapshot.digest,
      occurredAt: "2026-10-21T00:00:00Z",
      type: "snapshot-frozen",
      sourceDigest: snapshot.target.sourceDigest,
      dependencyDigests: snapshot.dependencies.map(
        (dependency) => dependency.sourceDigest,
      ),
    });
  const clock = () => new Date();
  const directory = join(root, "handoff");
  const verification = new Verification({
    ledger,
    store,
    lab,
    observer: createWordPressAttemptObserver({ store, lab }),
    readFinding: readWordPressFinding,
    promptVersion: WBH_VERIFY_SKILL_ID,
    // The same composition as `verify next --handoff` in the CLI host.
    verifier: {
      attempt: (input) =>
        new WordPressVerifier({
          transport: new HandoffVerifier({
            directory,
            handle: input.lab,
            lab,
            ports: shared.ports,
            reviewExport: async () => '{"schema":"review-export/v1"}',
            clock,
            pollIntervalMs: 5,
          }),
          store,
          ledger,
          lab,
          clock,
        }).attempt(input),
    },
    clock,
  });
  const [result, observed] = await Promise.all([
    verification.verify({
      campaignId: "campaign-1",
      findingId: finding.findingId,
      verificationId: "verification-1",
      snapshot,
      ...(scenario.ordinaryLatestVersion === true
        ? {
            basis: {
              kind: "latest-version" as const,
              findingSnapshotDigest: snapshot.digest,
            },
          }
        : {}),
      setup: {
        schemaVersion: 1,
        snapshotDigest: snapshot.digest,
        siteTitle: "Synthetic",
        // The approved-comment scenario needs a first post to comment on.
        initialPosts:
          scenario.ordinaryLatestVersion === true ? ["Welcome"] : [],
        customerRole: false,
        ...(scenario.ordinaryLatestVersion === true
          ? {
              scenario: {
                id: ORDINARY.id,
                digest: ORDINARY.digest,
              },
            }
          : {}),
      },
      campaignLabSetupDigest: sha("b"),
    }),
    skill(directory, state, scenario),
  ]);
  const event = ledger
    .read({ campaignId: "campaign-1", type: "verification-finished" })
    .at(0)?.event;
  return {
    result,
    event,
    ledger,
    store,
    finding,
    state,
    snapshot,
    ...observed,
  };
}

const ORDINARY = wordPressScenario("approved-comment-v1")!;

const AWAITING = {
  status: "incomplete",
  reason: "awaiting-human-observation",
} as const;

describe("handoff verification through the real transport and observer (#525)", () => {
  it("records a finished handoff as awaiting a human observation, with the Harness capture", async () => {
    const { result, event, store, attack, revokedBeforeAttack } =
      await verifyThroughHandoff({});
    expect(result).toMatchObject(AWAITING);
    expect(event).toMatchObject({
      type: "verification-finished",
      promptVersion: WBH_VERIFY_SKILL_ID,
      evidenceCapture: "harness-captured",
      result: AWAITING,
    });
    // The attacker data carries no canary, and setup ended before it was released.
    expect(attack).not.toHaveProperty("canary");
    expect(revokedBeforeAttack).toEqual(["harness-admin"]);
    if (result.status !== "incomplete" || result.evidenceDigest === undefined)
      throw new Error("No evidence was recorded");
    const capture = await store.readFile(
      result.evidenceDigest,
      "proxy-capture.jsonl",
      1024 * 1024,
    );
    expect(capture.status).toBe("resolved");
    // Only what the attacker sent after setup-done is the Harness record.
    if (capture.status === "resolved") {
      expect(capture.bytes.toString()).toContain("/synthetic");
      expect(capture.bytes.toString()).not.toContain("options-general.php");
    }
  });

  it("runs two handoffs at once on one host, each on its own free port, and removes only its own Lab (#432)", async () => {
    const host = dockerHost();
    const root = await mkdtemp(join(tmpdir(), "wbh-handoff-parallel-"));
    directories.push(root);
    const ownerDirectory = join(root, "lab-owners");
    const urls: string[] = [];
    let bothLive!: () => void;
    const together = new Promise<void>((resolve) => (bothLive = resolve));
    let firstDone!: () => void;
    const firstRemoved = new Promise<void>((resolve) => (firstDone = resolve));
    const labIds = () =>
      new Set(
        [...host.containers].map((name) =>
          name.split("-").slice(1, 6).join("-"),
        ),
      );
    let whileBoth: ReadonlySet<string> = new Set();
    let afterFirst:
      | {
          readonly live: ReadonlySet<string>;
          readonly hosted: ReadonlySet<string>;
        }
      | undefined;
    const reach = async (lab: { readonly url: string }) => {
      urls.push(lab.url);
      if (urls.length === 2) {
        whileBoth = labIds();
        bothLive();
      }
      await together;
    };
    const shared = { host, ownerDirectory, ports: { http: 0, database: 0 } };
    const first = verifyThroughHandoff({ beforeFiles: reach }, shared).finally(
      () => firstDone(),
    );
    const second = verifyThroughHandoff(
      {
        beforeFiles: async (lab) => {
          await reach(lab);
          await firstRemoved;
          afterFirst = {
            live: (await readLabOwners(ownerDirectory)).live,
            hosted: labIds(),
          };
        },
      },
      shared,
    );
    const results = await Promise.all([first, second]);
    for (const { result } of results) expect(result).toMatchObject(AWAITING);
    // Both Labs were live together, each behind its own loopback port.
    expect(whileBoth.size).toBe(2);
    expect(new Set(urls).size).toBe(2);
    for (const url of urls)
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d{5}$/);
    // The first teardown left the second Lab and its owner record in place.
    expect(afterFirst?.hosted.size).toBe(1);
    expect(afterFirst?.live).toEqual(afterFirst?.hosted);
    const [survivor] = afterFirst!.hosted;
    expect(whileBoth).toContain(survivor);
    expect([...host.containers, ...host.networks, ...host.volumes]).toEqual([]);
  });

  it("keeps a handoff with no captured attacker request incomplete(evidence)", async () => {
    const { result } = await verifyThroughHandoff({ silent: true });
    expect(result).toMatchObject({ status: "incomplete", reason: "evidence" });
  });

  it("has the Lab browser record the victim pages' marker dialog without deciding (stored XSS)", async () => {
    const { result, event, store, state } = await verifyThroughHandoff({
      impact: "stored-xss",
      victim: {
        role: "administrator",
        paths: ["/wp-admin/edit-comments.php"],
        dialogMarker: MARKER,
      },
    });
    expect(result).toMatchObject(AWAITING);
    expect(state.visits).toEqual(["/wp-admin/edit-comments.php"]);
    if (result.status !== "incomplete" || result.evidenceDigest === undefined)
      throw new Error("No evidence was recorded");
    const record = await store.readJson(
      result.evidenceDigest,
      "lab-browser-observation.json",
      (await import("zod")).z.looseObject({}),
      64 * 1024,
    );
    expect(record).toMatchObject({
      status: "resolved",
      value: {
        observerId: "wordpress-lab-browser",
        status: "visited",
        victimRole: "administrator",
        dialog: { marker: MARKER, visitIndex: 0 },
      },
    });
    const recipe =
      event?.type === "verification-finished"
        ? event.artifacts.find((artifact) => artifact.kind === "recipe")
        : undefined;
    const observed = await createWordPressVerifierRecordReader({
      store,
    }).read({
      recipeDigest: recipe!.digest,
      evidenceDigest: result.evidenceDigest,
    });
    expect(observed.victim).toMatchObject({
      role: "administrator",
      firing: "observed",
      screenshot: expect.stringContaining("victim-page-after-dialog.png"),
    });
  });

  it("records which Harness fixture the Lab browser put into the victim's file input (#468)", async () => {
    const { result, store, state } = await verifyThroughHandoff({
      impact: "stored-xss",
      victim: {
        role: "administrator",
        paths: [
          {
            path: "/wp-admin/upload.php?page=replace",
            actions: [
              {
                kind: "set-file",
                selector: "#userfile",
                fixture: "image-jpeg",
              },
              { kind: "click", selector: "#submit" },
            ],
          },
          "/wp-admin/upload.php",
        ],
        dialogMarker: MARKER,
      },
    });
    expect(result).toMatchObject(AWAITING);
    expect(state.visits).toEqual([
      "/wp-admin/upload.php?page=replace",
      "/wp-admin/upload.php",
    ]);
    if (result.status !== "incomplete" || result.evidenceDigest === undefined)
      throw new Error("No evidence was recorded");
    const jpeg = victimFile("image-jpeg");
    const record = await store.readJson(
      result.evidenceDigest,
      "lab-browser-observation.json",
      (await import("zod")).z.looseObject({}),
      64 * 1024,
    );
    expect(record).toMatchObject({
      status: "resolved",
      value: {
        status: "visited",
        files: [
          {
            visitIndex: 0,
            actionIndex: 0,
            fixture: "image-jpeg",
            fileName: "wbh-fixture.jpg",
            size: jpeg.bytes.length,
            sha256: jpeg.sha256,
          },
        ],
      },
    });
  });

  it("lets a named person record a Lab observation for the result (#525)", async () => {
    const { result, event, ledger, store, finding } =
      await verifyThroughHandoff({});
    if (event?.type !== "verification-finished") throw new Error("no event");
    const ref = {
      campaignId: "campaign-1",
      findingId: finding.findingId,
      verificationId: event.verificationId,
      snapshotDigest: event.snapshotDigest,
    };
    const admitted = await observedReviewLabPackage({ ledger, store, ref });
    expect(admitted).toEqual({
      packageDigest: expect.stringMatching(/^sha256:/),
      recipeDigest: expect.stringMatching(/^sha256:/),
      evidenceDigest:
        result.status === "incomplete" ? result.evidenceDigest : undefined,
    });
    const receipt = await recordManualObservationLabReady({
      ledger,
      store,
      ref,
      packageDigest: admitted!.packageDigest,
      sessionLabel: "wbh-review-net",
    });
    const recorded = await recordManualObservation({
      ledger,
      store,
      ref,
      packageDigest: admitted!.packageDigest,
      sessionReceiptDigest: receipt,
      evidence: new TextEncoder().encode("screen recording notes"),
      result: "match",
      recordedBy: "owner",
    });
    expect(recorded).toMatchObject({
      type: "manual-observation-recorded",
      result: "match",
    });
    expect(currentManualObservation(ledger, ref)).toMatchObject({
      result: "match",
      recordedBy: "owner",
    });
    // The verification event itself is never rewritten into a confirmation.
    expect(
      ledger.read({ type: "verification-finished" }).at(-1)?.event,
    ).toMatchObject({ result: AWAITING });
  });

  it("takes a human-observed result to a Submission Candidate and an exact authorization (#525)", async () => {
    const { result, event, ledger, store, finding, snapshot } =
      await verifyThroughHandoff({ ordinaryLatestVersion: true });
    expect(result).toMatchObject(AWAITING);
    if (event?.type !== "verification-finished") throw new Error("no event");
    const ref = {
      campaignId: "campaign-1",
      findingId: finding.findingId,
      verificationId: event.verificationId,
      snapshotDigest: event.snapshotDigest,
    };
    // The selection record scope reads, as `campaign run` writes it.
    await ledger.append({
      schemaVersion: 1,
      identity: "target-selected",
      campaignId: "campaign-1",
      snapshotDigest: snapshot.digest,
      occurredAt: "2026-10-21T00:00:00Z",
      type: "target-selected",
      selectionId: "selection-1",
      artifacts: [
        {
          kind: "target-selection",
          digest: await store.putFiles({
            "target-selection.json": canonicalJson({
              activeInstallations: 5_000,
              slug: "synthetic-plugin",
            }),
          }),
        },
      ],
    });
    const review = new Review({
      ledger,
      artifactStore: store,
      scopeEvaluator: createWordpressScopeEvaluator(
        await loadWordpressScopePolicy(),
      ),
      factsProvider: createWordPressScopeFacts({ ledger, store }),
    });
    const reproduce = () =>
      review.recordDecision({
        ref,
        decision: "defer",
        reasonCode: "manual-reproduction",
        openedEvidence: [],
        decidedBy: "owner",
        reproduction: { result: "match" },
      });
    // Without a person's Lab observation there is nothing to reproduce or assess.
    await expect(reproduce()).rejects.toThrow(
      "A matching evidence-backed verification is required",
    );
    await expect(review.assessScope({ ref })).rejects.toThrow(
      "A matching evidence-backed verification is required",
    );

    const admitted = await observedReviewLabPackage({ ledger, store, ref });
    if (admitted === null) throw new Error("no review Lab package");
    const receipt = await recordManualObservationLabReady({
      ledger,
      store,
      ref,
      packageDigest: admitted.packageDigest,
      sessionLabel: "wbh-review-net",
    });
    await recordManualObservation({
      ledger,
      store,
      ref,
      packageDigest: admitted.packageDigest,
      sessionReceiptDigest: receipt,
      evidence: new TextEncoder().encode("screen recording notes"),
      result: "match",
      recordedBy: "owner",
    });
    // The observation alone is not the reviewer's reproduction.
    await expect(review.assessScope({ ref })).rejects.toThrow(
      "A matching evidence-backed verification is required",
    );
    await reproduce();
    expect(
      ledger.read({ type: "human-reproduction-recorded" }).at(-1)?.event,
    ).toMatchObject({
      verificationId: ref.verificationId,
      reproductionPackageDigest: admitted.packageDigest,
      result: "match",
    });

    // wbh-review and wbh-report read both human records from the v2 export.
    const exported = await exportReviewBundleV2({
      ledger,
      store,
      campaignId: "campaign-1",
      findingId: finding.findingId,
      verifierRecord: createWordPressVerifierRecordReader({ store }),
    });
    expect(exported.verification).toMatchObject({
      status: "incomplete",
      reason: "awaiting-human-observation",
    });
    expect(exported.review).toMatchObject({
      manualObservation: { result: "match", evidenceStatus: "available" },
      humanReproduction: { result: "match" },
    });

    const assessed = await review.assessScope({ ref });
    expect(assessed.map((item) => [item.programmeId, item.status])).toEqual([
      ["wordfence", "in-scope"],
      ["patchstack", "in-scope"],
    ]);
    const wordfence = assessed.find(
      (item) => item.programmeId === "wordfence",
    )!;
    const draft = await review.saveDraft({
      assessmentId: wordfence.id,
      content: "Synthetic report reviewed by the owner",
      preparedBy: "human",
    });
    expect(draft).toMatchObject({
      candidateId: expect.stringMatching(/^sha256:/),
      destination: "wordfence",
    });
    await review.recordDecision({
      ref,
      decision: "accept",
      reasonCode: "manual-reproduction",
      openedEvidence: [],
      duplicate: { status: "no-match" },
      decidedBy: "owner",
    });
    const exact = {
      candidateId: draft.candidateId,
      draftDigest: draft.digest,
      destination: "wordfence",
    };
    await review.authorizeExternalAction({ ...exact, authorizedBy: "owner" });
    expect(await review.admitExternalAction(exact)).toMatchObject({
      status: "authorized",
    });
    // The verification event is never rewritten into a confirmation.
    expect(
      ledger.read({ type: "verification-finished" }).at(-1)?.event,
    ).toMatchObject({ result: AWAITING });
  });
});
