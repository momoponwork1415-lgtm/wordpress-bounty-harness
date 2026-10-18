import {
  SANDBOX_RESEARCH_MOUNT_PATH,
  SANDBOX_SOURCE_MOUNT_PATH,
  dependencyMountLabel,
} from "../../discovery/index.js";

/**
 * Where the WordPress profile places each fixed source tree inside the
 * sandbox. Declared once: the source pack, the prompt's Lab text, the
 * Verifier's Lab input and source-path normalisation all read it, and the
 * generic sandbox and runtime receive these paths through the run.
 */
export const WORDPRESS_SANDBOX_LAYOUT = {
  /** The target plugin, read-only; the sandbox's fixed source mount. */
  target: SANDBOX_SOURCE_MOUNT_PATH,
  /** The Trial-local writable notes directory; the sandbox's fixed mount. */
  research: SANDBOX_RESEARCH_MOUNT_PATH,
  /** WordPress core of the version the Lab runs, read-only. */
  wordpressCore: "/workspace/wordpress",
  /** PHP source matching the execution image, read-only. */
  php: "/workspace/php",
  /** Dependency plugins, one read-only mount per slug beneath this root. */
  dependencies: "/workspace/dependencies",
} as const;

export function wordpressDependencyPluginMountPath(slug: string): string {
  return `${WORDPRESS_SANDBOX_LAYOUT.dependencies}/${slug}`;
}

/** The dependency trees as the agent may name them: sandbox root, `../<name>/`, `@<name>/`. */
export const WORDPRESS_DEPENDENCY_SOURCE_ROOTS = [
  WORDPRESS_SANDBOX_LAYOUT.wordpressCore,
  WORDPRESS_SANDBOX_LAYOUT.php,
  WORDPRESS_SANDBOX_LAYOUT.dependencies,
].map((path) => ({
  path,
  label: dependencyMountLabel(path),
  relative: `../${dependencyMountLabel(path).slice(1)}/`,
}));
