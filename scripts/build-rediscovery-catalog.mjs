import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import Database from "better-sqlite3";

const maxArchiveBytes = 128 * 1024 * 1024;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const versionPattern = /^\d+(?:\.\d+)*$/;
const cvePattern = /^CVE-\d{4}-\d{4,}$/;
const caseIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function assertObject(value, context) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${context} must be an object`);
  return value;
}

function assertKeys(value, allowed, context) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${context} has unknown field`);
  }
}

function parseCases(value) {
  const input = assertObject(value, "case input");
  assertKeys(input, ["schemaVersion", "cases"], "case input");
  if (input.schemaVersion !== 1 || !Array.isArray(input.cases))
    throw new Error("invalid case input");
  const ids = new Set();
  const cves = new Set();
  const cases = input.cases.map((entry) => {
    const item = assertObject(entry, "case");
    assertKeys(item, ["caseId", "slug", "vulnerableVersion", "cve"], "case");
    if (
      typeof item.caseId !== "string" ||
      !caseIdPattern.test(item.caseId) ||
      typeof item.slug !== "string" ||
      !slugPattern.test(item.slug) ||
      typeof item.vulnerableVersion !== "string" ||
      !versionPattern.test(item.vulnerableVersion) ||
      typeof item.cve !== "string" ||
      !cvePattern.test(item.cve) ||
      ids.has(item.caseId) ||
      cves.has(item.cve)
    )
      throw new Error("invalid or duplicate case identity");
    ids.add(item.caseId);
    cves.add(item.cve);
    return {
      caseId: item.caseId,
      slug: item.slug,
      vulnerableVersion: item.vulnerableVersion,
      cve: item.cve,
    };
  });
  if (cases.length === 0) throw new Error("no cases supplied");
  return cases.sort((a, b) => a.caseId.localeCompare(b.caseId));
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

function normalizedDate(value) {
  if (typeof value !== "string") throw new Error("missing publication date");
  const date = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const instant = Date.parse(date);
  if (!Number.isFinite(instant)) throw new Error("invalid publication date");
  return new Date(instant).toISOString();
}

function selectedMirrorRecord(db, input) {
  const rows = db
    .prepare(
      "SELECT v.id, v.published, v.record_json FROM vulnerabilities v JOIN software s ON s.vulnerability_id = v.id WHERE s.slug = ? AND s.type = 'plugin' AND v.record_json LIKE ?",
    )
    .all(input.slug, `%${input.cve}%`);
  const matches = rows.filter((row) => {
    const record = JSON.parse(row.record_json);
    return record.cve === input.cve;
  });
  if (matches.length !== 1)
    throw new Error(`expected one mirror record for ${input.caseId}`);
  const row = matches[0];
  const record = assertObject(JSON.parse(row.record_json), "mirror record");
  if (typeof row.id !== "string" || row.id.length === 0)
    throw new Error("mirror record ID missing");
  if (!Array.isArray(record.software))
    throw new Error("mirror software list missing");
  const software = record.software.filter((item) => item?.slug === input.slug);
  if (software.length !== 1)
    throw new Error(`ambiguous mirror software for ${input.caseId}`);
  const item = assertObject(software[0], "mirror software");
  const ranges = assertObject(item.affected_versions, "affected versions");
  const upperBounds = Object.values(ranges)
    .filter((range) => range?.to_inclusive === true)
    .map((range) => range.to_version);
  if (upperBounds.length !== 1 || upperBounds[0] !== input.vulnerableVersion)
    throw new Error(`affected upper bound mismatch for ${input.caseId}`);
  if (
    !Array.isArray(item.patched_versions) ||
    item.patched_versions.length === 0 ||
    item.patched_versions.some(
      (version) => typeof version !== "string" || !versionPattern.test(version),
    )
  )
    throw new Error(`patched version missing for ${input.caseId}`);
  const declaredPatchedVersion = [...item.patched_versions].sort(
    compareVersions,
  )[0];
  if (compareVersions(declaredPatchedVersion, input.vulnerableVersion) <= 0)
    throw new Error(`invalid patched version for ${input.caseId}`);
  return {
    recordId: row.id,
    cve: input.cve,
    publishedAt: normalizedDate(row.published),
    affectedUpperBound: upperBounds[0],
    declaredPatchedVersion,
  };
}

function sourcePin(pins, input) {
  const entries = pins.plugins.filter(
    (entry) =>
      entry.slug === input.slug && entry.version === input.vulnerableVersion,
  );
  if (entries.length !== 1)
    throw new Error(`vulnerable source pin missing for ${input.caseId}`);
  const pin = entries[0];
  const digest = pin.archiveDigest ?? pin.sourceTreeDigest;
  if (!/^sha256:[a-f0-9]{64}$/.test(digest))
    throw new Error(`invalid vulnerable source pin for ${input.caseId}`);
  return { kind: pin.kind, digest };
}

async function wordpressVersions(slug, fetcher) {
  const url = new URL("https://api.wordpress.org/plugins/info/1.2/");
  url.searchParams.set("action", "plugin_information");
  url.searchParams.set("request[slug]", slug);
  url.searchParams.set("request[fields][versions]", "1");
  const response = await fetcher(url, { redirect: "error" });
  if (!response.ok)
    throw new Error(`WordPress.org version API failed for ${slug}`);
  const data = assertObject(await response.json(), "WordPress.org response");
  if (data.slug !== slug)
    throw new Error(`WordPress.org slug mismatch for ${slug}`);
  return assertObject(data.versions, "WordPress.org versions");
}

async function archiveBytes(url, fetcher) {
  const response = await fetcher(url, { redirect: "error" });
  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok || response.body === null)
    throw new Error("WordPress.org archive retrieval failed");
  const claimedSize = Number(response.headers.get("content-length"));
  if (claimedSize > maxArchiveBytes)
    throw new Error("WordPress.org archive exceeds size cap");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxArchiveBytes)
      throw new Error("WordPress.org archive exceeds size cap");
    chunks.push(Buffer.from(chunk));
  }
  const archive = Buffer.concat(chunks);
  if (
    archive.length < 4 ||
    archive.subarray(0, 4).toString("hex") !== "504b0304"
  )
    throw new Error("WordPress.org archive is not a ZIP");
  return archive;
}

