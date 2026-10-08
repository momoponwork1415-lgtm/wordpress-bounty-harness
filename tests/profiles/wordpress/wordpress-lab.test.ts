import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { measureCanonicalSourceTree } from "../../../src/infrastructure/canonical-source-tree.js";
import { canonicalDigest } from "../../../src/infrastructure/canonical-json.js";
import {
  openWordPressLab,
  type DockerRequest,
} from "../../../src/profiles/wordpress/lab/index.js";
import type { Snapshot } from "../../../src/snapshot/index.js";

const directories: string[] = [];
const sha = (value: string) => `sha256:${value.repeat(64)}`;

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(
  preflight: "ready" | "no-runsc" | "missing-image" = "ready",
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
    dependencies: [],
  };
  const snapshot: Snapshot = {
    ...snapshotBody,
    digest: canonicalDigest(snapshotBody),
  };
  const commands: DockerRequest[] = [];
  /** What the fake database holds in the SQL canary table. */
  const database = {
    table: "seeded" as "seeded" | "changed" | "dropped",
    /** What the WordPress container holds at the Execution Canary path. */
    execution: "executed" as "executed" | "plain-write" | "absent",
    /** Canary file paths that no longer exist. */
    deleted: new Set<string>(),
    /** Option values as `wp option get --format=json` prints them. */
    options: new Map<string, string>([
      ["users_can_register", "0"],
      ["default_role", '"subscriber"'],
    ]),
    /** Paths whose visit makes the stored script reach the beacon receiver. */
    firesOn: [] as string[],
    beacons: [] as string[],
  };
  const salts = new Map<string, string>();
  let seededRow = "";
  const lab = openWordPressLab({
    dockerExecutablePath: "/usr/bin/docker",
    images: {
      database: `mariadb@${sha("1")}`,
      wordpress: `wordpress@${sha("2")}`,
      wordpressCli: `wordpress-cli@${sha("3")}`,
      browser: `verification-browser@${sha("4")}`,
    },
    source: {
      resolve: async () => ({
        target: { pluginSlug: "example", sourceDirectory, sourceTree },
        dependencies: [],
      }),
    },
    runner: {
      async run(request) {
        commands.push(request);
        if (request.args[0] === "info")
          return {
            exitCode: 0,
            stdout: preflight === "no-runsc" ? "{}" : '{"runsc":{}}',
            stderr: "",
          };
        if (request.args[0] === "image" && preflight === "missing-image")
          return { exitCode: 1, stdout: "", stderr: "unavailable" };
        if (request.args[0] === "inspect")
          return { exitCode: 0, stdout: "172.20.0.2", stderr: "" };
        const saltArg = request.args.find((arg) =>
          arg.startsWith("WBH_EXECUTION_SALT="),
        );
        if (request.args[0] === "run" && saltArg !== undefined)
          salts.set(
            request.args[request.args.indexOf("--name") + 1] ?? "",
            saltArg.slice("WBH_EXECUTION_SALT=".length),
          );
        if (
          request.args[0] === "exec" &&
          request.args[2] === "cat" &&
          request.args[3]?.startsWith("/tmp/wbh-execution-")
        ) {
          const token = request.args[3]?.replace("/tmp/wbh-execution-", "");
          if (database.execution === "absent")
            return { exitCode: 1, stdout: "", stderr: "missing" };
          return {
            exitCode: 0,
            stdout:
              database.execution === "executed"
                ? createHash("sha256")
                    .update(`${token}${salts.get(request.args[1] ?? "")}`)
                    .digest("hex")
                : (token ?? ""),
            stderr: "",
          };
        }
        if (
          request.args[0] === "run" &&
          request.args.includes(`verification-browser@${sha("4")}`)
        ) {
          const visit = request.args
            .find((arg) => arg.startsWith("WBH_VISIT_PATH="))
            ?.slice("WBH_VISIT_PATH=".length);
          if (visit !== undefined && database.firesOn.includes(visit))
            database.beacons.push("/b/fixed-nonce");
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (
          request.args[0] === "exec" &&
          request.args[1]?.endsWith("-canary") &&
          request.args[2] === "cat"
        )
          return {
            exitCode: database.beacons.length === 0 ? 1 : 0,
            stdout: database.beacons.map((line) => `${line}\n`).join(""),
            stderr: "",
          };
        const option = request.args.indexOf("option");
        if (option >= 0 && request.args[option + 1] === "get") {
          const value = database.options.get(request.args[option + 2] ?? "");
          return value === undefined
            ? { exitCode: 1, stdout: "", stderr: "missing" }
            : { exitCode: 0, stdout: `${value}\n`, stderr: "" };
        }
        if (request.args[0] === "exec" && request.args[2] === "test")
          return {
            exitCode: database.deleted.has(request.args[4] ?? "") ? 1 : 0,
            stdout: "",
            stderr: "",
          };
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
          : null;
        if (query?.startsWith("CREATE TABLE"))
          seededRow = /'([a-f0-9]{32})'/.exec(query)?.[1] ?? "";
        else if (query?.includes("information_schema"))
          return {
            exitCode: 0,
            stdout: database.table === "dropped" ? "0\n" : "1\n",
            stderr: "",
          };
        else if (query?.startsWith("SELECT"))
          return {
            exitCode: 0,
            stdout:
              database.table === "seeded"
                ? `1\t${seededRow}\n`
                : `1\t${seededRow}\n2\tadded\n`,
            stderr: "",
          };
        if (request.args.includes("eval"))
          return {
            exitCode: 0,
            stdout: "wbh-canary-fixed-nonce\n",
            stderr: "",
          };
        if (request.args.includes("--porcelain"))
          return { exitCode: 0, stdout: "7", stderr: "" };
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    },
    nonce: () => "fixed-nonce",
    healthAttempts: 1,
  });
  const setup = {
    schemaVersion: 1 as const,
    snapshotDigest: snapshot.digest,
    siteTitle: "Fixture",
    initialPosts: ["Welcome"],
    customerRole: false,
  };
  return { lab, snapshot, setup, commands, sourceDirectory, database };
}

describe("WordPress gVisor Lab", () => {
  it("provisions two independent internal labs, seeds canaries, and removes resources", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const first = await lab.provision(snapshot, setup);
    const second = await lab.provision(snapshot, setup);
    expect(first.status, JSON.stringify(commands)).toBe("ready");
    expect(second.status).toBe("ready");
    if (first.status !== "ready" || second.status !== "ready") return;
    expect(first.handle.id).not.toBe(second.handle.id);
    expect(first.handle.setupDigest).toMatch(/^sha256:/);
    expect(first.handle.internalIp).toBe("172.20.0.2");
    expect(first.handle.networkName).toMatch(/^wbh-.+-net$/);
    expect(
      commands.some(
        (command) =>
          command.args[0] === "inspect" && command.args.includes("--format"),
      ),
    ).toBe(true);
    expect(Object.keys(first.handle.attackerAccounts)).toEqual(["subscriber"]);
    expect(JSON.stringify(first.handle)).not.toContain("harness-admin");
    const canaries = await lab.seedCanaries(first.handle);
    expect(canaries.status).toBe("seeded");
    expect(lab.canaryLedger(first.handle)).toMatchObject({
      nonce: "fixed-nonce",
      postId: "7",
    });
    const execution = lab.prepareExecutionCanary(first.handle);
    expect(execution?.php).toContain("file_put_contents");
    expect(await lab.observeExecution(first.handle)).toMatchObject({
      status: "executed",
    });
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
    expect(lab.canaryLedger(first.handle)).toBeNull();
    expect(await lab.teardown(second.handle)).toEqual({ status: "removed" });
  });

  it("resolves a presented session inside the Lab without placing it in PHP source", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const provisioned = await lab.provision(snapshot, setup);
    if (provisioned.status !== "ready") throw new Error("not ready");
    expect(
      await lab.observeSessionUser(provisioned.handle, "synthetic%7C1%7Cvalue"),
    ).toEqual({ status: "user", login: "wbh-canary-fixed-nonce" });
    const evaluation = commands.find((command) =>
      command.args.includes("eval"),
    );
    expect(evaluation?.args).toContain(
      "WBH_SESSION_COOKIE=synthetic%7C1%7Cvalue",
    );
    expect(evaluation?.args).toContain("--runtime=runsc");
    expect(
      evaluation?.args.some(
        (arg) => arg.includes("synthetic") && arg.includes("wp_validate"),
      ),
    ).toBe(false);
    const before = commands.length;
    expect(
      await lab.observeSessionUser(provisioned.handle, "bad value'"),
    ).toEqual({ status: "none" });
    expect(commands.length).toBe(before);
  });

  it("seeds an administrator canary and records each attacker role baseline", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const provisioned = await lab.provision(snapshot, setup);
    if (provisioned.status !== "ready") throw new Error("not ready");
    expect((await lab.seedCanaries(provisioned.handle)).status).toBe("seeded");
    const subscriber = provisioned.handle.attackerAccounts.subscriber.username;
    expect(lab.canaryLedger(provisioned.handle)).toMatchObject({
      user: "wbh-canary-fixed-nonce",
      adminUser: "wbh-canary-admin-fixed-nonce",
      roleBaseline: { [subscriber]: ["subscriber"] },
    });
    expect(
      commands.some(
        (command) =>
          command.args.includes("wbh-canary-admin-fixed-nonce") &&
          command.args.includes("--role=administrator"),
      ),
    ).toBe(true);
    expect(JSON.stringify(provisioned.handle)).not.toContain("canary-admin");
    expect(
      await lab.observeAccountRoles(provisioned.handle, subscriber),
    ).toEqual({
      status: "roles",
      roles: ["subscriber"],
    });
    const before = commands.length;
    expect(
      await lab.observeAccountRoles(provisioned.handle, "bad name;"),
    ).toEqual({ status: "unavailable" });
    expect(commands.length).toBe(before);
  });

  it("seeds a SQL canary row whose value appears nowhere else and reports whether the table changed", async () => {
    const { lab, snapshot, setup, commands, database } = await fixture();
    const provisioned = await lab.provision(snapshot, setup);
    if (provisioned.status !== "ready") throw new Error("not ready");
    expect(await lab.observeCanaryTable(provisioned.handle)).toEqual({
      status: "unavailable",
    });
    expect((await lab.seedCanaries(provisioned.handle)).status).toBe("seeded");
    const ledger = lab.canaryLedger(provisioned.handle);
    expect(ledger?.sqlCanary.table).toBe("wbh_canary");
    expect(ledger?.sqlCanary.value).toMatch(/^[a-f0-9]{32}$/);
    // Only the table insert carries the row value; posts, options and files do not.
    expect(
      commands.filter((command) =>
        command.args.some((arg) => arg.includes(ledger!.sqlCanary.value)),
      ),
    ).toHaveLength(1);
    expect(await lab.observeCanaryTable(provisioned.handle)).toEqual({
      status: "intact",
    });
    database.table = "changed";
    expect(await lab.observeCanaryTable(provisioned.handle)).toEqual({
      status: "changed",
    });
    database.table = "dropped";
    expect(await lab.observeCanaryTable(provisioned.handle)).toEqual({
      status: "changed",
    });
  });

  it("observes an Execution Canary only when its code ran with the Lab's hidden salt", async () => {
    const { lab, snapshot, setup, commands, database } = await fixture();
    const provisioned = await lab.provision(snapshot, setup);
    if (provisioned.status !== "ready") throw new Error("not ready");
    expect(await lab.observeExecution(provisioned.handle)).toEqual({
      status: "not-prepared",
    });
    const canary = lab.prepareExecutionCanary(provisioned.handle);
    expect(canary?.php).toContain("WBH_EXECUTION_SALT");
    const saltValue = commands
      .flatMap((command) => command.args)
      .find((arg) => arg.startsWith("WBH_EXECUTION_SALT="))
      ?.slice("WBH_EXECUTION_SALT=".length);
    expect(saltValue).toMatch(/^[a-f0-9]{32}$/);
    // Neither the handle nor the canary handed to a Verifier carries the salt.
    expect(JSON.stringify(provisioned.handle)).not.toContain(saltValue);
    expect(canary?.php).not.toContain(saltValue);
    expect(await lab.observeExecution(provisioned.handle)).toEqual({
      status: "executed",
      files: ["wp-content/uploads/synthetic.php"],
    });
    database.execution = "plain-write";
    expect(await lab.observeExecution(provisioned.handle)).toEqual({
      status: "not-executed",
    });
    database.execution = "absent";
    expect(await lab.observeExecution(provisioned.handle)).toEqual({
      status: "not-executed",
    });
  });

  it("places secret canary files outside wp-content and reports which ones were deleted", async () => {
    const { lab, snapshot, setup, commands, database } = await fixture();
    const provisioned = await lab.provision(snapshot, setup);
    if (provisioned.status !== "ready") throw new Error("not ready");
    expect(await lab.observeCanaryFiles(provisioned.handle)).toEqual({
      status: "unavailable",
    });
    expect((await lab.seedCanaries(provisioned.handle)).status).toBe("seeded");
    const files = lab.canaryLedger(provisioned.handle)?.fileCanaries ?? [];
    expect(files.map(({ kind, path }) => ({ kind, path }))).toEqual([
      { kind: "outside-webroot", path: "/etc/wbh-canary" },
      { kind: "php-source", path: "/var/www/html/wbh-canary.php" },
    ]);
    for (const file of files) {
      expect(file.value).toMatch(/^[a-f0-9]{32}$/);
      expect(file.path).not.toContain("wp-content");
      // Only the command that writes the file carries its value.
      expect(
        commands.filter((command) =>
          command.args.some((arg) => arg.includes(file.value)),
        ),
      ).toHaveLength(1);
    }
    expect(files[0]?.value).not.toBe(files[1]?.value);
    expect(await lab.observeCanaryFiles(provisioned.handle)).toEqual({
      status: "observed",
      deleted: [],
    });
    database.deleted.add("/var/www/html/wbh-canary.php");
    expect(await lab.observeCanaryFiles(provisioned.handle)).toEqual({
      status: "observed",
      deleted: ["php-source"],
    });
  });

  it("records option baselines at seeding and reports only canary or critical options that changed", async () => {
    const { lab, snapshot, setup, database } = await fixture();
    const provisioned = await lab.provision(snapshot, setup);
    if (provisioned.status !== "ready") throw new Error("not ready");
    expect(await lab.observeOptions(provisioned.handle)).toEqual({
      status: "unavailable",
    });
    expect((await lab.seedCanaries(provisioned.handle)).status).toBe("seeded");
    expect(await lab.observeOptions(provisioned.handle)).toEqual({
      status: "observed",
      changed: [],
    });
    database.options.set("blogdescription", '"changed tagline"');
    database.options.set("default_role", '"administrator"');
    database.options.set("wbh_canary_fixed-nonce", '"overwritten"');
    expect(await lab.observeOptions(provisioned.handle)).toEqual({
      status: "observed",
      changed: ["wbh_canary_fixed-nonce", "default_role"],
    });
  });

  it("runs a beacon receiver and reports which page contexts made an issued script canary reach it", async () => {
    const { lab, snapshot, setup, commands, database } = await fixture();
    const provisioned = await lab.provision(snapshot, setup);
    if (provisioned.status !== "ready") throw new Error("not ready");
    const { handle } = provisioned;
    const receiver = commands.find((command) =>
      command.args.includes("canary"),
    );
    expect(receiver?.args).toEqual(
      expect.arrayContaining(["--runtime=runsc", "--read-only"]),
    );
    expect(
      await lab.observeStoredScript(handle, { routePaths: ["/?p=7"] }),
    ).toEqual({ status: "not-prepared" });
    expect(lab.prepareScriptCanary(handle)).toEqual({
      nonce: "fixed-nonce",
      beaconUrl: "http://canary:8080/b/fixed-nonce",
    });

    const contexts = async (firesOn: string[]) => {
      database.firesOn = firesOn;
      return lab.observeStoredScript(handle, { routePaths: ["/?p=7"] });
    };
    expect(await contexts(["/"])).toEqual({
      status: "observed",
      contexts: ["front"],
    });
    expect(await contexts(["/wp-admin/", "/wp-admin/edit.php"])).toEqual({
      status: "observed",
      contexts: ["admin-all"],
    });
    expect(await contexts(["/wp-admin/"])).toEqual({
      status: "observed",
      contexts: ["admin-partial"],
    });
    expect(await contexts(["/?p=7"])).toEqual({
      status: "observed",
      contexts: ["route-page"],
    });
    expect(await contexts([])).toEqual({ status: "observed", contexts: [] });

    const browsers = commands.filter(
      (command) =>
        command.args[0] === "run" &&
        command.args.includes(`verification-browser@${sha("4")}`),
    );
    expect(browsers.length).toBeGreaterThan(0);
    for (const browser of browsers) {
      expect(browser.args).toContain("--runtime=runsc");
      expect(browser.args).toContain("--add-host=canary:172.20.0.2");
    }
    // Only the admin visits log in, and only the Lab's own browser sees that account.
    expect(
      browsers
        .filter((browser) =>
          browser.args.includes("WBH_LOGIN_USER=harness-admin"),
        )
        .map((browser) =>
          browser.args.find((arg) => arg.startsWith("WBH_VISIT_PATH=")),
        ),
    ).toEqual(
      expect.arrayContaining([
        "WBH_VISIT_PATH=/wp-admin/",
        "WBH_VISIT_PATH=/wp-admin/edit.php",
      ]),
    );
    expect(JSON.stringify(handle)).not.toContain("harness-admin");
    expect(
      await lab.observeStoredScript(handle, { routePaths: ["no-slash"] }),
    ).toEqual({ status: "unavailable" });
    expect(await lab.teardown(handle)).toEqual({ status: "removed" });
    expect(
      commands.some(
        (command) =>
          command.args[0] === "rm" &&
          command.args.some((arg) => arg.endsWith("-canary")),
      ),
    ).toBe(true);
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
});
