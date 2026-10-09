import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  enumerateWordPressEntryPoints,
  entryKey,
  planWordPressEntryAssignments,
  renderWordPressEntryAssignment,
  partitionWordPressEntryPoints,
} from "../../../src/profiles/wordpress/discovery/entry-points.js";
import { buildWordPressSourceIndex } from "../../../src/profiles/wordpress/discovery/storage-index.js";

const fixture = join(
  import.meta.dirname,
  "..",
  "..",
  "fixtures",
  "wordpress-source-index",
);

describe("WordPress source index", () => {
  it("connects producers and consumers, retains dynamic keys outside components, and scans one include hop", async () => {
    const index = await buildWordPressSourceIndex(fixture, "plugin");
    expect(index.incomplete).toBe(false);
    const pair = index.components.find((component) =>
      component.keys.includes("option:plugin_shared"),
    );
    expect(pair?.entries).toHaveLength(2);
    expect(pair?.producers).toHaveLength(1);
    expect(pair?.consumers.some((key) => key.includes("plugin_load"))).toBe(
      true,
    );
    expect(
      index.dynamicStorage.some(
        (ref) => ref.kind === "option" && ref.key === "dynamic",
      ),
    ).toBe(true);
    expect(
      index.components.every(
        (component) => !component.keys.includes("option:dynamic"),
      ),
    ).toBe(true);
    const save = index.entries.find((entry) =>
      entry.name.includes("plugin_save"),
    );
    expect(save?.callback).toBe("plugin_save");
    expect(save?.reach).toContain("includes/extra.php");
    expect(save?.storage.some((ref) => ref.key === "plugin_extra")).toBe(true);
    const mail = index.entries.find(
      (entry) => entry.name === "retrieve_password_message",
    );
    expect(
      mail?.crossings.some(
        (crossing) =>
          crossing.kind === "core-hook-callback" &&
          crossing.name === "retrieve_password_message",
      ),
    ).toBe(true);
    expect(
      save?.crossings.some(
        (crossing) =>
          crossing.kind === "core-hook-callback" &&
          crossing.name === "retrieve_password_message",
      ),
    ).toBe(false);
    expect(
      save?.crossings.some(
        (crossing) =>
          crossing.kind === "core-api-call" &&
          crossing.name === "wp_set_auth_cookie",
      ),
    ).toBe(true);
    expect(index.settingsKeys).toContain("plugin_shared");
  });

  it("splits an oversized component at a key boundary on both sides and digests independently of input order", async () => {
    const entries = await enumerateWordPressEntryPoints(fixture);
    const index = await buildWordPressSourceIndex(fixture, "plugin", entries);
    const reversed = await buildWordPressSourceIndex(
      fixture,
      "plugin",
      [...entries].reverse(),
    );
    expect(reversed.digest).toBe(index.digest);
    const assignments = planWordPressEntryAssignments(index, 1);
    const boundary = assignments.filter((assignment) =>
      assignment.boundaryKeys?.includes("option:plugin_shared"),
    );
    expect(boundary).toHaveLength(2);
    expect(
      boundary.every((assignment) =>
        renderWordPressEntryAssignment(assignment).includes(
          "Boundary keys shared",
        ),
      ),
    ).toBe(true);
    expect(assignments[0]?.planDigest).toMatch(/^sha256:/);
    expect(assignments[0]?.indexDigest).toBe(index.digest);
    expect(renderWordPressEntryAssignment(assignments[0]!)).toContain(
      "Storage keys in scope:",
    );
  });

  it("keeps the original partitions when every entry is a singleton component", async () => {
    const root = await mkdtemp(join(tmpdir(), "wbh-singleton-index-"));
    try {
      await writeFile(
        join(root, "plugin.php"),
        "<?php\nadd_action('wp_ajax_nopriv_one', 'one');\nadd_action('wp_ajax_nopriv_two', 'two');\nfunction one() {}\nfunction two() {}\n",
      );
      const entries = await enumerateWordPressEntryPoints(root);
      const index = await buildWordPressSourceIndex(root, "plugin", entries);
      const legacy = partitionWordPressEntryPoints(entries, 2);
      const planned = planWordPressEntryAssignments(index, 2);
      expect(
        planned.map((assignment) => assignment.entries.map(entryKey)),
      ).toEqual(legacy.map((assignment) => assignment.entries.map(entryKey)));
      expect(planned.map((assignment) => assignment.files)).toEqual(
        legacy.map((assignment) => assignment.files),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks an oversized file as a partial index instead of throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "wbh-partial-index-"));
    try {
      await writeFile(
        join(root, "large.php"),
        `<?php\n${" ".repeat(2 * 1024 * 1024)}`,
      );
      const index = await buildWordPressSourceIndex(root, "plugin");
      expect(index.incomplete).toBe(true);
      expect(index.entries).toEqual([]);
      expect(
        renderWordPressEntryAssignment(
          planWordPressEntryAssignments(index, 8)[0]!,
        ),
      ).toContain("Index: partial (limit reached)");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks components exceeding 200 keys as partial", async () => {
    const root = await mkdtemp(join(tmpdir(), "wbh-many-keys-index-"));
    try {
      const keys = Array.from(
        { length: 201 },
        (_, index) => `plugin_key_${index}`,
      );
      await writeFile(
        join(root, "plugin.php"),
        [
          "<?php",
          "add_action('wp_ajax_nopriv_write', 'write_keys');",
          "add_action('wp_ajax_nopriv_read', 'read_keys');",
          "function write_keys() {",
          ...keys.map((key) => `update_option('${key}', 'v');`),
          "}",
          "function read_keys() {",
          ...keys.map((key) => `get_option('${key}');`),
          "}",
        ].join("\n"),
      );
      const index = await buildWordPressSourceIndex(root, "plugin");
      expect(index.incomplete).toBe(true);
      expect(
        index.components.find((component) => component.keys.length > 200)
          ?.entries,
      ).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
