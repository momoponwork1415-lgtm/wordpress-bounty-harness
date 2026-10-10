import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  loadWordPressDiscoveryAsset,
  loadWordPressVerifierPrompt,
  WORDPRESS_DISCOVERY_ASSET_IDS,
  WORDPRESS_DISCOVERY_PROMPT_IDS,
} from "../../../src/profiles/wordpress/prompts/index.js";

describe("WordPress discovery prompt assets", () => {
  it("pins the Verifier prompt and keeps known answers and attack strings out", async () => {
    const prompt = await loadWordPressVerifierPrompt();
    expect(prompt.digest).toBe(
      "sha256:ddff21a73b534fd4c775163195f838e428124cf481fedad8ae9f3948dd1acd1d",
    );
    expect(prompt.text).toContain("http.json");
    expect(prompt.text).toContain("refutation.md");
    expect(prompt.text).not.toMatch(
      /\bCVE-\d{4}-\d+\b|\bPoC\b|\bpayload\b|既知(?:の)?脆弱性/i,
    );
    expect(prompt.text).not.toMatch(
      /\b(?:curl|python|php)\s+-|\/wp-admin\/admin-ajax\.php|<script\b/i,
    );
  });
  it("publishes versioned prompt variants and the shared trust boundary", async () => {
    expect(WORDPRESS_DISCOVERY_ASSET_IDS).toEqual([
      "wp2shell-derived-v1",
      "short-objective-v1",
      "wp2shell-derived-v2",
      "short-objective-v2",
      "short-objective-managed-v1",
      "short-objective-managed-v2",
      "short-objective-managed-v3",
      "short-objective-managed-v4",
      "wp2shell-single-http-v2",
      "wp2shell-bounty-v1",
      "wp2shell-bounty-v2",
      "trust-boundary-v1",
    ]);
    expect(WORDPRESS_DISCOVERY_PROMPT_IDS).toEqual([
      "wp2shell-derived-v1",
      "short-objective-v1",
      "wp2shell-derived-v2",
      "short-objective-v2",
      "short-objective-managed-v1",
      "short-objective-managed-v2",
      "short-objective-managed-v3",
      "short-objective-managed-v4",
      "wp2shell-single-http-v2",
      "wp2shell-bounty-v1",
      "wp2shell-bounty-v2",
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

  it("states the structured source trace contract in both comparison arms", async () => {
    for (const id of [
      "short-objective-managed-v4",
      "wp2shell-bounty-v2",
    ] as const) {
      const { text } = await loadWordPressDiscoveryAsset(id);
      expect(text).toContain(
        "Each `sourceTrace` entry is an object with `file`",
      );
      expect(text).toContain("`labObservations`");
      expect(text).toContain("positive integer");
    }
  });

  it("pins the v2 bytes and excludes answer clues and scripted commands", async () => {
    const pins = {
      "short-objective-v2":
        "sha256:e6a7a1650f2af3c1e34d73a42c2d378497f4553818967cb804227cbd01436809",
      "short-objective-managed-v1":
        "sha256:58460c592c424fe752c8e9fdf0b53b686302ee1e11d72a48a06dc9109a496215",
      "short-objective-managed-v2":
        "sha256:05331cbdf24b49b6352020ce6faf84f5d005e275d0665f88287c9ae7c4d54825",
      "short-objective-managed-v3":
        "sha256:989cec70830ff7d145e3c72fd9a984cacd253d181c253851e070f3bff50e6bab",
      "short-objective-managed-v4":
        "sha256:7aa340bdab52d28f0830f38b43703e958d44e163b3ac937ff7be7896ccd73040",
      "wp2shell-derived-v2":
        "sha256:f9d90b8ad1dd955527756bf9ad9869624cff999dd7fab3908a7f050b1cd422be",
      "wp2shell-single-http-v2":
        "sha256:a466aa5d5abba7ff18b70135d3ae7730880674652c87fd65feaa3534765904fe",
      "wp2shell-bounty-v1":
        "sha256:5b334f59d315d6cee721b7dc698353ed5a9f44553474dd87c7aac7192d832a98",
      "wp2shell-bounty-v2":
        "sha256:efeaefbd1775e2a4fd3984e19672e7e5cf8cfdbe0b16b84cededa23587b239c5",
    } as const;
    for (const [id, digest] of Object.entries(pins)) {
      const asset = await loadWordPressDiscoveryAsset(id as keyof typeof pins);
      expect(asset.digest).toBe(digest);
      expect(asset.text).toContain("A Lead is not a Finding.");
      expect(asset.text).not.toMatch(
        /\b(?:PoC|payload|CVE)\b|<script\b|\bcurl\s+-/i,
      );
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

  it("defines the human trust boundary", async () => {
    const trust = await loadWordPressDiscoveryAsset("trust-boundary-v1");
    expect(trust.text).toContain("human operator reviews and versions");
    expect(trust.text).toContain("contributor");
    expect(trust.text).toContain("administrator");
    expect(trust.text).toContain("unfiltered_html");
  });
});
