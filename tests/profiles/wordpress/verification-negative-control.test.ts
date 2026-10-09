import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import {
  openWordPressLab,
  type WordPressLabHandle,
  type WordPressLabSetup,
} from "../../../src/profiles/wordpress/lab/index.js";
import { createWordPressJudges } from "../../../src/profiles/wordpress/verification/judges.js";
import {
  wordpressReproductionRenderer,
  type WordPressReconstruction,
} from "../../../src/profiles/wordpress/verification/reproduction-package.js";
import type { Snapshot } from "../../../src/snapshot/index.js";
import { Verification } from "../../../src/verification/index.js";

const sha = (value: string) => `sha256:${value.repeat(64)}`;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

/** The Lab answers with Docker output; `changed` decides whether the canary state moved. */
async function verifyOnce(
  changed: boolean,
  impact: WordPressFinding["impact"] = "account-takeover",
) {
  let seededRow = "";
  let salt = "";
  let attempted = false;
  const beacons: string[] = [];
  const root = await mkdtemp(join(tmpdir(), "wbh-negative-"));
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
  const lab = openWordPressLab({
    dockerExecutablePath: "/usr/bin/docker",
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
      async run(request) {
        if (request.args[0] === "info")
          return { exitCode: 0, stdout: '{"runsc":{}}', stderr: "" };
        if (request.args[0] === "inspect")
          return { exitCode: 0, stdout: "172.20.0.2", stderr: "" };
        const saltArg = request.args.find((arg) =>
          arg.startsWith("WBH_EXECUTION_SALT="),
        );
        if (saltArg !== undefined)
          salt = saltArg.slice("WBH_EXECUTION_SALT=".length);
        if (
          request.args[0] === "run" &&
          request.args.includes(`verification-browser@${sha("4")}`)
        ) {
          // Unchanged Lab: the front page loads but nothing reaches the receiver.
          if (
            changed &&
            request.args.includes("WBH_VISIT_PATH=/") &&
            !request.args.some((arg) => arg.startsWith("WBH_LOGIN_USER="))
          )
            beacons.push("/b/fixed-nonce");
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (request.args[0] === "exec" && request.args[1]?.endsWith("-canary"))
          return {
            exitCode: beacons.length === 0 ? 1 : 0,
            stdout: beacons.map((line) => `${line}\n`).join(""),
            stderr: "",
          };
        if (request.args[0] === "exec" && request.args[2] === "cat") {
          // Unchanged Lab: the stored file holds the nonce but never ran.
          const token = (request.args[3] ?? "").replace(
            "/tmp/wbh-execution-",
            "",
          );
          return {
            exitCode: 0,
            stdout: changed
              ? createHash("sha256").update(`${token}${salt}`).digest("hex")
              : token,
            stderr: "",
          };
        }
        const option = request.args.indexOf("option");
        if (option >= 0 && request.args[option + 1] === "get")
          return {
            exitCode: 0,
            // Unchanged Lab: default_role reads the same before and after the route.
            stdout:
              changed &&
              attempted &&
              request.args[option + 2] === "default_role"
                ? '"administrator"\n'
                : '"subscriber"\n',
            stderr: "",
          };
        if (request.args[0] === "exec" && request.args[2] === "test")
          return { exitCode: changed ? 1 : 0, stdout: "", stderr: "" };
        if (request.args[0] === "exec" && request.args[2] === "grep")
          return {
            exitCode: 0,
            stdout: "/var/www/html/wp-content/uploads/synthetic.php\n",
            stderr: "",
          };
        if (request.args.includes("--field=roles"))
          return { exitCode: 0, stdout: "subscriber\n", stderr: "" };
        const query = request.args.includes("query")
          ? (request.args[request.args.indexOf("query") + 1] ?? "")
          : "";
        if (query.startsWith("CREATE TABLE"))
          seededRow = /'([a-f0-9]{32})'/.exec(query)?.[1] ?? "";
        if (query.includes("information_schema"))
          return { exitCode: 0, stdout: "1\n", stderr: "" };
        if (query.startsWith("SELECT"))
          return {
            exitCode: 0,
            stdout: `1\t${changed ? "overwritten" : seededRow}\n`,
            stderr: "",
          };
        if (request.args.includes("eval")) {
          // Unchanged Lab: the presented session is the attacker's own account.
          const attacker = request.args.find((arg) =>
            arg.startsWith("WBH_SESSION_COOKIE="),
          );
          return {
            exitCode: 0,
            stdout:
              changed && attacker !== undefined
                ? "wbh-canary-admin-fixed-nonce\n"
                : "wbh-subscriber-attacker\n",
            stderr: "",
          };
        }
        if (request.args.includes("--porcelain"))
          return { exitCode: 0, stdout: "7", stderr: "" };
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    },
    nonce: () => "fixed-nonce",
    healthAttempts: 1,
  });
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 10,
    maxBytes: 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: store,
  });
  const finding = admitWordPressFinding(
    {
      claim: "Synthetic administrator takeover claim",
      attackerPosition: "subscriber",
      impact,
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
  await ledger.append({
    schemaVersion: 1,
    identity: "finding",
    campaignId: "campaign-1",
    snapshotDigest: snapshot.digest,
    occurredAt: "2026-10-08T00:00:00Z",
    type: "finding-recorded",
    findingId: finding.findingId,
    runId: "run-1",
    category: finding.impact,
    artifacts: [
      {
        kind: "finding",
        digest: await store.putFiles({
          "finding.json": canonicalJson(finding),
        }),
      },
    ],
  });
  const verification = new Verification<
    WordPressFinding,
    WordPressLabSetup,
    WordPressLabHandle,
    WordPressReconstruction
  >({
    ledger,
    store,
    lab,
    judges: createWordPressJudges({ store, lab }),
    readFinding: readWordPressFinding,
    renderer: wordpressReproductionRenderer,
    verifier: {
      // The Verifier always claims success; only the Lab state may decide.
      async attempt({ lab: handle }) {
        lab.prepareExecutionCanary(handle);
        lab.prepareScriptCanary(handle);
        attempted = true;
        return {
          status: "attempted",
          recipeDigest: await store.putFiles({
            "route.json": JSON.stringify({
              role: "subscriber",
              account: "lab-subscriber",
              defaultSettings: true,
              configurationChanges: [],
              steps: [
                {
                  kind: "http",
                  method: "GET",
                  path: "/synthetic",
                  expected: "Administrator access obtained",
                },
              ],
            }),
            "http.json": JSON.stringify({
              exchanges: [
                {
                  request: { method: "GET", path: "/synthetic" },
                  response: { status: 200, body: "Synthetic page" },
                },
              ],
            }),
            "session.json": JSON.stringify({ cookie: "synthetic-session" }),
            "notes.md": "Administrator access was obtained.\n",
          }),
        };
      },
    },
    clock: () => new Date("2026-10-08T01:00:00Z"),
  });
  const result = await verification.verify({
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
    reconstruction: {
      wordpressVersion: "6.8",
      target: snapshot.target,
      enabledSettings: [],
      roles: ["unauthenticated", "subscriber"],
    },
  });
  const event = ledger
    .read({ campaignId: "campaign-1", type: "verification-finished" })
    .at(0)?.event;
  return {
    result,
    funnel: ledger.funnel("campaign-1"),
    evidenceCapture:
      event?.type === "verification-finished"
        ? event.evidenceCapture
        : undefined,
  };
}

describe("WordPress verification negative control", () => {
  it("does not confirm in a Lab where nothing changed, whatever the Verifier claims", async () => {
    const { result, funnel } = await verifyOnce(false);
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "observation",
    });
    expect(funnel.confirmed).toBe(0);
  });

  it("confirms the same route once the Lab reports the administrator canary session", async () => {
    const { result, funnel, evidenceCapture } = await verifyOnce(true);
    expect(result).toMatchObject({
      status: "runtime-confirmed",
      judgeId: "wordpress-administrator-principal",
      conditions: { reachedRole: "administrator", observedVia: "session" },
    });
    expect(funnel.confirmed).toBe(1);
    expect(evidenceCapture).toBe("agent-authored");
  });

  it("does not confirm rce when the stored canary file holds the nonce but never ran", async () => {
    const { result, funnel } = await verifyOnce(false, "rce");
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "observation",
    });
    expect(funnel.confirmed).toBe(0);
  });

  it("confirms rce once the Lab holds the salted marker", async () => {
    const { result } = await verifyOnce(true, "rce");
    expect(result).toMatchObject({
      status: "runtime-confirmed",
      judgeId: "wordpress-execution-canary",
      conditions: { canaryFiles: "wp-content/uploads/synthetic.php" },
    });
  });

  it.each(["arbitrary-file-read", "arbitrary-file-delete"] as const)(
    "does not confirm %s while every canary file is in place and none came back",
    async (impact) => {
      const { result, funnel } = await verifyOnce(false, impact);
      expect(result).toMatchObject({
        status: "incomplete",
        reason: "observation",
      });
      expect(funnel.confirmed).toBe(0);
    },
  );

  it("confirms arbitrary-file-delete once the Lab reports the canary files gone", async () => {
    const { result } = await verifyOnce(true, "arbitrary-file-delete");
    expect(result).toMatchObject({
      status: "runtime-confirmed",
      judgeId: "wordpress-file-canary-delete",
      conditions: { pathAndExtension: "attacker-chosen" },
    });
  });

  it("does not confirm options-update while every watched option keeps its baseline", async () => {
    const { result, funnel } = await verifyOnce(false, "options-update");
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "observation",
    });
    expect(funnel.confirmed).toBe(0);
  });

  it("confirms options-update once a critical option moved after the route", async () => {
    const { result } = await verifyOnce(true, "options-update");
    expect(result).toMatchObject({
      status: "runtime-confirmed",
      judgeId: "wordpress-option-canary",
      conditions: { changedOptions: "default_role", optionClass: "critical" },
    });
  });

  it("does not confirm stored-xss while no beacon reaches the Lab receiver", async () => {
    const { result, funnel } = await verifyOnce(false, "stored-xss");
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "observation",
    });
    expect(funnel.confirmed).toBe(0);
  });

  it("confirms stored-xss once the front page sends the issued beacon", async () => {
    const { result } = await verifyOnce(true, "stored-xss");
    expect(result).toMatchObject({
      status: "runtime-confirmed",
      judgeId: "wordpress-stored-script",
      conditions: { firedContexts: "front", siteWide: "yes" },
    });
  });

  it("does not confirm sqli while the canary table is intact and no response carries its row", async () => {
    const { result, funnel } = await verifyOnce(false, "sqli");
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "observation",
    });
    expect(funnel.confirmed).toBe(0);
  });

  it("confirms sqli once the Lab reports the canary table changed", async () => {
    const { result } = await verifyOnce(true, "sqli");
    expect(result).toMatchObject({
      status: "runtime-confirmed",
      judgeId: "wordpress-sql-canary",
      conditions: { observedVia: "canary-table-write" },
    });
  });
});
