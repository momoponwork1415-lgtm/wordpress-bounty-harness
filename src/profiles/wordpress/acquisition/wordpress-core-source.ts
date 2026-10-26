import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { walkCanonicalSourceTree } from "../../../infrastructure/canonical-source-tree.js";
import type { NativeModelProcessResult } from "../../../infrastructure/native-model-process.js";
import { pathExists } from "../../../infrastructure/immutable-file.js";
import { runNativeModelProcess } from "../../../infrastructure/native-model-process.js";
import type { AcquiredSource } from "../../../snapshot/index.js";
import { WORDPRESS_CORE_IDENTITY } from "../lab/index.js";

export { WORDPRESS_CORE_IDENTITY };

/** Where the official WordPress image keeps the core it copies into the web root. */
const IMAGE_CORE_PATH = "/usr/src/wordpress";
const DEFAULT_LIMITS = { maxEntries: 20_000, maxBytes: 512 * 1024 * 1024 };
const pinnedImage = /^[^\s@]+@sha256:([a-f0-9]{64})$/;

export type DockerCommand = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<NativeModelProcessResult>;

/**
 * Freezes the WordPress core of the pinned Lab image as a snapshot dependency.
 *
 * The core is copied out of a created, never started, container and laid out
 * once per image digest. Nothing in it is executed on the host. The version in
 * `wp-includes/version.php` must equal the campaign's declared version, so the
 * agents read exactly the core the Lab runs.
 */
export function openWordPressCoreSource(options: {
  readonly dockerExecutablePath: string;
  /** The Lab's WordPress image, pinned by digest. */
  readonly image: string;
  readonly stagingDirectory: string;
  readonly expectedVersion: string;
  readonly runDocker?: DockerCommand;
  readonly limits?: {
    readonly maxEntries?: number;
    readonly maxBytes?: number;
  };
}): () => Promise<readonly AcquiredSource[]> {
  const imageDigest = pinnedImage.exec(options.image)?.[1];
  if (
    imageDigest === undefined ||
    !isAbsolute(options.dockerExecutablePath) ||
    !isAbsolute(options.stagingDirectory) ||
    !/^[0-9A-Za-z.-]{1,32}$/.test(options.expectedVersion)
  )
    throw new Error("WordPress core source options are invalid");
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  if (
    !Number.isSafeInteger(limits.maxEntries) ||
    limits.maxEntries < 1 ||
    !Number.isSafeInteger(limits.maxBytes) ||
    limits.maxBytes < 1
  )
    throw new Error("WordPress core source limits are invalid");
  const runDocker: DockerCommand =
    options.runDocker ??
    ((args, timeoutMs) =>
      runNativeModelProcess({
        executablePath: options.dockerExecutablePath,
        args,
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
  const docker = async (
    args: readonly string[],
    timeoutMs: number,
  ): Promise<string> => {
    const result = await runDocker(args, timeoutMs);
    if (result.kind !== "exited" || result.exitCode !== 0)
      throw new Error("WordPress core extraction failed");
    return result.stdout;
  };
  const directory = join(options.stagingDirectory, imageDigest);

  const versionFile = join(directory, "wp-includes", "version.php");

  const extract = async (): Promise<void> => {
    if (await pathExists(versionFile)) return;
    await mkdir(options.stagingDirectory, { recursive: true, mode: 0o700 });
    // Each process copies into its own staging directory, so processes that
    // freeze the same image at once never remove or move each other's copy.
    const staging = `${directory}.staging-${randomUUID()}`;
    const id = (
      await docker(["create", "--pull=never", options.image], 60_000)
    ).trim();
    if (!/^[a-f0-9]{12,64}$/.test(id))
      throw new Error("WordPress core container id is invalid");
    try {
      await docker(["cp", `${id}:${IMAGE_CORE_PATH}`, staging], 600_000);
      try {
        await rename(staging, directory);
      } catch (error: unknown) {
        // Another process moved its complete copy in first. The rename is
        // atomic, so its tree is used and checked like any cached one below.
        if (!isTargetTaken(error) || !(await pathExists(versionFile)))
          throw error;
        await rm(staging, { recursive: true, force: true });
      }
    } catch (error: unknown) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    } finally {
      await docker(["rm", "--force", id], 60_000);
    }
  };

  return async () => {
    await extract();
    const version = /\$wp_version\s*=\s*'([0-9A-Za-z.-]{1,32})'/.exec(
      await readFile(join(directory, "wp-includes", "version.php"), "utf8"),
    )?.[1];
    if (version === undefined)
      throw new Error("WordPress core version is unreadable");
    if (version !== options.expectedVersion)
      throw new Error(
        `The Lab image runs WordPress ${version}, not the declared ${options.expectedVersion}`,
      );
    // Links, path collisions and files changing under the walk stop the freeze.
    const { manifest } = await walkCanonicalSourceTree(directory, limits);
    return [
      {
        identity: WORDPRESS_CORE_IDENTITY,
        version,
        manifest,
        readFile: (path) => readFile(join(directory, path)),
      },
    ];
  };
}

function isTargetTaken(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EEXIST" || code === "ENOTEMPTY";
}
