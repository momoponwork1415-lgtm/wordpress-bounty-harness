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
import { openWordPressLab } from "../../../src/profiles/wordpress/lab/index.js";
import { observedReviewLabPackage } from "../../../src/profiles/wordpress/lab/observed-review-lab.js";
import { createWordPressAttemptObserver } from "../../../src/profiles/wordpress/verification/attempt-observer.js";
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

type Scenario = {
  readonly impact?: WordPressFinding["impact"];
  /** The skill sends no attacker request after `setup-done`. */
  readonly silent?: boolean;
  /** The victim pages `route.json` declares for the Lab browser. */
  readonly victim?: unknown;
};

/** The skill's side: setup as the administrator, `setup-done`, then the attacker route. */
async function skill(directory: string, state: LabState, scenario: Scenario) {
  const lab = JSON.parse(await until(join(directory, "lab.json"))) as {
    administrator: { username: string };
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
async function verifyThroughHandoff(scenario: Scenario) {
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
    leaseDirectory: join(root, "host-lab-lease"),
    leaseWaitMs: 0,
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
            ports: { http: 18080, database: 13307 },
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
      setup: {
        schemaVersion: 1,
        snapshotDigest: snapshot.digest,
        siteTitle: "Synthetic",
        initialPosts: [],
        customerRole: false,
      },
      campaignLabSetupDigest: sha("b"),
    }),
    skill(directory, state, scenario),
  ]);
  const event = ledger
    .read({ campaignId: "campaign-1", type: "verification-finished" })
    .at(0)?.event;
  return { result, event, ledger, store, finding, state, ...observed };
}

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
});
