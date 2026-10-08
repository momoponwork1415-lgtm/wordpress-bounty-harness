import { lstat, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  agentRuntimeProfileDefinitionSchema,
  CodexNativeAgentRuntime,
  createProviderCredentialEgressBroker,
  defineAgentRuntimeProfile,
  GvisorCodexSandbox,
  ProviderAttachmentStore,
} from "../discovery/index.js";
import { canonicalDigest } from "../infrastructure/canonical-json.js";
import {
  runNativeModelProcess,
  type NativeModelProcessResult,
} from "../infrastructure/native-model-process.js";
import { openSnapshot, type Snapshot } from "../snapshot/index.js";
import type { Verifier } from "../verification/index.js";
import {
  createWordPressOrgFetchAdapter,
  openMaterializedSources,
  openWordPressOrgSnapshotSource,
  openWordPressOrgTargetSource,
} from "../profiles/wordpress/acquisition/index.js";
import type { WordPressFinding } from "../profiles/wordpress/discovery/finding.js";
import {
  openWordPressLab,
  type WordPressLabHandle,
} from "../profiles/wordpress/lab/index.js";
import { loadWordpressScopePolicy } from "../profiles/wordpress/scope-policy.js";
import {
  createWordPressSelection,
  type WordPressSelectionPolicy,
} from "../profiles/wordpress/selection/index.js";
import { CodexVerifier } from "../profiles/wordpress/verification/codex-verifier.js";
import { openTranscribedWordfenceProgramme } from "../profiles/wordpress/wordfence-programme/index.js";
import type { CliProfile, CliState } from "./index.js";
import {
  createWordPressCliProfile,
  type WordPressCampaignBoundaries,
  type WordPressCampaignConfig,
} from "./wordpress.js";

const absolutePath = z
  .string()
  .min(2)
  .regex(/^\/[^\0]*$/);
const pinnedImage = z.string().regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/);

/**
 * Host-private configuration, kept outside Git. It names where the provider
 * credential lives; only the egress broker ever reads that file.
 */
export const wordpressHostConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  dockerExecutablePath: absolutePath,
  /** Acquisitions, snapshots, materialized sources and sandbox scratch space. */
  workDirectory: absolutePath,
  credentialFilePath: absolutePath,
  images: z.strictObject({
    database: pinnedImage,
    wordpress: pinnedImage,
    wordpressCli: pinnedImage,
    browser: pinnedImage,
    codex: pinnedImage,
    broker: pinnedImage,
  }),
  codex: z.strictObject({
    /** Path inside the Codex image to the CLI's bundled model catalog. */
    bundledCatalogPath: absolutePath,
    /** The image digest is taken from `images.codex`. */
    runtimeProfile: agentRuntimeProfileDefinitionSchema.omit({
      transportKind: true,
      sandboxImageDigest: true,
    }),
  }),
  wordfenceProgrammeTranscriptionPath: absolutePath,
  scopePolicyPath: absolutePath.optional(),
  wordfenceHistory: z
    .strictObject({ databasePath: absolutePath, statePath: absolutePath })
    .optional(),
});
export type WordPressHostConfig = z.infer<typeof wordpressHostConfigSchema>;

/** One Docker CLI invocation; tests replace it at the process boundary. */
export type HostDockerRun = (
  args: readonly string[],
  stdin: string | undefined,
  timeoutMs: number,
) => Promise<NativeModelProcessResult>;

export type HostPreflightItem = {
  readonly item: string;
  readonly ok: boolean;
  readonly detail: string;
};

const INTAKE_LIMITS = {
  maxEntries: 20_000,
  maxFileBytes: 20 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxPathBytes: 512,
  maxDepth: 32,
};
const intakePolicy = {
  kind: "target-intake-policy" as const,
  schemaVersion: 1 as const,
  id: "wporg-intake-v1",
  digest: canonicalDigest({ id: "wporg-intake-v1", limits: INTAKE_LIMITS }),
  limits: INTAKE_LIMITS,
};

