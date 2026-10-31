import { readFile } from "node:fs/promises";

import { z } from "zod";

import { canonicalDigest } from "../../../infrastructure/canonical-json.js";
import type { LabBaselineRef } from "../../../lab/index.js";
import type { WordPressLabSession } from "./lab-session.js";

/**
 * The verification Lab's base environment (#699, owner decision 2026-10-31):
 * plain WordPress with the hardening Japanese shared hosts apply by default.
 * The values come from docs/reviews/2026-10-31-hosting-defaults.md and the
 * decision comment on #699. A new version is a new file; old files stay so a
 * recorded digest can still be rebuilt. The Harness never reads a verdict
 * from the baseline: it only applies the values and reads them back.
 */
export const CURRENT_WORDPRESS_LAB_BASELINE_ID = "hosting-default-v2";

const KNOWN_BASELINES = new Set(["hosting-default-v1", "hosting-default-v2"]);

const setting = z.discriminatedUnion("target", [
  z.discriminatedUnion("name", [
    z.strictObject({
      target: z.literal("wordpress"),
      name: z.literal("bundled-plugins"),
      value: z.literal("absent"),
    }),
    /** #706: set once at site creation, as a host's quick install does. */
    z.strictObject({
      target: z.literal("wordpress"),
      name: z.literal("permalink-structure"),
      value: z.string().regex(/^\/[A-Za-z0-9%_/-]{0,99}$/),
    }),
  ]),
  /** `null`: the constant stays undefined, so WordPress keeps its default. */
  z.strictObject({
    target: z.literal("wp-config"),
    name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    value: z.null(),
  }),
  z.strictObject({
    target: z.literal("php"),
    name: z.literal("major-version"),
    value: z.number().int().min(5).max(99),
  }),
  z.strictObject({
    target: z.literal("php-ini"),
    name: z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/),
    value: z.union([z.boolean(), z.string().regex(/^[A-Za-z0-9_,.\-]*$/)]),
  }),
  z.strictObject({
    target: z.literal("file-mode"),
    name: z.enum(["directories", "files"]),
    value: z.string().regex(/^[0-7]{3}$/),
  }),
  /**
   * `enabled`: `.htaccess` exists. `wordpress-rewrite` (#706): it also holds
   * WordPress's standard rewrite block.
   */
  z.strictObject({
    target: z.literal("web-server"),
    name: z.literal("htaccess"),
    value: z.enum(["enabled", "wordpress-rewrite"]),
  }),
]);
const pathRule = z.discriminatedUnion("match", [
  z.strictObject({
    match: z.literal("prefix"),
    path: z.string().regex(/^\/[A-Za-z0-9_./-]*$/),
    except: z.array(z.string().regex(/^\/[A-Za-z0-9_./-]*$/)).optional(),
  }),
  z.strictObject({
    match: z.enum(["exact", "suffix"]),
    path: z.string().regex(/^\/[A-Za-z0-9_./-]*$/),
  }),
]);
export const wordPressLabBaselineSchema = z.strictObject({
  schema: z.literal("wbh-lab-baseline/v1"),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  /** The review document the values were taken from. */
  reference: z.string().min(1).max(200),
  settings: z.array(setting).min(1).max(100),
  /**
   * Where the attacker position stands. `foreign` gets 403 on `deniedPaths`
   * at the Lab's host entrance after setup; `lenient` keeps admin-ajax and
   * admin-post open (a `strict` variant is reserved by name only).
   * `origin` is for an unauthenticated attacker. A position that logs in
   * (attack.json carries its account) stands at `authenticatedOrigin`: a
   * host's foreign-access block guards the unauthenticated entrances, and
   * someone who can log in is treated as a domestic user (decided 2026-10-31).
   */
  attacker: z.strictObject({
    origin: z.enum(["domestic", "foreign"]),
    authenticatedOrigin: z.enum(["domestic", "foreign"]),
    adminEndpoints: z.literal("lenient"),
    deniedPaths: z.array(pathRule).max(50),
  }),
});
export type WordPressLabBaseline = z.output<typeof wordPressLabBaselineSchema>;
export type WordPressDeniedPath =
  WordPressLabBaseline["attacker"]["deniedPaths"][number];

