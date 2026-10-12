import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalDigest } from "../dist/infrastructure/canonical-json.js";
import { openSnapshot } from "../dist/snapshot/index.js";
import {
  acquirePinnedWordPressOrgSvnSource,
  acquiredSourceFromIntakePacket,
  openMaterializedSources,
  openWordPressCoreSource,
  openWordPressOrgTargetSource,
} from "../dist/profiles/wordpress/acquisition/index.js";
import { prepareWordPressLab } from "../dist/profiles/wordpress/lab/provision-input.js";
import { loadWordPressHostConfig } from "../dist/cli/wordpress-host.js";

const execFile = promisify(execFileCallback);
const pinsPath = fileURLToPath(
  new URL("../docs/evaluation/public-source-pins.json", import.meta.url),
);
const limits = {
  maxEntries: 20_000,
  maxFileBytes: 20 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxPathBytes: 512,
  maxDepth: 32,
};
const policy = {
  kind: "target-intake-policy",
  schemaVersion: 1,
  id: "wporg-intake-v1",
  digest: canonicalDigest({ id: "wporg-intake-v1", limits }),
  limits,
};

function argumentsFrom(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      (key !== "--state" && key !== "--host") ||
      value === undefined ||
      options[key] !== undefined
    )
      throw new Error(
        "Usage: node scripts/preflight-unlimited-elements-sources.mjs --state ABSOLUTE_PRIVATE_DIRECTORY --host ABSOLUTE_HOST_CONFIG",
      );
    options[key] = value;
  }
  if (
    !isAbsolute(options["--state"] ?? "") ||
    !isAbsolute(options["--host"] ?? "")
  )
    throw new Error("Both paths must be absolute");
  return options;
}

function one(items, predicate, name) {
  const matches = items.filter(predicate);
  if (matches.length !== 1) throw new Error(`Expected one ${name} pin`);
  return matches[0];
}

function assertTree(source, pin, byteField) {
  const entries = source.manifest.entries;
  const bytes = entries.reduce((total, entry) => total + entry.size, 0);
  if (
    canonicalDigest(source.manifest) !==
    (pin.sourceTreeDigest ?? pin.sourceDigest)
  )
    throw new Error("Dependency source tree digest differs from its pin");
  if (entries.length !== pin.entries || bytes !== pin[byteField])
    throw new Error("Dependency source tree size differs from its pin");
}

async function ensureOutsideGit(path) {
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
        throw new Error("Private state has no real ancestor");
      cursor = parent;
    }
  }
  while (true) {
    try {
      await stat(join(cursor, ".git"));
      throw new Error("Preflight state must be outside Git");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = resolve(cursor, "..");
    if (parent === cursor) break;
    cursor = parent;
  }
}

