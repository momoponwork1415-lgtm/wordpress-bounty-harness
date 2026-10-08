import { createHash, randomBytes, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";

import { z } from "zod";

import { canonicalDigest } from "../../../infrastructure/canonical-json.js";
import {
  verifyCanonicalSourceTree,
  type ExpectedSourceTree,
} from "../../../infrastructure/canonical-source-tree.js";
import { runNativeModelProcess } from "../../../infrastructure/native-model-process.js";
import type {
  LabHandle,
  LabProvisioner,
  ProvisionResult,
} from "../../../lab/index.js";
import { snapshotSchema, type Snapshot } from "../../../snapshot/index.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const pinnedImage = z.string().regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/);
const slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .max(100);
const setupSchema = z.strictObject({
  schemaVersion: z.literal(1),
  snapshotDigest: digest,
  siteTitle: z.string().min(1).max(120),
  initialPosts: z.array(z.string().min(1).max(120)).max(20),
  customerRole: z.boolean(),
});
const SQL_CANARY_TABLE = "wbh_canary";
const snapshotWithDigestSchema = snapshotSchema.safeExtend({ digest });

export type WordPressLabSetup = z.infer<typeof setupSchema>;
export type DockerRequest = {
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
};
export type DockerResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};
export interface DockerRunner {
  run(request: DockerRequest): Promise<DockerResult>;
}

export interface WordPressSource {
  readonly pluginSlug: string;
  readonly sourceDirectory: string;
  readonly sourceTree: ExpectedSourceTree;
}
export interface WordPressSourceResolver {
  resolve(snapshot: Snapshot): Promise<{
    readonly target: WordPressSource;
    readonly dependencies: readonly WordPressSource[];
  }>;
}

export interface WordPressLabHandle extends LabHandle {
  readonly networkName: string;
  readonly internalIp: string;
  readonly attackerAccounts: Readonly<{
    subscriber: { readonly username: string; readonly password: string };
    customer?: { readonly username: string; readonly password: string };
  }>;
}

export interface WordPressCanaryLedger {
  readonly nonce: string;
  readonly option: string;
  readonly postId: string;
  readonly postMeta: string;
  readonly file: string;
  readonly user: string;
  /** Administrator canary: a takeover target the attacker never holds credentials for. */
  readonly adminUser: string;
  /** Roles of each attacker account when the Lab was seeded. */
  readonly roleBaseline: Readonly<Record<string, readonly string[]>>;
  /** One row whose value is stored only in this table; reading it needs SQL access. */
  readonly sqlCanary: { readonly table: string; readonly value: string };
}

export type WordPressCanaryTableObservation = {
  readonly status: "intact" | "changed" | "unavailable";
};

export type WordPressRoleObservation =
  | { readonly status: "roles"; readonly roles: readonly string[] }
  | { readonly status: "unavailable" };

export type WordPressSessionObservation =
  | { readonly status: "user"; readonly login: string }
  | { readonly status: "none" | "unavailable" };

export type WordPressExecutionObservation =
  | {
      readonly status: "executed";
      /** Files under the web root that hold the canary, relative to it. */
      readonly files: readonly string[];
    }
  | { readonly status: "not-executed" | "not-prepared" | "unavailable" };

export interface ExecutionCanary {
  readonly nonce: string;
  readonly php: string;
}

export interface WordPressLab extends LabProvisioner<
  WordPressLabSetup,
  WordPressLabHandle
> {
  canaryLedger(handle: WordPressLabHandle): WordPressCanaryLedger | null;
  prepareExecutionCanary(handle: WordPressLabHandle): ExecutionCanary | null;
  /**
   * Checks every Execution Canary issued for this Lab. Only code that ran inside
   * the WordPress container can produce the salted marker; a plain file write cannot.
   */
  observeExecution(
    handle: WordPressLabHandle,
  ): Promise<WordPressExecutionObservation>;
  /** Asks WordPress inside the Lab which user a logged-in cookie value authenticates. */
  observeSessionUser(
    handle: WordPressLabHandle,
    cookie: string,
  ): Promise<WordPressSessionObservation>;
  /** Compares the SQL canary table with the row seeded into it. */
  observeCanaryTable(
    handle: WordPressLabHandle,
  ): Promise<WordPressCanaryTableObservation>;
  /** Reads an account's current roles inside the Lab. */
  observeAccountRoles(
    handle: WordPressLabHandle,
    username: string,
  ): Promise<WordPressRoleObservation>;
}

