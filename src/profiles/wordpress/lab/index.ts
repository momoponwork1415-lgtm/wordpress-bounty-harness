import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import { canonicalDigest } from "../../../infrastructure/canonical-json.js";
import {
  forgetLabOwners,
  readLabOwners,
  recordLabOwner,
  type LabOwnerRecord,
} from "../../../infrastructure/lab-owner-record.js";
import type { HttpCaptureRead } from "../../../lab/capture.js";
import type {
  LabProvisioner,
  LabReachability,
  ProvisionResult,
} from "../../../lab/index.js";
import {
  closeWordPressSetup,
  placeVerificationCanaries,
  seedWordPressCanaries,
} from "./canary-placement.js";
import { startLabContainers } from "./container-startup.js";
import type {
  ExecutionCanary,
  Leftovers,
  LeftoverPatterns,
  ScriptCanary,
  WordPressCanaryFilesObservation,
  WordPressCanaryLedger,
  WordPressCanaryTableObservation,
  WordPressExecutionObservation,
  WordPressLabHandle,
  WordPressOptionsObservation,
  WordPressRoleObservation,
  WordPressSessionObservation,
  WordPressSourceResolver,
  WordPressStoredScriptObservation,
} from "./contract.js";
import {
  exposeWordPressLabToHost,
  withdrawWordPressLabFromHost,
  type HostExposure,
} from "./host-exposure.js";
import {
  createLabDocker,
  LabDockerFailure,
  nativeDockerRunner,
  type DockerRunner,
} from "./lab-docker.js";
import * as observe from "./lab-observation.js";
import type { WordPressVictimRoute } from "./lab-observation.js";
import {
  DATABASE_NAME,
  READ_ONLY_DATABASE_USER,
  WordPressLabSession,
  type LabImages,
} from "./lab-session.js";
import {
  prepareWordPressLab,
  type PreparedWordPressLab,
  type WordPressLabSetup,
} from "./provision-input.js";
import { STANDARD_REPRODUCER_SCRIPT } from "./standard-script.js";
import {
  captureWordPressLabState,
  type WordPressLabState,
} from "./state-capture.js";
import {
  grantReadOnlyDatabaseAccess,
  initializeWordPress,
} from "./wordpress-initialization.js";

export type * from "./contract.js";
export { WORDPRESS_SENSITIVE_OBJECT_KINDS_V1 } from "./contract.js";
export type {
  DockerRequest,
  DockerResult,
  DockerRunner,
} from "./lab-docker.js";
export type {
  WordPressLabState,
  WordPressLabStateDiff,
} from "./state-capture.js";
export {
  diffWordPressLabState,
  wordpressLabStateDiffSchema,
  wordpressLabStateSchema,
} from "./state-capture.js";
export { hostGatewayName, type HostExposure } from "./host-exposure.js";
export type {
  WordPressLabSetup,
  ParsedWordPressLabSetup,
} from "./provision-input.js";
export { WORDPRESS_CORE_IDENTITY } from "./provision-input.js";
export {
  wordpressVisitPathSchema,
  wordpressVictimRouteSchema,
  type WordPressVictimRoute,
} from "./lab-observation.js";
/** Name the plugin-specific adapters (removed in #353) use for the Lab they run against. */
export type Resources = WordPressLabSession;

const pinnedImage = z.string().regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/);

class MissingWordPressExtension extends Error {
  constructor() {
    super("The WordPress Lab image is missing pdo_mysql");
  }
}

export interface WordPressLab extends LabProvisioner<
  WordPressLabSetup,
  WordPressLabHandle
