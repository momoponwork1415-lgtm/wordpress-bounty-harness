import { sourceRelativePath } from "../../../discovery/index.js";
import { WORDPRESS_DEPENDENCY_SOURCE_ROOTS } from "../sandbox-layout.js";

const CORE = WORDPRESS_DEPENDENCY_SOURCE_ROOTS[0]!;

/** Preserve the source tree named in a Finding/Lead without keeping sandbox paths. */
export function normalizeWordPressSourcePath(value: string): string {
  const mounted = sourceRelativePath(
    WORDPRESS_DEPENDENCY_SOURCE_ROOTS.map((root) => root.path),
    value,
  );
  if (mounted !== undefined) return mounted;
  for (const root of WORDPRESS_DEPENDENCY_SOURCE_ROOTS)
    if (value.startsWith(root.relative))
      return `${root.label}/${value.slice(root.relative.length)}`;
  if (value.startsWith("WordPress "))
    return `${CORE.label}/${value.slice("WordPress ".length)}`;
  return value;
}
