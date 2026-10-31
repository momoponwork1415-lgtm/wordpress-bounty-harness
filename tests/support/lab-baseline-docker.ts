/**
 * #699: answers a fake Docker host gives the Lab baseline's read-back
 * commands, as a WordPress image that holds `hosting-default-v1` or `-v2`
 * (#706) would. It
 * tracks the plugins WP-CLI activated so the bundled-plugin check reads them
 * back. `drift` names settings that read back wrong.
 */
export function baselineDockerAnswers(
  options: { readonly drift?: readonly string[] } = {},
) {
  const drift = new Set(options.drift ?? []);
  const plugins = new Set<string>();
  const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
  const env = (args: readonly string[], name: string) =>
    args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  return (args: readonly string[]) => {
    const wp = args.indexOf("wp");
    if (args[0] === "run" && wp >= 0) {
      const command = args.slice(wp + 1);
      if (command[0] === "plugin" && command[1] === "activate")
        plugins.add(command[2] ?? "");
      if (command[0] === "plugin" && command[1] === "delete") plugins.clear();
      if (command[0] === "option" && command[2] === "permalink_structure")
        return ok(drift.has("permalink-structure") ? "\n" : "/%postname%/\n");
      if (command[0] === "plugin" && command[1] === "list")
        return ok(
          [...plugins, ...(drift.has("bundled-plugins") ? ["akismet"] : [])]
            .map((name) => `${name}\n`)
            .join(""),
        );
    }
    const constants = env(args, "WBH_BASELINE_CONSTANTS");
    if (constants !== undefined)
      return ok(
        JSON.stringify(
          Object.fromEntries(
            (JSON.parse(constants) as string[]).map((name) => [
              name,
              drift.has(name),
            ]),
          ),
        ),
      );
    const ini = env(args, "WBH_BASELINE_INI_NAMES");
    if (ini !== undefined)
      return ok(
        JSON.stringify({
          major: drift.has("major-version") ? 7 : 8,
          ini: Object.fromEntries(
            (JSON.parse(ini) as string[]).map((name) => [
              name,
              name === "allow_url_fopen" || drift.has(name) ? "1" : "",
            ]),
          ),
        }),
      );
    if (env(args, "WBH_BASELINE_HTACCESS_LINES") !== undefined)
      return ok(drift.has("rewrite-block") ? '["# BEGIN WordPress"]' : "[]");
    if (args[0] === "exec" && args.includes("find") && args.includes("!"))
      return ok(drift.has("file-mode") ? "/var/www/html/stray\n" : "");
    if (args[0] === "exec" && args.includes("test"))
      return drift.has("htaccess")
        ? { exitCode: 1, stdout: "", stderr: "" }
        : ok();
    return null;
  };
}
