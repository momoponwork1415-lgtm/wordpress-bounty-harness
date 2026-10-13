import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import {
  exposeWordPressLabToHost,
  hostGatewayName,
} from "../../../src/profiles/wordpress/lab/host-exposure.js";
import type {
  DockerResult,
  Resources,
  WordPressLabHandle,
} from "../../../src/profiles/wordpress/lab/index.js";
import {
  captureWordPressLabState,
  diffWordPressLabState,
  parseBatchRows,
  rolesFromCapabilities,
  WORDPRESS_LAB_STATE_DIFF_SCHEMA_ID,
  WORDPRESS_LAB_STATE_SCHEMA_ID,
  type WordPressLabState,
} from "../../../src/profiles/wordpress/lab/state-capture.js";
import {
  createWordPressLabStateObserver,
  createWordPressStateDiffReader,
  LAB_STATE_DIFF_FILE,
  LAB_STATE_FILE,
  summarizeWordPressLabStateDiff,
} from "../../../src/profiles/wordpress/verification/lab-state-diff.js";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const resource = {
  id: "0f1e2d3c-4b5a-4987-a654-3210fedcba98",
  network: "wbh-0f1e2d3c-4b5a-4987-a654-3210fedcba98-net",
  database: "wbh-0f1e2d3c-4b5a-4987-a654-3210fedcba98-db",
  databasePassword: "root-secret",
} as unknown as Resources;

const user = (
  login: string,
  roles: readonly string[],
  passwordDigest = sha256("hash"),
): WordPressLabState["users"][number] => ({
  id: login === "admin" ? "1" : "2",
  login,
  email: `${login}@lab.invalid`,
  registered: "2026-10-08 00:00:00",
  passwordDigest,
  roles: [...roles],
});

const baseline: WordPressLabState = {
  schema: WORDPRESS_LAB_STATE_SCHEMA_ID,
  capturedAt: "2026-10-08T00:00:00.000Z",
  tablePrefix: "wp_",
  options: [
    { name: "blogname", value: "Lab", autoload: "yes" },
    { name: "default_role", value: "subscriber", autoload: "yes" },
    { name: "synthetic_plugin_shared", value: "before-value", autoload: "no" },
  ],
  users: [
    user("admin", ["administrator"]),
    user("wbh-subscriber", ["subscriber"]),
  ],
  tables: [
    { name: "wp_options", rows: 3, checksum: "100" },
    { name: "wp_users", rows: 2, checksum: "200" },
    { name: "wp_usermeta", rows: 4, checksum: "300" },
  ],
};

