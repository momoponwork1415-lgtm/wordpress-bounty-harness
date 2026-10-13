import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createWordPressLabObservations } from "./lab-observation.js";
import { STANDARD_REPRODUCER_SCRIPT } from "../verification/standard-script.js";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import { startLabContainers } from "./container-startup.js";
import {
  placeVerificationCanaries,
  seedWordPressCanaries,
} from "./canary-placement.js";
import {
  grantReadOnlyDatabaseAccess,
  initializeWordPress,
} from "./wordpress-initialization.js";
import {
  createLabHandle,
  createLabResource,
  databaseIp,
  prepareWordPressLab,
  type WordPressLabSetup,
} from "./provision-input.js";
export type {
  WordPressLabSetup,
  ParsedWordPressLabSetup,
} from "./provision-input.js";
export { WORDPRESS_CORE_IDENTITY } from "./provision-input.js";
import type { ExpectedSourceTree } from "../../../infrastructure/canonical-source-tree.js";
import { runNativeModelProcess } from "../../../infrastructure/native-model-process.js";
import type {
  LabHandle,
  LabProvisioner,
  LabReachability,
  ProvisionResult,
} from "../../../lab/index.js";
import type { Snapshot } from "../../../snapshot/index.js";

const pinnedImage = z.string().regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/);
export {
  wordpressVisitPathSchema,
  wordpressVictimRouteSchema,
} from "./lab-observation.js";
import type { WordPressVictimRoute } from "./lab-observation.js";
export type { WordPressVictimRoute } from "./lab-observation.js";

export type DockerRequest = {
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
};
export type DockerResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};
class LabDockerFailure extends Error {
  constructor(readonly diagnostic: string) {
    super("gVisor Lab command failed");
  }
}
class MissingWordPressExtension extends Error {
  constructor() {
    super("The WordPress Lab image is missing pdo_mysql");
  }
}
export interface DockerRunner {
  run(request: DockerRequest): Promise<DockerResult>;
}

export type WordPressSource =
  | {
      readonly kind: "plugin";
      readonly pluginSlug: string;
      readonly sourceDirectory: string;
      readonly sourceTree: ExpectedSourceTree;
    }
  | {
      readonly kind: "wordpress-core";
      readonly version: string;
      readonly sourceDirectory: string;
      readonly sourceTree: ExpectedSourceTree;
    };
export interface WordPressSourceResolver {
  resolve(snapshot: Snapshot): Promise<{
    readonly target: WordPressSource;
    readonly dependencies: readonly WordPressSource[];
  }>;
}

export interface WordPressLabHandle extends LabHandle {
  /** Non-secret ordinary locale setting for prerequisite matching. */
  readonly secondaryLocale?: string;
  readonly networkName: string;
  readonly internalIp: string;
  /** Verifier traffic passes through this Lab-local recorder. */
  readonly recorderIp: string;
  readonly database?: {
    readonly host: "database";
    readonly ipv4: string;
    readonly port: 3306;
    readonly name: "wordpress";
    readonly readOnlyAccount: {
      readonly username: "wbh_reader";
      readonly password: string;
    };
  };
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
  /** Files outside wp-content at fixed paths; only their values are secret. */
  readonly fileCanaries: readonly WordPressFileCanary[];
  /** Verification-only protected objects; never mounted into a discovery Lab. */
  readonly sensitiveCanaries: readonly WordPressSensitiveCanary[];
}

export const WORDPRESS_SENSITIVE_OBJECT_KINDS_V1 = [
  "private-post",
  "other-user-meta",
] as const;
export type WordPressSensitiveObjectKind =
  (typeof WORDPRESS_SENSITIVE_OBJECT_KINDS_V1)[number];
export interface WordPressSensitiveCanary {
  readonly kind: WordPressSensitiveObjectKind;
  readonly objectId: string;
  readonly value: string;
}

export interface ScriptCanary {
  readonly nonce: string;
  readonly beaconUrl: string;
  /** Exact browser code for the nonce-bound POST; stays in Private Evidence. */
  readonly javascript: string;
  /** Short code for constrained surfaces; the module sends the same POST. */
  readonly loaderJavascript: string;
}

export type WordPressScriptContext =
  "front" | "admin-all" | "admin-partial" | "route-page" | "victim-route-page";

/** Bounded observer diagnostic; never includes a visited path or browser output. */
export type WordPressStoredScriptFailurePhase =
  | "lab"
  | "route-input"
  | "victim-input"
  | "front"
  | "dashboard"
  | "posts"
  | "route-page"
  | "victim-page";

