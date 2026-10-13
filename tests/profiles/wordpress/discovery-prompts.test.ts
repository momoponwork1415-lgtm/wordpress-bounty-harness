import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { wordpressFindingClaimSchema } from "../../../src/profiles/wordpress/discovery/finding.js";
import { wordpressLeadClaimSchema } from "../../../src/profiles/wordpress/discovery/lead.js";
import {
  wordPressDiscoveryOutputContract,
  wordPressDiscoveryOutputContractV2,
} from "../../../src/profiles/wordpress/discovery/output-contract.js";

import {
  loadWordPressDiscoveryAsset,
  loadWordPressVerifierPrompt,
  WORDPRESS_DISCOVERY_ASSET_IDS,
  WORDPRESS_DISCOVERY_PROMPT_IDS,
  WORDPRESS_OBJECTIVE_ONLY_PROMPT_IDS,
} from "../../../src/profiles/wordpress/prompts/index.js";

describe("WordPress discovery prompt assets", () => {
  it("pins the current Verifier prompt to its file bytes and keeps answer strings out", async () => {
    const prompt = await loadWordPressVerifierPrompt();
    const bytes = await readFile(
      new URL(
        "../../../src/profiles/wordpress/prompts/verifier-v7.md",
        import.meta.url,
      ),
    );
    expect(bytes.byteLength).toBeLessThan(4_000);
    expect(prompt.id).toBe("verifier-v7");
    expect(prompt.text).toBe(bytes.toString("utf8"));
    expect(prompt.digest).toBe(
      "sha256:df5ed497912146fd4ceaeacbf923d3cee3337c477afad8645044fca460bd3b18",
    );
    expect(prompt.digest).toBe(
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
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

  it("keeps the archived v6 Verifier prompt loadable", async () => {
    const prompt = await loadWordPressVerifierPrompt("verifier-v6");
    expect(prompt.id).toBe("verifier-v6");
    expect(prompt.digest).toBe(
      "sha256:f548a5a3121fc8eb1d761042577944c3fbf5899bd481884ed690753cf3400d58",
    );
    expect(prompt.text).toContain("# WordPress Verifier v6");
    expect(prompt.text).toContain("try to refute the Finding");
  });

  it("changes only the approved v6 lines in v7", async () => {
    const oldPrompt = await loadWordPressVerifierPrompt("verifier-v6");
    const current = await loadWordPressVerifierPrompt();
    const replacements = [
      ["# WordPress Verifier v6", "# WordPress Verifier v7"],
      [
        "Turn the Finding's reproduction clue into steps that work in this Lab, and try to refute the Finding.",
        "Reproduce the effect the Finding claims, from the supplied attacker position, in this Lab.",
      ],
      [
        "If the route does not support the claimed effect, explain the contrary evidence in `refutation.md`.",
        "If the effect does not reproduce, record what actually happened in `refutation.md`.",
      ],
      [
        "If the same route now fails, record the actual responses and explain the blocking observation in `refutation.md`.",
        "If the same route now fails, record the actual responses and what actually happened in `refutation.md`.",
      ],
    ] as const;
    let expected = oldPrompt.text;
    for (const [before, after] of replacements) {
      expect(expected.split(before)).toHaveLength(2);
      expected = expected.replace(before, after);
    }
    expect(current.text).toBe(expected);
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
      "short-objective-managed-v5",
      "screening-v1",
      "wp2shell-single-http-v2",
      "wp2shell-bounty-v1",
      "wp2shell-bounty-v2",
      "wp2shell-bounty-v3",
      "wp2shell-bounty-v4",
      "wp2shell-whitebox-v1.7",
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
      "short-objective-managed-v5",
      "screening-v1",
      "wp2shell-single-http-v2",
      "wp2shell-bounty-v1",
      "wp2shell-bounty-v2",
      "wp2shell-bounty-v3",
      "wp2shell-bounty-v4",
      "wp2shell-whitebox-v1.7",
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

  it("renders both complete claim schemas and normalization rules in one versioned contract", () => {
    const contract = wordPressDiscoveryOutputContract();
    const schemaLine = (label: string) =>
      JSON.parse(contract.text.split(`${label} schema: `)[1]!.split("\n")[0]!);
    expect(schemaLine("Finding")).toEqual(
      z.toJSONSchema(wordpressFindingClaimSchema, { io: "output" }),
    );
    expect(schemaLine("Lead")).toEqual(
      z.toJSONSchema(wordpressLeadClaimSchema, { io: "output" }),
    );
    expect(contract.text).toContain("single strings, not arrays");
    expect(contract.text).toContain("`sourceTrace` is an array of objects");
    expect(contract.text).toContain("`@wordpress/`");
    expect(contract.text).toContain("Root's final report");
    expect(contract.text).not.toMatch(
      /checklist|investigate|start three|30 minutes/i,
    );
    expect(contract.digest).toBe(
      "sha256:f4acb2d480739f0e89d2f01c14c7ae15b62c340a77ee01d34778f04821c07e41",
    );
  });

  it("keeps the archived contract and directs Root to request a final JSON report after child follow-ups", () => {
    const archived = wordPressDiscoveryOutputContract();
    const current = wordPressDiscoveryOutputContractV2();
    expect(archived.id).toBe("wordpress-discovery-contract-v1");
    expect(current.id).toBe("wordpress-discovery-contract-v2");
    expect(archived.text).not.toContain("every child spawn assignment");
    expect(current.text).toContain("every child spawn assignment");
    expect(current.text).toContain("every follow-up to a child");
    expect(current.text).toContain("even when there are no claims");
    expect(current.text).toContain("Finding schema:");
    expect(current.text).toContain("Lead schema:");
    expect(current.digest).toBe(
      "sha256:a74a93951d790aec174c3506a6df9ae2cd391bc44bdedea7fdf8ff74d503db3d",
    );
  });

  it("keeps the new objective assets free of the claim contract", async () => {
    const pins = {
      "short-objective-managed-v5":
        "sha256:972ebe7d10a0173fef24a7603e01defcb17fd81e87810795f705737114f584b4",
      "screening-v1":
        "sha256:effeb9e343601157e2da76eb65b99d4de91a9618daf7379efce13491a1d6aba6",
      "wp2shell-bounty-v3":
        "sha256:a97b4b3c1101470cec743dd51af1d2169f15d4d5ee1a2797997be05edef72c9b",
      "wp2shell-bounty-v4":
        "sha256:6c823fe2ddb8a9af27ea743927f5d4a8203ec29ef4bca7dbadf3135c1739ab62",
      "wp2shell-whitebox-v1.7":
        "sha256:3318ae6a06290ffbf306533f66357eb41401c1c48ccc7de7cc4e991ac3e07afb",
    } as const;
    for (const id of WORDPRESS_OBJECTIVE_ONLY_PROMPT_IDS) {
      const { text, digest } = await loadWordPressDiscoveryAsset(id);
      expect(digest).toBe(pins[id]);
      expect(text).toMatch(/Lead|Finding/);
      expect(text).not.toMatch(
        /sourceTrace|labObservations|JSON string|Each Finding is an object/,
      );
    }
  });

  it("keeps the v2 method in v3 without an effort floor or handwritten output contract", async () => {
    const { text } = await loadWordPressDiscoveryAsset("wp2shell-bounty-v3");
    expect(text).toContain(
      "three subagents with genuinely different questions",
    );
    expect(text).toContain("When agents converge on one family");
    expect(text).toContain(
      "After each wave, synthesize the children's evidence",
    );
    expect(text).toContain("test attacker control, reachability");
    expect(text).toContain(
      "Combine partial routes only when every connecting edge",
    );
    expect(text).toContain("two consecutive waves add no new approach family");
    expect(text).not.toMatch(
      /at least\s+\d+\s+(?:minutes?|hours?)|effort floor/i,
    );
    expect(text).not.toMatch(
      /sourceTrace|labObservations|JSON string|Each Finding is an object|Each Lead is an object/,
    );
    expect(text).not.toMatch(
      /TranslatePress|The Events Calendar|Smash Balloon|ThemePunch|revslider|wpforms|woocommerce|\b(?:PoC|CVE|advisory)\b/i,
    );
  });

  it("makes Critical and High examples the v4 objective without making an impact label a verdict", async () => {
    const archived = await loadWordPressDiscoveryAsset("wp2shell-bounty-v3");
    const current = await loadWordPressDiscoveryAsset("wp2shell-bounty-v4");
    expect(archived.digest).toBe(
      "sha256:a97b4b3c1101470cec743dd51af1d2169f15d4d5ee1a2797997be05edef72c9b",
    );
    expect(current.text).toContain(
      "Finding targets are these Critical examples for an unauthenticated attacker",
    );
    expect(current.text).toContain(
      "Finding targets are these High examples for a subscriber or customer attacker",
    );
    for (const effect of [
      "arbitrary file deletion",
      "arbitrary file read",
      "arbitrary file upload leading to remote code execution",
      "remote code execution",
      "privilege escalation",
      "SQL injection",
      "stored XSS",
      "missing authorization causing critical data alteration or read",
      "authentication bypass to administrator",
    ])
      expect(current.text).toContain(effect);
    expect(current.text).toContain("no extra exploit prerequisites");
    expect(current.text).toContain("beyond the ordinary feature flow");
    expect(current.text).toContain(
      "Report a Finding only for a complete route",
    );
    expect(current.text).toContain("Keep concrete unresolved chains as Leads");
    expect(current.text).toContain("An impact label alone");
    expect(current.text).toContain("`options-update`");
    expect(current.text).toContain("`sensitive-object-access`");
    expect(current.text).not.toContain("Prioritize `rce`");
    expect(current.text).not.toMatch(
      /sourceTrace|labObservations|JSON string|Each Finding is an object|Each Lead is an object/,
    );
    expect(current.text).not.toMatch(
      /TranslatePress|The Events Calendar|Smash Balloon|ThemePunch|revslider|wpforms|woocommerce|\b(?:PoC|CVE|advisory)\b/i,
    );
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
      if (id === "wp2shell-whitebox-v1.7") {
        expect(text).not.toMatch(/\bCVE-\d{4}-\d+\b/i);
      } else {
        expect(text).not.toMatch(/\bCVE(?:-\d+)?\b/i);
        expect(text).not.toMatch(/\badvisor(?:y|ies)\b/i);
        expect(text).not.toMatch(/\bPoC\b/i);
      }
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
      expect(text).toMatch(/subscriber/i);
      expect(text).toMatch(/customer/i);
      expect(text).toMatch(/\brce\b|remote code execution/i);
      expect(text).toMatch(/stored[- ]xss/i);
      if (!WORDPRESS_OBJECTIVE_ONLY_PROMPT_IDS.some((entry) => entry === id)) {
        expect(text).toContain("attackerPosition");
        expect(text).toContain("configurationPrecondition");
        expect(text).toContain("sourceTrace");
      }
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
