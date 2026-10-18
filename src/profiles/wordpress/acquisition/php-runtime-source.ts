import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  SourceTreeError,
  walkCanonicalSourceTree,
} from "../../../infrastructure/canonical-source-tree.js";
import type { NativeModelProcessResult } from "../../../infrastructure/native-model-process.js";
import { runNativeModelProcess } from "../../../infrastructure/native-model-process.js";
import {
  SourceAcquisitionError,
  type AcquiredSource,
  type SourceAcquisitionFailureKind,
} from "../../../snapshot/index.js";

export const PHP_RUNTIME_SOURCE_IDENTITY = "php-runtime-source";
const IMAGE_PHP_ARCHIVE = "/usr/src/php.tar.xz";
const pinnedImage = /^[^\s@]+@sha256:([a-f0-9]{64})$/;
const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:[A-Za-z0-9.-]+)?$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const DEFAULT_LIMITS = { maxEntries: 40_000, maxBytes: 512 * 1024 * 1024 };
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;

function failure(
  kind: SourceAcquisitionFailureKind,
  reason: string,
  extra: Record<string, unknown> = {},
): SourceAcquisitionError {
  return new SourceAcquisitionError(kind, { reason, ...extra });
}

export type PhpSourceDockerCommand = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<NativeModelProcessResult>;

/**
 * Freeze the PHP source archive baked into the exact pinned WordPress Lab image.
 * Docker create/cp never starts the image; the archive is checksum checked
 * against its image metadata before any extraction. The Lab later checks that
 * its executing PHP_VERSION agrees with this frozen source version.
 */