export type WordPressStoredScriptObservation =
  | {
      readonly status: "observed";
      readonly contexts: readonly WordPressScriptContext[];
      /** Actual Lab browser principal when a declared victim page fired. */
      readonly victimRole?:
        | "administrator"
        | "subscriber"
        | "customer"
        | "unauthenticated"
        | "self";
      /** First page whose visit delivered an issued canary; stays in Private Evidence. */
      readonly screenshot?: Buffer;
    }
  | { readonly status: "not-prepared" }
  | {
      readonly status: "unavailable";
      /** Optional for callers created before phase diagnostics were added. */
      readonly phase?: WordPressStoredScriptFailurePhase;
    };

export type WordPressOptionsObservation =
  | { readonly status: "observed"; readonly changed: readonly string[] }
  | { readonly status: "unavailable" };

export interface WordPressFileCanary {
  /** Different directory and extension, so reaching both shows full path control. */
  readonly kind: "outside-webroot" | "php-source";
  readonly path: string;
  readonly value: string;
}

export type WordPressCanaryFilesObservation =
  | {
      readonly status: "observed";
      readonly deleted: readonly WordPressFileCanary["kind"][];
    }
  | { readonly status: "unavailable" };

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

/** Private requests are passed over stdin to a short-lived runner in the Lab recorder. */
export type ReplayHttpInput = {
  readonly steps: readonly {
    readonly method: string;
    readonly path: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly bindingsAfter?: readonly {
      readonly name: string;
      readonly left: string;
      readonly right: string;
      readonly pattern?: string;
      readonly occurrence?: "unique" | "last";
    }[];
  }[];
  readonly initialBindings: Readonly<Record<string, string>>;
};

export type ReplayHttpResult =
  | { readonly status: "completed"; readonly completedSteps: number }
  | {
      readonly status: "incomplete";
      readonly completedSteps: number;
      readonly reason:
        | "invalid-input"
        | "missing-binding"
        | "ambiguous-binding"
        | "binding-pattern"
        | "request-failed"
        | "response-too-large";
    }
  | { readonly status: "unavailable" };

export interface WordPressLab extends LabProvisioner<
  WordPressLabSetup,
  WordPressLabHandle
> {
  probe(handle: WordPressLabHandle): Promise<LabReachability>;
  markCapture(handle: WordPressLabHandle): Promise<string | null>;
  readCapture(
    handle: WordPressLabHandle,
    sinceMarker: string,
  ): Promise<
    | {
        readonly status: "captured";
        readonly bytes: Buffer;
        readonly dropped: number;
      }
    | { readonly status: "unavailable" }
  >;
  /** Executes only the Harness-owned standard script in an isolated Lab peer. */
  runStandardScript(
    handle: WordPressLabHandle,
    input: string,
  ): Promise<
    | { readonly status: "completed"; readonly output: string }
    | { readonly status: "unavailable" }
  >;
  /** Review-only credential, never part of the attacker/Verifier handle. */
  reviewAdministrator(
    handle: WordPressLabHandle,
  ): { readonly username: "harness-admin"; readonly password: string } | null;
  /** Review-only receiver address for a human-operated browser in the Lab network. */
  reviewReceiverIp(handle: WordPressLabHandle): string | null;
  replayHttp(
    handle: WordPressLabHandle,
    input: ReplayHttpInput,
  ): Promise<ReplayHttpResult>;
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
    scheme?: "logged_in" | "auth" | "secure_auth",
  ): Promise<WordPressSessionObservation>;
  /** Compares the SQL canary table with the row seeded into it. */
  observeCanaryTable(
    handle: WordPressLabHandle,
  ): Promise<WordPressCanaryTableObservation>;
  /** Reports which seeded canary files no longer exist. */
  observeCanaryFiles(
    handle: WordPressLabHandle,
  ): Promise<WordPressCanaryFilesObservation>;
  /** Issues a nonce whose beacon URL a stored script would request from inside the Lab. */
  prepareScriptCanary(handle: WordPressLabHandle): ScriptCanary | null;
  /** Harness-owned issued script nonces for comparing a captured route across Labs. */
  issuedScriptNonces(handle: WordPressLabHandle): readonly string[] | null;
  /**
   * Opens the front page, two admin screens and the route's pages in fresh
   * browsers; a context counts only when the receiver logged an issued nonce.
   */
  observeStoredScript(
    handle: WordPressLabHandle,
    input: {
      readonly routePaths: readonly string[];
      readonly victim?: WordPressVictimRoute;
    },
  ): Promise<WordPressStoredScriptObservation>;
  /** Names of watched options (canary and critical) that differ from the seeded baseline. */
  observeOptions(
    handle: WordPressLabHandle,
  ): Promise<WordPressOptionsObservation>;
  /** Reads an account's current roles inside the Lab. */
  observeAccountRoles(
    handle: WordPressLabHandle,
    username: string,
  ): Promise<WordPressRoleObservation>;
  /**
   * Lists Docker resources a crashed run left behind: Lab names and the given
   * patterns only. Removes them when asked; use only while no campaign runs.
   */
  cleanupLeftovers(input: {
    readonly remove: boolean;
    readonly patterns?: LeftoverPatterns;
  }): Promise<Leftovers>;
}

