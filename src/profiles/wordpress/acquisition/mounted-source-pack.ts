import type { ExpectedSourceTree } from "../../../infrastructure/canonical-source-tree.js";
import { SourceAcquisitionError } from "../../../snapshot/index.js";
import type { WordPressSourceResolver } from "../lab/index.js";
import {
  WORDPRESS_SANDBOX_LAYOUT,
  wordpressDependencyPluginMountPath,
} from "../sandbox-layout.js";

/** One fixed tree and the sandbox path the layout assigns to it. */
type MountedTree = Readonly<{
  path: string;
  directory: string;
  tree: ExpectedSourceTree;
}>;

export type WordPressMountedSourcePack = Readonly<{
  target: MountedTree;
  core?: MountedTree;
  dependencies: readonly MountedTree[];
}>;

/** One Snapshot-derived mount map for both discovery and verification. */
export function mountedWordPressSourcePack(
  resolved: Awaited<ReturnType<WordPressSourceResolver["resolve"]>>,
  options: { readonly requireRuntimeSources?: boolean } = {},
): WordPressMountedSourcePack {
  const core = resolved.dependencies.filter(
    (source) => source.kind === "wordpress-core",
  );
  const php = resolved.dependencies.filter(
    (source) => source.kind === "php-source",
  );
  if (
    resolved.target.kind !== "plugin" ||
    core.length > 1 ||
    php.length > 1 ||
    (options.requireRuntimeSources === true &&
      (core.length !== 1 || php.length !== 1))
  )
    throw new SourceAcquisitionError("source-mismatch", {
      reason: "required-runtime-source-missing",
    });

  const dependencies = resolved.dependencies.flatMap((source) => {
    if (source.kind === "wordpress-core") return [];
    if (source.kind === "php-source")
      return [
        {
          path: WORDPRESS_SANDBOX_LAYOUT.php,
          directory: source.sourceDirectory,
          tree: source.sourceTree,
        },
      ];
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(source.pluginSlug))
      throw new SourceAcquisitionError("source-mismatch", {
        reason: "invalid-dependency-plugin-slug",
        slug: source.pluginSlug,
      });
    return [
      {
        path: wordpressDependencyPluginMountPath(source.pluginSlug),
        directory: source.sourceDirectory,
        tree: source.sourceTree,
      },
    ];
  });
  if (
    new Set(dependencies.map((source) => source.path)).size !==
    dependencies.length
  )
    throw new SourceAcquisitionError("source-mismatch", {
      reason: "duplicate-source-pack-mount",
    });

  return {
    target: {
      path: WORDPRESS_SANDBOX_LAYOUT.target,
      directory: resolved.target.sourceDirectory,
      tree: resolved.target.sourceTree,
    },
    ...(core[0] === undefined
      ? {}
      : {
          core: {
            path: WORDPRESS_SANDBOX_LAYOUT.wordpressCore,
            directory: core[0].sourceDirectory,
            tree: core[0].sourceTree,
          },
        }),
    dependencies,
  };
}
