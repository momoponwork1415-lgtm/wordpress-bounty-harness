import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  describeWordPressEntryPlan,
  enumerateWordPressEntryPoints,
  partitionWordPressEntryPoints,
  renderWordPressEntryAssignment,
} from "../../../src/profiles/wordpress/discovery/entry-points.js";

async function syntheticPlugin(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wbh-entry-points-"));
  await mkdir(join(root, "includes"), { recursive: true });
  await mkdir(join(root, "node_modules", "x"), { recursive: true });
  await writeFile(
    join(root, "plugin.php"),
    [
      "<?php",
      "add_action( 'init', 'plugin_boot' );",
      "add_action('wp_ajax_nopriv_plugin_lookup', array( $this, 'lookup' ));",
      "add_action( 'wp_ajax_plugin_lookup', [ $this, 'lookup' ] );",
      "add_action( 'admin_menu', 'plugin_menu' );",
      "add_filter( 'retrieve_password_message', 'plugin_mail', 10, 4 );",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "includes", "api.php"),
    [
      "<?php",
      "register_rest_route( 'plugin/v1', '/items', array( 'callback' => 'x' ) );",
      "register_rest_route( $ns, '/items/(?P<id>\\d+)', [] );",
      "add_shortcode( 'plugin_list', 'plugin_list' );",
      "add_action( 'wp_ajax_plugin_save', 'plugin_save' );",
      "add_action( 'wp_ajax_plugin_delete', 'plugin_delete' );",
      "",
    ].join("\n"),
  );
  await writeFile(join(root, "includes", "style.css"), "add_action('init')");
  await writeFile(
    join(root, "node_modules", "x", "index.php"),
    "<?php add_action( 'wp_ajax_nopriv_ignored', 'f' );",
  );
  return root;
}

describe("WordPress entry-point enumeration", () => {
  it("lists registrations with file and line, most reachable kinds first", async () => {
    const entries = await enumerateWordPressEntryPoints(
      await syntheticPlugin(),
    );
    expect(
      entries.map(
        (entry) => `${entry.kind} ${entry.name} ${entry.file}:${entry.line}`,
      ),
    ).toEqual([
      "ajax-nopriv wp_ajax_nopriv_plugin_lookup plugin.php:3",
      "rest-route 'plugin/v1' /items includes/api.php:2",
      "rest-route $ns /items/(?P<id>\\d+) includes/api.php:3",
      "shortcode plugin_list includes/api.php:4",
      "request-hook init plugin.php:2",
      "request-hook retrieve_password_message plugin.php:6",
      "ajax wp_ajax_plugin_save includes/api.php:5",
      "ajax wp_ajax_plugin_delete includes/api.php:6",
      "ajax wp_ajax_plugin_lookup plugin.php:4",
    ]);
  });

  it("packs entries into partitions by registration file and renders the scope", async () => {
    const entries = await enumerateWordPressEntryPoints(
      await syntheticPlugin(),
    );
    const assignments = partitionWordPressEntryPoints(entries, 4);
    expect(assignments.map((assignment) => assignment.entries.length)).toEqual([
      4, 4, 1,
    ]);
    expect(assignments.map((assignment) => assignment.files)).toEqual([
      ["plugin.php"],
      ["includes/api.php"],
      ["includes/api.php"],
    ]);
    expect(
      new Set(assignments.map((assignment) => assignment.planDigest)).size,
    ).toBe(1);
    expect(assignments[0]!.of).toBe(3);
    const text = renderWordPressEntryAssignment(assignments[0]!);
    expect(text).toContain("## Assigned entry points (partition 1 of 3)");
    expect(text).toContain(
      "- ajax-nopriv `wp_ajax_nopriv_plugin_lookup` — plugin.php:3",
    );
    expect(text).toContain("Registration files: plugin.php");
    expect(text).not.toContain("checklist");
    expect(describeWordPressEntryPlan(assignments)).toContain('"partition":2');
  });

  it("is deterministic and rejects an invalid width", async () => {
    const entries = await enumerateWordPressEntryPoints(
      await syntheticPlugin(),
    );
    expect(partitionWordPressEntryPoints(entries, 3)).toEqual(
      partitionWordPressEntryPoints([...entries].reverse(), 3),
    );
    expect(() => partitionWordPressEntryPoints(entries, 0)).toThrow(
      "Invalid entries per run",
    );
    expect(partitionWordPressEntryPoints([], 8)).toEqual([]);
  });
});