> {
  probe(handle: WordPressLabHandle): Promise<LabReachability>;
  markCapture(handle: WordPressLabHandle): Promise<string | null>;
  /** The recorder's exchanges since `sinceMarker`, parsed, with the bytes for evidence. */
  readCapture(
    handle: WordPressLabHandle,
    sinceMarker: string,
  ): Promise<HttpCaptureRead>;
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
  /**
   * Ends handoff precondition setup (#430): revokes the setup administrator
   * and the canary principals, then retakes the role and option baselines.
   * False when the Lab cannot, or when setup moved the SQL or file canaries.
   */
  finishSetup(handle: WordPressLabHandle): Promise<boolean>;
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
   * Reads the whole site state (options, users with roles, per-table row counts
   * and checksums) from the Lab's own database (#186). Review material only.
   */
  captureState(
    handle: WordPressLabHandle,
  ): Promise<
    | { readonly status: "captured"; readonly state: WordPressLabState }
    | { readonly status: "unavailable" }
  >;
  /**
   * Publishes the Lab on host loopback ports for a human's browser and curl.
   * Port 0 takes a free port; the result names the ports actually bound (#432).
   */
  exposeToHost(
    handle: WordPressLabHandle,
    input: {
      readonly httpPort: number;
      readonly databasePort?: number;
      /** `recorder` captures the host's HTTP like a Verifier's (handoff, #352). */
      readonly via?: "wordpress" | "recorder";
    },
  ): Promise<HostExposure>;
  /** Removes the `exposeToHost` gateway before teardown; true when it is gone. */
  withdrawFromHost(handle: WordPressLabHandle): Promise<boolean>;
  /**
   * Lists Docker resources a crashed run left behind: Lab names and the given
   * patterns only. Removes them when asked; use only while no campaign runs.
   * With `labId`, only that Lab's resources (and its host gateway) are named.
   * With `labs: false`, only the given patterns are named, so a live Lab is
   * never touched (the runner's discovery sweep, #526).
   */
  cleanupLeftovers(input: {
    readonly remove: boolean;
    readonly patterns?: LeftoverPatterns;
    readonly labId?: string;
    readonly labs?: boolean;
  }): Promise<Leftovers>;
}

const labId = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const labLeftoverPatterns = (id: string) =>
  ({
    containers: [new RegExp(`^wbh-${id}-(?:db|wp|canary|proxy|host)$`)],
    networks: [new RegExp(`^wbh-${id}-net$`)],
    volumes: [new RegExp(`^wbh-${id}-site$`)],
  }) as const;
const LAB_LEFTOVERS = labLeftoverPatterns(labId);
const exactLabId = new RegExp(`^${labId}$`);
const labOfResource = new RegExp(`^wbh-(${labId})-`);

/** The handle hands the Verifier only what it may use; the session keeps the rest. */
function issueHandle(input: {
  readonly lab: WordPressLabSession;
  readonly prepared: PreparedWordPressLab;
  readonly images: LabImages;
  readonly internalIp: string;
  readonly recorderIp: string;
}): WordPressLabHandle {
  const { lab, prepared, images, internalIp, recorderIp } = input;
  const { setup, snapshot } = prepared;
  return {
    id: lab.id,
    snapshotDigest: snapshot.digest,
    setupDigest: canonicalDigest({ setup, images }),
    ...(setup.scenario === undefined ? {} : { scenario: setup.scenario }),
    ...(lab.administratorSecondaryLocale === undefined
      ? {}
      : { secondaryLocale: lab.administratorSecondaryLocale }),
    endpoint: "http://wordpress",
    networkName: lab.network,
    internalIp,
    recorderIp,
    attackerAccounts: lab.attackerAccounts,
    ...(setup.databaseAccess === "read-only"
      ? {
          database: {
            host: "database" as const,
            ipv4: lab.databaseAddress(),
            port: 3306 as const,
            name: DATABASE_NAME,
            readOnlyAccount: {
              username: READ_ONLY_DATABASE_USER,
              password: lab.readerPassword,
            },
          },
        }
      : {}),
  };
}