const digestOf = (image: string): string =>
  image.slice(image.lastIndexOf("@") + 1);

export async function loadWordPressHostConfig(
  path: string,
): Promise<WordPressHostConfig> {
  return wordpressHostConfigSchema.parse(
    JSON.parse(await readFile(path, "utf8")) as unknown,
  );
}

/**
 * Builds the CLI profile over the real boundaries. Every command that needs a
 * boundary first checks the host; anything missing stops it before an adapter
 * is built, with no fallback to a weaker runtime.
 */
export async function createWordPressHostProfile(options: {
  readonly host: WordPressHostConfig;
  readonly runDocker?: HostDockerRun;
  readonly fetch?: typeof fetch;
  /** Compiled credential proxy; defaults to the built `discovery` directory. */
  readonly proxyBundleDirectory?: string;
}): Promise<CliProfile> {
  const host = options.host;
  const proxyBundleDirectory =
    options.proxyBundleDirectory ??
    fileURLToPath(new URL("../discovery/", import.meta.url));
  const runDocker: HostDockerRun =
    options.runDocker ??
    ((args, stdin, timeoutMs) =>
      runNativeModelProcess({
        executablePath: host.dockerExecutablePath,
        args,
        ...(stdin === undefined ? {} : { stdin }),
        workingDirectory: "/",
        environment: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          LANG: "C",
          LC_ALL: "C",
          TZ: "UTC",
        },
        timeoutMs,
        maxOutputBytes: 64 * 1024,
      }));
  const directories = {
    wordpressOrg: join(host.workDirectory, "wordpress-org"),
    snapshots: join(host.workDirectory, "snapshots"),
    sources: join(host.workDirectory, "sources"),
    programme: join(host.workDirectory, "programme"),
    codexScratch: join(host.workDirectory, "codex-scratch"),
    brokerScratch: join(host.workDirectory, "broker-scratch"),
    attachments: join(host.workDirectory, "provider-attachments"),
  };
  const runtimeProfile = defineAgentRuntimeProfile({
    ...host.codex.runtimeProfile,
    transportKind: "codex-native/v1",
    sandboxImageDigest: digestOf(host.images.codex),
  });

  const boundaries = async (
    config: WordPressCampaignConfig,
    state: CliState,
  ): Promise<WordPressCampaignBoundaries> => {
    for (const directory of Object.values(directories))
      await mkdir(directory, { recursive: true, mode: 0o700 });
    const sandbox = new GvisorCodexSandbox({
      dockerExecutablePath: host.dockerExecutablePath,
      image: host.images.codex,
      bundledCatalogPath: host.codex.bundledCatalogPath,
      scratchRootDirectory: directories.codexScratch,
      maxOutputBytes: 16 * 1024 * 1024,
      timeoutMs: config.runWallTimeMinutes * 60_000,
      clock: state.clock,
      ...(options.runDocker === undefined
        ? {}
        : { runDocker: options.runDocker }),
    });
    const failed = (
      await preflight({
        host,
        runDocker,
        proxyBundleDirectory,
        runtimeProfile,
        probe: () => sandbox.probe(),
      })
    ).filter((item) => !item.ok);
    if (failed.length > 0)
      throw new Error(
        `Host preflight failed; nothing was started:\n${failed.map((item) => `  ${item.item}: ${item.detail}`).join("\n")}`,
      );

    const targetSource = openWordPressOrgTargetSource({
      storageDirectory: directories.wordpressOrg,
      adapter: createWordPressOrgFetchAdapter(
        options.fetch === undefined ? {} : { fetch: options.fetch },
      ),
      clock: state.clock,
    });
    const sources = openMaterializedSources({
      rootDirectory: directories.sources,
    });
    const snapshotStore = openSnapshot({
      storageDirectory: directories.snapshots,
      source: sources.acquisition(
        openWordPressOrgSnapshotSource({
          targetSource,
          storageDirectory: directories.wordpressOrg,
        }),
      ),
    });
    const lab = openWordPressLab({
      dockerExecutablePath: host.dockerExecutablePath,
      images: {
        database: host.images.database,
        wordpress: host.images.wordpress,
        wordpressCli: host.images.wordpressCli,
        browser: host.images.browser,
      },
      source: sources,
      ...(options.runDocker === undefined
        ? {}
        : {
            runner: {
              run: async (request) => {
                const result = await runDocker(
                  request.args,
                  undefined,
                  request.timeoutMs,
                );
                return result.kind === "exited"
                  ? result
                  : { exitCode: -1, stdout: "", stderr: result.stderr };
              },
            },
          }),
    });
    const attachments = new ProviderAttachmentStore(directories.attachments);
    const runtime = new CodexNativeAgentRuntime(
      sandbox,
      createProviderCredentialEgressBroker({
        dockerExecutablePath: host.dockerExecutablePath,
        brokerImage: host.images.broker,
        credentialFilePath: host.credentialFilePath,
        scratchRootDirectory: directories.brokerScratch,
        proxyBundleDirectory,
        clock: state.clock,
      }),
      attachments,
      host.images.codex,
      state.clock,
    );

    // Selection needs the programme transcription; commands that never select do not.
    let selection: ReturnType<typeof createWordPressSelection> | undefined;
    const selectionOnce = async () => {
      if (selection !== undefined) return selection;
      const { programme, programmeRef } =
        await openTranscribedWordfenceProgramme({
          transcriptionPath: host.wordfenceProgrammeTranscriptionPath,
          storageDirectory: directories.programme,
          clock: state.clock,
        });
      selection = createWordPressSelection({
        targetSource,
        programme,
        programmeRef,
        clock: state.clock,
      });
      return selection;
    };

    const frozen = new Map<string, Snapshot>();
    const verifier: Verifier<WordPressFinding, WordPressLabHandle> = {
      async attempt({ finding, lab: handle }) {
        const snapshot = frozen.get(handle.snapshotDigest);
        const source =
          snapshot === undefined
            ? undefined
            : await sources.resolve(snapshot).catch(() => undefined);
        if (source === undefined)
          return {
            status: "incomplete",
            reason: "precondition",
            nextStep:
              "Freeze the target again so its materialized source matches the Lab snapshot",
          };
        return new CodexVerifier({
          runtime,
          store: state.store,
          ledger: state.ledger,
          profile: runtimeProfile,
          source: {
            directory: source.target.sourceDirectory,
            tree: source.target.sourceTree,
          },
          clock: state.clock,
        }).attempt({ finding, lab: handle });
      },
    };

    return {
      selection: {
        inspect: async (policy: WordPressSelectionPolicy) =>
          (await selectionOnce()).inspect(policy),
        select: async (policy: WordPressSelectionPolicy) =>
          (await selectionOnce()).select(policy),
      },
      async freeze(target) {
        const snapshot = await snapshotStore.freeze({
          kind: "wordpress-org-target-acquire",
          schemaVersion: 1,
          observationRef: target.observationRef,
          requestedVersion: target.version,
          policy: intakePolicy,
        });
        frozen.set(snapshot.digest, snapshot);
        return snapshot;
      },
      lab,
      async sourceFor(snapshot) {
        const { target } = await sources.resolve(snapshot);
        return { directory: target.sourceDirectory, tree: target.sourceTree };
      },
      runtimeProfile,
      probeRuntime: () => sandbox.probe(),
      executor: runtime,
      attachments,
      verifier,
    };
  };

  return createWordPressCliProfile({
    boundaries,
    scopePolicy: await loadWordpressScopePolicy(
      ...(host.scopePolicyPath === undefined ? [] : [host.scopePolicyPath]),
    ),
    ...(host.wordfenceHistory === undefined
      ? {}
      : { wordfenceHistory: host.wordfenceHistory }),
  });
}