export type WordPressAttackerOrigin =
  WordPressLabBaseline["attacker"]["origin"];
/** Where one Finding's attacker stands and what the host entrance denies it. */
export type WordPressAttackerEntrance = {
  readonly origin: WordPressAttackerOrigin;
  readonly deniedPaths: readonly WordPressDeniedPath[];
};

/**
 * The attacker's origin for one Finding: `origin` when unauthenticated,
 * `authenticatedOrigin` for a position that logs in. Only a foreign origin
 * is denied the baseline's paths.
 */
export function attackerEntranceFor(
  baseline: WordPressLabBaseline,
  attackerPosition: string,
): WordPressAttackerEntrance {
  const origin =
    attackerPosition === "unauthenticated"
      ? baseline.attacker.origin
      : baseline.attacker.authenticatedOrigin;
  return {
    origin,
    deniedPaths: origin === "foreign" ? baseline.attacker.deniedPaths : [],
  };
}

/** A baseline file read and checked against its schema; an unknown item stops here. */
export function parseWordPressLabBaseline(text: string): {
  readonly baseline: WordPressLabBaseline;
  readonly ref: LabBaselineRef;
} {
  const baseline = wordPressLabBaselineSchema.parse(
    JSON.parse(text) as unknown,
  );
  return {
    baseline,
    ref: { id: baseline.id, digest: canonicalDigest(baseline) },
  };
}

export async function loadWordPressLabBaseline(
  id: string,
  url: URL = new URL(`./baselines/${id}.json`, import.meta.url),
): Promise<{
  readonly baseline: WordPressLabBaseline;
  readonly ref: LabBaselineRef;
}> {
  if (!KNOWN_BASELINES.has(id)) throw new Error(`Unknown Lab baseline ${id}`);
  const loaded = parseWordPressLabBaseline(await readFile(url, "utf8"));
  if (loaded.baseline.id !== id)
    throw new Error("Lab baseline file names another id");
  return loaded;
}

/** The base environment did not read back as applied; the Lab is not used (#699). */
export class WordPressLabBaselineMismatch extends Error {
  constructor(readonly settings: readonly string[]) {
    super(`The Lab baseline did not hold: ${settings.join(", ")}`);
  }
}

const PHP_INI_FILE = "/usr/local/etc/php/conf.d/zz-wbh-lab-baseline.ini";
const SITE = "/var/www/html";
/**
 * The block WordPress writes for a site at the web root (`WP_Rewrite::
 * mod_rewrite_rules`), the same lines the WordPress image ships (#706).
 */
const WORDPRESS_REWRITE_BLOCK = [
  "# BEGIN WordPress",
  "",
  "RewriteEngine On",
  "RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]",
  "RewriteBase /",
  "RewriteRule ^index\\.php$ - [L]",
  "RewriteCond %{REQUEST_FILENAME} !-f",
  "RewriteCond %{REQUEST_FILENAME} !-d",
  "RewriteRule . /index.php [L]",
  "",
  "# END WordPress",
];
const iniValue = (value: boolean | string) =>
  typeof value === "boolean" ? (value ? "On" : "Off") : `"${value}"`;
const settingName = (item: WordPressLabBaseline["settings"][number]) =>
  `${item.target}:${item.name}`;

/** Removes the plugins the WordPress image ships; run before the Snapshot's plugins go in. */
export async function removeBundledPlugins(
  lab: WordPressLabSession,
  baseline: WordPressLabBaseline,
): Promise<void> {
  if (
    baseline.settings.some(
      (item) => item.target === "wordpress" && item.name === "bundled-plugins",
    )
  )
    await lab.wp(["plugin", "delete", "--all"]);
}

