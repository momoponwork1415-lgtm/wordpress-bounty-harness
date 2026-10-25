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
} from "../../../src/profiles/wordpress/discovery/finding.js";
import { readLabOwners } from "../../../src/infrastructure/lab-owner-record.js";
import { openWordPressLab } from "../../../src/profiles/wordpress/lab/index.js";
import {
  HandoffVerifier,
  WBH_VERIFY_SKILL_ID,
} from "../../../src/profiles/wordpress/verification/handoff-verifier.js";
import { createWordPressJudges } from "../../../src/profiles/wordpress/verification/judges.js";
import { wordpressReproductionRenderer } from "../../../src/profiles/wordpress/verification/reproduction-package.js";
import { WordPressVerifier } from "../../../src/profiles/wordpress/verification/wordpress-verifier.js";
import type { Snapshot } from "../../../src/snapshot/index.js";
import { Verification } from "../../../src/verification/index.js";

const sha = (value: string) => `sha256:${value.repeat(64)}`;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

/** The fake Docker host: roles, sessions (cookie → login) and the recorder's bytes. */
type LabState = {
  attacker: string;
  readonly roles: Map<string, string[]>;
  readonly sessions: Map<string, string>;
  capture: Buffer;
  seededRow: string;
  readonly revoked: string[];
};

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
  /** What the skill does with the setup administrator before `setup-done`. */
  readonly setup?: (state: LabState) => void;
  /** What happens after `attack.json`, besides one attacker request. */
  readonly attack?: (state: LabState) => void;
  /** The `session.json` text the skill reports. */
  readonly session?: string;
  /** Runs after `attack.json` with the connection `lab.json` named, before the six files. */
  readonly beforeFiles?: (lab: { readonly url: string }) => Promise<void>;
};

/** The skill's side: setup as the administrator, `setup-done`, then the attacker route. */
async function skill(directory: string, state: LabState, scenario: Scenario) {
  const lab = JSON.parse(await until(join(directory, "lab.json"))) as {
    administrator: { username: string };
    host: { url: string };
  };
  state.sessions.set("admin-session", lab.administrator.username);
  send(state, "admin-session", "/wp-admin/options-general.php");
  scenario.setup?.(state);
  await writeFile(join(directory, "setup-done"), "");
  await until(join(directory, "attack.json"));
  const revokedBeforeAttack = [...state.revoked];
  state.sessions.set("attacker-session", state.attacker);
  send(state, "attacker-session", "/synthetic");
  scenario.attack?.(state);
  await scenario.beforeFiles?.({ url: lab.host.url });
  for (const [name, text] of Object.entries({
    "route.json":
      '{"role":"subscriber","defaultSettings":true,"steps":[{"kind":"http","method":"GET","path":"/synthetic","expected":"Administrator access"}]}',
    "http.json":
      '{"exchanges":[{"request":{"method":"GET","path":"/synthetic"},"response":{"body":"ok"}}]}',
    "session.json": scenario.session ?? "",
    "steps.md": "Synthetic steps",
    "refutation.md": "",
    precondition: "",
  }))
    await writeFile(join(directory, name), text);
  return { revokedBeforeAttack };
}

/** Real Lab code over a fake Docker host, the real handoff transport and the real judges. */
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
    roles: new Map(),
    sessions: new Map(),
    capture: Buffer.alloc(0),
    seededRow: "",
    revoked: [],
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
        const cookie = env("WBH_SESSION_COOKIE");
        if (cookie !== undefined)
          return ok(`${state.sessions.get(cookie) ?? ""}\n`);
        if (args.includes("--field=roles"))
          return ok((state.roles.get(at("get")) ?? ["subscriber"]).join(","));
        if (at("option") === "get") return ok('"subscriber"\n');
        const query = args.includes("query") ? at("query") : "";
        if (query.startsWith("CREATE TABLE"))
          state.seededRow = /'([a-f0-9]{32})'/.exec(query)?.[1] ?? "";
        if (query.includes("information_schema")) return ok("1\n");
        if (query.startsWith("SELECT")) return ok(`1\t${state.seededRow}\n`);
        return ok(args.includes("--porcelain") ? "7" : "ok");
      },
    },
    nonce: () => "fixed-nonce",
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
    judges: createWordPressJudges({ store, lab }),
    readFinding: readWordPressFinding,
    renderer: wordpressReproductionRenderer,
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
    }),
    skill(directory, state, scenario),
  ]);
  const event = ledger
    .read({ campaignId: "campaign-1", type: "verification-finished" })
    .at(0)?.event;
  return { result, event, ...observed };
}

const escalate = (state: LabState) =>
  state.roles.set(state.attacker, ["administrator", "subscriber"]);

describe("handoff verification through the real transport and judges (#430)", () => {
  it.each([
    [
      "setup gives the attacker account the administrator role",
      { setup: escalate },
      { reason: "evidence", nextStep: expect.stringMatching(/role baseline/) },
    ],
    [
      "setup signs in as the administrator canary and reports that session",
      {
        setup: (state: LabState) =>
          state.sessions.set("canary-session", "wbh-canary-admin-fixed-nonce"),
        session: '{"cookie":"canary-session"}',
      },
      { reason: "observation" },
    ],
    [
      "the setup administrator's session is used after setup-done",
      {
        attack: (state: LabState) => {
          send(state, "admin-session", "/wp-admin/users.php");
          escalate(state);
        },
      },
      {
        reason: "evidence",
        nextStep: "A post-setup request session differs from the Lab attacker",
      },
    ],
  ] as const)(
    "keeps the result incomplete when %s",
    async (_name, scenario: Scenario, reason) => {
      const { result, event, revokedBeforeAttack } =
        await verifyThroughHandoff(scenario);
      expect(result).toMatchObject({ status: "incomplete", ...reason });
      expect(event).toMatchObject({
        type: "verification-finished",
        promptVersion: WBH_VERIFY_SKILL_ID,
        result: { status: "incomplete", ...reason },
      });
      // The setup administrator and the canary principals lost their sessions
      // before the attacker data was released.
      expect(revokedBeforeAttack).toEqual([
        "harness-admin",
        "wbh-canary-admin-fixed-nonce",
        "wbh-canary-fixed-nonce",
      ]);
    },
  );

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
    const first = verifyThroughHandoff(
      { attack: escalate, beforeFiles: reach },
      shared,
    ).finally(() => firstDone());
    const second = verifyThroughHandoff(
      {
        attack: escalate,
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
    for (const { result } of results)
      expect(result).toMatchObject({ status: "runtime-confirmed" });
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

  it("confirms a change the attacker route makes after setup-done", async () => {
    const { result, event } = await verifyThroughHandoff({ attack: escalate });
    expect(result).toMatchObject({
      status: "runtime-confirmed",
      judgeId: "wordpress-administrator-principal",
      conditions: { reachedRole: "administrator", observedVia: "role-change" },
    });
    expect(event).toMatchObject({ evidenceCapture: "harness-captured" });
  });
});
