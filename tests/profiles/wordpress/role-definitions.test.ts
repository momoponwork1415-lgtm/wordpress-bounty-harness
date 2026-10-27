import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadWordPressEnumerationTool,
  WORDPRESS_CURRENT_ENUMERATION_TOOL_IDS,
  WORDPRESS_ENUMERATION_TOOL_IDS,
  WORDPRESS_ENUMERATION_TOOLS,
  wordPressEnumerationToolsDigest,
} from "../../../src/profiles/wordpress/discovery/tools.js";
import {
  loadWordPressRoleDefinition,
  WORDPRESS_CURRENT_ROLE_DEFINITION_IDS,
  WORDPRESS_ROLE_DEFINITIONS,
  WORDPRESS_ROLES,
} from "../../../src/profiles/wordpress/prompts/roles.js";

const run = promisify(execFile);
const agentsUrl = new URL(
  "../../../src/profiles/wordpress/prompts/agents/",
  import.meta.url,
);
const toolsUrl = new URL(
  "../../../src/profiles/wordpress/discovery/tools/",
  import.meta.url,
);
const sha256 = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

// Agent-facing text of a partitioned Trial (ADR 0042): pinned by digest, in
// the wp2shell shape, free of answer clues, target names and attack steps.
const ANSWER_CLUES =
  /\bCVE(?:-\d+)?\b|\badvisor(?:y|ies)\b|\bPoC\b|\bpayload\b|<script\b|\bcurl\s+-|(?:past|previous)\s+(?:fix|patch)|TranslatePress|The Events Calendar|Smash Balloon|ThemePunch|revslider|wpforms|woocommerce|Tourfic|Groundhogg|rtMedia|Relevanssi|Brizy|Elementor/i;