interface Resources {
  readonly id: string;
  readonly network: string;
  readonly volume: string;
  readonly database: string;
  readonly wordpress: string;
  readonly databasePassword: string;
  readonly adminPassword: string;
  /** Only the WordPress container's environment holds this. */
  readonly executionSalt: string;
  handle?: WordPressLabHandle;
  canaries?: WordPressCanaryLedger;
  executionNonces: Set<string>;
  networkCreated: boolean;
  volumeCreated: boolean;
  databaseCreated: boolean;
  wordpressCreated: boolean;
}

export function openWordPressLab(options: {
  readonly dockerExecutablePath: string;
  readonly images: {
    readonly database: string;
    readonly wordpress: string;
    readonly wordpressCli: string;
  };
  readonly source: WordPressSourceResolver;
  readonly runner?: DockerRunner;
  readonly nonce?: () => string;
  readonly healthAttempts?: number;
}): WordPressLab {
  if (!isAbsolute(options.dockerExecutablePath))
    throw new Error("Docker executable path must be absolute");
  for (const image of Object.values(options.images)) pinnedImage.parse(image);
  const attempts = options.healthAttempts ?? 60;
  if (!Number.isSafeInteger(attempts) || attempts < 1)
    throw new Error("Invalid health attempt count");
  const nonce = options.nonce ?? randomUUID;
  const runner = options.runner ?? {
    async run(request: DockerRequest): Promise<DockerResult> {
      const result = await runNativeModelProcess({
        executablePath: options.dockerExecutablePath,
        args: request.args,
        workingDirectory: "/",
        environment: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          LANG: "C",
          LC_ALL: "C",
          TZ: "UTC",
        },
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes,
      });
      return result.kind === "exited"
        ? result
        : { exitCode: -1, stdout: "", stderr: result.stderr };
    },
  };
  const active = new Map<string, Resources>();

  const docker = (
    args: readonly string[],
    timeoutMs = 60_000,
  ): Promise<DockerResult> =>
    runner.run({ args, timeoutMs, maxOutputBytes: 64 * 1024 });
  const requireDocker = async (
    args: readonly string[],
    timeoutMs?: number,
  ): Promise<DockerResult> => {
    const result = await docker(args, timeoutMs);
    if (result.exitCode !== 0) throw new Error("gVisor Lab command failed");
    return result;
  };
  const wp = (
    resource: Resources,
    args: readonly string[],
    environment: readonly string[] = [],
  ): Promise<DockerResult> =>
    requireDocker([
      "run",
      "--rm",
      "--runtime=runsc",
      "--network",
      resource.network,
      "--security-opt=no-new-privileges",
      ...environment.flatMap((entry) => ["--env", entry]),
      "--env",
      "WORDPRESS_DB_HOST=database",
      "--env",
      "WORDPRESS_DB_NAME=wordpress",
      "--env",
      "WORDPRESS_DB_USER=root",
      "--env",
      `WORDPRESS_DB_PASSWORD=${resource.databasePassword}`,
      "--volume",
      `${resource.volume}:/var/www/html`,
      options.images.wordpressCli,
      "wp",
      ...args,
      "--allow-root",
    ]);
  const cleanup = async (resource: Resources): Promise<boolean> => {
    let okay = true;
    for (const args of [
      ...(resource.wordpressCreated || resource.databaseCreated
        ? [
            [
              "rm",
              "--force",
              ...[
                resource.wordpressCreated ? resource.wordpress : undefined,
                resource.databaseCreated ? resource.database : undefined,
              ].filter((value): value is string => value !== undefined),
            ],
          ]
        : []),
      ...(resource.volumeCreated
        ? [["volume", "rm", "--force", resource.volume]]
        : []),
      ...(resource.networkCreated ? [["network", "rm", resource.network]] : []),
    ]) {
      try {
        if ((await docker(args)).exitCode !== 0) okay = false;
      } catch {
        okay = false;
      }
    }
    if (okay) active.delete(resource.id);
    return okay;
  };
  const roles = async (
    resource: Resources,
    username: string,
  ): Promise<WordPressRoleObservation> => {
    if (!/^[A-Za-z0-9._@-]{1,60}$/.test(username))
      return { status: "unavailable" };
    try {
      const result = await wp(resource, [
        "user",
        "get",
        username,
        "--field=roles",
      ]);
      return {
        status: "roles",
        roles: result.stdout
          .split(",")
          .map((role) => role.trim())
          .filter((role) => role.length > 0)
          .sort(),
      };
    } catch {
      return { status: "unavailable" };
    }
  };
  const verifySource = async (
    source: WordPressSource,
    expected: string,
  ): Promise<string> => {
    slug.parse(source.pluginSlug);
    if (
      !isAbsolute(source.sourceDirectory) ||
      source.sourceDirectory.includes("\0") ||
      source.sourceTree.digest !== expected
    )
      throw new Error("Source digest mismatch");
    const directory = await realpath(source.sourceDirectory);
    if (
      !(await stat(directory)).isDirectory() ||
      !(await verifyCanonicalSourceTree(directory, source.sourceTree)).matches
    )
      throw new Error("Source tree mismatch");
    return directory;
  };
  const preflight = async (): Promise<void> => {
    const runtimes = await docker(
      ["info", "--format", "{{json .Runtimes}}"],
      10_000,
    );
    const parsed: unknown =
      runtimes.exitCode === 0 ? (JSON.parse(runtimes.stdout) as unknown) : null;
    if (
      !z.record(z.string(), z.unknown()).safeParse(parsed).success ||
      parsed === null ||
      typeof parsed !== "object" ||
      !Object.hasOwn(parsed, "runsc")
    )
      throw new Error("runsc unavailable");
    for (const image of Object.values(options.images))
      await requireDocker(["image", "inspect", image], 30_000);
  };
  return {
    async provision(
      candidateSnapshot,
      candidateSetup,
    ): Promise<ProvisionResult<WordPressLabHandle>> {
      let resource: Resources | undefined;
      try {
        const snapshot = snapshotWithDigestSchema.parse(candidateSnapshot);
        const { digest: snapshotDigest, ...record } = snapshot;
        if (canonicalDigest(record) !== snapshotDigest)
          throw new Error("Snapshot digest mismatch");
        const setup = setupSchema.parse(candidateSetup);
        if (setup.snapshotDigest !== snapshot.digest)
          throw new Error("Lab setup snapshot mismatch");
        const resolved = await options.source.resolve(snapshot);
        if (resolved.dependencies.length !== snapshot.dependencies.length)
          throw new Error("Dependency count mismatch");
        if (
          setup.customerRole &&
          ![resolved.target, ...resolved.dependencies].some(
            (source) => source.pluginSlug === "woocommerce",
          )
        )
          throw new Error("Customer role needs WooCommerce");
        const targetDirectory = await verifySource(
          resolved.target,
          snapshot.target.sourceDigest,
        );
        const dependencies: { slug: string; directory: string }[] = [];
        for (let index = 0; index < resolved.dependencies.length; index++) {
          const item = resolved.dependencies[index];
          const expected = snapshot.dependencies[index];
          if (item === undefined || expected === undefined)
            throw new Error("Dependency missing");
          dependencies.push({
            slug: item.pluginSlug,
            directory: await verifySource(item, expected.sourceDigest),
          });
        }
        await preflight();
        const id = randomUUID();
        const prefix = `wbh-${id}`;
        const subscriber = {
          username: `wbh-subscriber-${id.slice(0, 8)}`,
          password: randomUUID(),
        };
        const customer = setup.customerRole
          ? {
              username: `wbh-customer-${id.slice(0, 8)}`,
              password: randomUUID(),
            }
          : undefined;
        resource = {
          id,
          network: `${prefix}-net`,
          volume: `${prefix}-site`,
          database: `${prefix}-db`,
          wordpress: `${prefix}-wp`,
          databasePassword: randomUUID(),
          adminPassword: randomUUID(),
          executionSalt: randomBytes(16).toString("hex"),
          executionNonces: new Set(),
          networkCreated: false,
          volumeCreated: false,
          databaseCreated: false,
          wordpressCreated: false,
        };
        await requireDocker([
          "network",
          "create",
          "--internal",
          resource.network,
        ]);
        resource.networkCreated = true;
        await requireDocker(["volume", "create", resource.volume]);
        resource.volumeCreated = true;
        await requireDocker([
          "run",
          "--detach",
          "--name",
          resource.database,
          "--runtime=runsc",
          "--network",
          resource.network,
          "--network-alias",
          "database",
          "--security-opt=no-new-privileges",
          "--env",
          `MARIADB_ROOT_PASSWORD=${resource.databasePassword}`,
          "--env",
          "MARIADB_DATABASE=wordpress",
          options.images.database,
        ]);
        resource.databaseCreated = true;
        await requireDocker([
          "run",
          "--detach",
          "--name",
          resource.wordpress,
          "--runtime=runsc",
          "--network",
          resource.network,
          "--network-alias",
          "wordpress",
          "--security-opt=no-new-privileges",
          "--volume",
          `${resource.volume}:/var/www/html`,
          "--env",
          "WORDPRESS_DB_HOST=database",
          "--env",
          "WORDPRESS_DB_NAME=wordpress",
          "--env",
          "WORDPRESS_DB_USER=root",
          "--env",
          `WORDPRESS_DB_PASSWORD=${resource.databasePassword}`,
          "--env",
          `WBH_EXECUTION_SALT=${resource.executionSalt}`,
          options.images.wordpress,
        ]);
        resource.wordpressCreated = true;
        const inspected = await requireDocker([
          "inspect",
          "--format",
          "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
          resource.wordpress,
        ]);
        const internalIp = inspected.stdout.trim();
        const octets = internalIp.split(".").map(Number);
        if (
          isIP(internalIp) !== 4 ||
          !(
            octets[0] === 10 ||
            (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
            (octets[0] === 192 && octets[1] === 168)
          )
        )
          throw new Error("Lab internal address is unavailable");
        let healthy = false;
        for (let attempt = 0; attempt < attempts; attempt++) {
          const [wordpressHealth, databaseHealth] = await Promise.all([
            docker(
              [
                "exec",
                resource.wordpress,
                "php",
                "-r",
                'exit(is_file("/var/www/html/wp-settings.php") ? 0 : 1);',
              ],
              10_000,
            ),
            docker(
              [
                "exec",
                resource.database,
                "mariadb-admin",
                "ping",
                "--host=127.0.0.1",
                "--user=root",
                `--password=${resource.databasePassword}`,
                "--silent",
              ],
              10_000,
            ),
          ]);
          if (wordpressHealth.exitCode === 0 && databaseHealth.exitCode === 0) {
            healthy = true;
            break;
          }
          if (attempt + 1 < attempts)
            await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
        }
        if (!healthy) throw new Error("WordPress health check failed");
        await wp(resource, [
          "core",
          "install",
          "--url=http://wordpress",
          `--title=${setup.siteTitle}`,
          "--admin_user=harness-admin",
          `--admin_password=${resource.adminPassword}`,
          "--admin_email=harness-admin@example.invalid",
          "--skip-email",
        ]);
        for (const source of [
          ...dependencies,
          { slug: resolved.target.pluginSlug, directory: targetDirectory },
        ]) {
          await requireDocker([
            "exec",
            resource.wordpress,
            "mkdir",
            "-p",
            `/var/www/html/wp-content/plugins/${source.slug}`,
          ]);
          await requireDocker([
            "cp",
            `${source.directory}/.`,
            `${resource.wordpress}:/var/www/html/wp-content/plugins/${source.slug}`,
          ]);
          await wp(resource, ["plugin", "activate", source.slug]);
        }
        await wp(resource, [
          "user",
          "create",
          subscriber.username,
          `${subscriber.username}@example.invalid`,
          "--role=subscriber",
          `--user_pass=${subscriber.password}`,
        ]);
        if (customer !== undefined)
          await wp(resource, [
            "user",
            "create",
            customer.username,
            `${customer.username}@example.invalid`,
            "--role=customer",
            `--user_pass=${customer.password}`,
          ]);
        for (const title of setup.initialPosts)
          await wp(resource, [
            "post",
            "create",
            "--post_status=publish",
            `--post_title=${title}`,
          ]);
        const handle: WordPressLabHandle = {
          id,
          snapshotDigest: snapshot.digest,
          setupDigest: canonicalDigest({ setup, images: options.images }),
          endpoint: "http://wordpress",
          networkName: resource.network,
          internalIp,
          attackerAccounts: {
            subscriber,
            ...(customer === undefined ? {} : { customer }),
          },
        };
        resource.handle = handle;
        active.set(id, resource);
        return { status: "ready", handle };
      } catch {
        if (resource !== undefined) await cleanup(resource);
        return {
          status: "incomplete",
          reason: "provision",
          nextStep:
            "Check source, pinned images, runsc, and Lab initialization; then provision a fresh Lab",
        };
      }
    },
    async seedCanaries(handle) {
      const resource = active.get(handle.id);
      if (resource === undefined || resource.handle !== handle)
        return {
          status: "incomplete",
          reason: "provision",
          nextStep: "Provision a fresh Lab before seeding canaries",
        };
      try {
        const token = nonce();
        if (!/^[A-Za-z0-9-]{1,100}$/.test(token))
          throw new Error("Invalid nonce");
        await wp(resource, ["option", "add", `wbh_canary_${token}`, token]);
        const post = await wp(resource, [
          "post",
          "create",
          "--post_status=publish",
          `--post_title=wbh-canary-${token}`,
          "--porcelain",
        ]);
        const postId = post.stdout.trim();
        if (!/^\d+$/.test(postId)) throw new Error("Canary post missing");
        await wp(resource, [
          "post",
          "meta",
          "add",
          postId,
          `wbh_canary_${token}`,
          token,
        ]);
        await requireDocker([
          "exec",
          resource.wordpress,
          "sh",
          "-c",
          `printf %s '${token}' > /var/www/html/wp-content/wbh-canary-${token}.txt`,
        ]);
        await wp(resource, [
          "user",
          "create",
          `wbh-canary-${token}`,
          `wbh-canary-${token}@example.invalid`,
          "--role=subscriber",
          `--user_pass=${randomUUID()}`,
        ]);
        const adminUser = `wbh-canary-admin-${token}`;
        await wp(resource, [
          "user",
          "create",
          adminUser,
          `${adminUser}@example.invalid`,
          "--role=administrator",
          `--user_pass=${randomUUID()}`,
        ]);
        const sqlCanary = {
          table: SQL_CANARY_TABLE,
          value: randomBytes(16).toString("hex"),
        };
        await wp(resource, [
          "db",
          "query",
          `CREATE TABLE ${sqlCanary.table} (id INT PRIMARY KEY, value CHAR(32) NOT NULL); INSERT INTO ${sqlCanary.table} VALUES (1, '${sqlCanary.value}')`,
        ]);
        const roleBaseline: Record<string, readonly string[]> = {};
        for (const account of Object.values(handle.attackerAccounts)) {
          const observed = await roles(resource, account.username);
          if (observed.status !== "roles")
            throw new Error("Role baseline unavailable");
          roleBaseline[account.username] = observed.roles;
        }
        resource.canaries = {
          nonce: token,
          adminUser,
          roleBaseline,
          sqlCanary,
          option: `wbh_canary_${token}`,
          postId,
          postMeta: `wbh_canary_${token}`,
          file: `/var/www/html/wp-content/wbh-canary-${token}.txt`,
          user: `wbh-canary-${token}`,
        };
        return { status: "seeded", digest: canonicalDigest(resource.canaries) };
      } catch {
        return {
          status: "incomplete",
          reason: "provision",
          nextStep: "Discard this Lab and seed canaries in a fresh Lab",
        };
      }
    },
    async teardown(handle) {
      const resource = active.get(handle.id);
      if (resource === undefined || resource.handle !== handle)
        return {
          status: "incomplete",
          reason: "cleanup",
          nextStep: "Inspect Lab resources and remove them before retry",
        };
      return (await cleanup(resource))
        ? { status: "removed" }
        : {
            status: "incomplete",
            reason: "cleanup",
            nextStep: "Inspect and remove remaining Lab resources",
          };
    },
    canaryLedger(handle) {
      const resource = active.get(handle.id);
      return resource?.handle === handle ? (resource.canaries ?? null) : null;
    },
    prepareExecutionCanary(handle) {
      const resource = active.get(handle.id);
      if (resource?.handle !== handle) return null;
      const token = nonce();
      if (!/^[A-Za-z0-9-]{1,100}$/.test(token)) return null;
      resource.executionNonces.add(token);
      const path = `/tmp/wbh-execution-${token}`;
      return {
        nonce: token,
        php: `<?php file_put_contents('${path}', hash('sha256', '${token}' . getenv('WBH_EXECUTION_SALT'))); ?>`,
      };
    },
    async observeSessionUser(handle, cookie) {
      const resource = active.get(handle.id);
      if (resource?.handle !== handle) return { status: "unavailable" };
      // The value travels as an environment variable, never as PHP source.
      if (!/^[A-Za-z0-9%|._@+-]{1,4096}$/.test(cookie))
        return { status: "none" };
      try {
        const result = await wp(
          resource,
          [
            "eval",
            '$id = wp_validate_auth_cookie(rawurldecode((string) getenv("WBH_SESSION_COOKIE")), "logged_in"); echo $id ? get_userdata($id)->user_login : "";',
          ],
          [`WBH_SESSION_COOKIE=${cookie}`],
        );
        const login = result.stdout.trim();
        return login === "" ? { status: "none" } : { status: "user", login };
      } catch {
        return { status: "unavailable" };
      }
    },
    async observeCanaryTable(handle) {
      const resource = active.get(handle.id);
      const canary = resource?.canaries?.sqlCanary;
      if (resource?.handle !== handle || canary === undefined)
        return { status: "unavailable" };
      try {
        const present = await wp(resource, [
          "db",
          "query",
          `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${canary.table}'`,
          "--skip-column-names",
        ]);
        if (present.stdout.trim() === "0") return { status: "changed" };
        const rows = await wp(resource, [
          "db",
          "query",
          `SELECT id, value FROM ${canary.table} ORDER BY id`,
          "--skip-column-names",
        ]);
        return {
          status:
            rows.stdout.trim() === `1\t${canary.value}` ? "intact" : "changed",
        };
      } catch {
        return { status: "unavailable" };
      }
    },
    async observeAccountRoles(handle, username) {
      const resource = active.get(handle.id);
      return resource?.handle === handle
        ? roles(resource, username)
        : { status: "unavailable" };
    },
    async observeExecution(handle) {
      const resource = active.get(handle.id);
      if (resource?.handle !== handle) return { status: "unavailable" };
      if (resource.executionNonces.size === 0)
        return { status: "not-prepared" };
      try {
        for (const token of resource.executionNonces) {
          const marker = await docker(
            ["exec", resource.wordpress, "cat", `/tmp/wbh-execution-${token}`],
            10_000,
          );
          const expected = createHash("sha256")
            .update(`${token}${resource.executionSalt}`)
            .digest("hex");
          if (marker.exitCode !== 0 || marker.stdout.trim() !== expected)
            continue;
          const found = await docker(
            [
              "exec",
              resource.wordpress,
              "grep",
              "-rlF",
              "--",
              token,
              "/var/www/html",
            ],
            30_000,
          );
          const files = found.stdout
            .split("\n")
            .filter((line) => line.startsWith("/var/www/html/"))
            .slice(0, 5)
            .map((line) => line.slice("/var/www/html/".length));
          return { status: "executed", files };
        }
        return { status: "not-executed" };
      } catch {
        return { status: "unavailable" };
      }
    },
  };
}