export type LeftoverPatterns = {
  readonly containers?: readonly RegExp[];
  readonly networks?: readonly RegExp[];
  readonly volumes?: readonly RegExp[];
};
export type Leftovers = {
  readonly containers: readonly string[];
  readonly networks: readonly string[];
  readonly volumes: readonly string[];
};

const labId = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const LAB_LEFTOVERS = {
  containers: [new RegExp(`^wbh-${labId}-(?:db|wp|canary|proxy)$`)],
  networks: [new RegExp(`^wbh-${labId}-net$`)],
  volumes: [new RegExp(`^wbh-${labId}-site$`)],
} as const;

export interface Resources {
  readonly id: string;
  readonly network: string;
  readonly volume: string;
  readonly database: string;
  readonly wordpress: string;
  readonly recorder: string;
  readonly databasePassword: string;
  readonly readerPassword: string;
  readonly adminPassword: string;
  /** Verification-only browser accounts, never included in the attacker handle. */
  readonly victimAccounts: Readonly<{
    subscriber?: { readonly username: string; readonly password: string };
    customer?: { readonly username: string; readonly password: string };
  }>;
  readonly administratorSecondaryLocale?: string;
  /** Only the WordPress container's environment holds this. */
  readonly executionSalt: string;
  handle?: WordPressLabHandle;
  canaries?: WordPressCanaryLedger;
  sensitiveCanaries: WordPressSensitiveCanary[];
  /** Option digests taken when canaries were seeded. */
  optionBaseline?: ReadonlyMap<string, string>;
  executionNonces: Set<string>;
  scriptNonces: Set<string>;
  /** Beacon receiver container; only the Lab reads what it logged. */
  readonly receiver: string;
  receiverIp?: string;
  /** gVisor containers cannot use Docker's name resolution, so WordPress gets this address. */
  databaseIp?: string;
  receiverCreated: boolean;
  networkCreated: boolean;
  volumeCreated: boolean;
  databaseCreated: boolean;
  wordpressCreated: boolean;
  recorderCreated: boolean;
}

