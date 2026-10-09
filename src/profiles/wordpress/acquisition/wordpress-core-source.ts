import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { NativeModelProcessResult } from "../../../infrastructure/native-model-process.js";
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

  const extract = async (): Promise<void> => {
    if (await exists(join(directory, "wp-includes", "version.php"))) return;
    await mkdir(options.stagingDirectory, { recursive: true, mode: 0o700 });
    const staging = `${directory}.staging`;
    await rm(staging, { recursive: true, force: true });
    const id = (
      await docker(["create", "--pull=never", options.image], 60_000)
    ).trim();
    if (!/^[a-f0-9]{12,64}$/.test(id))
      throw new Error("WordPress core container id is invalid");
    try {
      await docker(["cp", `${id}:${IMAGE_CORE_PATH}`, staging], 600_000);
      await rename(staging, directory);
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
    const entries = await manifestEntries(directory, limits);
    return [
      {
        identity: WORDPRESS_CORE_IDENTITY,
        version,
        manifest: {
          kind: "canonical-file-manifest",
          schemaVersion: 1,
          entries,
        },
        readFile: (path) => readFile(join(directory, path)),
      },
    ];
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Sorted manifest of regular files; links and odd entries stop the freeze. */
async function manifestEntries(
  root: string,
  limits: { readonly maxEntries: number; readonly maxBytes: number },
): Promise<{ path: string; digest: string; size: number }[]> {
  const entries: { path: string; digest: string; size: number }[] = [];
  let bytes = 0;
  const walk = async (
    absolute: string,
    segments: readonly string[],
  ): Promise<void> => {
    for (const child of (await readdir(absolute, { withFileTypes: true })).sort(
      (left, right) => (left.name < right.name ? -1 : 1),
    )) {
      if (/[\\\0]/.test(child.name))
        throw new Error("WordPress core contains an invalid path");
      const path = join(absolute, child.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink())
        throw new Error("WordPress core contains a symbolic link");
      if (stat.isDirectory()) {
        await walk(path, [...segments, child.name]);
        continue;
      }
      if (!stat.isFile() || stat.nlink > 1)
        throw new Error("WordPress core contains a non-regular entry");
      const content = await readFile(path);
      bytes += content.byteLength;
      entries.push({
        path: [...segments, child.name].join("/"),
        digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
        size: content.byteLength,
      });
      if (entries.length > limits.maxEntries || bytes > limits.maxBytes)
        throw new Error("WordPress core exceeds the source limits");
    }
  };
  await walk(root, []);
  return entries.sort((left, right) => (left.path < right.path ? -1 : 1));
}
