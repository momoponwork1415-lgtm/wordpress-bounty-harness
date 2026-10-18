import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  planWordPressEntryAssignments,
  renderWordPressEntryAssignment,
  renderWordPressEntryIndex,
} from "../../../src/profiles/wordpress/discovery/entry-points.js";
import { buildWordPressSourceIndex } from "../../../src/profiles/wordpress/discovery/storage-index.js";
import {
  describeWordPressUnresolved,
  scanWordPressUnresolved,
} from "../../../src/profiles/wordpress/discovery/unresolved.js";

const php = (...lines: string[]) => ["<?php", ...lines].join("\n");
const located = (text: string) =>
  scanWordPressUnresolved(text, "p.php").map(
    (item) => `${item.kind} ${item.file}:${item.line}`,
  );

describe("WordPress unresolved registrations", () => {
  it("records hooks whose name is a variable, concatenation, interpolation or constant", () => {
    expect(
      located(
        php(
          "add_action( $hook, 'cb' );",
          "add_action( 'wp_ajax_' . self::SLUG, array( $this, 'save' ) );",
          "add_filter( \"{$prefix}_load\", 'cb' );",
          "add_action( MY_HOOK, 'cb' );",
          '$this->loader->add_action( "wp_ajax_$name", $this, "run" );',
        ),
      ),
    ).toEqual([
      "dynamic-hook p.php:2",
      "dynamic-hook p.php:3",
      "dynamic-hook p.php:4",
      "dynamic-hook p.php:5",
      "dynamic-hook p.php:6",
    ]);
  });

  it("records REST routes whose second argument is not a plain literal", () => {
    expect(
      located(
        php(
          "register_rest_route( $ns, '/' . $this->base, array() );",
          "register_rest_route( 'plugin/v1', $route, [] );",
          "register_rest_route( 'plugin/v1', \"/items/{$id}\", [] );",
        ),
      ),
    ).toEqual([
      "dynamic-rest-route p.php:2",
      "dynamic-rest-route p.php:3",
      "dynamic-rest-route p.php:4",
    ]);
  });

  it("records switch and call_user_func dispatchers on an action, task or cmd parameter", () => {
    expect(
      located(
        php(
          "switch ( $_REQUEST['action'] ) { case 'a': break; }",
          "$task = sanitize_text_field( $_POST['task'] );",
          "call_user_func( array( $this, 'do_' . $task ) );",
          "call_user_func_array( $request->get_param( 'cmd' ), $args );",
          "switch ( $mode ) { default: break; }",
          "call_user_func( $callback );",
        ),
      ),
    ).toEqual([
      "dispatcher p.php:2",
      "dispatcher p.php:4",
      "dispatcher p.php:5",
    ]);
  });

  it("does not count literal registrations", () => {
    expect(
      located(
        php(
          "add_action( 'wp_ajax_nopriv_plugin_lookup', array( $this, 'lookup' ) );",
          'add_filter( "the_content", "plugin_filter", 10, 2 );',
          "register_rest_route( $ns, '/items/(?P<id>\\d+)', array( 'callback' => 'x' ) );",
          "register_rest_route( 'plugin/v1', '/items', [] );",
          "function add_action( $hook, $callback ) {}",
        ),
      ),
    ).toEqual([]);
  });

  it("keeps unresolved apart from incomplete and out of agent-facing text", async () => {
    const root = await mkdtemp(join(tmpdir(), "wbh-unresolved-index-"));
    try {
      await writeFile(
        join(root, "plugin.php"),
        php(
          "add_action( 'wp_ajax_nopriv_plugin_lookup', 'lookup' );",
          "add_action( 'wp_ajax_' . $slug, 'save' );",
          "register_rest_route( 'plugin/v1', '/' . $base, [] );",
          "switch ( $_GET['action'] ) { default: break; }",
          "function lookup() { get_option( 'plugin_shared' ); }",
        ),
      );
      const index = await buildWordPressSourceIndex(root, "plugin");
      expect(index.incomplete).toBe(false);
      expect(index.unresolved).toEqual([
        { kind: "dynamic-hook", file: "plugin.php", line: 3 },
        { kind: "dynamic-rest-route", file: "plugin.php", line: 4 },
        { kind: "dispatcher", file: "plugin.php", line: 5 },
      ]);
      expect(describeWordPressUnresolved(index.unresolvedCounts)).toBe(
        "Unresolved registrations: dynamic-hook 1, dynamic-rest-route 1, dispatcher 1",
      );
      const cleared = {
        ...index,
        unresolved: [],
        unresolvedCounts: {
          "dynamic-hook": 0,
          "dynamic-rest-route": 0,
          dispatcher: 0,
        },
      };
      expect(renderWordPressEntryIndex(index)).toBe(
        renderWordPressEntryIndex(cleared),
      );
      const render = (value: typeof index) =>
        planWordPressEntryAssignments(value, 8).map((assignment) =>
          renderWordPressEntryAssignment(assignment, true),
        );
      expect(render(index)).toEqual(render(cleared));
      expect(
        [renderWordPressEntryIndex(index), ...render(index)].join("\n"),
      ).not.toMatch(/unresolved|dynamic-hook|dispatcher/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
