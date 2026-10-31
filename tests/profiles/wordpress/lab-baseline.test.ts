import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDigest } from "../../../src/infrastructure/canonical-json.js";
import { measureCanonicalSourceTree } from "../../../src/infrastructure/canonical-source-tree.js";
import {
  CURRENT_WORDPRESS_LAB_BASELINE_ID,
  deniedToAttacker,
  loadWordPressLabBaseline,
  parseWordPressLabBaseline,
  requestPath,
} from "../../../src/profiles/wordpress/lab/baseline.js";
import { FILTERING_HOST_GATEWAY_SCRIPT } from "../../../src/profiles/wordpress/lab/host-exposure.js";
import {
  openWordPressLab,
  type DockerRequest,
} from "../../../src/profiles/wordpress/lab/index.js";
import type { Snapshot } from "../../../src/snapshot/index.js";
import { baselineDockerAnswers } from "../../support/lab-baseline-docker.js";

// #699: 検証 Lab の基準環境（hosting-default-v1）の置き場、版、記録、読み戻し。
// #706: v2 はパーマリンク /%postname%/ と WordPress 標準の書き換えブロックを足す。

const sha = (value: string) => `sha256:${value.repeat(64)}`;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const BASELINE_FILE = new URL(
  "../../../src/profiles/wordpress/lab/baselines/hosting-default-v1.json",
  import.meta.url,
);

async function labFixture(options: { readonly drift?: readonly string[] }) {
  const root = await mkdtemp(join(tmpdir(), "wbh-lab-baseline-"));
  directories.push(root);
  const sourceDirectory = join(root, "source");
  await mkdir(sourceDirectory);
  await writeFile(join(sourceDirectory, "example.php"), "<?php // fixture\n");
  const tree = await measureCanonicalSourceTree(sourceDirectory, {
    maxEntries: 10,
    maxBytes: 1000,
  });
  const body = {
    kind: "source-snapshot" as const,
    schemaVersion: 1 as const,
    target: { identity: "example", version: "1.0", sourceDigest: tree.digest },
    dependencies: [],
  };
  const snapshot: Snapshot = { ...body, digest: canonicalDigest(body) };
  const commands: DockerRequest[] = [];
  const answers = baselineDockerAnswers(
    options.drift === undefined ? {} : { drift: options.drift },
  );
  const ok = (stdout = "ok") => ({ exitCode: 0, stdout, stderr: "" });
  const lab = openWordPressLab({
    dockerExecutablePath: "/usr/bin/docker",
    ownerDirectory: join(root, "lab-owners"),
    images: {
      database: `mariadb@${sha("1")}`,
      wordpress: `wordpress@${sha("2")}`,
      wordpressCli: `wordpress-cli@${sha("3")}`,
      browser: `verification-browser@${sha("4")}`,
      recorder: `node-recorder@${sha("5")}`,
    },
    source: {
      resolve: async () => ({
        target: {
          kind: "plugin",
          pluginSlug: "example",
          sourceDirectory,
          sourceTree: tree,
        },
        dependencies: [],
      }),
    },
    runner: {
      async run(request) {
        commands.push(request);
        const answered = answers(request.args);
        if (answered !== null) return answered;
        if (request.args[0] === "info") return ok('{"runsc":{}}');
        if (request.args[0] === "inspect") return ok("172.20.0.2");
        return ok();
      },
    },
    healthAttempts: 1,
  });
  const setup = {
    schemaVersion: 1 as const,
    snapshotDigest: snapshot.digest,
    siteTitle: "Synthetic",
    initialPosts: [],
    customerRole: false,
  };
  return { lab, snapshot, setup, commands };
}

