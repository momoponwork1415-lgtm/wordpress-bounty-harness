import { isAbsolute } from "node:path";

import { z } from "zod";

import { canonicalDigest } from "../../../infrastructure/canonical-json.js";
import {
  acquireHostLabLease,
  type HostLabLease,
} from "../../../infrastructure/host-lab-lease.js";
import type { HttpCaptureRead } from "../../../lab/capture.js";
import type {
  LabProvisioner,
  LabReachability,
  ProvisionResult,
} from "../../../lab/index.js";
import { startLabContainers } from "./container-startup.js";
import type {
  Leftovers,
  LeftoverPatterns,
  WordPressLabHandle,
  WordPressSourceResolver,
  WordPressVictimPagesObservation,
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
import {
  captureWordPressLabState,
  type WordPressLabState,
} from "./state-capture.js";
import { closeWordPressSetup } from "./setup-close.js";
import {
  grantReadOnlyDatabaseAccess,
  initializeWordPress,
} from "./wordpress-initialization.js";

export type * from "./contract.js";
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
  /** Review-only credential, never part of the attacker/Verifier handle. */
  reviewAdministrator(
    handle: WordPressLabHandle,
  ): { readonly username: "harness-admin"; readonly password: string } | null;
  /** Review-only receiver address for a human-operated browser in the Lab network. */
  reviewReceiverIp(handle: WordPressLabHandle): string | null;
  /**
   * Ends handoff precondition setup (#430): revokes the setup administrator.
   * False when the Lab cannot.
   */
  finishSetup(handle: WordPressLabHandle): Promise<boolean>;
  /**
   * Opens the declared victim pages in fresh Lab browsers and records the
   * marker dialog and the screen (#525). Review material, never a verdict.
   */
  observeVictimPages(
    handle: WordPressLabHandle,
    victim: WordPressVictimRoute,
  ): Promise<WordPressVictimPagesObservation>;
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
  /** Publishes the Lab on host loopback ports for a human's browser and curl (`lab up`). */
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
   */
  cleanupLeftovers(input: {
    readonly remove: boolean;
    readonly patterns?: LeftoverPatterns;
    readonly labId?: string;
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
  readonly healthAttempts?: number;
  /** Dependency injection for isolated Lab tests; hosts use the one shared path. */
  readonly leaseDirectory?: string;
  readonly leaseWaitMs?: number;
}): WordPressLab {
  if (!isAbsolute(options.dockerExecutablePath))
    throw new Error("Docker executable path must be absolute");
  for (const image of Object.values(options.images)) pinnedImage.parse(image);
  const attempts = options.healthAttempts ?? 60;
  if (!Number.isSafeInteger(attempts) || attempts < 1)
    throw new Error("Invalid health attempt count");
  const docker = createLabDocker(
    options.runner ?? nativeDockerRunner(options.dockerExecutablePath),
  );
  const active = new Map<string, WordPressLabSession>();
  const leases = new Map<string, HostLabLease>();
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
  }) => {
    if (onlyLab !== undefined && !exactLabId.test(onlyLab))
      throw new Error("Lab id is invalid");
    const owned =
      onlyLab === undefined ? LAB_LEFTOVERS : labLeftoverPatterns(onlyLab);
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
      const matching = [...owned[kind], ...(patterns[kind] ?? [])];
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
    // Containers go first so their networks and volumes are no longer in use.
    if (remove)
      for (const [kind, , removal] of kinds)
        if (found[kind].length > 0)
          await docker.require([...removal, ...found[kind]]);
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
      let lease: HostLabLease | undefined;
      try {
        const prepared = await prepareWordPressLab(
          candidateSnapshot,
          candidateSetup,
          options.source,
        );
        const { setup, phpVersion } = prepared;
        await preflight();
        if (context?.purpose === "verification") {
          const acquired = await acquireHostLabLease({
            ...(options.leaseDirectory === undefined
              ? {}
              : { directory: options.leaseDirectory }),
            waitMs: options.leaseWaitMs ?? 30 * 60_000,
          });
          if (acquired === null)
            return {
              status: "incomplete",
              reason: "provision",
              nextStep:
                "Another verification Lab held the host lease; retry after it finishes",
            };
          lease = acquired;
          const recovered = await lease.recover(async (labId) => {
            const leftovers = await cleanupLeftovers({ remove: false, labId });
            return (
              leftovers.containers.length +
                leftovers.networks.length +
                leftovers.volumes.length >
              0
            );
          });
          if (recovered.status === "blocked")
            return {
              status: "incomplete",
              reason: "provision",
              nextStep: recovered.reason,
            };
        }
        const secondaryLocale =
          setup.translatePress?.administratorSecondaryLocale ??
          prepared.scenario?.secondaryLocale ??
          undefined;
        lab = new WordPressLabSession({
          docker,
          images: options.images,
          customerRole: setup.customerRole,
          forVerification: context?.purpose === "verification",
          ...(secondaryLocale === undefined ? {} : { secondaryLocale }),
        });
        if (lease !== undefined) await lease.reserveLab(lab.id);
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
        if (lease !== undefined) {
          leases.set(lab.id, lease);
          lease = undefined;
        }
        return { status: "ready", handle };
      } catch (error: unknown) {
        if (lab !== undefined) {
          const cleaned = await lab.cleanup();
          if (lease !== undefined && lease.reservation?.kind === "lab") {
            if (cleaned) await lease.clear();
            else await lease.cleanupNeeded();
          }
        }
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
      } finally {
        if (lease !== undefined) await lease.release();
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
      const lease = leases.get(lab.id);
      try {
        if (!(await lab.cleanup())) {
          if (lease !== undefined) await lease.cleanupNeeded();
          return {
            status: "incomplete",
            reason: "cleanup",
            nextStep: "Inspect and remove remaining Lab resources",
          };
        }
        active.delete(lab.id);
        if (lease !== undefined) await lease.clear();
        return { status: "removed" };
      } finally {
        if (lease !== undefined) {
          leases.delete(lab.id);
          await lease.release();
        }
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
    async observeVictimPages(handle, victim) {
      const lab = sessionFor(handle);
      return lab === undefined
        ? { status: "unavailable", phase: "victim-page" }
        : observe.observeVictimPages(lab, victim);
    },
  };
}