describe("WordPress role definitions", () => {
  it("pins every definition to its digest and names its role in the front matter", async () => {
    for (const row of WORDPRESS_ROLE_DEFINITIONS) {
      const definition = await loadWordPressRoleDefinition(row.id);
      const bytes = await readFile(new URL(`${row.id}.md`, agentsUrl));
      expect(definition.digest).toBe(sha256(bytes));
      expect(definition.digest).toBe(row.digest);
      expect(definition.frontMatter.role).toBe(row.role);
      expect(definition.frontMatter.version).toBe(1);
      expect(definition.body.length).toBeGreaterThan(200);
      expect(Buffer.byteLength(definition.body, "utf8")).toBeLessThan(4_000);
    }
    const onDisk = (await readdir(agentsUrl)).filter((name) =>
      name.endsWith(".md"),
    );
    expect(onDisk.sort()).toEqual(
      WORDPRESS_ROLE_DEFINITIONS.map((row) => `${row.id}.md`).sort(),
    );
    expect(WORDPRESS_CURRENT_ROLE_DEFINITION_IDS).toEqual({
      enumerator: "enumerator-v1",
      tracer: "tracer-v1",
    });
    expect(WORDPRESS_ROLES).toEqual(["enumerator", "tracer"]);
  });

  it("keeps both bodies free of answer clues, bug-type lists and Root vocabulary", async () => {
    for (const row of WORDPRESS_ROLE_DEFINITIONS) {
      const { body, frontMatter } = await loadWordPressRoleDefinition(row.id);
      expect(body).not.toMatch(ANSWER_CLUES);
      expect(body).not.toMatch(
        /\b(?:XSS|SQLi|SQL injection|RCE|LFI|SSRF|CSRF|IDOR)\b/,
      );
      expect(body).not.toMatch(/\broot agent\b|\bspecialist\b|\bREGISTRY\b/i);
      expect(body).not.toMatch(/at least\s+\d+\s+(?:minutes?|hours?)/i);
      expect(body).toContain(
        "You have no internet access and you start no other agents.",
      );
      expect(frontMatter.output).toBe(
        row.role === "enumerator" ? "inventory" : "report",
      );
    }
  });

  it("tells the enumerator to run the tools itself and to split by feature at a fifth to a third of its context", async () => {
    const { body } = await loadWordPressRoleDefinition("enumerator-v1");
    expect(body).toContain("/workspace/tools");
    expect(body).toContain(
      "Run `enumerate-hooks-v1.sh` and `enumerate-sinks-v1.sh` yourself",
    );
    expect(body).toContain("Add what they cannot catch");
    expect(body).toContain("/workspace/output/inventory.json");
    expect(body).toContain("/workspace/output/partitions.json");
    expect(body).toContain("Every row belongs to exactly one partition.");
    expect(body).toContain("about a fifth to a third of its context window");
    expect(body).toContain(
      "comes back to you with the reason, and you decide the new split",
    );
    // No floor: the Harness hands no pre-run output.
    expect(body).not.toMatch(/already (?:listed|enumerated|run)/i);
  });

  it("tells the tracer to read only its partition and to report in the contract's JSON", async () => {
    const { body } = await loadWordPressRoleDefinition("tracer-v1");
    expect(body).toContain("/workspace/input/partition.json");
    expect(body).toContain(
      "do not go looking for entries outside your partition",
    );
    expect(body).toContain(
      "Report a Finding when the source shows an entry connected to an in-scope effect, and a Lead when a trace stops with a named missing edge.",
    );
    expect(body).toContain(
      "the first `sourceTrace` entry is the row you started from",
    );
    expect(body).toContain("even when there are no claims");
  });
});

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("WordPress enumeration tools", () => {
  it("pins every tool file to its digest and digests a tool set by its sorted ids", async () => {
    for (const row of WORDPRESS_ENUMERATION_TOOLS) {
      const tool = await loadWordPressEnumerationTool(row.id);
      expect(tool.digest).toBe(
        sha256(await readFile(new URL(row.file, toolsUrl))),
      );
      expect(tool.digest).toBe(row.digest);
      expect(tool.bytes.length).toBeGreaterThan(300);
      const text = Buffer.from(tool.bytes).toString("utf8");
      expect(text).not.toMatch(ANSWER_CLUES);
      expect(text).not.toMatch(
        /\b(?:XSS|SQLi|SQL injection|RCE|LFI|SSRF|CSRF|IDOR)\b/,
      );
    }
    const onDisk = await readdir(toolsUrl);
    expect(onDisk.sort()).toEqual(
      WORDPRESS_ENUMERATION_TOOLS.map((row) => row.file).sort(),
    );
    expect(WORDPRESS_ENUMERATION_TOOL_IDS).toEqual([
      "enumerate-hooks-v1",
      "enumerate-sinks-v1",
    ]);
    expect(WORDPRESS_CURRENT_ENUMERATION_TOOL_IDS).toEqual(
      WORDPRESS_ENUMERATION_TOOL_IDS,
    );
    expect(
      wordPressEnumerationToolsDigest([
        "enumerate-sinks-v1",
        "enumerate-hooks-v1",
        "enumerate-hooks-v1",
      ]),
    ).toBe(
      wordPressEnumerationToolsDigest([
        "enumerate-hooks-v1",
        "enumerate-sinks-v1",
      ]),
    );
    expect(wordPressEnumerationToolsDigest(["enumerate-hooks-v1"])).not.toBe(
      wordPressEnumerationToolsDigest(["enumerate-sinks-v1"]),
    );
  });

  it("prints tab-separated kind, file, line and text for literal registrations and calls only", async () => {
    const root = await mkdtemp(join(tmpdir(), "wbh-tools-"));
    directories.push(root);
    await writeFile(
      join(root, "plugin.php"),
      [
        "<?php",
        "add_action( 'init', 'demo_boot' );",
        "\tadd_shortcode('demo', [ $this, 'render' ]);",
        "add_action( $dynamic_name, 'demo_dynamic' );",
        "function demo_boot() { echo $value; $wpdb->query( $sql ); include $path; update_option( 'demo', $v ); }",
        "",
      ].join("\n"),
    );
    const sh = async (id: "enumerate-hooks-v1" | "enumerate-sinks-v1") => {
      const tool = await loadWordPressEnumerationTool(id);
      const { stdout } = await run("sh", [
        new URL(tool.sourceUrl).pathname,
        root,
      ]);
      return stdout
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.split("\t"));
    };
    expect(await sh("enumerate-hooks-v1")).toEqual([
      ["hook", "plugin.php", "2", "add_action( 'init', 'demo_boot' );"],
      [
        "hook",
        "plugin.php",
        "4",
        "add_action( $dynamic_name, 'demo_dynamic' );",
      ],
      [
        "shortcode",
        "plugin.php",
        "3",
        "add_shortcode('demo', [ $this, 'render' ]);",
      ],
    ]);
    const sinks = await sh("enumerate-sinks-v1");
    expect(sinks.map(([kind, file, line]) => [kind, file, line])).toEqual([
      ["output", "plugin.php", "5"],
      ["query", "plugin.php", "5"],
      ["file", "plugin.php", "5"],
      ["write", "plugin.php", "5"],
    ]);
    // A source tree with no PHP yields no rows and no failure.
    const empty = await mkdtemp(join(tmpdir(), "wbh-tools-empty-"));
    directories.push(empty);
    const tool = await loadWordPressEnumerationTool("enumerate-hooks-v1");
    expect(
      (await run("sh", [new URL(tool.sourceUrl).pathname, empty])).stdout,
    ).toBe("");
  });

  it("is copied into dist alongside the Markdown and JSON assets", async () => {
    const script = await readFile(
      new URL("../../../scripts/copy-assets.mjs", import.meta.url),
      "utf8",
    );
    expect(script).toContain("/\\.(md|json|sh)$/");
  });
});
