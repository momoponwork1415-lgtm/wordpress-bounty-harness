/** Preserve the source tree named in a Finding/Lead without keeping sandbox paths. */
export function normalizeWordPressSourcePath(value: string): string {
  if (value.startsWith("/workspace/main/"))
    return value.slice("/workspace/main/".length);
  if (value.startsWith("/workspace/wordpress/"))
    return `@wordpress/${value.slice("/workspace/wordpress/".length)}`;
  if (value.startsWith("../wordpress/"))
    return `@wordpress/${value.slice("../wordpress/".length)}`;
  if (value.startsWith("/workspace/php/"))
    return `@php/${value.slice("/workspace/php/".length)}`;
  if (value.startsWith("../php/"))
    return `@php/${value.slice("../php/".length)}`;
  if (value.startsWith("/workspace/dependencies/"))
    return `@dependencies/${value.slice("/workspace/dependencies/".length)}`;
  if (value.startsWith("../dependencies/"))
    return `@dependencies/${value.slice("../dependencies/".length)}`;
  if (value.startsWith("WordPress "))
    return `@wordpress/${value.slice("WordPress ".length)}`;
  return value;
}