async function main() {
  const args = argumentsFrom(process.argv.slice(2));
  const state = resolve(args["--state"]);
  await ensureOutsideGit(state);
  await mkdir(state, { recursive: true, mode: 0o700 });
  const stateRealPath = await realpath(state);
  const host = await loadWordPressHostConfig(args["--host"]);
  const pins = JSON.parse(await readFile(pinsPath, "utf8"));
  const targetPin = one(
    pins.plugins,
    (pin) =>
      pin.slug === "unlimited-elements-for-elementor" &&
      pin.version === "2.0.16" &&
      pin.kind === "wordpress-org-svn-export",
    "SVN target",
  );
  const elementorPin = one(
    pins.pluginDependencies,
    (pin) =>
      pin.forSlug === targetPin.slug &&
      pin.forVersion === targetPin.version &&
      pin.slug === "elementor" &&
      pin.kind === "wordpress-org-zip",
    "Elementor dependency",
  );
  if (
    host.images.wordpress.split("@")[1] !==
    pins.wordpressCore.image.split("@")[1]
  )
    throw new Error("Lab image differs from the pinned WordPress core image");

  const scratch = await mkdtemp(join(stateRealPath, "svn-export-"));
  try {
    const exportDirectory = join(scratch, "source");
    await execFile(
      "svn",
      [
        "export",
        "--non-interactive",
        "--ignore-externals",
        "--quiet",
        "--revision",
        String(targetPin.revision),
        targetPin.sourceUrl,
        exportDirectory,
      ],
      { timeout: 180_000, maxBuffer: 64 * 1024 },
    );
    const target = await acquirePinnedWordPressOrgSvnSource({
      sourceDirectory: exportDirectory,
      storageDirectory: join(stateRealPath, "svn-intake"),
      slug: targetPin.slug,
      version: targetPin.version,
      mainPluginFile: "unlimited_elements.php",
      sourceUrl: targetPin.sourceUrl,
      revision: targetPin.revision,
      expectedTree: {
        digest: targetPin.sourceTreeDigest,
        entries: targetPin.entries,
        bytes: targetPin.bytes,
      },
      policy,
    });

    const elementorStore = join(stateRealPath, "elementor-acquisition");
    const elementorSource = openWordPressOrgTargetSource({
      storageDirectory: elementorStore,
    });
    const observation = await elementorSource.observe({
      kind: "wordpress-org-target-observe",
      schemaVersion: 1,
      slug: elementorPin.slug,
    });
    if (observation.status !== "observed")
      throw new Error(
        `Elementor observation ${observation.status}: ${observation.reason}`,
      );
    const acquired = await elementorSource.acquire({
      kind: "wordpress-org-target-acquire",
      schemaVersion: 1,
      observationRef: observation.observationRef,
      requestedVersion: elementorPin.version,
      policy,
    });
    if (acquired.status !== "ready")
      throw new Error(`Elementor acquisition ${acquired.status}`);
    if (
      acquired.acquisitionOriginalRef.digest !== elementorPin.archiveDigest ||
      acquired.acquisitionOriginal.size !== elementorPin.archiveBytes ||
      acquired.acquisitionOriginal.sourceUrl !== elementorPin.sourceUrl
    )
      throw new Error("Elementor archive differs from its official pin");
    const elementorPacket = acquired.intake.packet;
    const elementor = acquiredSourceFromIntakePacket(
      elementorPacket,
      join(elementorStore, "target-intake"),
    );
    assertTree(elementor, elementorPin, "sourceBytes");

    const coreSources = await openWordPressCoreSource({
      dockerExecutablePath: host.dockerExecutablePath,
      image: host.images.wordpress,
      stagingDirectory: join(stateRealPath, "wordpress-core"),
      expectedVersion: pins.wordpressCore.version,
    })();
    if (coreSources.length !== 1)
      throw new Error("Expected one WordPress core source");
    const core = coreSources[0];
    assertTree(core, pins.wordpressCore, "bytes");

    const sources = openMaterializedSources({
      rootDirectory: join(stateRealPath, "sources"),
    });
    const snapshotStore = openSnapshot({
      storageDirectory: join(stateRealPath, "snapshots"),
      source: sources.acquisition({
        acquire: async () => ({
          target: target.source,
          dependencies: [elementor, core],
        }),
      }),
    });
    const snapshot = await snapshotStore.freeze(null);
    const prepared = await prepareWordPressLab(
      snapshot,
      {
        schemaVersion: 1,
        snapshotDigest: snapshot.digest,
        siteTitle: "Unlimited Elements source preflight",
        initialPosts: [],
        customerRole: false,
        databaseAccess: "none",
      },
      sources,
    );
    if (
      prepared.target.slug !== targetPin.slug ||
      prepared.dependencies.map((item) => item.slug).join() !==
        elementorPin.slug ||
      prepared.coreVersion !== pins.wordpressCore.version
    )
      throw new Error(
        "Lab dependency preparation differs from the pinned snapshot",
      );

    const report = {
      schemaVersion: 1,
      status: "source-and-dependency-ready",
      target: {
        slug: targetPin.slug,
        version: targetPin.version,
        sourceKind: "wordpress-org-svn-export",
        revision: targetPin.revision,
        sourceDigest: snapshot.target.sourceDigest,
      },
      dependencies: snapshot.dependencies,
      snapshotDigest: snapshot.digest,
      labPreparation: "static-only",
      providerTrials: 0,
    };
    await writeFile(
      join(stateRealPath, "preflight-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

await main();
