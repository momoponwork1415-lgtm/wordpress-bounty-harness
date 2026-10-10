import Database from "better-sqlite3";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const usage =
  "node scripts/prepare-pilot-selection.mjs --history <history.sqlite> --state <state.json> --cache <selection.sqlite> --template <selection.json> --output <private-selection.json>";
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value) throw new Error(usage);
  args.set(key, value);
}
for (const key of [
  "--history",
  "--state",
  "--cache",
  "--template",
  "--output",
]) {
  if (!args.has(key)) throw new Error(usage);
}

const now = new Date();
const state = JSON.parse(await readFile(args.get("--state"), "utf8"));
if (
  state.schema_version !== "wordfence-cache/v1" ||
  state.stale_fallback === true ||
  !Number.isFinite(Date.parse(state.last_successful_at)) ||
  now.getTime() - Date.parse(state.last_successful_at) > 24 * 60 * 60 * 1000 ||
  Date.parse(state.last_successful_at) > now.getTime()
) {
  throw new Error("Wordfence catalog is stale or unavailable");
}

const history = new Database(args.get("--history"), {
  readonly: true,
  fileMustExist: true,
});
const metadata = history.prepare("SELECT value FROM metadata WHERE key = ?");
if (
  metadata.get("projection_schema")?.value !== "wordfence-history/v1" ||
  metadata.get("content_sha256")?.value !== state.content_sha256 ||
  metadata.get("record_count")?.value !== String(state.record_count)
) {
  throw new Error("Wordfence catalog state and database disagree");
}

// Catalog titles and impact tags are nomination signals, never proof of a new finding.
const candidates = history
  .prepare(
    `
    SELECT s.slug AS slug, count(DISTINCT v.id) AS history_count
    FROM software s
    JOIN vulnerabilities v ON v.id = s.vulnerability_id
    JOIN signals g ON g.vulnerability_id = v.id AND g.slug = s.slug
    WHERE s.type = 'plugin' AND v.informational = 0
      AND v.published IS NOT NULL AND v.published <= ?
      AND (lower(v.title) LIKE '%unauthenticated%'
        OR lower(v.title) LIKE '%subscriber+%'
        OR lower(v.title) LIKE '%subscriber %')
      AND g.value IN (
        'sql-injection', 'stored-xss', 'remote-code-execution',
        'account-takeover', 'privilege-escalation-to-admin',
        'authentication-bypass-to-admin', 'arbitrary-php-file-upload',
        'arbitrary-file-upload', 'arbitrary-options-update',
        'arbitrary-php-file-read'
      )
    GROUP BY s.slug
    HAVING history_count >= 2
    ORDER BY history_count DESC, s.slug ASC
    LIMIT 50
  `,
  )
  .all(now.toISOString().replace("T", " ").slice(0, 19));
history.close();

const cachePath = resolve(args.get("--cache"));
await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 });
const cache = new Database(cachePath);
cache.exec(`
  CREATE TABLE IF NOT EXISTS wporg_install_observations (
    slug TEXT PRIMARY KEY,
    active_installations INTEGER NOT NULL,
    stable_version TEXT NOT NULL,
    last_updated TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    source_url TEXT NOT NULL
  )
`);
const cached = cache.prepare(
  "SELECT * FROM wporg_install_observations WHERE slug = ?",
);
const save = cache.prepare(`
  INSERT INTO wporg_install_observations
    (slug, active_installations, stable_version, last_updated, observed_at, source_url)
  VALUES (@slug, @active_installations, @stable_version, @last_updated, @observed_at, @source_url)
  ON CONFLICT(slug) DO UPDATE SET
    active_installations = excluded.active_installations,
    stable_version = excluded.stable_version,
    last_updated = excluded.last_updated,
    observed_at = excluded.observed_at,
    source_url = excluded.source_url
`);

async function observe(slug) {
  const previous = cached.get(slug);
  if (
    previous &&
    now.getTime() - Date.parse(previous.observed_at) <
      7 * 24 * 60 * 60 * 1000 &&
    Date.parse(previous.observed_at) <= now.getTime()
  )
    return previous;
  const url = new URL("https://api.wordpress.org/plugins/info/1.2/");
  url.searchParams.set("action", "plugin_information");
  url.searchParams.set("request[slug]", slug);
  url.searchParams.set("request[fields][sections]", "0");
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return null;
    const body = await response.json();
    if (
      body?.slug !== slug ||
      !Number.isSafeInteger(body.active_installs) ||
      body.active_installs < 0 ||
      typeof body.version !== "string" ||
      typeof body.last_updated !== "string"
    )
      return null;
    const observation = {
      slug,
      active_installations: body.active_installs,
      stable_version: body.version,
      last_updated: body.last_updated,
      observed_at: new Date().toISOString(),
      source_url: url.toString(),
    };
    save.run(observation);
    return observation;
  } catch {
    return null;
  }
}

const observed = [];
for (const candidate of candidates) {
  const observation = await observe(candidate.slug);
  if (!observation) continue;
  if (observation.active_installations < 10_000) continue;
  observed.push({ ...candidate, ...observation });
}
cache.close();
if (observed.length < 3)
  throw new Error(
    "Fewer than three current WordPress.org candidates meet the pilot threshold",
  );
observed.sort(
  (left, right) =>
    right.history_count - left.history_count ||
    right.active_installations - left.active_installations ||
    left.slug.localeCompare(right.slug),
);
const top = observed.slice(0, 20);
const template = JSON.parse(await readFile(args.get("--template"), "utf8"));
const { pinnedVersions: _pinnedVersions, ...policy } = template;
policy.id = `wordpress-pilot-${now.toISOString().slice(0, 10)}`;
policy.candidateSlugs = top.map((item) => item.slug);
policy.minimumActiveInstallations = 10_000;
policy.maximumTargets = 3;
policy.historySignals = Object.fromEntries(
  top.map((item) => [item.slug, item.history_count]),
);
policy.historySource = {
  digest: `sha256:${state.content_sha256}`,
  refreshedAt: state.last_successful_at,
};
policy.scoreWeights = { ...policy.scoreWeights, history: 8 };
policy.runBudget = { default: 1, highThreat: 1 };
const output = resolve(args.get("--output"));
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await writeFile(output, JSON.stringify(policy, null, 2) + "\n", {
  mode: 0o600,
});
console.log(
  `Prepared ${top.length} catalog-nominated candidates; ${observed.length} met the install threshold. Selection policy: ${output}`,
);
