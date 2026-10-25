import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { wordpressFindingClaimSchema } from "../../../src/profiles/wordpress/discovery/finding.js";
import { wordpressLeadClaimSchema } from "../../../src/profiles/wordpress/discovery/lead.js";
import {
  wordPressDiscoveryOutputContract,
  wordPressDiscoveryOutputContractV2,
  wordPressDiscoveryOutputContractV4,
} from "../../../src/profiles/wordpress/discovery/output-contract.js";

import {
  loadWordPressDiscoveryAsset,
  loadWordPressVerifierPrompt,
  WORDPRESS_CURRENT_DISCOVERY_PROMPT_ID,
  WORDPRESS_DISCOVERY_ASSET_IDS,
  WORDPRESS_DISCOVERY_PROMPT_IDS,
  WORDPRESS_DISCOVERY_PROMPTS,
  WORDPRESS_OBJECTIVE_ONLY_PROMPT_IDS,
  WORDPRESS_TRUST_BOUNDARY,
  WORDPRESS_VERIFIER_PROMPT_ID,
  WORDPRESS_VERIFIER_PROMPTS,
} from "../../../src/profiles/wordpress/prompts/index.js";

const promptBytes = (id: string) =>
  readFile(
    new URL(
      `../../../src/profiles/wordpress/prompts/${id}.md`,
      import.meta.url,
    ),
  );

describe("WordPress prompt table", () => {
  it("pins every prompt body to the digest recorded in its table row", async () => {
    // A changed `.md` body fails here until its row is re-pinned under a new version.
    for (const row of [
      ...WORDPRESS_DISCOVERY_PROMPTS,
      WORDPRESS_TRUST_BOUNDARY,
    ]) {
      const asset = await loadWordPressDiscoveryAsset(row.id);
      const bytes = await promptBytes(row.id);
      expect(asset.id).toBe(row.id);
      expect(asset.sourceUrl.pathname.endsWith(`/${row.id}.md`)).toBe(true);
      expect(asset.text).toBe(bytes.toString("utf8"));
      expect(asset.text.length).toBeGreaterThan(100);
      expect(asset.digest).toBe(
        `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      );
      expect(asset.digest).toBe(row.digest);
    }
    for (const row of WORDPRESS_VERIFIER_PROMPTS) {
      const prompt = await loadWordPressVerifierPrompt(row.id);
      const bytes = await promptBytes(row.id);
      expect(prompt.id).toBe(row.id);
      expect(prompt.text).toBe(bytes.toString("utf8"));
      expect(prompt.digest).toBe(
        `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      );
      expect(prompt.digest).toBe(row.digest);
    }
  });

  it("derives the id lists and the current versions from the table", () => {
    const ids = WORDPRESS_DISCOVERY_PROMPTS.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(21);
    expect(WORDPRESS_DISCOVERY_PROMPT_IDS).toEqual(ids);
    expect(WORDPRESS_DISCOVERY_ASSET_IDS).toEqual([
      ...ids,
      WORDPRESS_TRUST_BOUNDARY.id,
    ]);
    expect(WORDPRESS_OBJECTIVE_ONLY_PROMPT_IDS).toEqual(
      WORDPRESS_DISCOVERY_PROMPTS.filter(
        (row) => row.outputContract !== null,
      ).map((row) => row.id),
    );
    expect(
      WORDPRESS_DISCOVERY_PROMPTS.filter((row) => row.status === "current"),
    ).toHaveLength(1);
    expect(WORDPRESS_CURRENT_DISCOVERY_PROMPT_ID).toBe("wp2shell-bounty-v10");
    expect(
      WORDPRESS_VERIFIER_PROMPTS.filter((row) => row.status === "current"),
    ).toHaveLength(1);
    expect(WORDPRESS_VERIFIER_PROMPT_ID).toBe("verifier-v8");
    expect(WORDPRESS_TRUST_BOUNDARY.id).toBe("trust-boundary-v1");
  });

  it("carries no entry-index coverage column after ADR 0034", () => {
    for (const row of WORDPRESS_DISCOVERY_PROMPTS)
      expect(row).not.toHaveProperty("entryIndexCoverage");
  });
});

