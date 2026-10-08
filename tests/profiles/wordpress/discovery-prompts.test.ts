import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  loadWordPressDiscoveryAsset,
  WORDPRESS_DISCOVERY_ASSET_IDS,
  WORDPRESS_DISCOVERY_PROMPT_IDS,
} from "../../../src/profiles/wordpress/prompts/index.js";

describe("WordPress discovery prompt assets", () => {
  it("publishes two versioned prompt variants and the shared boundary and assignment rules", async () => {
    expect(WORDPRESS_DISCOVERY_ASSET_IDS).toEqual([
      "wp2shell-derived-v1",
      "short-objective-v1",
      "trust-boundary-v1",
      "file-assignment-v1",
    ]);
    expect(WORDPRESS_DISCOVERY_PROMPT_IDS).toEqual([
      "wp2shell-derived-v1",
      "short-objective-v1",
    ]);

    for (const id of WORDPRESS_DISCOVERY_ASSET_IDS) {
      const asset = await loadWordPressDiscoveryAsset(id);
      const bytes = await readFile(asset.sourceUrl);
      expect(asset.id).toBe(id);
      expect(asset.text).toBe(bytes.toString("utf8"));
      expect(asset.digest).toBe(
        `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      );
      expect(asset.text.length).toBeGreaterThan(100);
    }
  });

  it("keeps every discovery input free of known vulnerability clues", async () => {
    for (const id of WORDPRESS_DISCOVERY_ASSET_IDS) {
      const { text } = await loadWordPressDiscoveryAsset(id);
      expect(text).not.toMatch(/\bCVE(?:-\d+)?\b/i);
      expect(text).not.toMatch(/\badvisor(?:y|ies)\b/i);
      expect(text).not.toMatch(/\bPoC\b/i);
      expect(text).not.toMatch(/(?:past|previous)\s+(?:fix|patch)/i);
      expect(text).not.toMatch(/過去(?:の)?修正|既知(?:の)?脆弱性/);
    }
  });

  it("rejects an unknown asset ID at the public boundary", async () => {
    await expect(
      loadWordPressDiscoveryAsset("../policy/programme-scope" as never),
    ).rejects.toThrow("Unknown WordPress discovery asset");
  });

  it("keeps both variants within the same attacker, operation, impact and Finding contract", async () => {
    for (const id of WORDPRESS_DISCOVERY_PROMPT_IDS) {
      const { text } = await loadWordPressDiscoveryAsset(id);
      expect(text).toContain("unauthenticated");
      expect(text).toContain("subscriber");
      expect(text).toContain("customer");
      expect(text).toContain("rce");
      expect(text).toContain("stored-xss");
      expect(text).toContain("attackerPosition");
      expect(text).toContain("configurationPrecondition");
      expect(text).toContain("sourceTrace");
      expect(text).not.toMatch(
        /\/flag|at least 6 hours|guaranteed vulnerability/i,
      );
    }
  });

  it("defines the human trust boundary and entry-point work units", async () => {
    const trust = await loadWordPressDiscoveryAsset("trust-boundary-v1");
    expect(trust.text).toContain("human operator reviews and versions");
    expect(trust.text).toContain("contributor");
    expect(trust.text).toContain("administrator");
    expect(trust.text).toContain("unfiltered_html");

    const assignment = await loadWordPressDiscoveryAsset("file-assignment-v1");
    expect(assignment.text).toContain("hook callback");
    expect(assignment.text).toContain("registered route");
    expect(assignment.text).toContain("AJAX action");
    expect(assignment.text).toContain("shared by several units");
    expect(assignment.text).toContain("snapshot digest");
  });
});
