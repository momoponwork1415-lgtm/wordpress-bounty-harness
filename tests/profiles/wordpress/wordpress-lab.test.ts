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
  type WordPressVictimRoute,
} from "../../../src/profiles/wordpress/lab/index.js";
import type { Snapshot } from "../../../src/snapshot/index.js";
import {
  wordPressScenario,
  nextWordPressScenario,
} from "../../../src/profiles/wordpress/lab/scenarios.js";
import { downloadManagerOrdinarySetupScript } from "../../../src/profiles/wordpress/lab/download-manager-adapter.js";
import { downloadMonitorOrdinarySetupScript } from "../../../src/profiles/wordpress/lab/download-monitor-adapter.js";
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
    dependencies:
      core === undefined
        ? []
        : [
            {
              identity: "wordpress-core",
              version: core.version,
              sourceDigest: sourceTree.digest,
            },
          ],
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
    browserFailureAt: null as string | null,
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
        dependencies:
          core === undefined
            ? []
            : [
                {
                  kind: "wordpress-core" as const,
                  version: core.version,
                  sourceDirectory,
                  sourceTree,
                },
              ],
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
        if (
          preflight === "missing-extension" &&
          request.args[0] === "exec" &&
          request.args[2] === "php" &&
          request.args[4]?.includes('extension_loaded("pdo_mysql")')
        )
          return { exitCode: 43, stdout: "", stderr: "" };
        if (request.args[0] === "inspect")
          return {
            exitCode: 0,
            stdout: request.args.at(-1)?.endsWith("-db")
              ? "172.20.0.3"
              : request.args.at(-1)?.endsWith("-proxy")
                ? "172.20.0.4"
                : request.args.at(-1)?.endsWith("-canary")
                  ? "172.20.0.5"
                  : "172.20.0.2",
            stderr: "",
          };
        if (request.args[0] === "exec" && request.args[1] === "-i")
          return {
            exitCode: 0,
            stdout: '{"status":"completed","completedSteps":1}',
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
            stdout: "wp_options\nwp_posts\nwbh_canary\ninvalid;table\n",
            stderr: "",
          };
        if (request.args.includes("core") && request.args.includes("version"))
          return {
            exitCode: 0,
            stdout: `${core?.runningVersion ?? "6.8.3"}\n`,
            stderr: "",
          };
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
          if (visit === database.browserFailureAt)
            return {
              exitCode: 1,
              stdout: "",
              stderr: "private-debug-marker",
            };
          if (visit !== undefined && database.firesOn.includes(visit))
            database.beacons.push("/b/fixed-nonce");
          return {
            exitCode: 0,
            stdout: Buffer.concat([
              Buffer.from("89504e470d0a1a0a", "hex"),
              Buffer.from("synthetic observer output"),
            ]).toString("base64"),
            stderr: "",
          };
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
  it("passes a private replay request to the runsc recorder over stdin", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const provisioned = await lab.provision(snapshot, setup);
    expect(provisioned.status).toBe("ready");
    if (provisioned.status !== "ready") return;
    const secret = "private-replay-value";
    expect(
      await lab.replayHttp(provisioned.handle, {
        initialBindings: { value: secret },
        steps: [{ method: "GET", path: "/{{value}}" }],
      }),
    ).toEqual({ status: "completed", completedSteps: 1 });
    const replay = commands.find(
      (command) => command.args[0] === "exec" && command.args[1] === "-i",
    );
    expect(replay?.args).toContain(`wbh-${provisioned.handle.id}-proxy`);
    expect(JSON.stringify(replay?.args)).not.toContain(secret);
    expect(replay?.stdin).toContain(secret);
    await lab.teardown(provisioned.handle);
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

  it("provisions protected canaries only in a verification Lab", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const discovery = await lab.provision(snapshot, setup, {
      purpose: "discovery",
    });
    expect(discovery.status).toBe("ready");
    if (discovery.status !== "ready") return;
    expect(await lab.seedCanaries(discovery.handle)).toMatchObject({
      status: "seeded",
    });
    expect(lab.canaryLedger(discovery.handle)?.sensitiveCanaries).toEqual([]);
    expect(
      commands.some((command) =>
        command.args.includes("--post_status=private"),
      ),
    ).toBe(false);
    await lab.teardown(discovery.handle);

    const verification = await lab.provision(snapshot, setup, {
      purpose: "verification",
    });
    expect(verification.status).toBe("ready");
    if (verification.status !== "ready") return;
    expect(await lab.seedCanaries(verification.handle)).toMatchObject({
      status: "seeded",
    });
    expect(
      lab
        .canaryLedger(verification.handle)
        ?.sensitiveCanaries.map((item) => item.kind),
    ).toEqual(["private-post", "other-user-meta"]);
    expect(
      commands.some((command) =>
        command.args.includes("--post_status=private"),
      ),
    ).toBe(true);
    expect(
      commands.some((command) => command.args.includes("wbh_private_note")),
    ).toBe(true);
    expect(JSON.stringify(verification.handle)).not.toContain("wbh-sensitive-");
    await lab.teardown(verification.handle);
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

  it("repeats pinned public and subscriber downloads in isolated Labs", async () => {
    const { lab, snapshot, setup, commands } = await fixture(
      "ready",
      undefined,
      "download-manager",
    );
    const scenario = wordPressScenario("public-and-subscriber-downloads-v1")!;
    expect(scenario).toMatchObject({
      version: 1,
      pluginSlug: "download-manager",
      ordinaryDownloads: true,
      adapterDigest: canonicalDigest(downloadManagerOrdinarySetupScript()),
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
      .filter(
        ({ args }) => args[0] === "exec" && args.includes("--user=www-data"),
      )
      .map(({ args }) => args.at(-1) ?? "");
    expect(scripts).toHaveLength(2);
    for (const script of scripts) {
      expect(script).toContain('"access"=>["guest"]');
      expect(script).toContain('"access"=>["subscriber","administrator"]');
      expect(script).toContain('is_file(UPLOAD_DIR.".htaccess")');
      expect(script).toContain('"post_status"=>"publish"');
      expect(script).toContain("wpdm_package id=");
    }
    expect(
      commands.filter(
        ({ args }) => args[0] === "exec" && args.includes("www-data:www-data"),
      ),
    ).toHaveLength(2);
    expect(await lab.teardown(verification.handle)).toEqual({
      status: "removed",
    });
  });

  it("rejects the download scenario for another plugin before containers start", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const scenario = wordPressScenario("public-and-subscriber-downloads-v1")!;
    const result = await lab.provision(snapshot, {
      ...setup,
      scenario: { id: scenario.id, digest: scenario.digest },
    });
    expect(result.status).toBe("incomplete");
    expect(commands.some(({ args }) => args[0] === "run")).toBe(false);
  });

  it("provisions the pinned public download setup for both Lab purposes", async () => {
    const { lab, snapshot, setup, commands } = await fixture(
      "ready",
      { version: "6.8.3", runningVersion: "6.8.3" },
      "download-monitor",
    );
    const scenario = wordPressScenario("public-file-download-v1")!;
    expect(scenario).toMatchObject({
      version: 1,
      pluginSlug: "download-monitor",
      roles: ["unauthenticated", "subscriber"],
      expectedObservations: ["public-page-link", "public-download-fixture"],
      adapterDigest: canonicalDigest(downloadMonitorOrdinarySetupScript()),
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
      .filter(
        ({ args }) => args[0] === "exec" && args.includes("--user=www-data"),
      )
      .map(({ args }) => args.at(-1) ?? "");
    expect(scripts).toEqual([
      downloadMonitorOrdinarySetupScript(),
      downloadMonitorOrdinarySetupScript(),
    ]);
    expect(scripts[0]).toContain('"post_type"=>"dlm_download_version"');
    expect(scripts[0]).toContain('"post_content"=>$shortcode');
    expect(scripts[0]).toContain("get_mirrors()");
    expect(await lab.teardown(verification.handle)).toEqual({
      status: "removed",
    });
  });

  it("rejects the public file download scenario for another plugin", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const scenario = wordPressScenario("public-file-download-v1")!;
    const result = await lab.provision(snapshot, {
      ...setup,
      scenario: { id: scenario.id, digest: scenario.digest },
    });
    expect(result.status).toBe("incomplete");
    expect(commands.some(({ args }) => args[0] === "run")).toBe(false);
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

  it("grants SELECT only on existing non-canary tables before seeding", async () => {
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
    expect(sql.includes("wbh_canary")).toBe(false);
    expect(sql.includes("invalid;table")).toBe(false);
    expect(await lab.seedCanaries(provisioned.handle)).toMatchObject({
      status: "seeded",
    });
    const grantIndex = commands.indexOf(grant);
    const canaryIndex = commands.findIndex((command) =>
      command.args.some((arg) => arg.startsWith("CREATE TABLE wbh_canary")),
    );
    expect(grantIndex).toBeGreaterThanOrEqual(0);
    expect(canaryIndex).toBeGreaterThan(grantIndex);
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

  it("gives the administrator canary the configured published secondary locale", async () => {
    const { lab, snapshot, setup, commands } = await fixture(
      "ready",
      undefined,
      "translatepress-multilingual",
    );
    const provisioned = await lab.provision(snapshot, {
      ...setup,
      translatePress: { administratorSecondaryLocale: "fr_FR" },
    });
    if (provisioned.status !== "ready") throw new Error("not ready");
    expect((await lab.seedCanaries(provisioned.handle)).status).toBe("seeded");
    expect(
      commands.some(
        (command) =>
          command.args.includes("eval") &&
          command.args.some(
            (arg) =>
              arg.includes("wbh-canary-admin-fixed-nonce") &&
              arg.includes('get_user_locale($admin->ID)!=="fr_FR"'),
          ),
      ),
    ).toBe(true);
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

  it("runs a beacon receiver and reports which page contexts made an issued script canary reach it", async () => {
    const { lab, snapshot, setup, commands, database } = await fixture();
    const provisioned = await lab.provision(snapshot, setup, {
      purpose: "verification",
    });
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
      javascript:
        'fetch("http://canary:8080/b/fixed-nonce", { method: "POST", headers: { "X-WBH-Script-Canary": "fixed-nonce" } });',
      loaderJavascript: 'import("//canary:8080/c/fixed-nonce")',
    });

    const contexts = async (
      firesOn: string[],
      victim?: WordPressVictimRoute,
    ) => {
      database.firesOn = firesOn;
      return lab.observeStoredScript(handle, {
        routePaths: ["/?p=7"],
        ...(victim === undefined ? {} : { victim }),
      });
    };
    expect(await contexts(["/"])).toEqual({
      status: "observed",
      contexts: ["front"],
      screenshot: expect.any(Buffer),
    });
    expect(await contexts(["/wp-admin/", "/wp-admin/edit.php"])).toEqual({
      status: "observed",
      contexts: ["admin-all"],
      screenshot: expect.any(Buffer),
    });
    expect(await contexts(["/wp-admin/"])).toEqual({
      status: "observed",
      contexts: ["admin-partial"],
      screenshot: expect.any(Buffer),
    });
    expect(await contexts(["/?p=7"])).toEqual({
      status: "observed",
      contexts: ["route-page"],
      screenshot: expect.any(Buffer),
    });
    expect(
      await contexts(["/wp-admin/admin.php?page=fixture"], {
        role: "administrator",
        paths: [
          {
            path: "/wp-admin/admin.php?page=fixture",
            actions: [
              { kind: "click-text", text: "Choose a value", exact: false },
            ],
          },
        ],
      }),
    ).toEqual({
      status: "observed",
      contexts: ["victim-route-page"],
      victimRole: "administrator",
      screenshot: expect.any(Buffer),
    });
    expect(
      await contexts(["/?p=8"], {
        role: "subscriber",
        paths: ["/?p=8"],
      }),
    ).toEqual({
      status: "observed",
      contexts: ["victim-route-page"],
      victimRole: "subscriber",
      screenshot: expect.any(Buffer),
    });
    expect(await contexts([])).toEqual({ status: "observed", contexts: [] });

    database.browserFailureAt = "/wp-admin/admin.php?page=fixture";
    const failedVictimVisit = await contexts([], {
      role: "administrator",
      paths: ["/wp-admin/admin.php?page=fixture"],
    });
    expect(failedVictimVisit).toEqual({
      status: "unavailable",
      phase: "victim-page",
    });
    expect(JSON.stringify(failedVictimVisit)).not.toContain(
      "private-debug-marker",
    );
    expect(JSON.stringify(failedVictimVisit)).not.toContain("page=fixture");
    database.browserFailureAt = null;

    const browsers = commands.filter(
      (command) =>
        command.args[0] === "run" &&
        command.args.includes(`verification-browser@${sha("4")}`),
    );
    expect(browsers.length).toBeGreaterThan(0);
    for (const browser of browsers) {
      expect(browser.args).toContain("--runtime=runsc");
      expect(browser.args).toContain("--add-host=canary:172.20.0.5");
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
          'WBH_VISIT_ACTIONS=[{"kind":"click-text","text":"Choose a value","exact":false}]',
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
      commands.some((command) =>
        command.args.some((arg) => arg.startsWith("wbh-victim-subscriber-")),
      ),
    ).toBe(true);
    expect(
      await lab.observeStoredScript(handle, { routePaths: ["no-slash"] }),
    ).toEqual({ status: "unavailable", phase: "route-input" });
    expect(
      await lab.observeStoredScript(handle, {
        routePaths: [],
        victim: { role: "administrator", paths: ["/\\outside.invalid"] },
      }),
    ).toEqual({ status: "unavailable", phase: "victim-input" });
    expect(
      await lab.observeStoredScript(handle, {
        routePaths: [],
        victim: {
          role: "administrator",
          paths: [
            {
              path: "/wp-admin/",
              actions: [{ kind: "evaluate", source: "alert(1)" }],
            },
          ],
        } as unknown as WordPressVictimRoute,
      }),
    ).toEqual({ status: "unavailable", phase: "victim-input" });
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