describe("WordPress discovery prompt assets", () => {
  it("keeps answer strings out of the current Verifier prompt", async () => {
    const prompt = await loadWordPressVerifierPrompt();
    expect(Buffer.byteLength(prompt.text, "utf8")).toBeLessThan(4_000);
    expect(prompt.id).toBe("verifier-v8");
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
    expect(prompt.text).toContain("# WordPress Verifier v6");
    expect(prompt.text).toContain("try to refute the Finding");
  });

  it("changes only the approved v6 lines in v7", async () => {
    const oldPrompt = await loadWordPressVerifierPrompt("verifier-v6");
    const current = await loadWordPressVerifierPrompt("verifier-v7");
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

  it("keeps v7 loadable and changes only source mount guidance in v8", async () => {
    const oldPrompt = await loadWordPressVerifierPrompt("verifier-v7");
    const current = await loadWordPressVerifierPrompt();
    const before =
      "The Lab section may name a read-only database account and a WordPress core source tree; both are for reading only.";
    const after =
      "The Lab section may name a read-only database account. The Lab's `sourcePack` lists the read-only source trees mounted from this Finding's Target Snapshot: the target plugin at `/workspace/main` and, when supplied, WordPress core at `/workspace/wordpress`, PHP at `/workspace/php`, and plugin dependencies under `/workspace/dependencies/<slug>`. Check the claimed route and its prerequisites against listed source; treat unlisted dependencies as unavailable.";
    expect(oldPrompt.text.split(before)).toHaveLength(2);
    expect(current.text).toBe(
      oldPrompt.text
        .replace("# WordPress Verifier v7", "# WordPress Verifier v8")
        .replace(before, after),
    );
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

  it("describes pinned dependency source paths only in the new contract", () => {
    const current = wordPressDiscoveryOutputContractV4();
    expect(current.id).toBe("wordpress-discovery-contract-v4");
    expect(current.text).toContain("`@dependencies/<id>/`");
    expect(current.text).toContain("every child spawn assignment");
    expect(wordPressDiscoveryOutputContractV2().text).not.toContain(
      "`@dependencies/<id>/`",
    );
  });

  it("keeps the objective-only assets free of the claim contract", async () => {
    for (const id of WORDPRESS_OBJECTIVE_ONLY_PROMPT_IDS) {
      const { text } = await loadWordPressDiscoveryAsset(id);
      if (
        id === "wp2shell-bounty-v7" ||
        id === "wp2shell-bounty-v8" ||
        id === "wp2shell-bounty-v10"
      )
        expect(text).toContain("Use multiagents aggressively");
      else expect(text).toMatch(/Lead|Finding/);
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
    expect(Buffer.byteLength(current.text, "utf8")).toBeLessThan(4_000);
    expect(archived.text).not.toContain("Critical examples");
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

  it("keeps the multi-agent method in v5, drops class ranking and effort floors, and names core-stored data as attacker input", async () => {
    const archived = await loadWordPressDiscoveryAsset("wp2shell-bounty-v4");
    const current = await loadWordPressDiscoveryAsset("wp2shell-bounty-v5");
    expect(archived.text).toContain("Critical examples");
    expect(Buffer.byteLength(current.text, "utf8")).toBeLessThan(7_000);
    expect(current.text).toContain(
      "A false negative is worse than a false positive here",
    );
    expect(current.text).toContain(
      "comments and other content WordPress core accepts and stores on their behalf",
    );
    expect(current.text).toContain(
      "Treat the writer, the storage, and the reader as three places to inspect",
    );
    expect(current.text).toContain("Use multiple agents aggressively");
    expect(current.text).toContain("Search in all three directions");
    expect(current.text).toContain("research/REGISTRY.md");
    expect(current.text).toContain("Keep every agent short");
    expect(current.text).toContain(
      "After the first complete Finding, run at least one more round on a different approach family",
    );
    expect(current.text).toContain(
      "Stop only when no actionable frontier remains",
    );
    expect(current.text).toContain(
      "Reporting zero Findings after bounded closure is a normal ending",
    );
    expect(current.text).not.toMatch(
      /at least\s+\d+\s+(?:minutes?|hours?)|effort floor/i,
    );
    expect(current.text).not.toMatch(
      /strongest first|Dropped classes|Critical examples|High examples/,
    );
    expect(current.text).not.toMatch(
      /sourceTrace|labObservations|JSON string|Each Finding is an object|Each Lead is an object/,
    );
    expect(current.text).not.toMatch(
      /TranslatePress|The Events Calendar|Smash Balloon|ThemePunch|revslider|wpforms|woocommerce|Relevanssi|Brizy|Elementor|\b(?:PoC|CVE|advisory)\b/i,
    );
  });

  it("pins v6's index closure rule and keeps its source-derived class paragraphs", async () => {
    const v6 = await loadWordPressDiscoveryAsset("wp2shell-bounty-v6");
    const v17 = await loadWordPressDiscoveryAsset("wp2shell-whitebox-v1.7");
    const sourceLines = v17.text.split("\n");
    for (const line of [19, 23])
      expect(v6.text).toContain(sourceLines[line - 1]);
    expect(v6.text).toContain(
      sourceLines[20]!
        .split("An option that changes what a page looks like")[0]!
        .trimEnd(),
    );
    expect(v6.text).not.toContain(
      "An option that changes what a page looks like",
    );
    expect(v6.text).toContain(
      "every item in the Harness-provided entry index as `observed` or `blocked`",
    );
    expect(v6.text).toContain("do not apply this closure condition");
    expect(v6.text).not.toMatch(/at least\s+\d+\s+(?:minutes?|hours?)/i);
  });

  it("keeps the handwritten-contract bodies free of answer clues and scripted commands", async () => {
    // The first generation (v1 of each arm) predates the "A Lead is not a Finding." line.
    const firstGeneration = new Set([
      "wp2shell-derived-v1",
      "short-objective-v1",
    ]);
    for (const row of WORDPRESS_DISCOVERY_PROMPTS) {
      if (row.outputContract !== null) continue;
      const asset = await loadWordPressDiscoveryAsset(row.id);
      if (!firstGeneration.has(row.id))
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

  it("archives v8 and changes exactly the two-hop clause, the portfolio bullet and two inserted paragraphs in v10 (#522)", async () => {
    expect(
      WORDPRESS_DISCOVERY_PROMPTS.find((row) => row.id === "wp2shell-bounty-v8")
        ?.status,
    ).toBe("archived");
    const v8 = (await loadWordPressDiscoveryAsset("wp2shell-bounty-v8")).text;
    const v10 = (await loadWordPressDiscoveryAsset("wp2shell-bounty-v10")).text;
    const paragraphs = (text: string) => text.trim().split(/\n\s*\n/);
    const v8Paragraphs = paragraphs(v8);
    const v10Paragraphs = paragraphs(v10);

    // Two paragraphs are inserted, directly before the dependency paragraph.
    const dependency = v10Paragraphs.findIndex((paragraph) =>
      paragraph.startsWith("The plugin depends on WordPress, PHP, MySQL"),
    );
    expect(dependency).toBeGreaterThan(1);
    const inserted = v10Paragraphs.slice(dependency - 2, dependency);
    expect(inserted[0]).toMatch(
      /^Keep every agent short\. No agent may exceed 80 tool calls\./,
    );
    expect(inserted[1]).toMatch(
      /^Every agent writes its findings to \/workspace\/research\/<family>\.md /,
    );
    expect(inserted[1]).toContain("/workspace/research/REGISTRY.md");
    const withoutInserted = v10Paragraphs.filter(
      (_, index) => index < dependency - 2 || index >= dependency,
    );
    expect(withoutInserted).toHaveLength(v8Paragraphs.length);

    // Every other paragraph is byte-identical except the task statement and the portfolio list.
    const changed = withoutInserted.flatMap((paragraph, index) =>
      paragraph === v8Paragraphs[index] ? [] : [index],
    );
    expect(changed).toHaveLength(2);
    const [statement, portfolio] = changed as [number, number];

    // (1) The task statement gains only the two-hop clause.
    expect(withoutInserted[statement]).toBe(
      v8Paragraphs[statement]!.replace(
        "complete chain to an in-scope effect.",
        "complete chain to an in-scope effect; give at least two hops, the entry and the landing.",
      ),
    );
    expect(withoutInserted[statement]).not.toBe(v8Paragraphs[statement]);

    // (2) The portfolio paragraph differs only in its first bullet line.
    const v8Lines = v8Paragraphs[portfolio]!.split("\n");
    const v10Lines = withoutInserted[portfolio]!.split("\n");
    expect(v10Lines).toHaveLength(v8Lines.length);
    const changedLines = v10Lines.flatMap((line, index) =>
      line === v8Lines[index] ? [] : [index],
    );
    expect(changedLines).toHaveLength(1);
    const before = v8Lines[changedLines[0]!]!;
    const after = v10Lines[changedLines[0]!]!;
    expect(before).toMatch(/^- Begin with a genuinely diverse portfolio/);
    expect(after).toMatch(
      /^- Begin with a genuinely diverse portfolio of approaches, weighted by where publicly credited findings/,
    );
    expect(after).toContain("state the setting as the precondition");
    for (const text of [after, ...inserted])
      expect(text).not.toMatch(
        /TranslatePress|The Events Calendar|Smash Balloon|ThemePunch|revslider|wpforms|woocommerce|Relevanssi|Brizy|Elementor|\b(?:PoC|CVE|advisory|payload)\b/i,
      );

    // The persist paragraph and the resume directive stay byte-identical; the latter is last.
    expect(v10Paragraphs).toContain(
      v8Paragraphs.find((paragraph) =>
        paragraph.startsWith(
          "Do not return merely because current approaches fail",
        ),
      ),
    );
    expect(v10Paragraphs.at(-1)).toMatch(/^Before giving up,/);
    expect(v10Paragraphs.at(-1)).toBe(v8Paragraphs.at(-1));
  });

  it("rejects an unknown asset ID at the public boundary", async () => {
    await expect(
      loadWordPressDiscoveryAsset("../policy/programme-scope" as never),
    ).rejects.toThrow("Unknown WordPress discovery asset");
  });

  it("keeps both variants within the same attacker, operation, impact and Finding contract", async () => {
    for (const id of WORDPRESS_DISCOVERY_PROMPT_IDS) {
      const { text } = await loadWordPressDiscoveryAsset(id);
      if (
        id === "wp2shell-bounty-v5" ||
        id === "wp2shell-bounty-v6" ||
        id === "wp2shell-bounty-v7" ||
        id === "wp2shell-bounty-v8" ||
        id === "wp2shell-bounty-v10"
      ) {
        // v5 leaves attacker positions and in-scope effects to the supplied
        // trust boundary and Programme Boundary sections (owner decision, 2026-10-16).
        expect(text).toContain("trust boundary");
        expect(text).toContain("Programme Boundary");
      } else {
        expect(text).toContain("unauthenticated");
        expect(text).toMatch(/subscriber/i);
        expect(text).toMatch(/customer/i);
        expect(text).toMatch(/\brce\b|remote code execution/i);
        expect(text).toMatch(/stored[- ]xss/i);
      }
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