/** Applies the PHP and file settings once the Snapshot's plugins are in place. */
export async function applyWordPressLabBaseline(
  lab: WordPressLabSession,
  baseline: WordPressLabBaseline,
): Promise<void> {
  const ini = baseline.settings.flatMap((item) =>
    item.target === "php-ini" ? [`${item.name} = ${iniValue(item.value)}`] : [],
  );
  if (ini.length > 0) {
    // The value travels as an environment variable, never as shell source.
    await lab.requireDocker([
      "exec",
      "--user=root",
      "--env",
      `WBH_BASELINE_INI=${ini.join("\n")}\n`,
      lab.wordpress,
      "sh",
      "-c",
      `printf '%s' "$WBH_BASELINE_INI" > ${PHP_INI_FILE}`,
    ]);
    // A graceful restart makes Apache's PHP read the new file.
    await lab.requireDocker([
      "exec",
      "--user=root",
      lab.wordpress,
      "apache2ctl",
      "-k",
      "graceful",
    ]);
  }
  for (const item of baseline.settings)
    if (item.target === "wordpress" && item.name === "permalink-structure")
      await lab.wp(["rewrite", "structure", item.value]);
  if (
    baseline.settings.some(
      (item) =>
        item.target === "web-server" && item.value === "wordpress-rewrite",
    )
  )
    // Written only when no block is there, so blocks plugins added stay; the
    // block travels as an environment variable, never as shell source.
    await lab.requireDocker([
      "exec",
      "--user=root",
      "--env",
      `WBH_BASELINE_HTACCESS=${WORDPRESS_REWRITE_BLOCK.join("\n")}\n`,
      lab.wordpress,
      "sh",
      "-c",
      `grep -q '^# BEGIN WordPress' ${SITE}/.htaccess 2>/dev/null || { printf '%s' "$WBH_BASELINE_HTACCESS" >> ${SITE}/.htaccess && chown www-data:www-data ${SITE}/.htaccess; }`,
    ]);
  // File modes go last so a file written above gets them too.
  for (const item of baseline.settings)
    if (item.target === "file-mode")
      await lab.requireDocker([
        "exec",
        "--user=root",
        lab.wordpress,
        "find",
        SITE,
        "-type",
        item.name === "directories" ? "d" : "f",
        "-exec",
        "chmod",
        item.value,
        "{}",
        "+",
      ]);
}

const READBACK_PHP = `$names = json_decode((string) getenv("WBH_BASELINE_CONSTANTS"), true); $out = []; foreach ($names as $name) { $out[$name] = defined($name); } echo json_encode($out);`;

/**
 * Reads every setting back from the running Lab and throws
 * `WordPressLabBaselineMismatch` naming the settings that differ.
 */
