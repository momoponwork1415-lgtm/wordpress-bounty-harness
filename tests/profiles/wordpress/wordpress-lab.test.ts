import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";

import { afterEach, describe, expect, it } from "vitest";

import { measureCanonicalSourceTree } from "../../../src/infrastructure/canonical-source-tree.js";
import { canonicalDigest } from "../../../src/infrastructure/canonical-json.js";
import {
  readDiscoveryOwners,
  readLabOwners,
  recordDiscoveryOwner,
  recordLabOwner,
} from "../../../src/infrastructure/lab-owner-record.js";
import {
  openWordPressLab,
  type DockerRequest,
  type WordPressLabHandle,
  type WordPressVictimRoute,
} from "../../../src/profiles/wordpress/lab/index.js";
import type { Snapshot } from "../../../src/snapshot/index.js";
import {
  wordPressScenario,
  nextWordPressScenario,
} from "../../../src/profiles/wordpress/lab/scenarios.js";
import { userRegistrationOrdinarySetupScript } from "../../../src/profiles/wordpress/lab/user-registration-adapter.js";
import {
  userRegistrationMembershipEnrollmentScript,
  userRegistrationMembershipInstallScript,
  userRegistrationMembershipUnjoinedScript,
} from "../../../src/profiles/wordpress/lab/user-registration-membership-adapter.js";
import { wpDiscuzOrdinarySetupScript } from "../../../src/profiles/wordpress/lab/wpdiscuz-adapter.js";
import { wpMembersOrdinarySetupScript } from "../../../src/profiles/wordpress/lab/wp-members-adapter.js";

const directories: string[] = [];
const sha = (value: string) => `sha256:${value.repeat(64)}`;
const browserDiagnostic = {
  schemaVersion: 1,
  document: {
    readyState: "complete",
    elementCount: 12,
    imageCount: 1,
    brokenImageCount: 1,
    inlineHandlerCount: 1,
  },
  runtime: {
    pageErrorCounts: {
      syntax: 1,
      reference: 0,
      type: 0,
      security: 0,
      other: 0,
    },
    consoleErrorCount: 1,
    failedRequestCount: 1,
    http4xxCount: 1,
    http5xxCount: 0,
  },
} as const;

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(
  preflight:
    "ready" | "no-runsc" | "missing-image" | "missing-extension" = "ready",
  core?: { readonly version: string; readonly runningVersion: string },
  pluginSlug = "example",
  strictSourceMode = false,
  dependencySlugs: readonly string[] = [],
  php?: { readonly version: string; readonly runningVersion: string },
) {
  const root = await mkdtemp(join(tmpdir(), "wbh-lab-"));
  directories.push(root);
  const sourceDirectory = join(root, "source");
  await mkdir(sourceDirectory);
  await writeFile(
    join(sourceDirectory, "example.php"),
    "<?php // harmless fixture\n",
  );
  const sourceTree = await measureCanonicalSourceTree(sourceDirectory, {
    maxEntries: 10,
    maxBytes: 1000,
  });
  const snapshotBody = {
    kind: "source-snapshot" as const,
    schemaVersion: 1 as const,
    target: {
      identity: "example",
      version: "1.0",
      sourceDigest: sourceTree.digest,
    },
    dependencies: [
      ...(core === undefined
        ? []
        : [
            {
              identity: "wordpress-core",
              version: core.version,
              sourceDigest: sourceTree.digest,
            },
          ]),
      ...(php === undefined
        ? []
        : [
            {
              identity: "php-runtime-source",
              version: php.version,
              sourceDigest: sourceTree.digest,
            },
          ]),
      ...dependencySlugs.map((slug) => ({
        identity: `wporg:${slug}`,
        version: "1.0",
        sourceDigest: sourceTree.digest,
      })),
    ],
  };
  const snapshot: Snapshot = {
    ...snapshotBody,
    digest: canonicalDigest(snapshotBody),
  };
  const commands: DockerRequest[] = [];
  const fixedAddresses = new Map<string, string>();
  /** What the fake Lab browser and WP-CLI answer. */
  const database = {
    /** Option values as `wp option get --format=json` prints them. */
    options: new Map<string, string>([
      ["users_can_register", "0"],
      ["default_role", '"subscriber"'],
    ]),
    /** Paths whose visit shows an alert with the declared marker. */
    dialogOn: [] as string[],
    browserFailureAt: null as string | null,
    browserFailureMessage: "private-debug-marker",
    browserDiagnosticOutput: "valid" as "valid" | "missing" | "invalid",
  };
  /** The fake Docker daemon's objects and the loopback ports it bound. */
  const docker = {
    containers: new Set<string>(),
    networks: new Set<string>(),
    volumes: new Set<string>(),
    ports: new Map<string, number>(),
    nextPort: 32768,
  };
  let pluginReadableByCli = false;
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
          pluginSlug,
          sourceDirectory,
          sourceTree,
        },
        dependencies: [
          ...(core === undefined
            ? []
            : [
                {
                  kind: "wordpress-core" as const,
                  version: core.version,
                  sourceDirectory,
                  sourceTree,
                },
              ]),
          ...(php === undefined
            ? []
            : [
                {
                  kind: "php-source" as const,
                  version: php.version,
                  sourceDirectory,
                  sourceTree,
                },
              ]),
          ...dependencySlugs.map((slug) => ({
            kind: "plugin" as const,
            pluginSlug: slug,
            sourceDirectory,
            sourceTree,
          })),
        ],
      }),
    },
    runner: {
      async run(request) {
        commands.push(request);
        // An exploration Lab's WordPress takes a fixed address on a fixed subnet.
        const fixedIp = request.args.find((arg) => arg.startsWith("--ip="));
        if (request.args[0] === "run" && fixedIp !== undefined)
          fixedAddresses.set(
            request.args[request.args.indexOf("--name") + 1] ?? "",
            fixedIp.slice("--ip=".length),
          );
        if (request.args[0] === "network" && request.args[1] === "inspect")
          return { exitCode: 0, stdout: "172.20.0.0/24\n", stderr: "" };
        if (
          request.args[0] === "inspect" &&
          fixedAddresses.has(request.args.at(-1) ?? "")
        )
          return {
            exitCode: 0,
            stdout: fixedAddresses.get(request.args.at(-1) ?? "")!,
            stderr: "",
          };
        const [verb, object] = request.args;
        const named = request.args[request.args.indexOf("--name") + 1] ?? "";
        const operands = request.args.filter((arg) => !arg.startsWith("-"));
        const listing = (names: Set<string>) => ({
          exitCode: 0,
          stdout: [...names].join("\n"),
          stderr: "",
        });
        if (
          (verb === "run" && request.args.includes("--detach")) ||
          verb === "create"
        ) {
          docker.containers.add(named);
          request.args.forEach((arg, index) => {
            const published = /^127\.0\.0\.1:(\d*):(\d+)$/.exec(arg);
            if (request.args[index - 1] === "--publish" && published !== null)
              docker.ports.set(
                `${named} ${published[2]}/tcp`,
                published[1] === "" ? docker.nextPort++ : Number(published[1]),
              );
          });
        }
        if (verb === "rm")
          for (const name of operands.slice(1)) docker.containers.delete(name);
        if (verb === "network" && object === "create")
          docker.networks.add(request.args.at(-1)!);
        if (verb === "network" && object === "rm")
          for (const name of operands.slice(2)) docker.networks.delete(name);
        if (verb === "volume" && object === "create")
          docker.volumes.add(request.args.at(-1)!);
        if (verb === "volume" && object === "rm")
          for (const name of operands.slice(2)) docker.volumes.delete(name);
        if (verb === "ps") return listing(docker.containers);
        if (verb === "network" && object === "ls")
          return listing(docker.networks);
        if (verb === "volume" && object === "ls")
          return listing(docker.volumes);
        if (verb === "port") {
          const bound = docker.ports.get(
            `${request.args[1]} ${request.args[2]}`,
          );
          return bound === undefined
            ? { exitCode: 1, stdout: "", stderr: "no public port" }
            : { exitCode: 0, stdout: `127.0.0.1:${bound}\n`, stderr: "" };
        }
        if (request.args[0] === "info")
          return {
            exitCode: 0,
            stdout: preflight === "no-runsc" ? "{}" : '{"runsc":{}}',
            stderr: "",
          };
        if (request.args[0] === "image" && preflight === "missing-image")
          return { exitCode: 1, stdout: "", stderr: "unavailable" };
        if (
          request.args[0] === "exec" &&
          request.args.includes("chmod") &&
          request.args.includes("a+rX")
        )
          pluginReadableByCli = true;
        if (
          strictSourceMode &&
          request.args[0] === "run" &&
          request.args.includes("plugin") &&
          request.args.includes("activate") &&
          !pluginReadableByCli
        )
          return {
            exitCode: 1,
            stdout: "",
            stderr: "The 'example' plugin could not be found",
          };
        if (
          preflight === "missing-extension" &&
          request.args[0] === "exec" &&
          request.args[2] === "php" &&
          request.args[4]?.includes('extension_loaded("pdo_mysql")')
        )
          return { exitCode: 43, stdout: "", stderr: "" };
        if (
          request.args[0] === "exec" &&
          request.args[2] === "php" &&
          request.args[4] === "echo PHP_VERSION;"
        )
          return {
            exitCode: 0,
            stdout: php?.runningVersion ?? "8.3.35",
            stderr: "",
          };
        if (request.args[0] === "inspect")
          return {
            exitCode: 0,
            stdout: request.args.at(-1)?.endsWith("-db")
              ? "172.20.0.3"
              : request.args.at(-1)?.endsWith("-proxy")
                ? "172.20.0.4"
                : request.args.at(-1)?.endsWith("-canary")
                  ? "172.20.0.5"
                  : request.args.at(-1)?.endsWith("-ctl")
                    ? "172.20.0.130"
                    : "172.20.0.2",
            stderr: "",
          };
        if (request.args[0] === "exec" && request.args[1]?.endsWith("-proxy")) {
          if (request.args[2] === "wc")
            return {
              exitCode: 0,
              stdout: "0 /var/lib/wbh/capture.jsonl\n",
              stderr: "",
            };
          if (request.args[2] === "tail")
            return { exitCode: 0, stdout: '{"synthetic":true}\n', stderr: "" };
          if (request.args[2] === "sh")
            return { exitCode: 0, stdout: "0", stderr: "" };
        }
        if (request.args.includes("--entrypoint=php"))
          return {
            exitCode: 0,
            stdout: request.args.some((arg) => arg.startsWith("WBH_DB_USER="))
              ? '{"http":"ok","database":"ok"}'
              : '{"http":"ok","database":"not-exposed"}',
            stderr: "",
          };
        if (request.args.some((arg) => arg.startsWith("SHOW TABLES FROM ")))
          return {
            exitCode: 0,
            stdout: "wp_options\nwp_posts\ninvalid;table\n",
            stderr: "",
          };
        if (request.args.includes("core") && request.args.includes("version"))
          return {
            exitCode: 0,
            stdout: `${core?.runningVersion ?? "6.8.3"}\n`,
            stderr: "",
          };
        if (
          request.args[0] === "run" &&
          request.args.includes(`verification-browser@${sha("4")}`)
        ) {
          const visit = request.args
            .find((arg) => arg.startsWith("WBH_VISIT_PATH="))
            ?.slice("WBH_VISIT_PATH=".length);
          if (visit === database.browserFailureAt)
            return {
              exitCode: 1,
              stdout: "",
              stderr: database.browserFailureMessage,
            };
          const marker = request.args
            .find((arg) => arg.startsWith("WBH_DIALOG_MARKER="))
            ?.slice("WBH_DIALOG_MARKER=".length);
          const dialog =
            visit !== undefined &&
            marker !== undefined &&
            database.dialogOn.includes(visit)
              ? {
                  dialogEvent: {
                    type: "alert",
                    message: marker,
                    topLevelPageUrlAtEvent: `http://wordpress${visit}`,
                    topLevelPageOriginAtEvent: "http://wordpress",
                    frameUrlsAtEvent: [`http://wordpress${visit}`],
                  },
                }
              : {};
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              screenshotBase64: Buffer.concat([
                Buffer.from("89504e470d0a1a0a", "hex"),
                Buffer.from("synthetic observer output"),
              ]).toString("base64"),
              httpStatus: 404,
              dialogCount: 1,
              consoleErrorCount: 3,
              ...dialog,
              ...(database.browserDiagnosticOutput === "missing"
                ? {}
                : {
                    diagnostic:
                      database.browserDiagnosticOutput === "valid"
                        ? browserDiagnostic
                        : { schemaVersion: 99 },
                  }),
            }),
            stderr: "",
          };
        }
        const option = request.args.indexOf("option");
        if (option >= 0 && request.args[option + 1] === "get") {
          const value = database.options.get(request.args[option + 2] ?? "");
          return value === undefined
            ? { exitCode: 1, stdout: "", stderr: "missing" }
            : { exitCode: 0, stdout: `${value}\n`, stderr: "" };
        }
        if (request.args.includes("--porcelain"))
          return { exitCode: 0, stdout: "7", stderr: "" };
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    },
    healthAttempts: 1,
  });
  const setup = {
    schemaVersion: 1 as const,
    snapshotDigest: snapshot.digest,
    siteTitle: "Fixture",
    initialPosts: ["Welcome"],
    customerRole: false,
  };
  return {
    lab,
    snapshot,
    setup,
    commands,
    sourceDirectory,
    database,
    docker,
    ownerDirectory: join(root, "lab-owners"),
  };
}