describe("WordPress Lab state capture", () => {
  it("unescapes mariadb --batch rows and maps NULL to an empty cell", () => {
    expect(parseBatchRows("a\\tb\tc\\nd\t\\N\te\\\\f\n")).toEqual([
      ["a\tb", "c\nd", "", "e\\f"],
    ]);
    expect(parseBatchRows("")).toEqual([]);
  });

  it("reads role names out of a serialized capabilities array", () => {
    expect(
      rolesFromCapabilities(
        'a:2:{s:13:"administrator";b:1;s:10:"subscriber";b:1;}',
      ),
    ).toEqual(["administrator", "subscriber"]);
    expect(rolesFromCapabilities('a:1:{s:6:"editor";b:0;}')).toEqual([]);
    expect(rolesFromCapabilities("not serialized")).toEqual([]);
  });

  it("captures options, users with roles and per-table counts through the Lab database", async () => {
    const queries: string[] = [];
    const docker = async (args: readonly string[]): Promise<DockerResult> => {
      expect(args.slice(0, 4)).toEqual([
        "exec",
        resource.database,
        "mariadb",
        "--user=root",
      ]);
      expect(args.at(-1)).toBe("wordpress");
      const sql = args[args.indexOf("--execute") + 1] ?? "";
      queries.push(sql);
      if (sql === "SHOW TABLES")
        return {
          exitCode: 0,
          stdout: "wp_users\nwp_options\nwp_usermeta\n",
          stderr: "",
        };
      if (sql.startsWith("SELECT option_name"))
        return {
          exitCode: 0,
          stdout: "blogname\tLab\tyes\nsynthetic\tline1\\nline2\tno\n",
          stderr: "",
        };
      if (sql.startsWith("SELECT u.ID"))
        return {
          exitCode: 0,
          stdout: `1\tadmin\tadmin@lab.invalid\t2026-10-08 00:00:00\t${sha256("hash")}\ta:1:{s:13:"administrator";b:1;}\n2\tsub\tsub@lab.invalid\t2026-10-08 00:00:00\t${sha256("other")}\t\\N\n`,
          stderr: "",
        };
      if (sql.startsWith("SELECT 'wp_options'"))
        return {
          exitCode: 0,
          stdout: "wp_options\t2\nwp_usermeta\t4\nwp_users\t2\n",
          stderr: "",
        };
      if (sql.startsWith("CHECKSUM TABLE"))
        return {
          exitCode: 0,
          stdout:
            "wordpress.wp_options\t11\nwordpress.wp_usermeta\t22\nwordpress.wp_users\t33\n",
          stderr: "",
        };
      throw new Error(`unexpected query ${sql}`);
    };
    const state = await captureWordPressLabState({
      resource,
      docker,
      now: () => new Date("2026-10-08T00:00:00Z"),
    });
    expect(state).toEqual({
      schema: WORDPRESS_LAB_STATE_SCHEMA_ID,
      capturedAt: "2026-10-08T00:00:00.000Z",
      tablePrefix: "wp_",
      options: [
        { name: "blogname", value: "Lab", autoload: "yes" },
        { name: "synthetic", value: "line1\nline2", autoload: "no" },
      ],
      users: [
        {
          id: "1",
          login: "admin",
          email: "admin@lab.invalid",
          registered: "2026-10-08 00:00:00",
          passwordDigest: sha256("hash"),
          roles: ["administrator"],
        },
        {
          id: "2",
          login: "sub",
          email: "sub@lab.invalid",
          registered: "2026-10-08 00:00:00",
          passwordDigest: sha256("other"),
          roles: [],
        },
      ],
      tables: [
        { name: "wp_options", rows: 2, checksum: "11" },
        { name: "wp_usermeta", rows: 4, checksum: "22" },
        { name: "wp_users", rows: 2, checksum: "33" },
      ],
    });
    expect(queries).toHaveLength(5);
    // The capabilities meta key follows the detected table prefix.
    expect(queries[2]).toContain("m.meta_key = 'wp_capabilities'");
  });

  it("fails the capture when a query fails or the options table is missing", async () => {
    await expect(
      captureWordPressLabState({
        resource,
        docker: async () => ({ exitCode: 1, stdout: "", stderr: "denied" }),
        now: () => new Date(),
      }),
    ).rejects.toThrow("Lab database query failed");
    await expect(
      captureWordPressLabState({
        resource,
        docker: async () => ({ exitCode: 0, stdout: "wp_posts\n", stderr: "" }),
        now: () => new Date(),
      }),
    ).rejects.toThrow("Options table is missing");
  });

  it("diffs two captures by name: an option write, a role change and a table checksum", () => {
    const after: WordPressLabState = {
      ...baseline,
      capturedAt: "2026-10-08T00:05:00.000Z",
      options: [
        { name: "blogname", value: "Lab", autoload: "yes" },
        {
          name: "synthetic_plugin_shared",
          value: "after-value",
          autoload: "no",
        },
        { name: "zz_new_option", value: "1", autoload: "yes" },
      ],
      users: [
        user("admin", ["administrator"]),
        user("wbh-subscriber", ["administrator"], sha256("rotated")),
        user("intruder", ["subscriber"]),
      ],
      tables: [
        { name: "wp_options", rows: 3, checksum: "101" },
        { name: "wp_users", rows: 3, checksum: "201" },
        { name: "wp_usermeta", rows: 4, checksum: "300" },
        { name: "wp_synthetic", rows: 1, checksum: "1" },
      ],
    };
    const diff = diffWordPressLabState(baseline, after, {
      before: `sha256:${"a".repeat(64)}`,
      after: `sha256:${"b".repeat(64)}`,
    });
    expect(diff.schema).toBe(WORDPRESS_LAB_STATE_DIFF_SCHEMA_ID);
    expect(diff.options).toEqual({
      added: [{ name: "zz_new_option", after: "1", afterDigest: sha256("1") }],
      removed: [
        {
          name: "default_role",
          before: "subscriber",
          beforeDigest: sha256("subscriber"),
        },
      ],
      changed: [
        {
          name: "synthetic_plugin_shared",
          before: "before-value",
          after: "after-value",
          beforeDigest: sha256("before-value"),
          afterDigest: sha256("after-value"),
        },
      ],
    });
    expect(diff.users.added.map((entry) => entry.login)).toEqual(["intruder"]);
    expect(diff.users.removed).toEqual([]);
    expect(diff.users.changed).toMatchObject([
      {
        login: "wbh-subscriber",
        before: { roles: ["subscriber"] },
        after: { roles: ["administrator"] },
      },
    ]);
    expect(diff.tables).toEqual({
      added: ["wp_synthetic"],
      removed: [],
      changed: [
        {
          name: "wp_options",
          rowsBefore: 3,
          rowsAfter: 3,
          checksumChanged: true,
        },
        {
          name: "wp_users",
          rowsBefore: 2,
          rowsAfter: 3,
          checksumChanged: true,
        },
      ],
    });
    expect(diff.summary).toEqual({
      optionsAdded: 1,
      optionsRemoved: 1,
      optionsChanged: 1,
      usersAdded: 1,
      usersRemoved: 0,
      usersChanged: 1,
      tablesChanged: 2,
    });
    // Identical captures yield an empty diff regardless of row order.
    const shuffled: WordPressLabState = {
      ...baseline,
      options: [...baseline.options].reverse(),
      tables: [...baseline.tables].reverse(),
    };
    expect(
      diffWordPressLabState(baseline, shuffled, {
        before: "sha256:a",
        after: "sha256:a",
      }).summary,
    ).toEqual({
      optionsAdded: 0,
      optionsRemoved: 0,
      optionsChanged: 0,
      usersAdded: 0,
      usersRemoved: 0,
      usersChanged: 0,
      tablesChanged: 0,
    });
  });

  it("summarizes a diff for review export without any option values", () => {
    const after: WordPressLabState = {
      ...baseline,
      options: baseline.options.map((option) =>
        option.name === "synthetic_plugin_shared"
          ? { ...option, value: "after-value" }
          : option,
      ),
      users: [
        user("admin", ["administrator"]),
        user("wbh-subscriber", ["subscriber"], sha256("rotated")),
      ],
    };
    const summary = summarizeWordPressLabStateDiff(
      diffWordPressLabState(baseline, after, {
        before: "sha256:a",
        after: "sha256:b",
      }),
    );
    expect(summary.settings.changed).toEqual([
      {
        key: "synthetic_plugin_shared",
        beforeDigest: sha256("before-value"),
        afterDigest: sha256("after-value"),
      },
    ]);
    expect(summary.principals.changed).toEqual([
      {
        name: "wbh-subscriber",
        rolesBefore: ["subscriber"],
        rolesAfter: ["subscriber"],
        credentialChanged: true,
      },
    ]);
    const serialized = canonicalJson(summary);
    expect(serialized).not.toContain("before-value");
    expect(serialized).not.toContain("after-value");
    expect(serialized).not.toContain("@lab.invalid");
  });
});