export function openWordPressLab(options: {
  readonly dockerExecutablePath: string;
  readonly images: {
    readonly database: string;
    readonly wordpress: string;
    readonly wordpressCli: string;
    /** Playwright Chromium, used only by the Lab's own observer visits. */
    readonly browser: string;
    readonly recorder: string;
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
        ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
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
    maxOutputBytes = 64 * 1024,
    stdin?: string,
  ): Promise<DockerResult> =>
    runner.run({
      args,
      timeoutMs,
      maxOutputBytes,
      ...(stdin === undefined ? {} : { stdin }),
    });
  const requireDocker = async (
    args: readonly string[],
    timeoutMs?: number,
  ): Promise<DockerResult> => {
    const result = await docker(args, timeoutMs);
    if (result.exitCode !== 0)
      throw new LabDockerFailure(
        result.stderr ||
          result.stdout ||
          `Docker command exited with status ${result.exitCode}`,
      );
    return result;
  };
  const wpCommand = (
    resource: Resources,
    args: readonly string[],
    environment: readonly string[] = [],
  ): readonly string[] => [
    "run",
    "--rm",
    "--runtime=runsc",
    "--network",
    resource.network,
    "--security-opt=no-new-privileges",
    // The Apache image owns the shared WordPress volume as UID/GID 33;
    // the CLI image's www-data is UID/GID 82 and cannot create uploads.
    "--user=33:33",
    ...environment.flatMap((entry) => ["--env", entry]),
    "--env",
    `WORDPRESS_DB_HOST=${databaseIp(resource)}`,
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
  ];
  const wp = (
    resource: Resources,
    args: readonly string[],
    environment: readonly string[] = [],
  ): Promise<DockerResult> =>
    requireDocker(wpCommand(resource, args, environment));
  /** Digest of an option as WP-CLI prints it; a missing option has its own marker. */
  const optionDigest = async (
    resource: Resources,
    name: string,
  ): Promise<string> => {
    const result = await docker(
      wpCommand(resource, ["option", "get", name, "--format=json"]),
    );
    if (result.exitCode === 1) return "absent";
    if (result.exitCode !== 0) throw new Error("Option unreadable");
    return createHash("sha256").update(result.stdout.trim()).digest("hex");
  };
  const cleanup = async (resource: Resources): Promise<boolean> => {
    let okay = true;
    for (const args of [
      ...(resource.wordpressCreated ||
      resource.databaseCreated ||
      resource.receiverCreated ||
      resource.recorderCreated
        ? [
            [
              "rm",
              "--force",
              ...[
                resource.wordpressCreated ? resource.wordpress : undefined,
                resource.databaseCreated ? resource.database : undefined,
                resource.receiverCreated ? resource.receiver : undefined,
                resource.recorderCreated ? resource.recorder : undefined,
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
    async replayHttp(handle, input) {
      const resource = active.get(handle.id);
      if (resource?.handle !== handle) return { status: "unavailable" };
      const serialized = JSON.stringify(input);
      if (Buffer.byteLength(serialized) > 12 * 1024 * 1024)
        return { status: "unavailable" };
      const result = await docker(
        [
          "exec",
          "-i",
          resource.recorder,
          "node",
          "/opt/wbh-recorder/replay-cli.js",
        ],
        180_000,
        4096,
        serialized,
      );
      if (result.exitCode !== 0 && result.exitCode !== 1)
        return { status: "unavailable" };
      let output: unknown;
      try {
        output = JSON.parse(result.stdout) as unknown;
      } catch {
        return { status: "unavailable" };
      }
      const parsed = z
        .discriminatedUnion("status", [
          z.strictObject({
            status: z.literal("completed"),
            completedSteps: z.number().int().nonnegative(),
          }),
          z.strictObject({
            status: z.literal("incomplete"),
            completedSteps: z.number().int().nonnegative(),
            reason: z.enum([
              "invalid-input",
              "missing-binding",
              "ambiguous-binding",
              "binding-pattern",
              "request-failed",
              "response-too-large",
            ]),
          }),
        ])
        .safeParse(output);
      if (
        !parsed.success ||
        (result.exitCode === 0) !== (parsed.data.status === "completed")
      )
        return { status: "unavailable" };
      return parsed.data;
    },
    async cleanupLeftovers({ remove, patterns = {} }) {
      const kinds = [
        ["containers", ["ps", "-a", "--format", "{{.Names}}"], ["rm", "-f"]],
        [
          "networks",
          ["network", "ls", "--format", "{{.Name}}"],
          ["network", "rm"],
        ],
        [
          "volumes",
          ["volume", "ls", "--format", "{{.Name}}"],
          ["volume", "rm"],
        ],
      ] as const;
      const found: Record<(typeof kinds)[number][0], string[]> = {
        containers: [],
        networks: [],
        volumes: [],
      };
      for (const [kind, list] of kinds) {
        const owned = [...LAB_LEFTOVERS[kind], ...(patterns[kind] ?? [])];
        found[kind] = (await requireDocker(list)).stdout
          .split("\n")
          .map((name) => name.trim())
          .filter((name) => owned.some((pattern) => pattern.test(name)));
      }
      // Containers go first so their networks and volumes are no longer in use.
      if (remove)
        for (const [kind, , removal] of kinds)
          if (found[kind].length > 0)
            await requireDocker([...removal, ...found[kind]]);
      return found;
    },
    async provision(
      candidateSnapshot,
      candidateSetup,
      context,
    ): Promise<ProvisionResult<WordPressLabHandle>> {
      let resource: Resources | undefined;
      try {
        const prepared = await prepareWordPressLab(
          candidateSnapshot,
          candidateSetup,
          options.source,
        );
        const { setup, scenario, target, dependencies, coreVersion } = prepared;
        await preflight();
        const created = createLabResource(
          prepared,
          context?.purpose === "verification",
        );
        resource = created.resource;
        const { subscriber, customer, victimSubscriber, victimCustomer } =
          created;
        const { id } = resource;
        const { internalIp, recorderIp } = await startLabContainers(resource, {
          images: options.images,
          attempts,
          docker,
          requireDocker,
        });
        // Probe the running runsc image before installing the target plugin.
        // PHP exits 43 only when the required extension is absent.
        const extension = await docker([
          "exec",
          resource.wordpress,
          "php",
          "-r",
          'exit(extension_loaded("pdo_mysql") ? 0 : 43);',
        ]);
        if (extension.exitCode === 43) throw new MissingWordPressExtension();
        if (extension.exitCode !== 0)
          throw new LabDockerFailure(
            extension.stderr || "WordPress PHP extension probe failed",
          );
        await initializeWordPress({
          resource,
          setup,
          scenario,
          coreVersion,
          target,
          dependencies,
          subscriber,
          ...(customer === undefined ? {} : { customer }),
          ...(victimSubscriber === undefined ? {} : { victimSubscriber }),
          ...(victimCustomer === undefined ? {} : { victimCustomer }),
          wp,
          requireDocker,
        });
        if (context?.purpose === "verification")
          await placeVerificationCanaries(resource, wp);
        if (setup.databaseAccess === "read-only")
          await grantReadOnlyDatabaseAccess(resource, requireDocker);
        const handle = createLabHandle({
          prepared,
          resource,
          images: options.images,
          internalIp,
          recorderIp,
          subscriber,
          customer,
        });
        resource.handle = handle;
        active.set(id, resource);
        return { status: "ready", handle };
      } catch (error: unknown) {
        if (resource !== undefined) await cleanup(resource);
        return {
          status: "incomplete",
          reason:
            error instanceof MissingWordPressExtension
              ? "precondition"
              : "provision",
          nextStep:
            error instanceof MissingWordPressExtension ||
            (error instanceof Error &&
              error.message === "The Lab image runs another WordPress version")
              ? error.message
              : "Check source, pinned images, runsc, and Lab initialization; then provision a fresh Lab",
          ...(error instanceof LabDockerFailure && error.diagnostic
            ? { diagnostic: error.diagnostic }
            : {}),
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
        const seededDigest = await seedWordPressCanaries({
          resource,
          handle,
          nonce,
          wp,
          requireDocker,
          roles,
          optionDigest,
        });
        return { status: "seeded", digest: seededDigest };
      } catch (error: unknown) {
        return {
          status: "incomplete",
          reason: "provision",
          nextStep: "Discard this Lab and seed canaries in a fresh Lab",
          ...(error instanceof LabDockerFailure && error.diagnostic
            ? { diagnostic: error.diagnostic }
            : {}),
        };
      }
    },
    async runStandardScript(handle, input) {
      const resource = active.get(handle.id);
      if (
        resource?.handle !== handle ||
        Buffer.byteLength(STANDARD_REPRODUCER_SCRIPT) > 64 * 1024 ||
        Buffer.byteLength(input) > 128 * 1024
      )
        return { status: "unavailable" };
      const directory = await mkdtemp(join(tmpdir(), "wbh-reproduction-"));
      try {
        await Promise.all([
          writeFile(
            join(directory, "standard-reproduce.py"),
            STANDARD_REPRODUCER_SCRIPT,
            {
              mode: 0o600,
            },
          ),
          writeFile(join(directory, "input.json"), input, { mode: 0o600 }),
        ]);
        const result = await docker(
          [
            "run",
            "--rm",
            "--runtime=runsc",
            "--network",
            resource.network,
            "--add-host",
            `wordpress:${handle.recorderIp}`,
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--pids-limit=64",
            "--memory=256m",
            "--mount",
            `type=bind,src=${directory},dst=/run/wbh-reproduction,readonly`,
            options.images.browser,
            "python3",
            "/run/wbh-reproduction/standard-reproduce.py",
          ],
          90_000,
          128 * 1024,
        );
        return result.exitCode === 0
          ? { status: "completed", output: result.stdout }
          : { status: "unavailable" };
      } catch {
        return { status: "unavailable" };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    reviewAdministrator(handle) {
      const resource = active.get(handle.id);
      return resource?.handle === handle
        ? { username: "harness-admin", password: resource.adminPassword }
        : null;
    },
    reviewReceiverIp(handle) {
      const resource = active.get(handle.id);
      return resource?.handle === handle ? (resource.receiverIp ?? null) : null;
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
    ...createWordPressLabObservations({
      active,
      docker,
      wp,
      roles,
      optionDigest,
      nonce,
      images: options.images,
    }),
  };
}