describe("WordPress gVisor Lab", () => {
  it("checks the active PHP version against frozen source without installing it as a plugin", async () => {
    const { lab, snapshot, setup, commands } = await fixture(
      "ready",
      undefined,
      "example",
      false,
      [],
      { version: "8.3.35", runningVersion: "8.3.35" },
    );
    const provisioned = await lab.provision(snapshot, setup);
    expect(provisioned.status).toBe("ready");
    expect(
      commands.some(({ args }) => args.includes("echo PHP_VERSION;")),
    ).toBe(true);
    expect(
      commands
        .filter(
          ({ args }) => args.includes("plugin") && args.includes("activate"),
        )
        .map(({ args }) => args[args.indexOf("activate") + 1]),
    ).toEqual(["example"]);
    if (provisioned.status === "ready") await lab.teardown(provisioned.handle);
  });

  it("does not start a Trial when active PHP differs from the frozen source", async () => {
    const { lab, snapshot, setup, commands } = await fixture(
      "ready",
      undefined,
      "example",
      false,
      [],
      { version: "8.3.35", runningVersion: "8.3.34" },
    );
    const provisioned = await lab.provision(snapshot, setup);
    expect(provisioned).toMatchObject({
      status: "incomplete",
      reason: "provision",
    });
    expect(
      commands.some(
        ({ args }) => args.includes("plugin") && args.includes("activate"),
      ),
    ).toBe(false);
  });

  it("installs and activates pinned plugin dependencies before the target", async () => {
    const { lab, snapshot, setup, commands } = await fixture(
      "ready",
      undefined,
      "example",
      false,
      ["widgets", "elementor"],
    );
    const provisioned = await lab.provision(snapshot, setup);
    expect(provisioned.status).toBe("ready");
    const activations = commands
      .filter(
        ({ args }) => args.includes("plugin") && args.includes("activate"),
      )
      .map(({ args }) => args[args.indexOf("activate") + 1]);
    expect(activations).toEqual(["widgets", "elementor", "example"]);
    if (provisioned.status === "ready") await lab.teardown(provisioned.handle);
  });

  it("rejects a dependency resolver that maps the frozen identity to another plugin", async () => {
    const { lab, snapshot, setup, commands } = await fixture(
      "ready",
      undefined,
      "example",
      false,
      ["elementor"],
    );
    const body = {
      kind: snapshot.kind,
      schemaVersion: snapshot.schemaVersion,
      target: snapshot.target,
      dependencies: snapshot.dependencies.map((dependency) => ({
        ...dependency,
        identity: "wporg:another-plugin",
      })),
    };
    const altered: Snapshot = { ...body, digest: canonicalDigest(body) };
    const provisioned = await lab.provision(altered, {
      ...setup,
      snapshotDigest: altered.digest,
    });
    expect(provisioned).toMatchObject({
      status: "incomplete",
      reason: "provision",
    });
    expect(
      commands.some(
        ({ args }) => args.includes("plugin") && args.includes("activate"),
      ),
    ).toBe(false);
  });

  it("activates a copied plugin even when the frozen source has strict modes", async () => {
    const { lab, snapshot, setup } = await fixture(
      "ready",
      undefined,
      "example",
      true,
    );
    const provisioned = await lab.provision(snapshot, setup);
    expect(provisioned.status).toBe("ready");
    if (provisioned.status === "ready")
      expect(await lab.teardown(provisioned.handle)).toEqual({
        status: "removed",
      });
  });

  it("runs WP-CLI as the Apache volume owner when activating plugins", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    for (const purpose of ["discovery", "verification"] as const) {
      const result = await lab.provision(snapshot, setup, { purpose });
      expect(result.status).toBe("ready");
      if (result.status === "ready") await lab.teardown(result.handle);
    }

    const cliRuns = commands.filter(
      ({ args }) =>
        args[0] === "run" && args.includes(`wordpress-cli@${sha("3")}`),
    );
    expect(cliRuns.length).toBeGreaterThan(0);
    expect(
      cliRuns.filter(
        ({ args }) => args.includes("plugin") && args.includes("activate"),
      ),
    ).toHaveLength(2);
    for (const { args } of cliRuns) {
      expect(args).toContain("--runtime=runsc");
      expect(args).toContain("--user=33:33");
      expect(args).not.toContain("--allow-root");
    }
  });

  it("gives an exploration Lab a fixed WordPress address, a control endpoint and an administrator, and resets it behind the same recorder", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const provisioned = await lab.provision(snapshot, setup, {
      purpose: "discovery",
    });
    expect(provisioned.status).toBe("ready");
    if (provisioned.status !== "ready") return;
    const { handle } = provisioned;
    const id = handle.id;
    // Docker picks the subnet; the network is made again with it given explicitly.
    expect(
      commands
        .filter(
          ({ args }) =>
            args[0] === "network" && (args[1] === "create" || args[1] === "rm"),
        )
        .map(({ args }) => args.slice(1).join(" ")),
    ).toEqual([
      `create --internal wbh-${id}-net`,
      `rm wbh-${id}-net`,
      `create --internal --subnet=172.20.0.0/24 --ip-range=172.20.0.128/25 wbh-${id}-net`,
    ]);
    expect(handle.internalIp).toBe("172.20.0.10");
    expect(handle.exploration).toEqual({
      control: { host: "labctl", ipv4: "172.20.0.130" },
      administrator: {
        username: "harness-admin",
        password: lab.reviewAdministrator(handle)!.password,
      },
    });
    const started = (suffix: string) =>
      commands.filter(
        ({ args }) => args[0] === "run" && args.includes(`wbh-${id}-${suffix}`),
      );
    expect(started("ctl")).toHaveLength(1);
    expect(started("ctl")[0]?.args).toEqual(
      expect.arrayContaining([
        "--runtime=runsc",
        "--read-only",
        "--cap-drop=ALL",
        "serve",
      ]),
    );
    // No canary receiver runs in an exploration Lab.
    expect(started("canary")).toHaveLength(0);
    const verification = await lab.provision(snapshot, setup, {
      purpose: "verification",
    });
    expect(verification.status).toBe("ready");
    if (verification.status === "ready")
      expect(await lab.teardown(verification.handle)).toEqual({
        status: "removed",
      });

    const before = commands.length;
    expect(await lab.reset(handle)).toBe(true);
    const reset = commands.slice(before).map(({ args }) => args);
    expect(reset[0]).toEqual(["rm", "--force", `wbh-${id}-wp`, `wbh-${id}-db`]);
    expect(reset).toContainEqual(["volume", "rm", "--force", `wbh-${id}-site`]);
    expect(started("wp").at(-1)?.args).toContain("--ip=172.20.0.10");
    expect(started("wp")).toHaveLength(2);
    expect(started("proxy")).toHaveLength(1);
    expect(started("ctl")).toHaveLength(1);
    // The same accounts come back.
    expect(
      reset.filter(
        (args) =>
          args.includes("user") &&
          args.includes("create") &&
          args.includes(handle.attackerAccounts.subscriber.username),
      ),
    ).toHaveLength(1);

    const asked = commands.length;
    expect(await lab.nextControlRequest(handle, 10)).toBe("unavailable");
    expect(commands[asked]?.args).toEqual([
      "exec",
      `wbh-${id}-ctl`,
      "node",
      "/opt/wbh-control/cli.js",
      "next",
      "10",
    ]);
    expect(
      await lab.answerControlRequest(handle, "a".repeat(32), {
        statusCode: 200,
        body: { status: "reset" },
      }),
    ).toBe(true);
    expect(await lab.teardown(handle)).toEqual({ status: "removed" });
    expect(
      commands.some(
        ({ args }) => args[0] === "rm" && args.includes(`wbh-${id}-ctl`),
      ),
    ).toBe(true);
  });

  it("opens an exploration Lab page as one of the Lab's own accounts in the verification observer's browser (Phase D2)", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const provisioned = await lab.provision(snapshot, setup, {
      purpose: "discovery",
    });
    if (provisioned.status !== "ready") throw new Error("not ready");
    const { handle } = provisioned;
    const before = commands.length;
    const observed = await lab.observeExplorationPage(handle, {
      role: "subscriber",
      path: "/?p=1",
      actions: [{ kind: "click-text", text: "Open", exact: true }],
      dialogMarker: "1234567890",
    });
    expect(observed).toMatchObject({
      status: "observed",
      httpStatus: 404,
      dialogCount: 1,
      markerDialog: false,
      consoleErrorCount: 3,
    });
    const browser = commands
      .slice(before)
      .find(({ args }) => args.includes(`verification-browser@${sha("4")}`));
    expect(browser?.args).toEqual(
      expect.arrayContaining([
        "--runtime=runsc",
        "--network",
        `wbh-${handle.id}-net`,
        "--add-host=wordpress:172.20.0.10",
        "--read-only",
        "--cap-drop=ALL",
        `WBH_LOGIN_USER=${handle.attackerAccounts.subscriber.username}`,
        `WBH_LOGIN_PASSWORD=${handle.attackerAccounts.subscriber.password}`,
        "WBH_VISIT_PATH=/?p=1",
        `WBH_VISIT_ACTIONS=${JSON.stringify([{ kind: "click-text", text: "Open", exact: true }])}`,
        "WBH_DIALOG_MARKER=1234567890",
      ]),
    );
    // No canary receiver exists to point the browser at.
    expect(
      browser?.args.some((arg) => arg.startsWith("--add-host=canary:")),
    ).toBe(false);
    // A visitor logs in as nobody; a role the Lab lacks is refused.
    const visitor = commands.length;
    await lab.observeExplorationPage(handle, { role: "visitor", path: "/" });
    expect(
      commands
        .slice(visitor)
        .some(({ args }) =>
          args.some((arg) => arg.startsWith("WBH_LOGIN_USER=")),
        ),
    ).toBe(false);
    expect(
      await lab.observeExplorationPage(handle, { role: "customer", path: "/" }),
    ).toEqual({ status: "role-unavailable" });
    const verification = await lab.provision(snapshot, setup, {
      purpose: "verification",
    });
    if (verification.status !== "ready") throw new Error("not ready");
    expect(
      await lab.observeExplorationPage(verification.handle, {
        role: "visitor",
        path: "/",
      }),
    ).toEqual({ status: "unavailable" });
    await lab.teardown(verification.handle);
    await lab.teardown(handle);
  });

  it("resets only exploration Labs", async () => {
    const { lab, snapshot, setup } = await fixture();
    const verification = await lab.provision(snapshot, setup, {
      purpose: "verification",
    });
    expect(verification.status).toBe("ready");
    if (verification.status !== "ready") return;
    expect(verification.handle.exploration).toBeUndefined();
    expect(await lab.reset(verification.handle)).toBe(false);
    expect(await lab.nextControlRequest(verification.handle, 1)).toBe(
      "unavailable",
    );
    await lab.teardown(verification.handle);
  });

  it("runs verification Labs side by side on their own names and loopback ports (#432)", async () => {
    const { lab, snapshot, setup, docker, ownerDirectory } = await fixture();
    const readable = { ...setup, databaseAccess: "read-only" as const };
    const labs = await Promise.all(
      [1, 2, 3].map(() =>
        lab.provision(snapshot, readable, { purpose: "verification" }),
      ),
    );
    const handles = labs.map((provisioned) => {
      if (provisioned.status !== "ready") throw new Error(provisioned.nextStep);
      return provisioned.handle;
    });
    const [first, ...others] = handles as [
      WordPressLabHandle,
      ...WordPressLabHandle[],
    ];
    expect(new Set(handles.map(({ id }) => id)).size).toBe(3);
    expect(new Set(handles.map(({ networkName }) => networkName)).size).toBe(3);
    for (const { id } of handles)
      expect([...docker.volumes]).toContain(`wbh-${id}-site`);
    expect((await readLabOwners(ownerDirectory)).live).toEqual(
      new Set(handles.map(({ id }) => id)),
    );
    // Port 0 takes a free port; the exposure names the one Docker bound.
    const exposures = await Promise.all(
      handles.map((handle) =>
        lab.exposeToHost(handle, { httpPort: 0, databasePort: 0 }),
      ),
    );
    const ports = exposures.flatMap((exposure) =>
      exposure.status === "exposed"
        ? [exposure.httpPort, exposure.databasePort]
        : [],
    );
    expect(ports).toHaveLength(6);
    expect(new Set(ports).size).toBe(6);
    expect(ports).not.toContain(0);
    // A broad cleanup, as the runner's or the operator's, names none of the live Labs.
    const swept = await lab.cleanupLeftovers({ remove: true });
    expect(swept).toEqual({ containers: [], networks: [], volumes: [] });
    // Removing one Lab leaves the others' containers, network, volume and record.
    expect(await lab.withdrawFromHost(first)).toBe(true);
    expect(await lab.teardown(first)).toEqual({ status: "removed" });
    const remaining = [
      ...docker.containers,
      ...docker.networks,
      ...docker.volumes,
    ];
    expect(remaining.some((name) => name.includes(first.id))).toBe(false);
    for (const { id } of others) {
      expect(docker.containers).toContain(`wbh-${id}-wp`);
      expect(docker.containers).toContain(`wbh-${id}-host`);
      expect(docker.networks).toContain(`wbh-${id}-net`);
    }
    expect((await readLabOwners(ownerDirectory)).live).toEqual(
      new Set(others.map(({ id }) => id)),
    );
    for (const handle of others) {
      await lab.withdrawFromHost(handle);
      expect(await lab.teardown(handle)).toEqual({ status: "removed" });
    }
    expect((await readLabOwners(ownerDirectory)).live.size).toBe(0);
  });

  it("removes in a broad cleanup only the Labs whose owner process is gone", async () => {
    const { lab, docker, ownerDirectory } = await fixture();
    const [alive, dead, unowned] = [randomUUID(), randomUUID(), randomUUID()];
    await recordLabOwner({ labId: alive, directory: ownerDirectory });
    await writeFile(
      join(ownerDirectory, `${dead}.json`),
      JSON.stringify({
        schemaVersion: 1,
        labId: dead,
        owner: { pid: 1, bootId: "previous-boot", startTicks: "1" },
      }),
    );
    for (const id of [alive, dead, unowned]) {
      docker.containers.add(`wbh-${id}-wp`);
      docker.networks.add(`wbh-${id}-net`);
      docker.volumes.add(`wbh-${id}-site`);
    }
    expect(await lab.cleanupLeftovers({ remove: true })).toEqual({
      containers: [`wbh-${dead}-wp`, `wbh-${unowned}-wp`],
      networks: [`wbh-${dead}-net`, `wbh-${unowned}-net`],
      volumes: [`wbh-${dead}-site`, `wbh-${unowned}-site`],
    });
    expect([...docker.containers]).toEqual([`wbh-${alive}-wp`]);
    expect(await readLabOwners(ownerDirectory)).toEqual({
      live: new Set([alive]),
      dead: new Set(),
    });
    // Naming the exact Lab still lists it: `lab down` and the resume check decide.
    expect(await lab.cleanupLeftovers({ remove: false, labId: alive })).toEqual(
      {
        containers: [`wbh-${alive}-wp`],
        networks: [`wbh-${alive}-net`],
        volumes: [`wbh-${alive}-site`],
      },
    );
  });

  it("never reads or forgets owner records in the runner's discovery sweep, even when they are unreadable (#526)", async () => {
    const { lab, docker, ownerDirectory } = await fixture();
    const dead = randomUUID();
    await mkdir(ownerDirectory, { recursive: true });
    const deadRecord = join(ownerDirectory, `${dead}.json`);
    await writeFile(
      deadRecord,
      JSON.stringify({
        schemaVersion: 1,
        labId: dead,
        owner: { pid: 1, bootId: "previous-boot", startTicks: "1" },
      }),
    );
    docker.containers.add(`wbh-${dead}-wp`);
    docker.containers.add(`codex-agent-${dead}`);
    docker.networks.add(`wbh-${dead}-net`);
    const patterns = { containers: [/^codex-agent-/] };
    // A dead owner's record and its Lab survive: the sweep names no Lab.
    expect(
      await lab.cleanupLeftovers({ remove: true, labs: false, patterns }),
    ).toEqual({
      containers: [`codex-agent-${dead}`],
      networks: [],
      volumes: [],
    });
    expect(existsSync(deadRecord)).toBe(true);
    expect([...docker.containers]).toEqual([`wbh-${dead}-wp`]);
    // An unreadable owner directory (readdir EACCES) does not stop the sweep.
    docker.containers.add(`codex-agent-${dead}`);
    await chmod(ownerDirectory, 0o000);
    try {
      expect(
        await lab.cleanupLeftovers({ remove: true, labs: false, patterns }),
      ).toEqual({
        containers: [`codex-agent-${dead}`],
        networks: [],
        volumes: [],
      });
      // The control: a sweep that names Labs does read the directory.
      if (process.getuid?.() !== 0)
        await expect(lab.cleanupLeftovers({ remove: true })).rejects.toThrow();
    } finally {
      await chmod(ownerDirectory, 0o755);
    }
    expect(existsSync(deadRecord)).toBe(true);
  });

  it("never names a discovery resource whose owner lives, whichever state directory started it (#550)", async () => {
    const { lab, docker, ownerDirectory } = await fixture();
    // Host-wide: the sibling of the Lab owner records, not a state directory.
    const directory = join(dirname(ownerDirectory), "discovery-owners");
    const [foreign, dead, own] = [randomUUID(), randomUUID(), randomUUID()];
    // A live process (another runner's, standing in) owns these three.
    const records = await Promise.all(
      [
        `codex-agent-${foreign}`,
        `provider-egress-broker-${foreign}`,
        `provider-egress-${foreign}`,
      ].map((resource) => recordDiscoveryOwner({ resource, directory })),
    );
    // A runner killed on an earlier boot left these behind with their records.
    for (const resource of [`claude-agent-${dead}`, `provider-egress-${dead}`])
      await writeFile(
        join(directory, `${resource}.json`),
        JSON.stringify({
          schemaVersion: 1,
          resource,
          owner: { pid: 1, bootId: "previous-boot", startTicks: "1" },
        }),
      );
    for (const id of [foreign, dead, own]) {
      docker.containers.add(`codex-agent-${id}`);
      docker.networks.add(`provider-egress-${id}`);
    }
    docker.containers.add(`provider-egress-broker-${foreign}`);
    docker.containers.add(`claude-agent-${dead}`);
    const patterns = {
      containers: [
        /^codex-agent-/,
        /^claude-agent-/,
        /^provider-egress-broker-/,
      ],
      networks: [/^provider-egress-(?!broker-)/],
    };
    const expected = {
      containers: [
        `codex-agent-${dead}`,
        `codex-agent-${own}`,
        `claude-agent-${dead}`,
      ],
      networks: [`provider-egress-${dead}`, `provider-egress-${own}`],
      volumes: [],
    };
    // Listing (`lab cleanup` without --remove) leaves the live owner out too.
    expect(
      await lab.cleanupLeftovers({ remove: false, labs: false, patterns }),
    ).toEqual(expected);
    expect(
      await lab.cleanupLeftovers({ remove: true, labs: false, patterns }),
    ).toEqual(expected);
    expect([...docker.containers].sort()).toEqual(
      [`codex-agent-${foreign}`, `provider-egress-broker-${foreign}`].sort(),
    );
    expect([...docker.networks]).toEqual([`provider-egress-${foreign}`]);
    // Dead records go with their resources; the live owner keeps its own.
    expect(await readDiscoveryOwners(directory)).toEqual({
      live: new Set([
        `codex-agent-${foreign}`,
        `provider-egress-broker-${foreign}`,
        `provider-egress-${foreign}`,
      ]),
      dead: new Set(),
    });
    // Once that owner releases (or dies), the next sweep removes what is left.
    await Promise.all(records.map((record) => record.release()));
    expect(
      await lab.cleanupLeftovers({ remove: true, labs: false, patterns }),
    ).toEqual({
      containers: [
        `codex-agent-${foreign}`,
        `provider-egress-broker-${foreign}`,
      ],
      networks: [`provider-egress-${foreign}`],
      volumes: [],
    });
  });

  it("pins ordinary scenarios and seeds translation data with an approved comment", async () => {
    const { lab, snapshot, setup, commands } = await fixture(
      "ready",
      undefined,
      "translatepress-multilingual",
    );
    const scenario = wordPressScenario("translatepress-translation-data-v1")!;
    const provisioned = await lab.provision(snapshot, {
      ...setup,
      initialPosts: ["Welcome", "Sample page for translation"],
      scenario: { id: scenario.id, digest: scenario.digest },
    });
    expect(provisioned.status).toBe("ready");
    if (provisioned.status !== "ready") return;
    expect(provisioned.handle.scenario).toEqual({
      id: scenario.id,
      digest: scenario.digest,
    });
    expect(provisioned.handle.secondaryLocale).toBe("fr_FR");
    expect(
      commands.some((command) => command.args.includes("--comment_approved=1")),
    ).toBe(true);
    expect(
      commands.some((command) =>
        command.args.some((arg) =>
          arg.includes('"translated"=>"Exemple de page traduite"'),
        ),
      ),
    ).toBe(true);
    expect(nextWordPressScenario("translation dictionary is empty")).toBe(
      `${scenario.id}: ${scenario.name}`,
    );
    expect(
      nextWordPressScenario("translation dictionary is empty", scenario.id),
    ).toBe("catalogue に無い前提");
    expect(nextWordPressScenario("approved comment missing", scenario.id)).toBe(
      "catalogue に無い前提",
    );
    await lab.teardown(provisioned.handle);
  });

  it("repeats the pinned ordinary registration setup in discovery and verification Labs", async () => {
    const { lab, snapshot, setup, commands } = await fixture(
      "ready",
      undefined,
      "user-registration",
    );
    const scenario = wordPressScenario("public-registration-and-account-v1")!;
    expect(scenario).toMatchObject({
      version: 1,
      pluginSlug: "user-registration",
      ordinaryRegistration: true,
      adapterDigest: canonicalDigest(userRegistrationOrdinarySetupScript()),
    });
    const ordinarySetup = {
      ...setup,
      scenario: { id: scenario.id, digest: scenario.digest },
    };
    const discovery = await lab.provision(snapshot, ordinarySetup, {
      purpose: "discovery",
    });
    expect(discovery.status).toBe("ready");
    if (discovery.status !== "ready") return;
    expect(await lab.teardown(discovery.handle)).toEqual({ status: "removed" });

    const verification = await lab.provision(snapshot, ordinarySetup, {
      purpose: "verification",
    });
    expect(verification.status).toBe("ready");
    if (verification.status !== "ready") return;
    expect(verification.handle.scenario).toEqual(ordinarySetup.scenario);
    expect(verification.handle.setupDigest).toBe(discovery.handle.setupDigest);
    const scripts = commands
      .flatMap(({ args }) => args)
      .filter((arg) => arg.includes("UR_Install::create_form()"));
    expect(scripts).toHaveLength(2);
    for (const script of scripts) {
      expect(script).toContain("UR_Install::create_pages()");
      expect(script).toContain('update_option("users_can_register",1)');
      expect(script).toContain('get_option("default_role") !== "subscriber"');
    }
    expect(await lab.teardown(verification.handle)).toEqual({
      status: "removed",
    });
  });

  it("rejects the registration scenario for another plugin before containers start", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const scenario = wordPressScenario("public-registration-and-account-v1")!;
    const result = await lab.provision(snapshot, {
      ...setup,
      scenario: { id: scenario.id, digest: scenario.digest },
    });
    expect(result.status).toBe("incomplete");
    expect(commands.some(({ args }) => args[0] === "run")).toBe(false);
  });

  it("pins the free membership setup across independent Lab purposes", async () => {
    const { lab, snapshot, setup, commands } = await fixture(
      "ready",
      undefined,
      "user-registration",
    );
    const scenario = wordPressScenario("public-free-membership-v1")!;
    expect(scenario).toMatchObject({
      version: 1,
      pluginSlug: "user-registration",
      ordinaryRegistration: true,
      freeMembership: true,
      adapterDigest: canonicalDigest({
        registration: userRegistrationOrdinarySetupScript(),
        install: userRegistrationMembershipInstallScript(),
        enrollment: userRegistrationMembershipEnrollmentScript("{subscriber}"),
      }),
    });
    const membershipSetup = {
      ...setup,
      scenario: { id: scenario.id, digest: scenario.digest },
    };
    const discovery = await lab.provision(snapshot, membershipSetup, {
      purpose: "discovery",
    });
    expect(discovery.status).toBe("ready");
    if (discovery.status !== "ready") return;
    expect(await lab.teardown(discovery.handle)).toEqual({ status: "removed" });
    const verification = await lab.provision(snapshot, membershipSetup, {
      purpose: "verification",
    });
    expect(verification.status).toBe("ready");
    if (verification.status !== "ready") return;
    expect(verification.handle.setupDigest).toBe(discovery.handle.setupDigest);
    expect(verification.handle.scenario).toEqual(membershipSetup.scenario);
    const scripts = commands.flatMap(({ args }) => args);
    expect(
      scripts.filter((arg) => arg.includes("UR_Install::create_form()")),
    ).toHaveLength(2);
    expect(
      scripts.filter((arg) =>
        arg.includes("ur_membership_install_required_pages()"),
      ),
    ).toHaveLength(2);
    expect(
      scripts.filter((arg) =>
        arg.includes("create_membership_order_and_subscription"),
      ),
    ).toHaveLength(2);
    expect(await lab.teardown(verification.handle)).toEqual({
      status: "removed",
    });
  });

  it("leaves the existing subscriber unjoined in the versioned free membership setup", async () => {
    const { lab, snapshot, setup, commands } = await fixture(
      "ready",
      undefined,
      "user-registration",
    );
    const scenario = wordPressScenario("public-free-membership-v2")!;
    expect(scenario).toMatchObject({
      version: 2,
      pluginSlug: "user-registration",
      ordinaryRegistration: true,
      freeMembership: true,
      adapterDigest: canonicalDigest({
        registration: userRegistrationOrdinarySetupScript(),
        install: userRegistrationMembershipInstallScript(),
        unjoined: userRegistrationMembershipUnjoinedScript("{subscriber}"),
      }),
    });
    const membershipSetup = {
      ...setup,
      scenario: { id: scenario.id, digest: scenario.digest },
    };
    const discovery = await lab.provision(snapshot, membershipSetup, {
      purpose: "discovery",
    });
    expect(discovery.status).toBe("ready");
    if (discovery.status !== "ready") return;
    expect(await lab.teardown(discovery.handle)).toEqual({ status: "removed" });

    const verification = await lab.provision(snapshot, membershipSetup, {
      purpose: "verification",
    });
    expect(verification.status).toBe("ready");
    if (verification.status !== "ready") return;
    expect(verification.handle.setupDigest).toBe(discovery.handle.setupDigest);
    expect(verification.handle.scenario).toEqual(membershipSetup.scenario);
    const scripts = commands.flatMap(({ args }) => args);
    expect(
      scripts.filter((arg) => arg.includes("UR_Install::create_form()")),
    ).toHaveLength(2);
    expect(
      scripts.filter((arg) =>
        arg.includes("ur_membership_install_required_pages()"),
      ),
    ).toHaveLength(2);
    expect(
      scripts.filter((arg) =>
        arg.includes("Lab subscriber is already enrolled"),
      ),
    ).toHaveLength(2);
    expect(
      scripts.filter((arg) =>
        arg.includes('metadata_exists("user",$subscriber->ID,"ur_form_id")'),
      ),
    ).toHaveLength(2);
    expect(
      scripts.filter((arg) =>
        arg.includes("create_membership_order_and_subscription"),
      ),
    ).toHaveLength(0);
    expect(await lab.teardown(verification.handle)).toEqual({
      status: "removed",
    });
  });

  it("repeats the pinned ordinary member post setup in discovery and verification Labs", async () => {
    const { lab, snapshot, setup, commands } = await fixture(
      "ready",
      undefined,
      "wp-members",
    );
    const scenario = wordPressScenario("public-member-post-v1")!;
    expect(scenario).toMatchObject({
      version: 1,
      pluginSlug: "wp-members",
      ordinaryMemberPost: true,
      adapterDigest: canonicalDigest(wpMembersOrdinarySetupScript()),
    });
    const ordinarySetup = {
      ...setup,
      scenario: { id: scenario.id, digest: scenario.digest },
    };
    const discovery = await lab.provision(snapshot, ordinarySetup, {
      purpose: "discovery",
    });
    expect(discovery.status).toBe("ready");
    if (discovery.status !== "ready") return;
    expect(await lab.teardown(discovery.handle)).toEqual({ status: "removed" });

    const verification = await lab.provision(snapshot, ordinarySetup, {
      purpose: "verification",
    });
    expect(verification.status).toBe("ready");
    if (verification.status !== "ready") return;
    expect(verification.handle.scenario).toEqual(ordinarySetup.scenario);
    expect(verification.handle.setupDigest).toBe(discovery.handle.setupDigest);
    const scripts = commands
      .flatMap(({ args }) => args)
      .filter((arg) => arg.includes('"lab-member-post"'));
    expect(scripts).toHaveLength(2);
    for (const script of scripts) {
      expect(script).toContain("[wpmem_form register]");
      expect(script).toContain("[wpmem_form login]");
      expect(script).toContain("<!--more-->");
      expect(script).toContain('update_option("rss_use_excerpt",1)');
    }
    expect(await lab.teardown(verification.handle)).toEqual({
      status: "removed",
    });
  });

  it("repeats the pinned public comment setup in discovery and verification Labs", async () => {
    const { lab, snapshot, setup, commands } = await fixture(
      "ready",
      undefined,
      "wpdiscuz",
    );
    const scenario = wordPressScenario("public-plugin-comment-v1")!;
    expect(scenario).toMatchObject({
      version: 1,
      pluginSlug: "wpdiscuz",
      approvedComment: true,
      adapterDigest: canonicalDigest(wpDiscuzOrdinarySetupScript()),
    });
    const ordinarySetup = {
      ...setup,
      scenario: { id: scenario.id, digest: scenario.digest },
    };
    const discovery = await lab.provision(snapshot, ordinarySetup, {
      purpose: "discovery",
    });
    expect(discovery.status).toBe("ready");
    if (discovery.status !== "ready") return;
    expect(await lab.teardown(discovery.handle)).toEqual({ status: "removed" });

    const verification = await lab.provision(snapshot, ordinarySetup, {
      purpose: "verification",
    });
    expect(verification.status).toBe("ready");
    if (verification.status !== "ready") return;
    expect(verification.handle.setupDigest).toBe(discovery.handle.setupDigest);
    const scripts = commands
      .flatMap(({ args }) => args)
      .filter((arg) => arg.includes('do_action("admin_init")'));
    expect(scripts).toEqual([
      wpDiscuzOrdinarySetupScript(),
      wpDiscuzOrdinarySetupScript(),
    ]);
    expect(
      commands.filter(({ args }) => args.includes("--comment_approved=1")),
    ).toHaveLength(2);
    expect(await lab.teardown(verification.handle)).toEqual({
      status: "removed",
    });
  });

  it("rejects the public comment scenario for another plugin before containers start", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const scenario = wordPressScenario("public-plugin-comment-v1")!;
    const result = await lab.provision(snapshot, {
      ...setup,
      scenario: { id: scenario.id, digest: scenario.digest },
    });
    expect(result.status).toBe("incomplete");
    expect(commands.some(({ args }) => args[0] === "run")).toBe(false);
  });

  it.each([
    ["private-post-v1", "post", "lab-private-post"],
    ["private-page-v1", "page", "lab-private-page"],
  ] as const)(
    "seeds a digest-pinned ordinary %s without changing privileges",
    async (id, type, slug) => {
      const { lab, snapshot, setup, commands } = await fixture();
      const scenario = wordPressScenario(id)!;
      const provisioned = await lab.provision(snapshot, {
        ...setup,
        scenario: { id: scenario.id, digest: scenario.digest },
      });
      expect(provisioned.status).toBe("ready");
      if (provisioned.status !== "ready") return;
      expect(provisioned.handle.scenario).toEqual({
        id,
        digest: scenario.digest,
      });
      expect(
        commands.some(
          ({ args }) =>
            args.includes(`--post_type=${type}`) &&
            args.includes("--post_status=private") &&
            args.includes(`--post_name=${slug}`),
        ),
      ).toBe(true);
      expect(
        commands.some(({ args }) => args.includes("--role=administrator")),
      ).toBe(false);
      expect(nextWordPressScenario(`A private ${type} is missing`)).toBe(
        `${id}: ${scenario.name}`,
      );
      expect(nextWordPressScenario(`A private ${type} is missing`, id)).toBe(
        "catalogue に無い前提",
      );
      await lab.teardown(provisioned.handle);
    },
  );

  it.each(["discovery", "verification"] as const)(
    "builds a normal searchable approved comment index in a %s Lab",
    async (purpose) => {
      const { lab, snapshot, setup, commands } = await fixture(
        "ready",
        undefined,
        "relevanssi",
      );
      const scenario = wordPressScenario("approved-comment-searchable-v1")!;
      const provisioned = await lab.provision(
        snapshot,
        {
          ...setup,
          scenario: { id: scenario.id, digest: scenario.digest },
        },
        { purpose },
      );
      expect(provisioned.status).toBe("ready");
      if (provisioned.status !== "ready") return;
      const commentIndex = commands.findIndex(({ args }) =>
        args.includes(
          "--comment_content=A reader noticed the ordinary orchardlantern detail.",
        ),
      );
      const settingIndex = commands.findIndex(({ args }) =>
        args.includes("relevanssi_index_comments"),
      );
      const buildIndex = commands.findIndex(({ args }) =>
        args.some((arg) => arg.includes("relevanssi_build_index()")),
      );
      expect(commentIndex).toBeGreaterThanOrEqual(0);
      expect(settingIndex).toBeGreaterThan(commentIndex);
      expect(buildIndex).toBeGreaterThan(settingIndex);
      expect(commands[settingIndex]?.args).toContain("normal");
      expect(commands[buildIndex]?.args.join(" ")).toContain(
        "term=%s AND comment>0",
      );
      expect(
        nextWordPressScenario("approved comment searchable in the index"),
      ).toBe(`${scenario.id}: ${scenario.name}`);
      expect(
        nextWordPressScenario(
          "approved comment searchable in the index",
          scenario.id,
        ),
      ).toBe("catalogue に無い前提");
      expect(
        nextWordPressScenario(
          "approved comment searchable in the index",
          "approved-comment-v1",
        ),
      ).toBe(`${scenario.id}: ${scenario.name}`);
      await lab.teardown(provisioned.handle);
    },
  );

  it("rejects a searchable comment when no target adapter exists", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const scenario = wordPressScenario("approved-comment-searchable-v1")!;
    const result = await lab.provision(snapshot, {
      ...setup,
      scenario: { id: scenario.id, digest: scenario.digest },
    });
    expect(result.status).toBe("incomplete");
    expect(commands.some(({ args }) => args[0] === "run")).toBe(false);
  });

  it.each(["discovery", "verification"] as const)(
    "seeds a normal public booking page in a %s Lab",
    async (purpose) => {
      const { lab, snapshot, setup, commands } = await fixture(
        "ready",
        undefined,
        "simply-schedule-appointments",
      );
      const scenario = wordPressScenario("public-booking-page-v1")!;
      const result = await lab.provision(
        snapshot,
        { ...setup, scenario: { id: scenario.id, digest: scenario.digest } },
        { purpose },
      );
      expect(result.status).toBe("ready");
      if (result.status !== "ready") return;
      expect(
        commands.some(({ args }) =>
          args.some((arg) => arg.includes('"post_content"=>"[ssa_booking]"')),
        ),
      ).toBe(true);
      expect(nextWordPressScenario("Public booking page is missing")).toBe(
        `${scenario.id}: ${scenario.name}`,
      );
      await lab.teardown(result.handle);
    },
  );

  it("rejects a booking page when no target adapter exists", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const scenario = wordPressScenario("public-booking-page-v1")!;
    const result = await lab.provision(snapshot, {
      ...setup,
      scenario: { id: scenario.id, digest: scenario.digest },
    });
    expect(result.status).toBe("incomplete");
    expect(commands.some(({ args }) => args[0] === "run")).toBe(false);
  });

  it.each(["discovery", "verification"] as const)(
    "seeds a normal public builder page in a %s Lab",
    async (purpose) => {
      const { lab, snapshot, setup, commands } = await fixture(
        "ready",
        undefined,
        "brizy",
      );
      const scenario = wordPressScenario("public-builder-page-v1")!;
      const result = await lab.provision(
        snapshot,
        { ...setup, scenario: { id: scenario.id, digest: scenario.digest } },
        { purpose },
      );
      expect(result.status).toBe("ready");
      if (result.status !== "ready") return;
      expect(
        commands.some(({ args }) =>
          args.some((arg) => arg.includes("$editor->enable_editor()")),
        ),
      ).toBe(true);
      expect(nextWordPressScenario("Public builder page is missing")).toBe(
        `${scenario.id}: ${scenario.name}`,
      );
      await lab.teardown(result.handle);
    },
  );

  it("rejects a builder page when no target adapter exists", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const scenario = wordPressScenario("public-builder-page-v1")!;
    const result = await lab.provision(snapshot, {
      ...setup,
      scenario: { id: scenario.id, digest: scenario.digest },
    });
    expect(result.status).toBe("incomplete");
    expect(commands.some(({ args }) => args[0] === "run")).toBe(false);
  });

  it("catalogues an ordinary public form with a file attachment independently of the builder page", () => {
    const form = wordPressScenario("public-file-attachment-form-v1");
    const builder = wordPressScenario("public-builder-page-v1");
    expect(form?.name).toBe("公開のファイル添付フォーム");
    expect(
      form && "adapterDigest" in form ? form.adapterDigest : undefined,
    ).toBe(
      "sha256:e67915bcb506678e170e1801d2e91fb6b1e5ef4865f4bb87a76aae133d817272",
    );
    expect(form?.digest).toBe(
      "sha256:74e511ab2d7f35e0249cd42efcb82bfc9f4bf569820435742db3b3ad80a5dc58",
    );
    expect(builder?.digest).toBe(
      "sha256:eb3935f5d09cbce5598408d9f9e01ec167e11f9ad7153d06a6987edf237d81a7",
    );
    expect(
      nextWordPressScenario("A public form with a file attachment is missing"),
    ).toBe("public-file-attachment-form-v1: 公開のファイル添付フォーム");
    expect(
      nextWordPressScenario(
        "A public form with a file attachment is missing",
        "public-file-attachment-form-v1",
      ),
    ).toBe("catalogue に無い前提");
    expect(
      nextWordPressScenario(
        "A public builder page is missing",
        "public-file-attachment-form-v1",
      ),
    ).toBe("catalogue に無い前提");
  });

  it.each(["discovery", "verification"] as const)(
    "seeds an ordinary public attachment form in a %s Lab",
    async (purpose) => {
      const { lab, snapshot, setup, commands } = await fixture(
        "ready",
        undefined,
        "brizy",
      );
      const scenario = wordPressScenario("public-file-attachment-form-v1")!;
      const result = await lab.provision(
        snapshot,
        { ...setup, scenario: { id: scenario.id, digest: scenario.digest } },
        { purpose },
      );
      expect(result.status).toBe("ready");
      if (result.status !== "ready") return;
      expect(result.handle.scenario).toEqual({
        id: scenario.id,
        digest: scenario.digest,
      });
      expect(
        commands.some(({ args }) =>
          args.some((arg) => arg.includes("Brizy_Editor_Forms_FormManager")),
        ),
      ).toBe(true);
      await lab.teardown(result.handle);
    },
  );

  it("rejects a public attachment form before starting containers when no target adapter exists", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const scenario = wordPressScenario("public-file-attachment-form-v1")!;
    const result = await lab.provision(snapshot, {
      ...setup,
      scenario: { id: scenario.id, digest: scenario.digest },
    });
    expect(result.status).toBe("incomplete");
    expect(commands.some(({ args }) => args[0] === "run")).toBe(false);
  });

  it("does not promise a private-content scenario unless a separate locale prerequisite is met", () => {
    const privatePost = wordPressScenario("private-post-v1")!;
    const translation = wordPressScenario(
      "translatepress-translation-data-v1",
    )!;
    const prerequisite = "A private post and secondary language enabled";
    expect(nextWordPressScenario(prerequisite)).toBe("catalogue に無い前提");
    expect(
      nextWordPressScenario(prerequisite, undefined, {
        secondaryLocaleConfigured: true,
      }),
    ).toBe(`${privatePost.id}: ${privatePost.name}`);
    expect(
      nextWordPressScenario("A private post in the secondary locale"),
    ).toBe("catalogue に無い前提");
    expect(
      nextWordPressScenario(
        "A private post in the secondary locale",
        undefined,
        { secondaryLocaleConfigured: true },
      ),
    ).toBe("catalogue に無い前提");
    expect(
      nextWordPressScenario("A private page in the secondary locale"),
    ).toBe("catalogue に無い前提");
    expect(
      nextWordPressScenario(
        "A private page in the secondary locale",
        undefined,
        { secondaryLocaleConfigured: true },
      ),
    ).toBe("catalogue に無い前提");
    expect(
      nextWordPressScenario(
        "A private post with translation dictionary",
        undefined,
        {
          secondaryLocaleConfigured: true,
        },
      ),
    ).toBe("catalogue に無い前提");
    expect(
      nextWordPressScenario("A translated private post", undefined, {
        secondaryLocaleConfigured: true,
      }),
    ).toBe("catalogue に無い前提");
    expect(
      nextWordPressScenario("A private page with translation", undefined, {
        secondaryLocaleConfigured: true,
      }),
    ).toBe("catalogue に無い前提");
    expect(
      nextWordPressScenario("A private post with an approved comment"),
    ).toBe("catalogue に無い前提");
    expect(nextWordPressScenario("A private post and private page")).toBe(
      "catalogue に無い前提",
    );
    expect(
      nextWordPressScenario("A private page with translation dictionary"),
    ).toBe("catalogue に無い前提");
    expect(nextWordPressScenario("A private post in the default locale")).toBe(
      `${privatePost.id}: ${privatePost.name}`,
    );
    expect(nextWordPressScenario("secondary language enabled")).toBe(
      `${translation.id}: ${translation.name}`,
    );
    expect(nextWordPressScenario("secondary locale enabled")).toBe(
      "catalogue に無い前提",
    );
  });

  it("rejects a changed scenario digest before provisioning", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const result = await lab.provision(snapshot, {
      ...setup,
      scenario: {
        id: "approved-comment-v1",
        digest: sha("f"),
      },
    });
    expect(result.status).toBe("incomplete");
    expect(commands.some((command) => command.args[0] === "run")).toBe(false);
  });

  it("seeds an ordinary approved comment on the first published post when requested", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const provisioned = await lab.provision(snapshot, {
      ...setup,
      initialApprovedComment: true,
    });
    expect(provisioned.status).toBe("ready");
    if (provisioned.status !== "ready") return;
    const post = commands.find((command) =>
      command.args.includes("--post_title=Welcome"),
    );
    const comment = commands.find((command) =>
      command.args.includes("--comment_content=Thanks for the useful post."),
    );
    expect(post?.args).toContain("--porcelain");
    expect(comment?.args).toContain("--comment_post_ID=7");
    expect(comment?.args).toContain("--comment_approved=1");
    expect(comment).toBeDefined();
    expect(post).toBeDefined();
    if (comment !== undefined && post !== undefined)
      expect(commands.indexOf(comment)).toBeGreaterThan(commands.indexOf(post));
    await lab.teardown(provisioned.handle);
  });

  it("grants SELECT only on existing tables", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const provisioned = await lab.provision(snapshot, {
      ...setup,
      databaseAccess: "read-only",
    });
    expect(provisioned.status).toBe("ready");
    if (provisioned.status !== "ready") return;
    expect(provisioned.handle.database).toMatchObject({
      host: "database",
      ipv4: "172.20.0.3",
      port: 3306,
      name: "wordpress",
      readOnlyAccount: { username: "wbh_reader" },
    });
    expect(provisioned.handle.database?.readOnlyAccount.password).toMatch(
      /^[a-f0-9]{64}$/,
    );
    const grants = commands.filter((command) =>
      command.args.some((arg) => arg.includes("CREATE USER 'wbh_reader'")),
    );
    expect(grants).toHaveLength(1);
    const grant = grants[0];
    if (grant === undefined) return;
    const sql = grant.args.at(-1) ?? "";
    expect(sql.includes("GRANT SELECT ON wordpress.wp_options")).toBe(true);
    expect(sql.includes("GRANT SELECT ON wordpress.wp_posts")).toBe(true);
    expect(sql.includes("wordpress.*")).toBe(false);
    expect(sql.includes("invalid;table")).toBe(false);
    await lab.teardown(provisioned.handle);
  });

  it("does not create a reader when database access is disabled", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const provisioned = await lab.provision(snapshot, {
      ...setup,
      databaseAccess: "none",
    });
    expect(provisioned.status).toBe("ready");
    if (provisioned.status !== "ready") return;
    expect(provisioned.handle.database).toBeUndefined();
    expect(
      commands.some((command) =>
        command.args.some((arg) => arg.includes("CREATE USER 'wbh_reader'")),
      ),
    ).toBe(false);
    await lab.teardown(provisioned.handle);
  });

  it("refuses to provision when the running core differs from its dependency snapshot", async () => {
    const { lab, snapshot, setup, commands } = await fixture("ready", {
      version: "6.8.3",
      runningVersion: "6.8.2",
    });
    expect(await lab.provision(snapshot, setup)).toMatchObject({
      status: "incomplete",
      reason: "provision",
      nextStep: "The Lab image runs another WordPress version",
    });
    expect(
      commands.some(
        (command) =>
          command.args.includes("core") && command.args.includes("version"),
      ),
    ).toBe(true);
    expect(commands.some((command) => command.args.includes("install"))).toBe(
      false,
    );
  });

  it("probes HTTP from a disposable runsc container on the Lab network", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const provisioned = await lab.provision(snapshot, setup);
    expect(provisioned.status).toBe("ready");
    if (provisioned.status !== "ready") return;
    expect(await lab.probe(provisioned.handle)).toEqual({
      http: "ok",
      database: "not-exposed",
    });
    const probe = commands.find((command) =>
      command.args.includes("--entrypoint=php"),
    );
    expect(probe?.args).toContain("--runtime=runsc");
    expect(probe?.args).toContain("--network");
    expect(probe?.args).toContain(
      `--add-host=wordpress:${provisioned.handle.internalIp}`,
    );
    expect(probe?.args).toContain("--read-only");
    await lab.teardown(provisioned.handle);
  });

  it("probes an exposed read-only database through the same isolated network", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const provisioned = await lab.provision(snapshot, setup);
    expect(provisioned.status).toBe("ready");
    if (provisioned.status !== "ready") return;
    Object.assign(provisioned.handle, {
      database: {
        host: "database",
        ipv4: "172.20.0.3",
        port: 3306,
        name: "wordpress",
        readOnlyAccount: {
          username: "fixture_reader",
          password: "fixture_only",
        },
      },
    });
    expect(await lab.probe(provisioned.handle)).toEqual({
      http: "ok",
      database: "ok",
    });
    const probe = commands.find((command) =>
      command.args.includes("--entrypoint=php"),
    );
    expect(probe?.args).toContain("--add-host=database:172.20.0.3");
    expect(probe?.args).toContain("WBH_DB_USER=fixture_reader");
    expect(probe?.args).toContain("WBH_DB_NAME=wordpress");
    await lab.teardown(provisioned.handle);
  });

  it("provisions two independent internal labs and removes resources", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const first = await lab.provision(snapshot, setup);
    const second = await lab.provision(snapshot, setup);
    expect(first.status, JSON.stringify(commands)).toBe("ready");
    expect(second.status).toBe("ready");
    if (first.status !== "ready" || second.status !== "ready") return;
    expect(first.handle.id).not.toBe(second.handle.id);
    expect(first.handle.setupDigest).toMatch(/^sha256:/);
    expect(first.handle.internalIp).toBe("172.20.0.2");
    expect(first.handle.recorderIp).toBe("172.20.0.4");
    const proxy = commands.find(
      (command) =>
        command.args[0] === "run" &&
        command.args.some((arg) => arg === `wbh-${first.handle.id}-proxy`),
    );
    expect(proxy?.args).toContain("--runtime=runsc");
    expect(proxy?.args).toContain("--add-host=wordpress:172.20.0.2");
    expect(await lab.markCapture(first.handle)).toBe("0");
    expect(await lab.readCapture(first.handle, "0")).toMatchObject({
      status: "captured",
      bytes: Buffer.from('{"synthetic":true}\n'),
      dropped: 0,
    });
    expect(first.handle.networkName).toMatch(/^wbh-.+-net$/);
    expect(
      commands.some(
        (command) =>
          command.args[0] === "inspect" && command.args.includes("--format"),
      ),
    ).toBe(true);
    expect(Object.keys(first.handle.attackerAccounts)).toEqual(["subscriber"]);
    expect(JSON.stringify(first.handle)).not.toContain("harness-admin");
    // The Lab seeds nothing for a judge (#525): no canary row, file or account.
    expect(
      commands.some((command) =>
        command.args.some((arg) => /wbh[-_]canary/.test(arg)),
      ),
    ).toBe(false);
    expect(
      commands
        .filter(
          (command) =>
            command.args[0] === "network" && command.args[1] === "create",
        )
        .every((command) => command.args.includes("--internal")),
    ).toBe(true);
    expect(
      commands
        .filter((command) => command.args[0] === "run")
        .every((command) => command.args.includes("--runtime=runsc")),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.args.includes("wp_magic_quotes") ||
          command.args.includes("WP_DEBUG") ||
          command.args.includes("allow_url_fopen"),
      ),
    ).toBe(false);
    expect(await lab.teardown(first.handle)).toEqual({ status: "removed" });
    expect(await lab.teardown(second.handle)).toEqual({ status: "removed" });
  });

  it("points WordPress at the database by address, since gVisor containers cannot use Docker's name resolution", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const provisioned = await lab.provision(snapshot, setup);
    expect(provisioned.status).toBe("ready");
    const databaseHosts = commands.flatMap((command) =>
      command.args.filter((arg) => arg.startsWith("WORDPRESS_DB_HOST=")),
    );
    expect(databaseHosts.length).toBeGreaterThan(1);
    expect(new Set(databaseHosts)).toEqual(
      new Set(["WORDPRESS_DB_HOST=172.20.0.3"]),
    );
  });

  it("ends handoff setup by revoking its administrator (#430, #525)", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const provisioned = await lab.provision(snapshot, setup);
    if (provisioned.status !== "ready") throw new Error("not ready");
    const { handle } = provisioned;
    const setupPassword = lab.reviewAdministrator(handle)?.password;
    expect(await lab.finishSetup(handle)).toBe(true);
    const variable = commands
      .flatMap((command) => command.args)
      .find((arg) => arg.startsWith("WBH_SETUP_PRINCIPALS="));
    const principals = JSON.parse(
      variable?.slice("WBH_SETUP_PRINCIPALS=".length) ?? "[]",
    ) as [string, string][];
    expect(principals.map(([login]) => login)).toEqual(["harness-admin"]);
    const rotated = lab.reviewAdministrator(handle)?.password;
    expect(rotated).not.toBe(setupPassword);
    expect(principals[0]?.[1]).toBe(rotated);
    // The new password reaches PHP only through the environment.
    expect(
      commands
        .flatMap((command) => command.args)
        .filter((arg) => arg.includes(rotated!)),
    ).toEqual([variable]);
    expect(await lab.teardown(handle)).toEqual({ status: "removed" });
    expect(await lab.finishSetup(handle)).toBe(false);
  });

  it("exposes the active review Lab receiver address only to its owned handle", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const provisioned = await lab.provision(snapshot, setup, {
      purpose: "verification",
    });
    if (provisioned.status !== "ready") throw new Error("not ready");
    const { handle } = provisioned;

    expect(lab.reviewReceiverIp(handle)).toBe("172.20.0.5");
    expect(
      commands.some(
        (command) =>
          command.args[0] === "inspect" &&
          command.args.at(-1)?.endsWith("-canary"),
      ),
    ).toBe(true);
    expect(lab.reviewReceiverIp({ ...handle })).toBeNull();

    expect(await lab.teardown(handle)).toEqual({ status: "removed" });
    expect(lab.reviewReceiverIp(handle)).toBeNull();
  });

  it("opens the declared victim pages and records the marker dialog and screen without deciding (#525)", async () => {
    const { lab, snapshot, setup, commands, database } = await fixture();
    const provisioned = await lab.provision(snapshot, setup, {
      purpose: "verification",
    });
    if (provisioned.status !== "ready") throw new Error("not ready");
    const { handle } = provisioned;
    const pages = (victim: WordPressVictimRoute) =>
      lab.observeVictimPages(handle, victim);

    const adminVisit = await pages({
      role: "administrator",
      paths: [
        {
          path: "/wp-admin/admin.php?page=fixture",
          actions: [
            { kind: "click-text", text: "Choose a value", exact: false },
            { kind: "fill", selector: "#recipient-search", value: "sample" },
          ],
        },
      ],
    });
    expect(adminVisit).toEqual({
      status: "observed",
      victimRole: "administrator",
      screenshot: expect.any(Buffer),
      victimBrowserDiagnostic: browserDiagnostic,
    });
    expect(JSON.stringify(adminVisit)).not.toContain("page=fixture");
    expect(await pages({ role: "subscriber", paths: ["/?p=8"] })).toMatchObject(
      { status: "observed", victimRole: "subscriber" },
    );

    const marker = "5837294610";
    database.dialogOn = ["/?p=9"];
    const dialog = await pages({
      role: "unauthenticated",
      paths: ["/?p=8", "/?p=9"],
      dialogMarker: marker,
    });
    expect(dialog).toMatchObject({
      status: "observed",
      victimRole: "unauthenticated",
      dialog: {
        visitIndex: 1,
        event: { type: "alert", message: marker },
        screenshot: expect.any(Buffer),
      },
    });
    database.dialogOn = [];

    database.browserDiagnosticOutput = "missing";
    expect(
      await pages({
        role: "administrator",
        paths: ["/wp-admin/admin.php?page=fixture"],
      }),
    ).toEqual({
      status: "observed",
      victimRole: "administrator",
      screenshot: expect.any(Buffer),
    });
    database.browserDiagnosticOutput = "invalid";
    expect(
      await pages({
        role: "administrator",
        paths: ["/wp-admin/admin.php?page=fixture"],
      }),
    ).toEqual({
      status: "observed",
      victimRole: "administrator",
      screenshot: expect.any(Buffer),
    });
    database.browserDiagnosticOutput = "valid";

    database.browserFailureAt = "/wp-admin/admin.php?page=fixture";
    const failedVictimVisit = await pages({
      role: "administrator",
      paths: ["/wp-admin/admin.php?page=fixture"],
    });
    expect(failedVictimVisit).toEqual({
      status: "unavailable",
      phase: "victim-page",
      failureCode: "browser-visit",
      privateDiagnostic: Buffer.from("private-debug-marker"),
    });
    expect(JSON.stringify(failedVictimVisit)).not.toContain("page=fixture");
    database.browserFailureMessage = "x".repeat(20_000);
    const boundedFailure = await pages({
      role: "administrator",
      paths: ["/wp-admin/admin.php?page=fixture"],
    });
    expect(boundedFailure).toMatchObject({
      status: "unavailable",
      phase: "victim-page",
      failureCode: "browser-visit",
    });
    if (boundedFailure.status !== "unavailable")
      throw new Error("Expected bounded browser failure");
    expect(boundedFailure.privateDiagnostic?.length).toBe(16 * 1024);
    const navigationLine =
      'Victim action left the Lab origin {"check":"url-origin","actionIndex":0}';
    database.browserFailureMessage = `(node:1) warning\n${navigationLine}\n`;
    expect(
      await pages({
        role: "administrator",
        paths: ["/wp-admin/admin.php?page=fixture"],
      }),
    ).toEqual({
      status: "unavailable",
      phase: "victim-page",
      failureCode: "victim-navigation",
      privateDiagnostic: Buffer.from(navigationLine),
    });
    // Page text inside the detail cannot rename the failure.
    const notVisibleLine =
      'Victim action not visible {"visibleText":"Victim login failed"}';
    database.browserFailureMessage = notVisibleLine;
    expect(
      await pages({
        role: "administrator",
        paths: ["/wp-admin/admin.php?page=fixture"],
      }),
    ).toEqual({
      status: "unavailable",
      phase: "victim-page",
      failureCode: "victim-action-not-visible",
      privateDiagnostic: Buffer.from(notVisibleLine),
    });
    database.browserFailureAt = null;

    const browsers = commands.filter(
      (command) =>
        command.args[0] === "run" &&
        command.args.includes(`verification-browser@${sha("4")}`),
    );
    expect(browsers.length).toBeGreaterThan(0);
    for (const browser of browsers) {
      expect(browser.args).toContain("--runtime=runsc");
      expect(browser.args.some((arg) => arg.includes("canary"))).toBe(false);
    }
    // Only the declared pages are opened; nothing else is visited for a verdict.
    expect(
      browsers
        .map((browser) =>
          browser.args.find((arg) => arg.startsWith("WBH_VISIT_PATH=")),
        )
        .filter(
          (arg) =>
            arg !== "WBH_VISIT_PATH=/wp-admin/admin.php?page=fixture" &&
            arg !== "WBH_VISIT_PATH=/?p=8" &&
            arg !== "WBH_VISIT_PATH=/?p=9",
        ),
    ).toEqual([]);
    expect(
      browsers.some(
        (browser) =>
          browser.args.includes(
            "WBH_VISIT_PATH=/wp-admin/admin.php?page=fixture",
          ) && browser.args.includes("WBH_LOGIN_USER=harness-admin"),
      ),
    ).toBe(true);
    expect(
      browsers.some((browser) =>
        browser.args.includes(
          'WBH_VISIT_ACTIONS=[{"kind":"click-text","text":"Choose a value","exact":false},{"kind":"fill","selector":"#recipient-search","value":"sample"}]',
        ),
      ),
    ).toBe(true);
    expect(
      browsers.some(
        (browser) =>
          browser.args.includes("WBH_VISIT_PATH=/?p=8") &&
          browser.args.some((arg) =>
            arg.startsWith("WBH_LOGIN_USER=wbh-victim-subscriber-"),
          ) &&
          !browser.args.includes(
            `WBH_LOGIN_USER=${handle.attackerAccounts.subscriber.username}`,
          ),
      ),
    ).toBe(true);
    expect(JSON.stringify(handle)).not.toContain("harness-admin");
    expect(JSON.stringify(handle)).not.toContain("wbh-victim-subscriber-");
    expect(
      await pages({ role: "administrator", paths: ["/\\outside.invalid"] }),
    ).toEqual({ status: "unavailable", phase: "victim-input" });
    const doubleEncodedMarker = [...marker]
      .map((digit) => `%25${digit.charCodeAt(0).toString(16)}`)
      .join("");
    expect(
      await pages({
        role: "unauthenticated",
        paths: [`/?q=${doubleEncodedMarker}`],
        dialogMarker: marker,
      }),
    ).toEqual({
      status: "unavailable",
      phase: "victim-input",
      failureCode: "observer-marker-input",
    });
    expect(
      await pages({
        role: "administrator",
        paths: [
          {
            path: "/wp-admin/",
            actions: [{ kind: "evaluate", source: "alert(1)" }],
          },
        ],
      } as unknown as WordPressVictimRoute),
    ).toEqual({ status: "unavailable", phase: "victim-input" });
    expect(await lab.teardown(handle)).toEqual({ status: "removed" });
  });

  it("observes only a selected popup that inherits the Lab origin", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const provisioned = await lab.provision(snapshot, setup, {
      purpose: "verification",
    });
    if (provisioned.status !== "ready") throw new Error("not ready");
    await lab.observeVictimPages(provisioned.handle, {
      role: "unauthenticated",
      paths: [
        { path: "/?p=7", actions: [{ kind: "click", selector: "#open" }] },
      ],
    });
    const visit = commands.find((command) =>
      command.args.includes("WBH_VISIT_PATH=/?p=7"),
    );
    const script = visit?.args[visit.args.indexOf("-e") + 1];
    if (script === undefined) throw new Error("Browser visit script missing");
    expect(await lab.teardown(provisioned.handle)).toEqual({
      status: "removed",
    });

    const runPopupVisit = async (input: {
      url: string;
      browserOpener?: boolean;
      effectiveOrigin?: string;
      openerAccessible?: boolean;
      extraPopup?: boolean;
      captureDiagnostic?: boolean;
      hidden?: boolean;
      clickText?: boolean;
    }): Promise<string> => {
      let onPage: ((tab: unknown) => void) | undefined;
      let resolvePopup: ((tab: unknown) => void) | undefined;
      const contextListeners = new Map<string, (value: unknown) => void>();
      const popupListeners = new Map<string, (value: unknown) => void>();
      let finish: (result: string) => void = () => {};
      const completed = new Promise<string>((resolve) => {
        finish = resolve;
      });
      const context = {
        on(event: string, listener: (value: unknown) => void) {
          contextListeners.set(event, listener);
          if (event === "page") onPage = listener;
        },
      };
      const popup = {
        on(event: string, listener: (value: unknown) => void) {
          popupListeners.set(event, listener);
        },
        url: () => input.url,
        opener: async () => (input.browserOpener === false ? null : main),
        evaluate: async (
          check: (argument: string | string[]) => unknown,
          argument: string | string[],
        ) => check(argument),
        waitForLoadState: async () => {},
        waitForTimeout: async () => {},
        isClosed: () => false,
        screenshot: async () => Buffer.from("89504e470d0a1a0a", "hex"),
      };
      const target = {
        waitFor: async () => {
          if (input.hidden) throw new Error("Timeout");
        },
        count: async () => (input.hidden ? 0 : 1),
        evaluate: async () => true,
        click: async () => {
          onPage?.(popup);
          if (input.extraPopup) onPage?.({ on() {}, isClosed: () => false });
          if (input.captureDiagnostic) {
            popupListeners.get("pageerror")?.({
              name: "SyntaxError",
              message: "private runtime detail",
            });
            popupListeners.get("console")?.({
              type: () => "error",
              text: () => "private console detail",
            });
            contextListeners.get("requestfailed")?.({
              url: () => "private request detail",
            });
            contextListeners.get("response")?.({
              status: () => 404,
              url: () => "private response detail",
            });
          }
          resolvePopup?.(popup);
        },
      };
      const main = {
        on() {},
        context: () => context,
        goto: async () => {},
        url: () => "http://wordpress/?p=7&_wpnonce=private",
        evaluate: async (read: () => unknown) => read(),
        locator: () => target,
        getByText: (_text: string, options: { exact: boolean }) =>
          options.exact ? target : { count: async () => 2 },
        waitForEvent: () =>
          new Promise<unknown>((resolve) => {
            resolvePopup = resolve;
          }),
        isClosed: () => false,
      };
      const opener = input.openerAccessible === false ? {} : { document: {} };
      Object.defineProperty(opener, "document", {
        get: () => {
          if (input.openerAccessible === false)
            throw new Error("Cross-origin opener");
          return {};
        },
      });
      class ImageElement {
        complete = true;
        naturalWidth = 0;
        attributes: { name: string; value: string }[] = [];
      }
      runInNewContext(script, {
        require: () => ({
          chromium: {
            launch: async () => ({
              newPage: async () => main,
              close: async () => {},
            }),
          },
        }),
        process: {
          env: {
            WBH_VISIT_PATH: "/?p=7",
            WBH_VISIT_ACTIONS: JSON.stringify([
              input.clickText
                ? { kind: "click-text", text: "Open", exact: true }
                : { kind: "click", selector: "#open" },
            ]),
          },
          stdout: {
            write: (value: string) =>
              finish(input.captureDiagnostic ? value : "observed"),
          },
          exitCode: 0,
        },
        console: { error: (message: unknown) => finish(String(message)) },
        window: {
          origin: input.effectiveOrigin ?? "http://wordpress",
          opener,
        },
        Buffer,
        URL,
        HTMLImageElement: ImageElement,
        document: {
          body: { innerText: `  Plugin   settings\n${"x".repeat(2000)}` },
          readyState: "complete",
          querySelectorAll: () => [
            new ImageElement(),
            { attributes: [{ name: "onclick", value: "marker" }] },
          ],
        },
      });
      return completed;
    };

    expect(await runPopupVisit({ url: "about:blank" })).toBe("observed");
    const diagnosticOutput = await runPopupVisit({
      url: "about:blank",
      captureDiagnostic: true,
    });
    expect(diagnosticOutput).not.toContain("private runtime detail");
    expect(diagnosticOutput).not.toContain("private request detail");
    expect(JSON.parse(diagnosticOutput).diagnostic).toMatchObject({
      document: {
        elementCount: 2,
        imageCount: 1,
        brokenImageCount: 1,
        inlineHandlerCount: 1,
      },
      runtime: {
        pageErrorCounts: { syntax: 1 },
        consoleErrorCount: 1,
        failedRequestCount: 1,
        http4xxCount: 1,
      },
    });
    const failure = (output: string, name: string): unknown => {
      expect(output.startsWith(`${name} {`)).toBe(true);
      return JSON.parse(output.slice(name.length + 1));
    };
    const leftOrigin = "Victim action left the Lab origin";
    expect(
      failure(
        await runPopupVisit({ url: "about:blank", browserOpener: false }),
        leftOrigin,
      ),
    ).toEqual({
      check: "blank-opener-differs",
      actionIndex: 0,
      popup: true,
      url: "about:blank",
      expectedOrigin: "http://wordpress",
    });
    expect(
      failure(
        await runPopupVisit({ url: "about:blank", effectiveOrigin: "null" }),
        leftOrigin,
      ),
    ).toMatchObject({ check: "blank-origin-not-inherited" });
    expect(
      failure(
        await runPopupVisit({ url: "about:blank", openerAccessible: false }),
        leftOrigin,
      ),
    ).toMatchObject({ check: "blank-origin-not-inherited" });
    expect(
      failure(
        await runPopupVisit({
          url: "https://outside.invalid/path?token=private#frag",
        }),
        leftOrigin,
      ),
    ).toEqual({
      check: "url-origin",
      actionIndex: 0,
      popup: true,
      url: "https://outside.invalid/path",
      expectedOrigin: "http://wordpress",
    });
    const notVisible = failure(
      await runPopupVisit({ url: "about:blank", hidden: true }),
      "Victim action not visible",
    );
    expect(notVisible).toEqual({
      check: "action-visible",
      actionIndex: 0,
      kind: "click",
      selector: "#open",
      url: "http://wordpress/",
      attachedCount: 0,
      visibleText: expect.stringMatching(/^Plugin settings x+$/),
    });
    expect((notVisible as { visibleText: string }).visibleText.length).toBe(
      1024,
    );
    // An exact text that misses while looser text matches is told apart.
    expect(
      failure(
        await runPopupVisit({
          url: "about:blank",
          hidden: true,
          clickText: true,
        }),
        "Victim action not visible",
      ),
    ).toMatchObject({
      kind: "click-text",
      text: "Open",
      exact: true,
      attachedCount: 0,
      looseTextCount: 2,
    });
    expect(
      await runPopupVisit({
        url: "http://wordpress/?p=8",
        browserOpener: false,
      }),
    ).toBe("observed");
    expect(await runPopupVisit({ url: "about:blank", extraPopup: true })).toBe(
      "Unobserved victim popup opened",
    );
  });

  it("does not start target containers when source differs from its snapshot", async () => {
    const { lab, snapshot, setup, commands, sourceDirectory } = await fixture();
    await writeFile(join(sourceDirectory, "example.php"), "changed");
    expect(await lab.provision(snapshot, setup)).toMatchObject({
      status: "incomplete",
      reason: "provision",
    });
    expect(commands.some((command) => command.args[0] === "run")).toBe(false);
  });

  it.each(["no-runsc", "missing-image"] as const)(
    "does not start target containers when %s preflight fails",
    async (failure) => {
      const { lab, snapshot, setup, commands } = await fixture(failure);
      expect(await lab.provision(snapshot, setup)).toMatchObject({
        status: "incomplete",
        reason: "provision",
      });
      expect(commands.some((command) => command.args[0] === "run")).toBe(false);
    },
  );

  it("marks a missing PDO MySQL extension as a precondition before installing the target", async () => {
    const { lab, snapshot, setup, commands } =
      await fixture("missing-extension");
    expect(await lab.provision(snapshot, setup)).toMatchObject({
      status: "incomplete",
      reason: "precondition",
    });
    expect(commands.some((command) => command.args.includes("activate"))).toBe(
      false,
    );
    expect(
      commands.some(
        (command) =>
          command.args[0] === "run" &&
          !command.args.includes("--runtime=runsc"),
      ),
    ).toBe(false);
    expect(commands.some((command) => command.args[0] === "rm")).toBe(true);
    expect(
      commands.some(
        (command) => command.args[0] === "volume" && command.args[1] === "rm",
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) => command.args[0] === "network" && command.args[1] === "rm",
      ),
    ).toBe(true);
  });
});