function officialArchiveUrl(raw, slug, version) {
  if (typeof raw !== "string") return null;
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "downloads.wordpress.org" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== `/plugin/${slug}.${version}.zip` ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new Error("WordPress.org version link is not an official ZIP");
  return url.href;
}

async function selectFixedArchive(
  input,
  declaredPatchedVersion,
  versions,
  fetcher,
) {
  const candidates = Object.keys(versions)
    .filter(
      (version) =>
        versionPattern.test(version) &&
        compareVersions(version, input.vulnerableVersion) > 0 &&
        compareVersions(version, declaredPatchedVersion) >= 0,
    )
    .sort(compareVersions);
  for (const version of candidates) {
    const url = officialArchiveUrl(versions[version], input.slug, version);
    if (url === null) continue;
    const archive = await archiveBytes(url, fetcher);
    if (archive !== null) return { version, url, archive };
  }
  throw new Error(`no available fixed ZIP for ${input.caseId}`);
}

async function ensureOutsideGit(path) {
  if (!isAbsolute(path)) throw new Error("private path must be absolute");
  let cursor = resolve(path);
  while (true) {
    try {
      cursor = await realpath(cursor);
      if (!(await stat(cursor)).isDirectory()) cursor = dirname(cursor);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor)
        throw new Error("private path has no real ancestor");
      cursor = parent;
    }
  }
  while (true) {
    try {
      await stat(join(cursor, ".git"));
      throw new Error("private output must be outside Git");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = resolve(cursor, "..");
    if (parent === cursor) break;
    cursor = parent;
  }
}