export function openWordPressLab(options: {
  readonly dockerExecutablePath: string;
  readonly images: LabImages;
  readonly source: WordPressSourceResolver;
  readonly runner?: DockerRunner;
  readonly nonce?: () => string;
  readonly healthAttempts?: number;
  /** Dependency injection for isolated Lab tests; hosts use the one shared path. */
  readonly ownerDirectory?: string;
}): WordPressLab {
  if (!isAbsolute(options.dockerExecutablePath))
    throw new Error("Docker executable path must be absolute");
  for (const image of Object.values(options.images)) pinnedImage.parse(image);
  const attempts = options.healthAttempts ?? 60;
  if (!Number.isSafeInteger(attempts) || attempts < 1)
    throw new Error("Invalid health attempt count");
  const nonce = options.nonce ?? randomUUID;
  const docker = createLabDocker(
    options.runner ?? nativeDockerRunner(options.dockerExecutablePath),
  );
  const active = new Map<string, WordPressLabSession>();
  /** One owner record per live Lab of this process; there is no host-wide slot (#432). */
  const owners = new Map<string, LabOwnerRecord>();
  /** The one place a handle is checked: only the exact issued object reaches its Lab. */
  const sessionFor = (
    handle: WordPressLabHandle,
  ): WordPressLabSession | undefined => {
    const lab = active.get(handle.id);
    return lab?.owns(handle) ? lab : undefined;
  };
  const preflight = async (): Promise<void> => {
    const runtimes = await docker.run(
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
      await docker.require(["image", "inspect", image], 30_000);
  };
  const cleanupLeftovers: WordPressLab["cleanupLeftovers"] = async ({
    remove,
    patterns = {},
    labId: onlyLab,
    labs = true,
  }) => {
    if (onlyLab !== undefined && !exactLabId.test(onlyLab))
      throw new Error("Lab id is invalid");
    const owned: LeftoverPatterns = !labs
      ? {}
      : onlyLab === undefined
        ? LAB_LEFTOVERS
        : labLeftoverPatterns(onlyLab);
    const kinds = [
      ["containers", ["ps", "-a", "--format", "{{.Names}}"], ["rm", "-f"]],
      [
        "networks",
        ["network", "ls", "--format", "{{.Name}}"],
        ["network", "rm"],
      ],
      ["volumes", ["volume", "ls", "--format", "{{.Name}}"], ["volume", "rm"]],
    ] as const;
    const found: Record<(typeof kinds)[number][0], string[]> = {
      containers: [],
      networks: [],
      volumes: [],
    };
    for (const [kind, list] of kinds) {
      const matching = [...(owned[kind] ?? []), ...(patterns[kind] ?? [])];
      // A host with thousands of anonymous volumes lists far more than the 64 KiB default.
      const listing = await docker.run(list, 60_000, 8 * 1024 * 1024);
      if (listing.exitCode !== 0)
        throw new LabDockerFailure(
          listing.stderr ||
            `Docker command exited with status ${listing.exitCode}`,
        );
      found[kind] = listing.stdout
        .split("\n")
        .map((name) => name.trim())
        .filter((name) => matching.some((pattern) => pattern.test(name)));
    }
    // Read after listing: a Lab records its owner before its first resource exists.
    const { live, dead } =
      onlyLab === undefined || remove
        ? await readLabOwners(options.ownerDirectory)
        : { live: new Set<string>(), dead: new Set<string>() };
    if (onlyLab === undefined)
      for (const [kind] of kinds)
        found[kind] = found[kind].filter((name) => {
          const owner = labOfResource.exec(name)?.[1];
          return owner === undefined || !live.has(owner);
        });
    // Containers go first so their networks and volumes are no longer in use.
    if (remove) {
      for (const [kind, , removal] of kinds)
        if (found[kind].length > 0)
          await docker.require([...removal, ...found[kind]]);
      await forgetLabOwners(
        onlyLab === undefined ? dead : [...dead].filter((id) => id === onlyLab),
        options.ownerDirectory,
      );
    }
    return found;
  };
  return {
    cleanupLeftovers,
    async provision(
      candidateSnapshot,
      candidateSetup,
      context,
    ): Promise<ProvisionResult<WordPressLabHandle>> {
      let lab: WordPressLabSession | undefined;
      let owner: LabOwnerRecord | undefined;
      try {
        const prepared = await prepareWordPressLab(
          candidateSnapshot,
          candidateSetup,
          options.source,
        );
        const { setup, phpVersion } = prepared;
        await preflight();
        const secondaryLocale =
          setup.translatePress?.administratorSecondaryLocale ??
          prepared.scenario?.secondaryLocale ??
          undefined;
        lab = new WordPressLabSession({
          docker,
          images: options.images,
          nonce,
          customerRole: setup.customerRole,
          forVerification: context?.purpose === "verification",
          ...(secondaryLocale === undefined ? {} : { secondaryLocale }),
        });
        // Any number of Labs may run at once; this only keeps broad cleanups off this one.
        owner = await recordLabOwner({
          labId: lab.id,
          ...(options.ownerDirectory === undefined
            ? {}
            : { directory: options.ownerDirectory }),
        });
        const { internalIp, recorderIp } = await startLabContainers(
          lab,
          attempts,
        );
        // Probe the running runsc image before installing the target plugin.
        // PHP exits 43 only when the required extension is absent.
        const extension = await lab.docker([
          "exec",
          lab.wordpress,
          "php",
          "-r",
          'exit(extension_loaded("pdo_mysql") ? 0 : 43);',
        ]);
        if (extension.exitCode === 43) throw new MissingWordPressExtension();
        if (extension.exitCode !== 0)
          throw new LabDockerFailure(
            extension.stderr || "WordPress PHP extension probe failed",
          );
        if (phpVersion !== undefined) {
          const runningPhp = await lab.docker([
            "exec",
            lab.wordpress,
            "php",
            "-r",
            "echo PHP_VERSION;",
          ]);
          if (
            runningPhp.exitCode !== 0 ||
            runningPhp.stdout.trim() !== phpVersion
          )
            throw new Error(
              "The Lab runs another PHP version than the frozen source",
            );
        }
        await initializeWordPress(lab, prepared);
        if (context?.purpose === "verification")
          await placeVerificationCanaries(lab);
        if (setup.databaseAccess === "read-only")
          await grantReadOnlyDatabaseAccess(lab);
        const handle = issueHandle({
          lab,
          prepared,
          images: options.images,
          internalIp,
          recorderIp,
        });
        lab.bind(handle);
        active.set(lab.id, lab);
        owners.set(lab.id, owner);
        owner = undefined;
        return { status: "ready", handle };
      } catch (error: unknown) {
        // A Lab that failed to provision is no longer used; whatever remains is a leftover.
        if (lab !== undefined) await lab.cleanup();
        await owner?.release();
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
      const lab = sessionFor(handle);
      if (lab === undefined)
        return {
          status: "incomplete",
          reason: "provision",
          nextStep: "Provision a fresh Lab before seeding canaries",
        };
      try {
        return { status: "seeded", digest: await seedWordPressCanaries(lab) };
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
      const lab = sessionFor(handle);
      if (
        lab === undefined ||
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
        const result = await lab.docker(
          [
            "run",
            "--rm",
            "--runtime=runsc",
            "--network",
            lab.network,
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
      const lab = sessionFor(handle);
      return lab === undefined
        ? null
        : { username: "harness-admin", password: lab.adminPassword };
    },
    reviewReceiverIp(handle) {
      return sessionFor(handle)?.receiverIp ?? null;
    },
    async finishSetup(handle) {
      const lab = sessionFor(handle);
      if (lab === undefined) return false;
      try {
        // No baseline can restore a seeded value; a moved one ends the attempt.
        const table = await observe.observeCanaryTable(lab);
        const files = await observe.observeCanaryFiles(lab);
        if (
          table.status !== "intact" ||
          files.status !== "observed" ||
          files.deleted.length > 0
        )
          return false;
        await closeWordPressSetup(lab);
        return true;
      } catch {
        return false;
      }
    },
    async teardown(handle) {
      const lab = sessionFor(handle);
      if (lab === undefined)
        return {
          status: "incomplete",
          reason: "cleanup",
          nextStep: "Inspect Lab resources and remove them before retry",
        };
      try {
        if (!(await lab.cleanup()))
          return {
            status: "incomplete",
            reason: "cleanup",
            nextStep: "Inspect and remove remaining Lab resources",
          };
        active.delete(lab.id);
        return { status: "removed" };
      } finally {
        // The owner is done with this Lab; what a failed cleanup left is a leftover.
        await owners.get(lab.id)?.release();
        owners.delete(lab.id);
      }
    },
    async captureState(handle) {
      const lab = sessionFor(handle);
      if (lab === undefined) return { status: "unavailable" };
      try {
        return {
          status: "captured",
          state: await captureWordPressLabState(lab, () => new Date()),
        };
      } catch {
        return { status: "unavailable" };
      }
    },
    async exposeToHost(handle, input) {
      const lab = sessionFor(handle);
      if (lab === undefined)
        return {
          status: "unavailable",
          diagnostic: "The Lab is not active in this process",
        };
      return exposeWordPressLabToHost(lab, {
        image: options.images.recorder,
        httpPort: input.httpPort,
        ...(input.databasePort === undefined
          ? {}
          : { databasePort: input.databasePort }),
        ...(input.via === undefined ? {} : { via: input.via }),
      });
    },
    async withdrawFromHost(handle) {
      const lab = sessionFor(handle);
      return lab === undefined ? false : withdrawWordPressLabFromHost(lab);
    },
    async markCapture(handle) {
      const lab = sessionFor(handle);
      return lab === undefined ? null : observe.markCapture(lab);
    },
    async readCapture(handle, sinceMarker) {
      const lab = sessionFor(handle);
      return lab === undefined
        ? { status: "unavailable" }
        : observe.readCapture(lab, sinceMarker);
    },
    async probe(handle) {
      const lab = sessionFor(handle);
      return lab === undefined
        ? observe.labUnreachable(handle)
        : observe.probe(lab);
    },
    canaryLedger(handle) {
      return sessionFor(handle)?.canaries ?? null;
    },
    prepareExecutionCanary(handle) {
      const lab = sessionFor(handle);
      return lab === undefined ? null : observe.prepareExecutionCanary(lab);
    },
    async observeSessionUser(handle, cookie, scheme) {
      const lab = sessionFor(handle);
      return lab === undefined
        ? { status: "unavailable" }
        : observe.observeSessionUser(lab, cookie, scheme);
    },
    async observeCanaryTable(handle) {
      const lab = sessionFor(handle);
      return lab === undefined
        ? { status: "unavailable" }
        : observe.observeCanaryTable(lab);
    },
    async observeCanaryFiles(handle) {
      const lab = sessionFor(handle);
      return lab === undefined
        ? { status: "unavailable" }
        : observe.observeCanaryFiles(lab);
    },
    prepareScriptCanary(handle) {
      const lab = sessionFor(handle);
      return lab === undefined ? null : observe.prepareScriptCanary(lab);
    },
    issuedScriptNonces(handle) {
      const lab = sessionFor(handle);
      return lab === undefined ? null : [...lab.scriptNonces];
    },
    async observeStoredScript(handle, input) {
      const lab = sessionFor(handle);
      return lab === undefined
        ? { status: "unavailable", phase: "lab" }
        : observe.observeStoredScript(lab, input);
    },
    async observeOptions(handle) {
      const lab = sessionFor(handle);
      return lab === undefined
        ? { status: "unavailable" }
        : observe.observeOptions(lab);
    },
    async observeAccountRoles(handle, username) {
      const lab = sessionFor(handle);
      return lab === undefined
        ? { status: "unavailable" }
        : lab.roles(username);
    },
    async observeExecution(handle) {
      const lab = sessionFor(handle);
      return lab === undefined
        ? { status: "unavailable" }
        : observe.observeExecution(lab);
    },
  };
}
