import { z } from "zod";

/**
 * Where the sandbox places fixed source trees. The target source and the
 * Trial notes are the sandbox's own contract; every other read-only tree is a
 * dependency mount the profile declares and the run carries as input.
 */
export const SANDBOX_WORKSPACE_ROOT = "/workspace";
/** The fixed target source, read-only; also the agent's working directory. */
export const SANDBOX_SOURCE_MOUNT_PATH = "/workspace/main";
/** The Trial-local writable notes directory of a cooperative run. */
export const SANDBOX_RESEARCH_MOUNT_PATH = "/workspace/research";
/** Every path the sandbox itself owns; no dependency mount may use or contain one. */
const FIXED_MOUNT_PATHS = [
  SANDBOX_SOURCE_MOUNT_PATH,
  SANDBOX_RESEARCH_MOUNT_PATH,
] as const;

/** One or two lower-case segments directly under the workspace root. */
const DEPENDENCY_MOUNT_PATH =
  /^\/workspace\/[a-z0-9][a-z0-9-]{0,63}(?:\/[a-z0-9][a-z0-9-]{0,63})?$/;

export function isDependencyMountPath(path: string): boolean {
  return (
    DEPENDENCY_MOUNT_PATH.test(path) &&
    FIXED_MOUNT_PATHS.every(
      (fixed) => path !== fixed && !path.startsWith(`${fixed}/`),
    )
  );
}

export const dependencyMountPathSchema = z
  .string()
  .refine(isDependencyMountPath, "Not a sandbox dependency mount path");

/** Distinct, and no mount sits inside another (including the fixed mounts). */
export function dependencyMountPathsAreDisjoint(
  paths: readonly string[],
): boolean {
  const all = [...FIXED_MOUNT_PATHS, ...paths];
  if (new Set(all).size !== all.length) return false;
  return all.every((path) =>
    all.every((other) => other === path || !other.startsWith(`${path}/`)),
  );
}

/** The dependency mount paths one run supplies, in mount order. */
export function dependencyMountPathsOf(run: {
  readonly dependencySource?: { readonly path: string };
  readonly dependencySources?: readonly { readonly path: string }[];
}): string[] {
  return [
    ...(run.dependencySource === undefined ? [] : [run.dependencySource.path]),
    ...(run.dependencySources ?? []).map((source) => source.path),
  ];
}

/** The label a dependency mount gets in recorded source paths: `@<mount>`. */
export function dependencyMountLabel(mountPath: string): string {
  return `@${mountPath.slice(SANDBOX_WORKSPACE_ROOT.length + 1)}`;
}

/**
 * The absolute sandbox path when it lies in the target source or one of the
 * supplied dependency mounts, else undefined.
 */
export function mountedSourcePath(
  dependencyMounts: readonly string[],
  resolved: string,
): string | undefined {
  return [SANDBOX_SOURCE_MOUNT_PATH, ...dependencyMounts].some((mount) =>
    resolved.startsWith(`${mount}/`),
  )
    ? resolved
    : undefined;
}

/**
 * A sandbox path as a source-relative record: target files keep their
 * relative path, files of a dependency mount get `@<mount>/<file>`.
 */
export function sourceRelativePath(
  dependencyMounts: readonly string[],
  resolved: string,
): string | undefined {
  if (resolved.startsWith(`${SANDBOX_SOURCE_MOUNT_PATH}/`))
    return resolved.slice(SANDBOX_SOURCE_MOUNT_PATH.length + 1);
  for (const mount of dependencyMounts)
    if (resolved.startsWith(`${mount}/`))
      return `${dependencyMountLabel(mount)}/${resolved.slice(mount.length + 1)}`;
  return undefined;
}

/** Matches file paths of the target source or a supplied mount inside command text. */
export function mountedSourcePathPattern(
  dependencyMounts: readonly string[],
): RegExp {
  const mounts = [SANDBOX_SOURCE_MOUNT_PATH, ...dependencyMounts].map((path) =>
    path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return new RegExp(`(?:${mounts.join("|")})\\/[^\\s'"\`;&|)]+`, "g");
}