async function writePrivate(path, bytes) {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let existing;
    try {
      existing = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (!existing.equals(bytes))
      throw new Error(`private pin conflict: ${path}`);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

export async function buildRediscoveryCatalog(options) {
  const {
    casePath,
    mirrorPath,
    mirrorStatePath,
    sourcePinsPath,
    privateDirectory,
    pinPath,
    fetcher = fetch,
  } = options;
  await ensureOutsideGit(privateDirectory);
  await ensureOutsideGit(casePath);
  const cases = parseCases(JSON.parse(await readFile(casePath, "utf8")));
  const pins = assertObject(
    JSON.parse(await readFile(sourcePinsPath, "utf8")),
    "source pins",
  );
  if (!Array.isArray(pins.plugins)) throw new Error("source pin list missing");
  const mirrorState = assertObject(
    JSON.parse(await readFile(mirrorStatePath, "utf8")),
    "mirror state",
  );
  const db = new Database(mirrorPath, { readonly: true, fileMustExist: true });
  let source;
  try {
    const metadata = db.prepare("SELECT value FROM metadata WHERE key = ?");
    if (
      metadata.get("projection_schema")?.value !== "wordfence-history/v1" ||
      metadata.get("content_sha256")?.value !== mirrorState.content_sha256 ||
      metadata.get("record_count")?.value !==
        String(mirrorState.record_count) ||
      mirrorState.stale_fallback === true
    )
      throw new Error("Wordfence mirror state mismatch");
    source = cases.map((input) => ({
      input,
      advisory: selectedMirrorRecord(db, input),
      vulnerableSource: sourcePin(pins, input),
    }));
  } finally {
    db.close();
  }
  const versionCache = new Map();
  const selectionCache = new Map();
  const archiveCache = new Map();
  const records = [];
  await mkdir(join(privateDirectory, "fixed-archives"), {
    recursive: true,
    mode: 0o700,
  });
  await ensureOutsideGit(join(privateDirectory, "fixed-archives"));
  for (const { input, advisory, vulnerableSource } of source) {
    let versions = versionCache.get(input.slug);
    if (versions === undefined) {
      versions = await wordpressVersions(input.slug, fetcher);
      versionCache.set(input.slug, versions);
    }
    const selectionKey = `${input.slug}@${input.vulnerableVersion}@${advisory.declaredPatchedVersion}`;
    let fixed = selectionCache.get(selectionKey);
    if (fixed === undefined) {
      fixed = await selectFixedArchive(
        input,
        advisory.declaredPatchedVersion,
        versions,
        fetcher,
      );
      selectionCache.set(selectionKey, fixed);
    }
    const archiveName = `${input.slug}.${fixed.version}.zip`;
    const archiveDigest = sha256(fixed.archive);
    const previous = archiveCache.get(archiveName);
    if (previous !== undefined && previous !== archiveDigest)
      throw new Error("fixed archive changed within one acquisition");
    archiveCache.set(archiveName, archiveDigest);
    await writePrivate(
      join(privateDirectory, "fixed-archives", archiveName),
      fixed.archive,
    );
    records.push({
      caseId: input.caseId,
      slug: input.slug,
      vulnerableVersion: input.vulnerableVersion,
      vulnerableSourceKind: vulnerableSource.kind,
      vulnerableSourceDigest: vulnerableSource.digest,
      recordId: advisory.recordId,
      cve: advisory.cve,
      publishedAt: advisory.publishedAt,
      affectedUpperBound: advisory.affectedUpperBound,
      declaredPatchedVersion: advisory.declaredPatchedVersion,
      fixedVersion: fixed.version,
      fixedZipUrl: fixed.url,
      fixedZipAvailable: true,
      fixedArchiveDigest: archiveDigest,
      fixedArchiveBytes: fixed.archive.length,
    });
  }
  const manifest = {
    schemaVersion: 1,
    source: {
      wordfenceMirrorDigest: `sha256:${mirrorState.content_sha256}`,
      wordpressVersionApi: "https://api.wordpress.org/plugins/info/1.2/",
    },
    cases: records,
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestDigest = sha256(bytes);
  await writePrivate(join(privateDirectory, "manifest.json"), bytes);
  const publicPin = {
    schemaVersion: 1,
    manifestDigest,
    cases: records.map(({ caseId, slug, vulnerableVersion, fixedVersion }) => ({
      caseId,
      slug,
      vulnerableVersion,
      fixedVersion,
    })),
  };
  await writeFile(pinPath, `${JSON.stringify(publicPin, null, 2)}\n`, {
    flag: "wx",
  });
  return {
    manifestDigest,
    cases: records.length,
    fixedArchives: archiveCache.size,
  };
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined)
      throw new Error("expected --option value pairs");
    options[key.slice(2)] = value;
  }
  const required = [
    "cases",
    "mirror",
    "mirror-state",
    "source-pins",
    "private-dir",
    "pin-output",
  ];
  if (
    Object.keys(options).some((key) => !required.includes(key)) ||
    required.some((key) => !options[key])
  )
    throw new Error(`required: ${required.map((key) => `--${key}`).join(" ")}`);
  return {
    casePath: options.cases,
    mirrorPath: options.mirror,
    mirrorStatePath: options["mirror-state"],
    sourcePinsPath: options["source-pins"],
    privateDirectory: options["private-dir"],
    pinPath: options["pin-output"],
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const result = await buildRediscoveryCatalog(
      parseArguments(process.argv.slice(2)),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
