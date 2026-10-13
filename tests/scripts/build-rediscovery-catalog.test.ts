import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";

const script = join(process.cwd(), "scripts/build-rediscovery-catalog.mjs");
const catalog = await import(pathToFileURL(script).href);
const zip = Buffer.from("504b030400010203", "hex");
let directory: string;
let db: Database.Database;
let casesPath: string;
let mirrorPath: string;
let mirrorStatePath: string;
let sourcePinsPath: string;
let privateDirectory: string;
let pinPath: string;

function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function caseInput(caseId: string, cve: string) {
  return { caseId, slug: "sample-plugin", vulnerableVersion: "1.0", cve };
}

function record(caseId: string, cve: string, upper = "1.0") {
  db.prepare("INSERT INTO vulnerabilities VALUES (?, ?, ?)").run(
    caseId,
    "2026-08-05 17:09:31",
    JSON.stringify({
      cve,
      description: "DO_NOT_COPY_DESCRIPTION",
      title: "DO_NOT_COPY_TITLE",
      software: [
        {
          slug: "sample-plugin",
          affected_versions: {
            [`*-${upper}`]: {
              from_version: "*",
              to_version: upper,
              to_inclusive: true,
            },
          },
          patched_versions: ["1.1"],
        },
      ],
    }),
  );
  db.prepare("INSERT INTO software VALUES (?, ?, ?)").run(
    caseId,
    "sample-plugin",
    "plugin",
  );
}

function fetcher(url: URL | string): Promise<Response> {
  const request = new URL(url);
  if (request.hostname === "api.wordpress.org")
    return Promise.resolve(
      Response.json({
        slug: "sample-plugin",
        versions: {
          "1.0": "https://downloads.wordpress.org/plugin/sample-plugin.1.0.zip",
          "1.2": "https://downloads.wordpress.org/plugin/sample-plugin.1.2.zip",
          "1.3": "https://downloads.wordpress.org/plugin/sample-plugin.1.3.zip",
        },
      }),
    );
  if (request.pathname.endsWith("1.2.zip"))
    return Promise.resolve(new Response("missing", { status: 404 }));
  return Promise.resolve(new Response(zip));
}