describe("the verification Lab baseline (#699)", () => {
  it("loads hosting-default-v1 and digests the file's content", async () => {
    const { baseline, ref } =
      await loadWordPressLabBaseline("hosting-default-v1");
    expect(ref.id).toBe("hosting-default-v1");
    // #706: v1 stays as recorded; a new value is a new file.
    expect(ref.digest).toBe(
      "sha256:e909f7950403e25bc988dcd9b7920a27fb599c822bbc3ca611e6d26d85a21e2c",
    );
    expect(baseline.reference).toBe(
      "docs/reviews/2026-10-31-hosting-defaults.md",
    );
    expect(ref.digest).toBe(canonicalDigest(baseline));
    const text = await readFile(BASELINE_FILE, "utf8");
    // One character of a value changes the digest.
    const changed = parseWordPressLabBaseline(
      text.replace('"value": "755"', '"value": "775"'),
    );
    expect(changed.ref.digest).not.toBe(ref.digest);
    // Only the attacker origin's common four paths are denied; admin-ajax and admin-post stay open.
    expect(baseline.attacker).toMatchObject({
      origin: "foreign",
      adminEndpoints: "lenient",
    });
    expect(baseline.attacker.deniedPaths.map((rule) => rule.path)).toEqual([
      "/wp-admin",
      "/wp-login.php",
      "/xmlrpc.php",
      "/wlwmanifest.xml",
    ]);
  });

  it("makes hosting-default-v2 current: v1 plus /%postname%/ permalinks and the standard rewrite block (#706)", async () => {
    expect(CURRENT_WORDPRESS_LAB_BASELINE_ID).toBe("hosting-default-v2");
    const v1 = await loadWordPressLabBaseline("hosting-default-v1");
    const v2 = await loadWordPressLabBaseline(
      CURRENT_WORDPRESS_LAB_BASELINE_ID,
    );
    expect(v2.ref.id).toBe("hosting-default-v2");
    expect(v2.ref.digest).not.toBe(v1.ref.digest);
    expect(v2.baseline.attacker).toEqual(v1.baseline.attacker);
    expect(v2.baseline.settings).toEqual([
      ...v1.baseline.settings.filter((item) => item.target !== "web-server"),
      {
        target: "wordpress",
        name: "permalink-structure",
        value: "/%postname%/",
      },
      { target: "web-server", name: "htaccess", value: "wordpress-rewrite" },
    ]);
  });

  it("sets /%postname%/ and writes the rewrite block only when .htaccess has none, before files go to 644 (#706)", async () => {
    const f = await labFixture({});
    const { ref } = await loadWordPressLabBaseline("hosting-default-v2");
    const ready = await f.lab.provision(
      f.snapshot,
      { ...f.setup, baseline: ref },
      { purpose: "verification" },
    );
    expect(ready.status).toBe("ready");
    const commands = f.commands.map(({ args }) => args);
    const lines = commands.map((args) => args.join(" "));
    const activated = lines.findIndex((line) =>
      line.endsWith("wp plugin activate example"),
    );
    const structure = lines.findIndex((line) =>
      line.endsWith("wp rewrite structure /%postname%/"),
    );
    const htaccess = commands.findIndex((args) =>
      args.some((arg) => arg.startsWith("WBH_BASELINE_HTACCESS=")),
    );
    const chmod = lines.findIndex((line) => line.includes("chmod 644 {} +"));
    expect(structure).toBeGreaterThan(activated);
    expect(htaccess).toBeGreaterThan(activated);
    expect(htaccess).toBeLessThan(chmod);
    const write = commands[htaccess]!;
    const block = write
      .find((arg) => arg.startsWith("WBH_BASELINE_HTACCESS="))!
      .slice("WBH_BASELINE_HTACCESS=".length);
    expect(block.split("\n")).toEqual(
      expect.arrayContaining([
        "# BEGIN WordPress",
        "RewriteEngine On",
        "RewriteBase /",
        "RewriteRule . /index.php [L]",
        "# END WordPress",
      ]),
    );
    // The block travels as data and is appended only when none is there.
    const script = write.at(-1)!;
    expect(script).not.toContain("RewriteRule");
    expect(script).toContain("grep -q '^# BEGIN WordPress'");
    expect(script).toContain(">>");
    expect(script).toContain("chown www-data:www-data");
    // Both read back: the option and the block's lines in the file.
    expect(
      lines.some((line) => line.endsWith("wp option get permalink_structure")),
    ).toBe(true);
    expect(
      commands.some((args) =>
        args.some((arg) => arg.startsWith("WBH_BASELINE_HTACCESS_LINES=")),
      ),
    ).toBe(true);
  });

  it.each([["permalink-structure"], ["rewrite-block"]])(
    "stops a v2 Lab at the seed stage when %s does not read back (#706)",
    async (setting) => {
      const f = await labFixture({ drift: [setting] });
      const { ref } = await loadWordPressLabBaseline("hosting-default-v2");
      const result = await f.lab.provision(
        f.snapshot,
        { ...f.setup, baseline: ref },
        { purpose: "verification" },
      );
      expect(result).toMatchObject({
        status: "incomplete",
        reason: "provision",
        stage: "seed",
        baseline: ref,
      });
    },
  );

  it("refuses an unknown kind of setting and an unknown baseline id", async () => {
    const text = await readFile(BASELINE_FILE, "utf8");
    const unknown = JSON.parse(text) as { settings: unknown[] };
    unknown.settings.push({ target: "waf", name: "rules", value: "on" });
    expect(() => parseWordPressLabBaseline(JSON.stringify(unknown))).toThrow();
    await expect(loadWordPressLabBaseline("hosting-other-v9")).rejects.toThrow(
      /Unknown Lab baseline/,
    );
  });

  it.each([
    ["/wp-admin/", true],
    ["/wp-admin", true],
    ["/wp-admin/options.php", true],
    ["/wp-admin/admin-ajax.php", false],
    ["/wp-admin/admin-post.php", false],
    ["/wp-login.php?action=lostpassword", true],
    ["//wp-login.php", true],
    ["/%77p-login.php", true],
    ["/a/../xmlrpc.php", true],
    ["/wp-includes/wlwmanifest.xml", true],
    ["/wp-json/wp/v2/posts", false],
    ["/?rest_route=/wp/v2/posts", false],
    ["/wp-comments-post.php", false],
    ["/%zz", true],
  ])("answers %s with 403: %s", async (url, denied) => {
    const { baseline } = await loadWordPressLabBaseline("hosting-default-v1");
    const path = requestPath(url);
    expect(
      path === null || deniedToAttacker(baseline.attacker.deniedPaths, path),
    ).toBe(denied);
  });

  it("compiles the filtering host gateway with the same matcher source", () => {
    expect(() => new Script(FILTERING_HOST_GATEWAY_SCRIPT)).not.toThrow();
    expect(FILTERING_HOST_GATEWAY_SCRIPT).toContain("deniedToAttacker");
  });

  it("applies the baseline, reads it back and names it on the handle and in the setup digest", async () => {
    const plain = await labFixture({});
    const without = await plain.lab.provision(plain.snapshot, plain.setup, {
      purpose: "verification",
    });
    const { ref } = await loadWordPressLabBaseline("hosting-default-v1");
    const based = await labFixture({});
    const ready = await based.lab.provision(
      based.snapshot,
      { ...based.setup, baseline: ref },
      { purpose: "verification" },
    );
    expect(ready.status).toBe("ready");
    expect(without.status).toBe("ready");
    if (ready.status !== "ready" || without.status !== "ready") return;
    expect(ready.handle.baseline).toEqual(ref);
    expect(without.handle.baseline).toBeUndefined();
    expect(ready.handle.setupDigest).not.toBe(without.handle.setupDigest);
    const commands = based.commands.map(({ args }) => args.join(" "));
    // The image's bundled plugins go before the Snapshot's are installed.
    const deleted = commands.findIndex((line) =>
      line.endsWith("wp plugin delete --all"),
    );
    const activated = commands.findIndex((line) =>
      line.endsWith("wp plugin activate example"),
    );
    expect(deleted).toBeGreaterThan(0);
    expect(deleted).toBeLessThan(activated);
    expect(
      commands.some(
        (line) =>
          line.includes("WBH_BASELINE_INI=display_errors = Off") &&
          line.includes("allow_url_fopen = On"),
      ),
    ).toBe(true);
    expect(
      commands.some((line) => line.endsWith("apache2ctl -k graceful")),
    ).toBe(true);
    expect(
      commands.some((line) => line.includes("chmod 755 {} +")) &&
        commands.some((line) => line.includes("chmod 644 {} +")),
    ).toBe(true);
    expect(
      based.lab.attackerEntrance(ready.handle, "unauthenticated"),
    ).toMatchObject({ origin: "foreign", deniedPaths: { length: 4 } });
    expect(
      plain.lab.attackerEntrance(without.handle, "unauthenticated"),
    ).toBeNull();
  });

  it.each(["subscriber", "customer", "contributor"])(
    "puts a %s attacker at the domestic origin, so /wp-login.php stays open",
    async (position) => {
      const f = await labFixture({});
      const { baseline, ref } =
        await loadWordPressLabBaseline("hosting-default-v1");
      const ready = await f.lab.provision(
        f.snapshot,
        { ...f.setup, baseline: ref },
        { purpose: "verification" },
      );
      if (ready.status !== "ready") throw new Error("Lab not ready");
      // The default stays foreign; only a logged-in position is domestic.
      expect(baseline.attacker.origin).toBe("foreign");
      const signedIn = f.lab.attackerEntrance(ready.handle, position);
      expect(signedIn).toEqual({ origin: "domestic", deniedPaths: [] });
      expect(deniedToAttacker(signedIn!.deniedPaths, "/wp-login.php")).toBe(
        false,
      );
      const visitor = f.lab.attackerEntrance(ready.handle, "unauthenticated");
      expect(deniedToAttacker(visitor!.deniedPaths, "/wp-login.php")).toBe(
        true,
      );
    },
  );

  it.each([
    ["display_errors"],
    ["file-mode"],
    ["bundled-plugins"],
    ["htaccess"],
  ])("stops at the seed stage when %s does not read back", async (setting) => {
    const f = await labFixture({ drift: [setting] });
    const { ref } = await loadWordPressLabBaseline("hosting-default-v1");
    const result = await f.lab.provision(
      f.snapshot,
      { ...f.setup, baseline: ref },
      { purpose: "verification" },
    );
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "provision",
      stage: "seed",
      labId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      baseline: ref,
    });
  });

  it("refuses a setup whose baseline digest differs before starting any container", async () => {
    const f = await labFixture({});
    const result = await f.lab.provision(
      f.snapshot,
      { ...f.setup, baseline: { id: "hosting-default-v1", digest: sha("9") } },
      { purpose: "verification" },
    );
    expect(result).toMatchObject({ status: "incomplete", reason: "provision" });
    expect(result).not.toHaveProperty("stage");
    expect(f.commands.filter(({ args }) => args[0] === "run")).toEqual([]);
  });
});