/** Checks the host without starting a target container or reading the credential. */
async function preflight(options: {
  readonly host: WordPressHostConfig;
  readonly runDocker: HostDockerRun;
  readonly proxyBundleDirectory: string;
  readonly runtimeProfile: {
    codexCliVersion: string;
    bundledCatalogDigest: string;
  };
  readonly probe: () => Promise<{
    readonly cliVersion: string;
    readonly bundledCatalogDigest: string;
  }>;
}): Promise<readonly HostPreflightItem[]> {
  const items: HostPreflightItem[] = [];
  const check = (item: string, ok: boolean, detail: string) =>
    items.push({ item, ok, detail });
  const docker = async (args: readonly string[]) => {
    const result = await options.runDocker(args, undefined, 30_000);
    return result.kind === "exited" && result.exitCode === 0
      ? result.stdout
      : undefined;
  };

  const server = await docker(["version", "--format", "{{.Server.Version}}"]);
  check(
    "docker",
    server !== undefined,
    server === undefined ? "the Docker daemon is unreachable" : server.trim(),
  );
  if (server === undefined) return items;

  const runtimes = await docker(["info", "--format", "{{json .Runtimes}}"]);
  let runsc = false;
  try {
    const parsed: unknown =
      runtimes === undefined ? null : (JSON.parse(runtimes) as unknown);
    runsc =
      typeof parsed === "object" &&
      parsed !== null &&
      Object.hasOwn(parsed, "runsc");
  } catch {
    runsc = false;
  }
  check(
    "runsc",
    runsc,
    runsc
      ? "registered"
      : "gVisor (runsc) is not a registered Docker runtime; runc is not used instead",
  );

  for (const [role, image] of Object.entries(options.host.images)) {
    const present =
      (await docker(["image", "inspect", "--format", "{{.Id}}", image])) !==
      undefined;
    check(
      `image ${role}`,
      present,
      present ? image : `${image} is not present locally (pull it by digest)`,
    );
  }

  try {
    const credential = await lstat(options.host.credentialFilePath);
    const owner =
      typeof process.getuid === "function" ? process.getuid() : undefined;
    const problems = [
      ...(credential.isFile() ? [] : ["not a regular file"]),
      ...((credential.mode & 0o077) === 0 ? [] : ["readable by others"]),
      ...(credential.uid === owner ? [] : ["not owned by this user"]),
      ...(credential.size > 0 ? [] : ["empty"]),
    ];
    check(
      "credential",
      problems.length === 0,
      problems.length === 0
        ? "present (0600, broker only)"
        : problems.join(", "),
    );
  } catch {
    check("credential", false, "the credential file is missing");
  }

  const bundleFiles = [
    "provider-credential-proxy-cli.js",
    "provider-credential-proxy.js",
  ];
  const bundled = await Promise.all(
    bundleFiles.map((file) =>
      stat(join(options.proxyBundleDirectory, file)).then(
        (entry) => entry.isFile(),
        () => false,
      ),
    ),
  );
  check(
    "proxy-bundle",
    bundled.every(Boolean),
    bundled.every(Boolean)
      ? options.proxyBundleDirectory
      : "the compiled credential proxy is missing (run pnpm build)",
  );

  if (runsc && items.every((item) => item.ok || item.item !== "image codex")) {
    const measured = await options.probe().catch(() => undefined);
    const ok =
      measured !== undefined &&
      measured.cliVersion === options.runtimeProfile.codexCliVersion &&
      measured.bundledCatalogDigest ===
        options.runtimeProfile.bundledCatalogDigest;
    check(
      "codex-runtime",
      ok,
      measured === undefined
        ? "the Codex image could not be probed"
        : `image codex-cli ${measured.cliVersion} catalog ${measured.bundledCatalogDigest}; profile codex-cli ${options.runtimeProfile.codexCliVersion} catalog ${options.runtimeProfile.bundledCatalogDigest}`,
    );
  } else {
    check(
      "codex-runtime",
      false,
      "not probed without runsc and the Codex image",
    );
  }
  return items;
}