function options(customFetcher = fetcher) {
  return {
    casePath: casesPath,
    mirrorPath,
    mirrorStatePath,
    sourcePinsPath,
    privateDirectory,
    pinPath,
    fetcher: customFetcher,
  };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "wbh-rediscovery-catalog-"));
  mirrorPath = join(directory, "history.sqlite");
  mirrorStatePath = join(directory, "state.json");
  casesPath = join(directory, "cases.json");
  sourcePinsPath = join(directory, "source-pins.json");
  privateDirectory = join(directory, "private-catalog");
  pinPath = join(directory, "catalog-pins.json");
  db = new Database(mirrorPath);
  db.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE vulnerabilities (id TEXT PRIMARY KEY, published TEXT, record_json TEXT NOT NULL);
    CREATE TABLE software (vulnerability_id TEXT, slug TEXT, type TEXT);
  `);
  for (const [key, value] of [
    ["projection_schema", "wordfence-history/v1"],
    ["content_sha256", "a".repeat(64)],
    ["record_count", "2"],
  ])
    db.prepare("INSERT INTO metadata VALUES (?, ?)").run(key, value);
  await writeFile(
    mirrorStatePath,
    JSON.stringify({ content_sha256: "a".repeat(64), record_count: 2 }),
  );
  await writeFile(
    sourcePinsPath,
    JSON.stringify({
      plugins: [
        {
          slug: "sample-plugin",
          version: "1.0",
          kind: "wordpress-org-zip",
          archiveDigest: `sha256:${"b".repeat(64)}`,
        },
      ],
    }),
  );
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

test("pins distinct advisory records and one shared downloadable fixed archive without prose", async () => {
  record("mirror-a", "CVE-2026-11111");
  record("mirror-b", "CVE-2026-22222");
  await writeFile(
    casesPath,
    JSON.stringify({
      schemaVersion: 1,
      cases: [
        caseInput("sample-b", "CVE-2026-22222"),
        caseInput("sample-a", "CVE-2026-11111"),
      ],
    }),
  );
  const result = await catalog.buildRediscoveryCatalog(options());
  const manifestBytes = await readFile(join(privateDirectory, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const publicPin = JSON.parse(await readFile(pinPath, "utf8"));
  expect(result).toEqual({
    manifestDigest: digest(manifestBytes),
    cases: 2,
    fixedArchives: 1,
  });
  expect(manifest.cases).toMatchObject([
    {
      caseId: "sample-a",
      recordId: "mirror-a",
      cve: "CVE-2026-11111",
      publishedAt: "2026-08-05T17:09:31.000Z",
      affectedUpperBound: "1.0",
      declaredPatchedVersion: "1.1",
      fixedVersion: "1.3",
      fixedZipAvailable: true,
      fixedArchiveDigest: digest(zip),
      fixedArchiveBytes: zip.length,
    },
    { caseId: "sample-b", recordId: "mirror-b", fixedVersion: "1.3" },
  ]);
  expect(
    await readFile(
      join(privateDirectory, "fixed-archives/sample-plugin.1.3.zip"),
    ),
  ).toEqual(zip);
  expect(publicPin).toEqual({
    schemaVersion: 1,
    manifestDigest: digest(manifestBytes),
    cases: [
      {
        caseId: "sample-a",
        slug: "sample-plugin",
        vulnerableVersion: "1.0",
        fixedVersion: "1.3",
      },
      {
        caseId: "sample-b",
        slug: "sample-plugin",
        vulnerableVersion: "1.0",
        fixedVersion: "1.3",
      },
    ],
  });
  expect(manifestBytes.toString()).not.toContain("DO_NOT_COPY");
  expect(JSON.stringify(publicPin)).not.toContain("CVE-");
});

test("rejects a mismatched affected bound before writing any pin", async () => {
  record("mirror-a", "CVE-2026-11111", "0.9");
  await writeFile(
    casesPath,
    JSON.stringify({
      schemaVersion: 1,
      cases: [caseInput("sample-a", "CVE-2026-11111")],
    }),
  );
  await expect(catalog.buildRediscoveryCatalog(options())).rejects.toThrow(
    "affected upper bound mismatch",
  );
  await expect(readFile(pinPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("rejects extra private fields and a Git directory for private output", async () => {
  record("mirror-a", "CVE-2026-11111");
  await writeFile(
    casesPath,
    JSON.stringify({
      schemaVersion: 1,
      cases: [
        { ...caseInput("sample-a", "CVE-2026-11111"), description: "answer" },
      ],
    }),
  );
  await expect(catalog.buildRediscoveryCatalog(options())).rejects.toThrow(
    "unknown field",
  );
  await writeFile(
    casesPath,
    JSON.stringify({
      schemaVersion: 1,
      cases: [caseInput("sample-a", "CVE-2026-11111")],
    }),
  );
  await expect(
    catalog.buildRediscoveryCatalog({
      ...options(),
      privateDirectory: process.cwd(),
    }),
  ).rejects.toThrow("outside Git");
  const linked = join(directory, "linked-output");
  await symlink(join(process.cwd(), "docs", "evaluation"), linked, "dir");
  await expect(
    catalog.buildRediscoveryCatalog({ ...options(), privateDirectory: linked }),
  ).rejects.toThrow("outside Git");
});

test("rejects an archive URL outside the official WordPress download host", async () => {
  record("mirror-a", "CVE-2026-11111");
  await writeFile(
    casesPath,
    JSON.stringify({
      schemaVersion: 1,
      cases: [caseInput("sample-a", "CVE-2026-11111")],
    }),
  );
  const malicious = (url: URL | string): Promise<Response> => {
    if (new URL(url).hostname === "api.wordpress.org")
      return Promise.resolve(
        Response.json({
          slug: "sample-plugin",
          versions: { "1.1": "https://example.test/answer.zip" },
        }),
      );
    throw new Error("unexpected archive fetch");
  };
  await expect(
    catalog.buildRediscoveryCatalog(options(malicious)),
  ).rejects.toThrow("not an official ZIP");
  await expect(readFile(pinPath)).rejects.toMatchObject({ code: "ENOENT" });
});