export async function readBackWordPressLabBaseline(
  lab: WordPressLabSession,
  baseline: WordPressLabBaseline,
  expectedPlugins: readonly string[],
): Promise<void> {
  const differs: string[] = [];
  const constants = baseline.settings.flatMap((item) =>
    item.target === "wp-config" ? [item.name] : [],
  );
  const defined =
    constants.length === 0
      ? {}
      : z
          .record(z.string(), z.boolean())
          .parse(
            JSON.parse(
              (
                await lab.wp(
                  ["eval", READBACK_PHP],
                  [`WBH_BASELINE_CONSTANTS=${JSON.stringify(constants)}`],
                )
              ).stdout.trim(),
            ) as unknown,
          );
  const ini = baseline.settings.flatMap((item) =>
    item.target === "php-ini" ? [item.name] : [],
  );
  const php = z
    .strictObject({
      major: z.number().int(),
      ini: z.record(z.string(), z.union([z.string(), z.literal(false)])),
    })
    .parse(
      JSON.parse(
        (
          await lab.requireDocker([
            "exec",
            "--env",
            `WBH_BASELINE_INI_NAMES=${JSON.stringify(ini)}`,
            lab.wordpress,
            "php",
            "-r",
            `$out = ["major" => PHP_MAJOR_VERSION, "ini" => []]; foreach (json_decode((string) getenv("WBH_BASELINE_INI_NAMES"), true) as $name) { $out["ini"][$name] = ini_get($name); } echo json_encode($out);`,
          ])
        ).stdout.trim(),
      ) as unknown,
    );
  for (const item of baseline.settings) {
    switch (item.target) {
      case "wordpress": {
        if (item.name === "permalink-structure") {
          const structure = (
            await lab.wp(["option", "get", "permalink_structure"])
          ).stdout.trim();
          if (structure !== item.value) differs.push(settingName(item));
          break;
        }
        const installed = (
          await lab.wp(["plugin", "list", "--field=name"])
        ).stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "")
          .sort();
        if (
          JSON.stringify(installed) !==
          JSON.stringify([...new Set(expectedPlugins)].sort())
        )
          differs.push(settingName(item));
        break;
      }
      case "wp-config":
        if (defined[item.name] !== false) differs.push(settingName(item));
        break;
      case "php":
        if (php.major !== item.value) differs.push(settingName(item));
        break;
      case "php-ini": {
        const observed = php.ini[item.name];
        const holds =
          typeof item.value === "boolean"
            ? typeof observed === "string" &&
              ["1", "on", "true", "yes"].includes(observed.toLowerCase()) ===
                item.value
            : observed === item.value;
        if (!holds) differs.push(settingName(item));
        break;
      }
      case "file-mode": {
        const stray = await lab.docker([
          "exec",
          "--user=root",
          lab.wordpress,
          "find",
          SITE,
          "-type",
          item.name === "directories" ? "d" : "f",
          "!",
          "-perm",
          item.value,
          "-print",
          "-quit",
        ]);
        if (stray.exitCode !== 0 || stray.stdout.trim() !== "")
          differs.push(settingName(item));
        break;
      }
      case "web-server": {
        const present = await lab.docker([
          "exec",
          lab.wordpress,
          "test",
          "-f",
          `${SITE}/.htaccess`,
        ]);
        if (present.exitCode !== 0) {
          differs.push(settingName(item));
          break;
        }
        if (item.value === "wordpress-rewrite") {
          const missing = z
            .array(z.string())
            .parse(
              JSON.parse(
                (
                  await lab.requireDocker([
                    "exec",
                    "--env",
                    `WBH_BASELINE_HTACCESS_LINES=${JSON.stringify(WORDPRESS_REWRITE_BLOCK.filter((line) => line !== ""))}`,
                    lab.wordpress,
                    "php",
                    "-r",
                    `$lines = @file("${SITE}/.htaccess", FILE_IGNORE_NEW_LINES); echo json_encode(array_values(array_diff(json_decode((string) getenv("WBH_BASELINE_HTACCESS_LINES"), true), array_map("trim", $lines === false ? [] : $lines))));`,
                  ])
                ).stdout.trim(),
              ) as unknown,
            );
          if (missing.length > 0) differs.push(`${settingName(item)}:rewrite`);
        }
        break;
      }
    }
  }
  if (differs.length > 0) throw new WordPressLabBaselineMismatch(differs);
}

/**
 * Whether `path` is denied to the attacker position; only the path, never the
 * query. Self-contained: the host gateway runs its source (#699).
 */
export function deniedToAttacker(
  rules: readonly WordPressDeniedPath[],
  path: string,
): boolean {
  return rules.some((rule) =>
    rule.match === "exact"
      ? path === rule.path
      : rule.match === "suffix"
        ? path.endsWith(rule.path)
        : (path === rule.path || path.startsWith(rule.path + "/")) &&
          !("except" in rule && (rule.except || []).includes(path)),
  );
}

/**
 * The path a request names, as the gateway matches it: dot segments
 * resolved, repeated slashes folded and percent escapes decoded, then
 * resolved again. Null when it is not a path. Self-contained like the matcher.
 */
export function requestPath(url: string): string | null {
  // An origin-form target is appended to the origin, so `//x` stays a path.
  const resolve = (value: string) =>
    new URL(
      value.startsWith("/") ? `http://wordpress${value}` : value,
    ).pathname.replace(/\/{2,}/g, "/");
  let path: string;
  try {
    path = resolve(url);
  } catch {
    return null;
  }
  try {
    return resolve(decodeURIComponent(path));
  } catch {
    return null;
  }
}
