import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalDigest,
  canonicalJson,
} from "../../../src/infrastructure/canonical-json.js";
import { measureCanonicalSourceTree } from "../../../src/infrastructure/canonical-source-tree.js";
import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../../src/ledger/index.js";
import {
  admitWordPressFinding,
  readWordPressFinding,
} from "../../../src/profiles/wordpress/discovery/finding.js";
import { loadWordPressLabBaseline } from "../../../src/profiles/wordpress/lab/baseline.js";
import { openWordPressLab } from "../../../src/profiles/wordpress/lab/index.js";
import { createWordPressAttemptObserver } from "../../../src/profiles/wordpress/verification/attempt-observer.js";
import {
  handoffBatchDirectory,
  HandoffVerifier,
  WBH_VERIFY_SKILL_ID,
  writeHandoffBatch,
} from "../../../src/profiles/wordpress/verification/handoff-verifier.js";
import { WordPressVerifier } from "../../../src/profiles/wordpress/verification/wordpress-verifier.js";
import type { Snapshot } from "../../../src/snapshot/index.js";
import { Verification } from "../../../src/verification/index.js";
import { baselineDockerAnswers } from "../../support/lab-baseline-docker.js";

// #699: 同じ Snapshot の Finding 2 件を、本物の Lab コード（偽の Docker）と本物の
// handoff の受け渡しで 1 つの Lab に順に流す。Finding ごとのディレクトリ、管理者の
// 発行と無効化、host 入口の国外向け 403 を確かめる。

const sha = (value: string) => `sha256:${value.repeat(64)}`;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function until(path: string): Promise<string> {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
    const text = await readFile(path, "utf8").catch(() => null);
    if (text !== null) return text;
    await sleep(5);
  }
  throw new Error(`${path} did not appear`);
}

/** The skill on one Finding's directory: setup as the administrator, then the six files. */
async function skill(
  directory: string,
  sessions: Map<string, string>,
  capture: { bytes: Buffer },
) {
  const lab = JSON.parse(await until(join(directory, "lab.json"))) as {
    schema: string;
    administrator: { username: string; password: string };
    files: { setupDone: string };
  };
  sessions.set(`setup-${directory}`, lab.administrator.username);
  await writeFile(lab.files.setupDone, "");
  await until(join(directory, "attack.json"));
  const sessionAfterSetup = sessions.has(`setup-${directory}`);
  const line = JSON.stringify({
    request: {
      method: "GET",
      path: "/synthetic",
      headers: {},
      body: "",
      bodyBase64: "",
      truncated: false,
    },
    response: {
      statusCode: 200,
      headers: {},
      body: "ok",
      bodyBase64: Buffer.from("ok").toString("base64"),
      truncated: false,
    },
  });
  capture.bytes = Buffer.concat([capture.bytes, Buffer.from(`${line}\n`)]);
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
    }),
    "http.json":
      '{"exchanges":[{"request":{"method":"GET","path":"/synthetic"},"response":{"body":"ok"}}]}',
    "session.json": "",
    "steps.md": "Synthetic steps",
    "refutation.md": "",
    precondition: "",
  }))
    await writeFile(join(directory, name), text);
  return { lab, sessionAfterSetup };
}