describe("WordPress Lab state observer", () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "wbh-state-"));
    directories.push(root);
    const store = new PrivateArtifactStore({
      rootDirectory: join(root, "evidence"),
      maxEntries: 10,
      maxBytes: 1024 * 1024,
    });
    const handle = { id: resource.id } as WordPressLabHandle;
    return { store, handle };
  }

  it("stores before, after and diff files and reports their digests by kind", async () => {
    const { store, handle } = await fixture();
    const captures: WordPressLabState[] = [
      baseline,
      {
        ...baseline,
        capturedAt: "2026-10-08T00:05:00.000Z",
        options: baseline.options.map((option) =>
          option.name === "synthetic_plugin_shared"
            ? { ...option, value: "after-value" }
            : option,
        ),
      },
    ];
    const observer = createWordPressLabStateObserver({
      store,
      lab: {
        captureState: async () => ({
          status: "captured",
          state: captures.shift()!,
        }),
      },
    });
    const before = await observer.before(handle);
    expect(before).not.toBeNull();
    const record = await observer.after(handle, before!);
    expect(record.status).toBe("captured");
    if (record.status !== "captured") throw new Error("unreachable");
    expect(record.artifacts.map((artifact) => artifact.kind)).toEqual([
      "lab-state-before",
      "lab-state-after",
      "lab-state-diff",
    ]);
    expect(record.artifacts[0]!.digest).toBe(before!.digest);
    const stored = await store.readFile(
      record.artifacts[2]!.digest,
      LAB_STATE_DIFF_FILE,
      1024 * 1024,
    );
    expect(stored.status).toBe("resolved");
    const beforeFile = await store.readFile(
      before!.digest,
      LAB_STATE_FILE,
      1024 * 1024,
    );
    expect(beforeFile.status).toBe("resolved");

    // The reader hands review export names and digests only.
    const summary = await createWordPressStateDiffReader({ store }).read(
      record.artifacts[2]!.digest,
    );
    expect(summary?.settings.changed.map((entry) => entry.key)).toEqual([
      "synthetic_plugin_shared",
    ]);
    expect(canonicalJson(summary)).not.toContain("after-value");
    expect(
      await createWordPressStateDiffReader({ store }).read(
        `sha256:${"0".repeat(64)}`,
      ),
    ).toBeNull();
  });

  it("records a missing capture with its stage instead of failing", async () => {
    const { store, handle } = await fixture();
    const unavailable = createWordPressLabStateObserver({
      store,
      lab: { captureState: async () => ({ status: "unavailable" }) },
    });
    expect(await unavailable.before(handle)).toBeNull();

    let calls = 0;
    const afterFails = createWordPressLabStateObserver({
      store,
      lab: {
        captureState: async () =>
          ++calls === 1
            ? { status: "captured", state: baseline }
            : { status: "unavailable" },
      },
    });
    const before = await afterFails.before(handle);
    expect(await afterFails.after(handle, before!)).toEqual({
      status: "missing",
      reason: "after-capture",
    });
    expect(
      await afterFails.after(handle, { digest: before!.digest, state: {} }),
    ).toEqual({ status: "missing", reason: "before-capture" });
  });
});