export function openPhpRuntimeSource(options: {
  readonly dockerExecutablePath: string;
  readonly image: string;
  readonly stagingDirectory: string;
  readonly runDocker?: PhpSourceDockerCommand;
  readonly tarExecutablePath?: string;
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
    (options.tarExecutablePath !== undefined &&
      !isAbsolute(options.tarExecutablePath))
  )
    throw new Error("PHP runtime source options are invalid");
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  if (
    !Number.isSafeInteger(limits.maxEntries) ||
    limits.maxEntries < 1 ||
    !Number.isSafeInteger(limits.maxBytes) ||
    limits.maxBytes < 1
  )
    throw new Error("PHP runtime source limits are invalid");
  const runDocker: PhpSourceDockerCommand =
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
    reason: string,
    failureKind: SourceAcquisitionFailureKind = "deferred",
  ): Promise<string> => {
    const result = await runDocker(args, timeoutMs);
    if (result.kind !== "exited")
      throw failure("deferred", reason, { processKind: result.kind });
    if (result.exitCode !== 0)
      throw failure(failureKind, reason, { exitCode: result.exitCode });
    return result.stdout;
  };
  const tar = async (args: readonly string[]): Promise<string> => {
    const result = await runNativeModelProcess({
      executablePath: options.tarExecutablePath ?? "/usr/bin/tar",
      args,
      workingDirectory: "/",
      environment: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" },
      timeoutMs: 600_000,
      maxOutputBytes: 8 * 1024 * 1024,
    });
    if (result.kind !== "exited")
      throw failure("deferred", "php-archive-tool-unavailable", {
        processKind: result.kind,
      });
    if (result.exitCode !== 0)
      throw failure("invalid-archive", "php-archive-invalid", {
        exitCode: result.exitCode,
      });
    return result.stdout;
  };
  const directory = join(options.stagingDirectory, imageDigest);

  return async () => {
    try {
      let environment: unknown;
      try {
        environment = JSON.parse(
          await docker(
            [
              "image",
              "inspect",
              "--format={{json .Config.Env}}",
              options.image,
            ],
            60_000,
            "php-image-metadata-unavailable",
          ),
        ) as unknown;
      } catch (error: unknown) {
        if (error instanceof SourceAcquisitionError) throw error;
        throw failure("source-mismatch", "php-image-metadata-invalid");
      }
      if (
        !Array.isArray(environment) ||
        !environment.every((item) => typeof item === "string")
      )
        throw failure("source-mismatch", "php-image-metadata-invalid");
      const values = new Map(
        environment.map((item: string) => [
          item.slice(0, item.indexOf("=")),
          item.slice(item.indexOf("=") + 1),
        ]),
      );
      const version = values.get("PHP_VERSION");
      const archiveSha256 = values.get("PHP_SHA256");
      if (
        version === undefined ||
        !versionPattern.test(version) ||
        archiveSha256 === undefined ||
        !sha256Pattern.test(archiveSha256)
      )
        throw failure(
          "source-mismatch",
          "php-image-version-or-checksum-missing",
        );

      const cached = await exists(directory);
      if (cached && !(await exists(join(directory, "main", "php_version.h"))))
        throw failure("source-mismatch", "php-source-cache-incomplete");
      if (!cached) {
        await mkdir(options.stagingDirectory, { recursive: true, mode: 0o700 });
        const staging = join(
          options.stagingDirectory,
          `${imageDigest}.staging-${randomUUID()}`,
        );
        const archive = join(staging, "php.tar.xz");
        const source = join(staging, "source");
        await mkdir(source, { recursive: true, mode: 0o700 });
        const id = (
          await docker(
            ["create", "--pull=never", options.image],
            60_000,
            "php-image-container-unavailable",
          )
        ).trim();
        if (!/^[a-f0-9]{12,64}$/.test(id)) {
          await rm(staging, { recursive: true, force: true });
          throw failure("source-mismatch", "php-image-container-id-invalid");
        }
        let extractionError: unknown;
        try {
          await docker(
            ["cp", `${id}:${IMAGE_PHP_ARCHIVE}`, archive],
            120_000,
            "php-archive-unavailable",
            "source-mismatch",
          );
          if ((await stat(archive)).size > MAX_ARCHIVE_BYTES)
            throw failure("quota-exceeded", "php-archive-too-large");
          const actualSha256 = createHash("sha256")
            .update(await readFile(archive))
            .digest("hex");
          if (actualSha256 !== archiveSha256)
            throw failure("source-mismatch", "php-archive-checksum-mismatch");
          const names = (
            await tar(["--quoting-style=literal", "-tJf", archive])
          )
            .trimEnd()
            .split("\n");
          const types = (
            await tar(["--quoting-style=literal", "-tvJf", archive])
          )
            .trimEnd()
            .split("\n");
          if (names.length !== types.length)
            throw failure(
              "invalid-archive",
              "php-archive-listing-inconsistent",
            );
          if (names.length > limits.maxEntries + 1000)
            throw failure("quota-exceeded", "php-archive-entry-limit");
          if (
            names.some(
              (name) =>
                !name.startsWith(`php-${version}/`) ||
                name.includes("\\") ||
                name.includes("\r") ||
                name.split("/").some((part) => part === ".."),
            )
          )
            throw failure("invalid-archive", "php-archive-unsafe-path");
          if (types.some((entry) => !/^[d-]/.test(entry)))
            throw failure("invalid-archive", "php-archive-special-entry");
          await tar([
            "-xJf",
            archive,
            "--strip-components=1",
            "--no-same-owner",
            "--no-same-permissions",
            "-C",
            source,
          ]);
          if (await exists(directory)) {
            await rm(staging, { recursive: true, force: true });
          } else {
            await rename(source, directory);
            await rm(staging, { recursive: true, force: true });
          }
        } catch (error: unknown) {
          extractionError = error;
          await rm(staging, { recursive: true, force: true });
          throw error;
        } finally {
          try {
            await docker(
              ["rm", "--force", id],
              60_000,
              "php-image-container-cleanup-failed",
            );
          } catch (cleanupError: unknown) {
            // Keep the acquisition failure that explains why source was refused.
            if (extractionError === undefined) throw cleanupError;
          }
        }
      }
      const sourceVersion = /#define PHP_VERSION "([0-9A-Za-z.-]+)"/.exec(
        await readFile(join(directory, "main", "php_version.h"), "utf8"),
      )?.[1];
      if (sourceVersion !== version)
        throw failure("source-mismatch", "php-source-version-mismatch");
      const { manifest } = await walkCanonicalSourceTree(directory, limits);
      return [
        {
          identity: PHP_RUNTIME_SOURCE_IDENTITY,
          version,
          manifest,
          readFile: (path: string) => readFile(join(directory, path)),
        },
      ];
    } catch (error: unknown) {
      if (error instanceof SourceAcquisitionError) throw error;
      if (error instanceof SourceTreeError) throw sourceTreeFailure(error);
      throw failure("deferred", "php-source-acquisition-failed", {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

/** The extracted tree is refused under the same reasons the archive listing is. */
function sourceTreeFailure(error: SourceTreeError): SourceAcquisitionError {
  switch (error.code) {
    case "invalid-path":
      return failure("invalid-archive", "php-source-invalid-path");
    case "symbolic-link":
      return failure("invalid-archive", "php-source-symbolic-link");
    case "path-collision":
      return failure("invalid-archive", "php-source-path-collision");
    case "bounds-exceeded":
      return failure("quota-exceeded", "php-source-limit");
    case "hard-link":
    case "non-regular-entry":
    case "root-not-directory":
      return failure("invalid-archive", "php-source-non-regular-entry");
    case "changed-while-reading":
      return failure("deferred", "php-source-acquisition-failed", {
        detail: error.message,
      });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