describe("one handoff Lab for two Findings of one Snapshot (#699)", () => {
  it("serves each Finding from its own directory with its own administrator, on one Lab", async () => {
    const root = await mkdtemp(join(tmpdir(), "wbh-handoff-batch-"));
    directories.push(root);
    const sourceDirectory = join(root, "source");
    await mkdir(sourceDirectory);
    await writeFile(join(sourceDirectory, "example.php"), "<?php // ok\n");
    const tree = await measureCanonicalSourceTree(sourceDirectory, {
      maxEntries: 10,
      maxBytes: 1000,
    });
    const body = {
      kind: "source-snapshot" as const,
      schemaVersion: 1 as const,
      target: {
        identity: "example",
        version: "1.0",
        sourceDigest: tree.digest,
      },
      dependencies: [],
    };
    const snapshot: Snapshot = { ...body, digest: canonicalDigest(body) };
    const sessions = new Map<string, string>();
    const capture = { bytes: Buffer.alloc(0) };
    const revoked: string[] = [];
    const exposures: (readonly string[])[] = [];
    const answers = baselineDockerAnswers();
    let wordpressStarts = 0;
    const ok = (stdout = "ok") => ({ exitCode: 0, stdout, stderr: "" });
    const lab = openWordPressLab({
      dockerExecutablePath: "/usr/bin/docker",
      ownerDirectory: join(root, "lab-owners"),
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
          const answered = answers(args);
          if (answered !== null) return answered;
          const env = (name: string) =>
            args
              .find((arg) => arg.startsWith(`${name}=`))
              ?.slice(name.length + 1);
          if (args[0] === "info") return ok('{"runsc":{}}');
          if (args[0] === "inspect") return ok("172.20.0.2");
          if (args[0] === "port") return ok("127.0.0.1:18080\n");
          if (
            args[0] === "run" &&
            args.includes("--detach") &&
            args[args.indexOf("--name") + 1]?.endsWith("-wp")
          )
            wordpressStarts++;
          if (args[0] === "create" && args.some((arg) => arg.endsWith("-host")))
            exposures.push(args);
          if (args[0] === "exec" && args[1]?.endsWith("-proxy"))
            return args[2] === "wc"
              ? ok(`${capture.bytes.length} capture\n`)
              : args[2] === "tail"
                ? ok(
                    capture.bytes
                      .subarray(Number(args[4]?.slice(1)) - 1)
                      .toString(),
                  )
                : ok("0");
          const principals = env("WBH_SETUP_PRINCIPALS");
          if (principals !== undefined) {
            const logins = (JSON.parse(principals) as string[][]).map(
              ([login]) => login!,
            );
            for (const [cookie, login] of sessions)
              if (logins.includes(login)) sessions.delete(cookie);
            revoked.push(...logins);
            return ok();
          }
          if (env("WBH_VISIT_PATH") !== undefined)
            return ok(
              JSON.stringify({
                screenshotBase64: Buffer.from("png").toString("base64"),
              }),
            );
          return ok(args.includes("--porcelain") ? "7" : "ok");
        },
      },
      healthAttempts: 1,
    });
    const store = new PrivateArtifactStore({
      rootDirectory: join(root, "evidence"),
      maxEntries: 40,
      maxBytes: 1024 * 1024,
    });
    const ledger = new Ledger({
      databasePath: join(root, "ledger.sqlite"),
      artifactStore: store,
    });
    const findings = [];
    for (const caseId of ["a", "b"]) {
      const finding = admitWordPressFinding(
        {
          claim: `Synthetic subscriber escalation claim ${caseId}`,
          attackerPosition: "subscriber",
          impact: "privesc-to-admin",
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
        identity: `finding-${caseId}`,
        campaignId: "campaign-1",
        snapshotDigest: snapshot.digest,
        occurredAt: "2026-10-31T00:00:00Z",
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
      findings.push(finding);
    }
    const handoff = join(root, "handoff");
    const clock = () => new Date();
    // The composition `verify next --handoff` builds in the CLI host.
    const verification = new Verification({
      ledger,
      store,
      lab,
      observer: createWordPressAttemptObserver({ store, lab }),
      readFinding: readWordPressFinding,
      promptVersion: WBH_VERIFY_SKILL_ID,
      verifier: {
        readyForNextAttempt: (handle) => lab.finishSetup(handle),
        attackerOrigin: (handle, finding) =>
          lab.attackerEntrance(handle, finding.attackerPosition)?.origin,
        attempt: (input) =>
          new WordPressVerifier({
            transport: new HandoffVerifier({
              directory:
                input.batch === undefined
                  ? handoff
                  : handoffBatchDirectory(
                      handoff,
                      input.batch.position,
                      input.finding.findingId,
                    ),
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
    const { ref } = await loadWordPressLabBaseline("hosting-default-v1");
    const items = findings.map((finding, index) => ({
      findingId: finding.findingId,
      verificationId: `verification-${index + 1}`,
    }));
    await writeHandoffBatch(handoff, items);
    const dirs = findings.map((finding, index) =>
      handoffBatchDirectory(handoff, index + 1, finding.findingId),
    );
    const skills = (async () => {
      const first = await skill(dirs[0]!, sessions, capture);
      const revokedAfterFirst = revoked.length;
      const second = await skill(dirs[1]!, sessions, capture);
      return { first, second, revokedAfterFirst };
    })();
    const [outcomes, seen] = await Promise.all([
      verification.verifyBatch({
        campaignId: "campaign-1",
        items,
        snapshot,
        setup: {
          schemaVersion: 1,
          snapshotDigest: snapshot.digest,
          siteTitle: "Synthetic",
          initialPosts: [],
          customerRole: false,
          baseline: ref,
        },
        campaignLabSetupDigest: sha("b"),
      }),
      skills,
    ]);

    // One Lab served both Findings.
    expect(wordpressStarts).toBe(1);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "recorded",
      "recorded",
    ]);
    const labs = ledger
      .readAll({ type: "lab-provisioned" })
      .map(({ event }) => event);
    expect(
      new Set(
        labs.map((event) => event.type === "lab-provisioned" && event.labId),
      ).size,
    ).toBe(1);
    expect(labs[0]).toMatchObject({ baseline: ref });
    // Both attackers log in as a subscriber, so they stand at the domestic origin.
    expect(
      labs.map(
        (event) =>
          event.type === "lab-provisioned" && event.baseline?.attackerOrigin,
      ),
    ).toEqual(["domestic", "domestic"]);
    expect(
      ledger
        .readAll({ type: "verification-finished" })
        .map(({ event }) =>
          event.type === "verification-finished"
            ? [event.findingId, event.result]
            : null,
        ),
    ).toEqual(
      findings.map((finding) => [
        finding.findingId,
        expect.objectContaining({
          status: "incomplete",
          reason: "awaiting-human-observation",
        }),
      ]),
    );

    // Each directory has today's lab.json and the six files; batch.json lists them.
    expect(seen.first.lab.schema).toBe("wbh-handoff-lab/v2");
    expect(seen.second.lab.schema).toBe("wbh-handoff-lab/v2");
    expect(
      JSON.parse(await readFile(join(handoff, "batch.json"), "utf8")),
    ).toEqual({
      schema: "wbh-handoff-batch/v1",
      findings: items.map((item, index) => ({
        position: index + 1,
        findingId: item.findingId,
        verificationId: item.verificationId,
        directory: dirs[index],
      })),
    });
    expect(dirs[0]).toMatch(/\/1-[a-f0-9]{12}$/);

    // 受入 6: each Finding's setup administrator is revoked at its own setup-done,
    // and the next Finding gets a password issued after that.
    expect(seen.first.sessionAfterSetup).toBe(false);
    expect(seen.second.sessionAfterSetup).toBe(false);
    expect(seen.revokedAfterFirst).toBeGreaterThanOrEqual(1);
    // setup-done of the first, the next Finding's issue, setup-done of the second.
    expect(revoked).toEqual([
      "harness-admin",
      "harness-admin",
      "harness-admin",
    ]);
    expect(seen.second.lab.administrator.password).not.toBe(
      seen.first.lab.administrator.password,
    );

    // A logged-in attacker is domestic: no 403 entrance after either setup-done.
    const filtered = exposures.map((args) =>
      args.some((arg) => arg.startsWith("WBH_DENIED_PATHS=")),
    );
    expect(filtered).toEqual([false, false]);
  });
});