describe("WordPress Lab host exposure", () => {
  it("publishes the Lab through a runsc gateway on loopback and joins the internal network", async () => {
    const calls: string[][] = [];
    const handle = {
      id: resource.id,
      internalIp: "172.20.0.3",
      database: { ipv4: "172.20.0.2" },
    } as unknown as WordPressLabHandle;
    const exposure = await exposeWordPressLabToHost({
      resource,
      handle,
      image: "node-recorder@sha256:abc",
      httpPort: 8080,
      databasePort: 3307,
      requireDocker: async (args) => {
        calls.push([...args]);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(exposure).toEqual({
      status: "exposed",
      container: hostGatewayName(resource.id),
      httpPort: 8080,
      databasePort: 3307,
    });
    expect(calls).toHaveLength(2);
    const run = calls[0]!;
    expect(run.slice(0, 2)).toEqual(["run", "--detach"]);
    expect(run).toContain("--runtime=runsc");
    expect(run).toContain("127.0.0.1:8080:80");
    expect(run).toContain("127.0.0.1:3307:3306");
    expect(run).toContain("WBH_WP_IP=172.20.0.3");
    expect(run).toContain("WBH_DB_IP=172.20.0.2");
    expect(run).toContain("node-recorder@sha256:abc");
    expect(calls[1]).toEqual([
      "network",
      "connect",
      resource.network,
      hostGatewayName(resource.id),
    ]);
  });

  it("stays unavailable on bad ports or a failing gateway start", async () => {
    const handle = {
      id: resource.id,
      internalIp: "172.20.0.3",
    } as unknown as WordPressLabHandle;
    expect(
      await exposeWordPressLabToHost({
        resource,
        handle,
        image: "image",
        httpPort: 70000,
        requireDocker: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).toMatchObject({ status: "unavailable" });
    const failing = await exposeWordPressLabToHost({
      resource,
      handle,
      image: "image",
      httpPort: 8080,
      requireDocker: async () => {
        throw new Error("docker failed");
      },
    });
    expect(failing).toEqual({
      status: "unavailable",
      diagnostic: "The host gateway could not be started",
    });
  });
});
