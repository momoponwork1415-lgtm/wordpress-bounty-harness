import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { wordpressFindingClaimSchema } from "../../../src/profiles/wordpress/discovery/finding.js";
import { wordpressLeadClaimSchema } from "../../../src/profiles/wordpress/discovery/lead.js";
import {
  wordPressDiscoveryOutputContract,
  wordPressDiscoveryOutputContractV2,
  wordPressDiscoveryOutputContractV4,
  wordPressDiscoveryOutputContractV5,
} from "../../../src/profiles/wordpress/discovery/output-contract.js";

import {
  loadWordPressDiscoveryAsset,
  loadWordPressVerifierPrompt,
  WORDPRESS_CURRENT_DISCOVERY_PROMPT_ID,
  WORDPRESS_CURRENT_DISCOVERY_PROMPT_IDS,
  WORDPRESS_DISCOVERY_ASSET_IDS,
  WORDPRESS_DISCOVERY_MODES,
  WORDPRESS_DISCOVERY_PROMPT_IDS,
  WORDPRESS_DISCOVERY_PROMPTS,
  WORDPRESS_LAUNCHABLE_DISCOVERY_PROMPT_IDS,
  WORDPRESS_OBJECTIVE_ONLY_PROMPT_IDS,
  WORDPRESS_PROMPT_SECTIONS,
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
    expect(ids).toHaveLength(29);
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
    // ADR 0039: exactly one current objective per launch mode.
    for (const mode of WORDPRESS_DISCOVERY_MODES)
      expect(
        WORDPRESS_DISCOVERY_PROMPTS.filter(
          (row) =>
            row.status === "current" && "mode" in row && row.mode === mode,
        ),
      ).toHaveLength(1);
    expect(
      WORDPRESS_DISCOVERY_PROMPTS.filter((row) => row.status === "current"),
    ).toHaveLength(WORDPRESS_DISCOVERY_MODES.length);
    expect(WORDPRESS_CURRENT_DISCOVERY_PROMPT_IDS).toEqual({
      deep: "wp2shell-bounty-v11",
      wide: "wp2shell-bounty-v16-wide",
    });
    expect(WORDPRESS_CURRENT_DISCOVERY_PROMPT_ID).toBe("wp2shell-bounty-v11");
    // Archived rows carry no mode, so only a current row launches (ADR 0039).
    for (const row of WORDPRESS_DISCOVERY_PROMPTS)
      if (row.status === "archived") expect(row).not.toHaveProperty("mode");
      else expect(row).toHaveProperty("mode");
    // A candidate launches only when a campaign names it (DEVELOPMENT §5, #599).
    expect(
      WORDPRESS_DISCOVERY_PROMPTS.filter((row) => row.status === "candidate"),
    ).toMatchObject([{ id: "wp2shell-bounty-v15-wide", mode: "wide" }]);
    expect(WORDPRESS_LAUNCHABLE_DISCOVERY_PROMPT_IDS).toEqual([
      "wp2shell-bounty-v11",
      "wp2shell-bounty-v15-wide",
      "wp2shell-bounty-v16-wide",
    ]);
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

const sectionsUrl = new URL(
  "../../../src/profiles/wordpress/prompts/sections/",
  import.meta.url,
);
const sha256 = (text: string) =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;

const HANDOVER_OPENING =
  "Each agent is given one piece of work and returns when that piece is done.";

describe("WordPress prompt fragments (redesign 2026-10-25 §5)", () => {
  const composed = WORDPRESS_DISCOVERY_PROMPTS.flatMap((row) =>
    "fragments" in row ? [row] : [],
  );
  const fragmentText = (section: string, file: string) =>
    readFile(new URL(`${section}/${file}.md`, sectionsUrl), "utf8");

  it("composes every current objective and keeps the archived v10 and v12-wide composed", () => {
    expect(composed.map((row) => row.id)).toEqual([
      "wp2shell-bounty-v10",
      "wp2shell-bounty-v11",
      "wp2shell-bounty-v12-wide",
      "wp2shell-bounty-v13-wide",
      "wp2shell-bounty-v14-wide",
      "wp2shell-bounty-v15-wide",
      "wp2shell-bounty-v16-wide",
    ]);
    for (const row of WORDPRESS_DISCOVERY_PROMPTS.filter(
      (entry) => entry.status !== "archived",
    ))
      expect(composed).toContain(row);
  });

  it("composes byte-identical text to the kept .md under the unchanged digest", async () => {
    const pinned = {
      "wp2shell-bounty-v10":
        "sha256:fd4e395ecb50923487c9bab6dbae81f0aff4e67342abecedda3f53cd9ff5f8b3",
      "wp2shell-bounty-v11":
        "sha256:0ce13a617484c0e0b7ff3af6a55b4b821ea106189a897ed573040e9d5ad16ae9",
      "wp2shell-bounty-v12-wide":
        "sha256:9a79a3b20fdba7af54f32464d868ab00806335c526781aba026e76ce9290c3c3",
      "wp2shell-bounty-v13-wide":
        "sha256:0dd2072b4c6a544d47ebb6df94c7981f2fbb758b4dee82e063896ff91f892bb8",
      "wp2shell-bounty-v14-wide":
        "sha256:42ec734364d93492bf9b936e415b94796da21fb154d3b29033cafbd58596229d",
      "wp2shell-bounty-v15-wide":
        "sha256:3e82116ebdd32e4e863d7daacf7a87d90c43f6c4e73efe49333668883fcf680d",
      "wp2shell-bounty-v16-wide":
        "sha256:1ffb15f4f3f7ad6de70e330e10fd24c31513e41d250c8e0d6885b760a0a5c1f3",
    } as const;
    for (const row of composed) {
      const bytes = (await promptBytes(row.id)).toString("utf8");
      const fragments = await Promise.all(
        row.fragments.map(({ section, file }) => fragmentText(section, file)),
      );
      // Every fragment is whole paragraphs; together they are the .md's paragraphs in order.
      expect(
        fragments.flatMap((text) => text.replace(/\n$/, "").split("\n\n")),
      ).toEqual(bytes.replace(/\n$/, "").split("\n\n"));
      const asset = await loadWordPressDiscoveryAsset(row.id);
      expect(asset.text).toBe(bytes);
      expect(asset.digest).toBe(sha256(bytes));
      expect(asset.digest).toBe(pinned[row.id]);
    }
  });

  it("digests each section as its own fragments composed in row order", async () => {
    for (const row of composed) {
      const asset = await loadWordPressDiscoveryAsset(row.id);
      const expected: Record<string, string> = {};
      for (const section of WORDPRESS_PROMPT_SECTIONS) {
        const texts = await Promise.all(
          row.fragments
            .filter((fragment) => fragment.section === section)
            .map(({ file }) => fragmentText(section, file)),
        );
        expected[section] = sha256(
          `${texts.map((text) => text.slice(0, -1)).join("\n\n")}\n`,
        );
      }
      expect(asset.sectionDigests).toEqual(expected);
    }
    for (const id of ["wp2shell-bounty-v10-wide", "wp2shell-bounty-v11-wide"])
      expect(await loadWordPressDiscoveryAsset(id as never)).not.toHaveProperty(
        "sectionDigests",
      );
  });

  it("shares the common paragraphs as one file and leaves no file unused", async () => {
    const files = (row: (typeof composed)[number]) =>
      row.fragments.map(({ section, file }) => `${section}/${file}`);
    const byId = (id: string) => files(composed.find((row) => row.id === id)!);
    const [deep, wide] = [
      byId("wp2shell-bounty-v11"),
      byId("wp2shell-bounty-v16-wide"),
    ];
    expect(deep.filter((file) => wide.includes(file))).toEqual([
      "objective/task-v10",
      "coordination/handover-v11",
      "objective/sources-v8",
    ]);
    // The lifetime paragraph is left only to the archived rows.
    expect([...deep, ...wide]).not.toContain("coordination/lifetime-v10");
    const onDisk = (await readdir(sectionsUrl, { recursive: true }))
      .filter((path) => path.endsWith(".md"))
      .map((path) => path.replace(/\.md$/, ""))
      .sort();
    expect(onDisk).toEqual([...new Set(composed.flatMap(files))].sort());
    for (const path of onDisk)
      expect(WORDPRESS_PROMPT_SECTIONS).toContain(path.split("/")[0]);
  });

  it("pins the generated v5 contract the composed objectives receive and keeps v4", () => {
    expect(wordPressDiscoveryOutputContractV5().digest).toBe(
      "sha256:4ead63b056590be4cbdd7f474bd79c7e301550454a7e4644d943a17bb0bd6ec4",
    );
    // Archived rows and earlier Trials' `contractDigest` (#613).
    expect(wordPressDiscoveryOutputContractV4().digest).toBe(
      "sha256:5acd5157fc82cb76c35490af607513a1558477c4eb03acaa046fdf0a64c99883",
    );
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
    const schemaLine = (label: string, text = contract.text) =>
      JSON.parse(text.split(`${label} schema: `)[1]!.split("\n")[0]!);
    // The archived contracts keep the schema before the declared fields (#613).
    expect(schemaLine("Finding")).toEqual(
      z.toJSONSchema(
        wordpressFindingClaimSchema.omit({
          configurationClass: true,
          attackerInputPath: true,
          exploitTiming: true,
        }),
        { io: "output" },
      ),
    );
    expect(
      schemaLine("Finding", wordPressDiscoveryOutputContractV5().text),
    ).toEqual(z.toJSONSchema(wordpressFindingClaimSchema, { io: "output" }));
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

  it("carries the three declared-precondition fields and each value's description only in v5", () => {
    const v5 = wordPressDiscoveryOutputContractV5();
    expect(v5.id).toBe("wordpress-discovery-contract-v5");
    const finding = JSON.parse(
      v5.text.split("Finding schema: ")[1]!.split("\n")[0]!,
    ) as {
      required: string[];
      properties: Record<
        string,
        { anyOf: { const: string; description: string }[] }
      >;
    };
    expect(finding.required).not.toContain("configurationClass");
    expect(finding.required).not.toContain("attackerInputPath");
    expect(finding.required).not.toContain("exploitTiming");
    const values = (field: string) =>
      finding.properties[field]!.anyOf.map((option) => option.const);
    expect(values("configurationClass")).toEqual([
      "default",
      "ordinary-feature-use",
      "admin-authored-unsafe-content",
      "admin-setting-change",
      "developer-mode",
    ]);
    expect(values("attackerInputPath")).toEqual([
      "direct-request",
      "own-account-data",
      "public-third-party-content",
      "vendor-controlled-data",
    ]);
    expect(values("exploitTiming")).toEqual([
      "any-time",
      "time-window",
      "race",
    ]);
    for (const field of [
      "configurationClass",
      "attackerInputPath",
      "exploitTiming",
    ])
      for (const option of finding.properties[field]!.anyOf)
        expect(option.description).toMatch(/^[^\n]{10,260}$/);
    expect(v5.text).toContain(
      "Anyone can write it, e.g. a comment on a public social-media page, or the attacker's own blocked request kept in a WAF log.",
    );
    expect(v5.text).toContain(
      "Only the service's vendor, the site itself or an administrator writes it, e.g. scanner results, a vulnerability database, a fixed vendor feed or notice, an official translation pack, an API response body, an administrator-run check's output.",
    );
    for (const archived of [
      wordPressDiscoveryOutputContract(),
      wordPressDiscoveryOutputContractV2(),
      wordPressDiscoveryOutputContractV4(),
    ]) {
      expect(archived.text).not.toContain("configurationClass");
      expect(archived.text).not.toContain("attackerInputPath");
      expect(archived.text).not.toContain("exploitTiming");
    }
    // v5 is v4 with only the Finding schema line changed.
    const withoutFinding = (text: string) =>
      text
        .split("\n")
        .filter((line) => !line.startsWith("Finding schema: "))
        .join("\n")
        .replace(/contract-v[45]/, "contract-vN");
    expect(withoutFinding(v5.text)).toBe(
      withoutFinding(wordPressDiscoveryOutputContractV4().text),
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
        id === "wp2shell-bounty-v10" ||
        id === "wp2shell-bounty-v11"
      )
        expect(text).toContain("Use multiagents aggressively");
      else if (
        id === "wp2shell-bounty-v11-wide" ||
        id === "wp2shell-bounty-v12-wide"
      )
        expect(text).toContain("four specialist agents");
      else if (
        id === "wp2shell-bounty-v13-wide" ||
        id === "wp2shell-bounty-v14-wide" ||
        id === "wp2shell-bounty-v15-wide" ||
        id === "wp2shell-bounty-v16-wide"
      )
        expect(text).toContain("one specialist agent per sink class");
      else expect(text).toMatch(/Lead|Finding/);
      expect(text).not.toMatch(
        /sourceTrace|labObservations|JSON string|Each Finding is an object/,
      );
    }
  });

  it("keeps the archived v10-wide as v10 without the persist paragraph and with the stop rule in place of the floor (ADR 0039)", async () => {
    const deep = (await loadWordPressDiscoveryAsset("wp2shell-bounty-v10"))
      .text;
    const wide = (await loadWordPressDiscoveryAsset("wp2shell-bounty-v10-wide"))
      .text;
    const paragraphs = (text: string) => text.trim().split(/\n\s*\n/);
    const deepParagraphs = paragraphs(deep);
    const wideParagraphs = paragraphs(wide);
    expect(deepParagraphs.at(-2)).toMatch(
      /^Do not return merely because current approaches fail/,
    );
    expect(deepParagraphs.at(-1)).toMatch(/^Before giving up,/);
    expect(wideParagraphs.slice(0, -1)).toEqual(deepParagraphs.slice(0, -2));
    expect(wideParagraphs.at(-1)).toMatch(
      /^Stop when two consecutive waves produce no new approach family and no new candidate/,
    );
    expect(wide).not.toMatch(
      /60 minutes|one hour|Before giving up|Do not return merely/,
    );
  });

  it("makes v11-wide the v10 task with four fixed sink specialists and a stop rule (ADR 0039, 2026-10-25)", async () => {
    const paragraphs = (text: string) => text.trim().split(/\n\s*\n/);
    const v10 = paragraphs(
      (await loadWordPressDiscoveryAsset("wp2shell-bounty-v10")).text,
    );
    const text = (await loadWordPressDiscoveryAsset("wp2shell-bounty-v11-wide"))
      .text;
    const v11 = paragraphs(text);
    const startingWith = (rows: readonly string[], prefix: string) =>
      rows.find((paragraph) => paragraph.startsWith(prefix));
    // Task statement unchanged; the first-principles paragraph gains one guard sentence.
    expect(v11.slice(0, 2)).toEqual(v10.slice(0, 2));
    expect(v11[2]?.startsWith(`${v10[2]} Before you report a candidate,`)).toBe(
      true,
    );
    for (const prefix of ["Keep every agent short.", "The plugin depends on"]) {
      expect(startingWith(v11, prefix)).toBeDefined();
      expect(startingWith(v11, prefix)).toBe(startingWith(v10, prefix));
    }
    expect(v11.at(-1)).toMatch(/^Stop when/);
    expect(startingWith(v11, "Before giving up")).toBeUndefined();
    expect(startingWith(v11, "Do not return merely")).toBeUndefined();
    expect(text.match(/four specialist agents/g)).toHaveLength(1);
    expect(text).not.toMatch(
      /TranslatePress|The Events Calendar|Smash Balloon|ThemePunch|revslider|wpforms|woocommerce|\b(?:PoC|CVE|advisory|payload)\b/i,
    );
  });

  it("makes v12-wide the v11-wide text with backward tracing, early-hook entries and six recurring shapes (ADR 0039, 2026-10-25 追記 2)", async () => {
    const paragraphs = (text: string) => text.trim().split(/\n\s*\n/);
    const v11 = paragraphs(
      (await loadWordPressDiscoveryAsset("wp2shell-bounty-v11-wide")).text,
    );
    const text = (await loadWordPressDiscoveryAsset("wp2shell-bounty-v12-wide"))
      .text;
    const v12 = paragraphs(text);
    // One paragraph inserted after the specialists; every other paragraph is byte-identical to v11-wide.
    expect(v12).toHaveLength(v11.length + 1);
    expect(v12.slice(0, 3)).toEqual(v11.slice(0, 3));
    expect(v12.slice(5)).toEqual(v11.slice(4));
    expect(v12[4]).toMatch(
      /^Shapes that recur in published WordPress findings/,
    );
    expect(v12[4]?.match(/\([a-f]\)/g)).toEqual([
      "(a)",
      "(b)",
      "(c)",
      "(d)",
      "(e)",
      "(f)",
    ]);
    // The specialists paragraph gains backward tracing and the early-hook entry sentence only.
    const specialists = v12[3] ?? "";
    expect(specialists).toContain(
      "and backward from each sink to the untrusted inputs that can arrive there,",
    );
    expect(specialists).toContain(
      "Also treat as entry points the handlers that run on every request from early hooks",
    );
    expect(
      specialists
        .replace(
          ", and backward from each sink to the untrusted inputs that can arrive there, and reports",
          " and reports",
        )
        .replace(
          /Also treat as entry points the handlers that run on every request from early hooks[^.]*\. /,
          "",
        ),
    ).toBe(v11[3]);
    expect(text.match(/four specialist agents/g)).toHaveLength(1);
    expect(text).not.toMatch(
      /TranslatePress|The Events Calendar|Smash Balloon|ThemePunch|revslider|wpforms|woocommerce|Tourfic|Groundhogg|rtMedia|\b(?:PoC|CVE|advisory|payload)\b/i,
    );
  });

  it("makes v11 the v10 text without the lifetime paragraph, the child count and the minutes, plus the hand-over paragraph (ADR 0039 追記 4, 2026-10-25 and 2026-10-26)", async () => {
    const paragraphs = (text: string) => text.trim().split(/\n\s*\n/);
    const v10 = paragraphs(
      (await loadWordPressDiscoveryAsset("wp2shell-bounty-v10")).text,
    );
    const text = (await loadWordPressDiscoveryAsset("wp2shell-bounty-v11"))
      .text;
    const withHandover = paragraphs(text);
    // One paragraph removed; one inserted after the research paragraph (owner
    // 2026-10-26); two changed in place; every other paragraph is byte-identical.
    const lifetime = v10.findIndex((paragraph) =>
      paragraph.startsWith("Keep every agent short."),
    );
    const withoutLifetime = v10.filter((_, index) => index !== lifetime);
    const handover = withHandover.findIndex((paragraph) =>
      paragraph.startsWith(HANDOVER_OPENING),
    );
    expect(withHandover[handover - 1]).toBe(v10[lifetime + 1]);
    expect(withHandover[handover - 1]).toMatch(
      /^Every agent writes its findings/,
    );
    const v11 = withHandover.filter((_, index) => index !== handover);
    expect(v11).toHaveLength(withoutLifetime.length);
    const changed = v11.flatMap((paragraph, index) =>
      paragraph === withoutLifetime[index] ? [] : [index],
    );
    expect(changed).toEqual([3, v11.length - 1]);
    expect(v11[3]).toBe(
      withoutLifetime[3]!.replace(
        " You may spawn up to 4 agents at any one time.",
        "",
      ),
    );
    expect(v11.at(-1)).toBe(
      withoutLifetime
        .at(-1)!
        .replace(
          "use at least one hour for active exploration",
          "use at least the minimum active exploration time stated in the Run parameters for active exploration",
        )
        .replace("before that hour has elapsed", "before that time has elapsed")
        .replace(
          "until the hour is met. The Trial has a 120-minute wall cap.",
          "until that time is met.",
        ),
    );
    // The resume directive stays the last paragraph (ADR 0036, 0039).
    expect(v11.at(-1)).toMatch(/^Before giving up,/);
    expect(text).toContain(
      "Do not return merely because current approaches fail",
    );
    expect(text).not.toMatch(
      /tool calls|one hour|\bhour\b|minutes?\b(?! active exploration time)|wall cap|up to \d|\b\d+ agents\b/,
    );
    expect(text).not.toMatch(
      /TranslatePress|The Events Calendar|Smash Balloon|ThemePunch|revslider|wpforms|woocommerce|Tourfic|Groundhogg|rtMedia|\b(?:PoC|CVE|advisory|payload)\b/i,
    );
  });

  it("makes v13-wide the v12-wide text without the lifetime paragraph and the specialist count, plus the hand-over paragraph and the registry stop rule (ADR 0039 追記 4, 2026-10-25 and 2026-10-26)", async () => {
    const paragraphs = (text: string) => text.trim().split(/\n\s*\n/);
    const v12 = paragraphs(
      (await loadWordPressDiscoveryAsset("wp2shell-bounty-v12-wide")).text,
    );
    const text = (await loadWordPressDiscoveryAsset("wp2shell-bounty-v13-wide"))
      .text;
    const withHandover = paragraphs(text);
    const lifetime = v12.findIndex((paragraph) =>
      paragraph.startsWith("Keep every agent short."),
    );
    const withoutLifetime = v12.filter((_, index) => index !== lifetime);
    // The hand-over paragraph follows the research paragraph (owner 2026-10-26).
    const handover = withHandover.findIndex((paragraph) =>
      paragraph.startsWith(HANDOVER_OPENING),
    );
    expect(withHandover[handover - 1]).toBe(v12[lifetime + 1]);
    expect(withHandover[handover - 1]).toMatch(
      /^Every specialist writes its routes/,
    );
    const v13 = withHandover.filter((_, index) => index !== handover);
    expect(v13).toHaveLength(withoutLifetime.length);
    const changed = v13.flatMap((paragraph, index) =>
      paragraph === withoutLifetime[index] ? [] : [index],
    );
    expect(changed).toEqual([3, v13.length - 2, v13.length - 1]);
    expect(v13[3]).toBe(
      withoutLifetime[3]!.replace(
        "Use four specialist agents, one per sink class, running in parallel:",
        "Use one specialist agent per sink class, running in parallel:",
      ),
    );
    expect(v13.at(-2)).toBe(
      withoutLifetime
        .at(-2)!
        .replace(
          "The root agent assigns the four sinks,",
          "The root agent assigns one sink class to each specialist,",
        )
        .replace(
          "It does not redirect specialists toward promising leads and does not launch further rounds.",
          "It does not redirect specialists toward promising leads; the only new specialists it starts are the ones that continue a sink whose entry points remain.",
        ),
    );
    expect(v13.at(-1)).toBe(
      withoutLifetime
        .at(-1)!
        .replace(
          "Stop when every specialist has reported that it has worked through the entry points for its sink,",
          "Stop when the registry shows that the entry points of every sink have been worked through,",
        ),
    );
    // The four sink classes stay listed; the stop rule stays last (ADR 0039).
    expect(v13[3]?.match(/\([1-4]\)/g)).toEqual(["(1)", "(2)", "(3)", "(4)"]);
    expect(v13.at(-1)).toMatch(/^Stop when/);
    expect(text).not.toMatch(
      /\bfour\b|tool calls|\bhour\b|\bminutes?\b|\b\d+ (?:agents|specialists)\b/,
    );
    expect(text).not.toMatch(
      /TranslatePress|The Events Calendar|Smash Balloon|ThemePunch|revslider|wpforms|woocommerce|Tourfic|Groundhogg|rtMedia|\b(?:PoC|CVE|advisory|payload)\b/i,
    );
  });

  it("makes v14-wide the v13-wide objective with exactly the sink strategy and fixed coordination fragments replaced (ADR 0039, 2026-10-26 addendum)", async () => {
    const rows = WORDPRESS_DISCOVERY_PROMPTS.filter(
      (row) => "fragments" in row,
    );
    const v13 = rows.find((row) => row.id === "wp2shell-bounty-v13-wide")!;
    const v14 = rows.find((row) => row.id === "wp2shell-bounty-v14-wide")!;
    expect(v14.fragments).toHaveLength(v13.fragments.length);
    expect(
      v14.fragments.flatMap((fragment, index) =>
        fragment.section === v13.fragments[index]!.section &&
        fragment.file === v13.fragments[index]!.file
          ? []
          : [index],
      ),
    ).toEqual([2, 7]);
    expect(v14.fragments[2]).toEqual({
      section: "strategy",
      file: "sinks-v14",
    });
    expect(v14.fragments[7]).toEqual({
      section: "coordination",
      file: "fixed-v14",
    });

    const paragraphs = (text: string) => text.trim().split(/\n\s*\n/);
    const oldText = paragraphs(
      (await loadWordPressDiscoveryAsset("wp2shell-bounty-v13-wide")).text,
    );
    const newText = paragraphs(
      (await loadWordPressDiscoveryAsset("wp2shell-bounty-v14-wide")).text,
    );
    expect(newText).toHaveLength(oldText.length);
    expect(
      newText.flatMap((paragraph, index) =>
        paragraph === oldText[index] ? [] : [index],
      ),
    ).toEqual([3, newText.length - 2]);

    const sinks = newText[3]!;
    expect(sinks).toContain(
      "For example, entry points can be considered roughly in this order of observed frequency:",
    );
    expect(sinks).toContain(
      "Content the plugin imports from third-party services (for example, a social feed, external reviews, a webhook sender or a remote API response) is attacker-placeable input",
    );
    expect(sinks).toContain(
      "A shared helper that assembles a query, a path or markup is examined once at the helper",
    );
    expect(sinks).toContain(
      "Routes are usually one or two hops, and a longer chain is welcome when the source supports every hop.",
    );
    expect(sinks).not.toContain("Work through entry points in this order");
    expect(sinks).not.toContain("Do not build multi-step chains");

    const fixed = newText.at(-2)!;
    expect(fixed).toContain(
      "a source-grounded chain is reported even when an uncertainty remains, with that uncertainty stated; the later human review tolerates some false positives, and a missed route is the costlier error.",
    );
    expect(fixed).not.toContain("doubly checks every concrete bug");
    expect(fixed.split(". ").slice(1).join(". ")).toBe(
      oldText.at(-2)!.split(". ").slice(1).join(". "),
    );
  });

  it("makes v15-wide the v14-wide objective plus the Lab hand-on sentence, with both judge sentences naming the human's review Lab observation (#599, #555)", async () => {
    const rows = WORDPRESS_DISCOVERY_PROMPTS.filter(
      (row) => "fragments" in row,
    );
    const v14 = rows.find((row) => row.id === "wp2shell-bounty-v14-wide")!;
    const v15 = rows.find((row) => row.id === "wp2shell-bounty-v15-wide")!;
    expect(v15.fragments).toHaveLength(v14.fragments.length);
    expect(
      v15.fragments.flatMap((fragment, index) =>
        fragment.section === v14.fragments[index]!.section &&
        fragment.file === v14.fragments[index]!.file
          ? []
          : [index],
      ),
    ).toEqual([0, 7]);
    expect(v15.fragments[0]).toEqual({
      section: "objective",
      file: "task-v15",
    });
    expect(v15.fragments[7]).toEqual({
      section: "coordination",
      file: "fixed-v15",
    });

    const labSentence =
      "When the Trial has a Lab, the root agent copies the `## Lab` section supplied by the Harness, unchanged, into the instructions of every agent it starts.";
    const replacements = [
      [
        "Runtime confirmation belongs only to the later, independent Harness-owned deterministic judge, which must observe the corresponding nonce canary outcome in a fresh Lab.",
        "Runtime confirmation is made later only by a named human's recorded observation in a review Lab.",
      ],
      [
        "Runtime confirmation is decided later by the independent Harness judge, not by the discovery agents.",
        `${labSentence} Runtime confirmation is made later only by a named human's recorded observation in a review Lab, not by the discovery agents.`,
      ],
    ] as const;
    let expected = (
      await loadWordPressDiscoveryAsset("wp2shell-bounty-v14-wide")
    ).text;
    for (const [before, after] of replacements) {
      expect(expected.split(before)).toHaveLength(2);
      expected = expected.replace(before, after);
    }
    const text = (await loadWordPressDiscoveryAsset("wp2shell-bounty-v15-wide"))
      .text;
    expect(text).toBe(expected);

    // The sentence sits in the root agent's paragraph; "Stop when" stays last.
    const paragraphs = text.trim().split(/\n\s*\n/);
    expect(paragraphs.at(-2)).toMatch(/^The root agent assigns/);
    expect(paragraphs.at(-2)).toContain(labSentence);
    expect(paragraphs.at(-1)).toMatch(/^Stop when/);
    expect(text.split(labSentence)).toHaveLength(2);
    expect(text).not.toMatch(/\bjudge\b|canary/i);
  });

  it("makes v16-wide the v14-wide objective with only the third-party content sentence of the sink strategy replaced (owner instruction 2026-10-26)", async () => {
    const rows = WORDPRESS_DISCOVERY_PROMPTS.filter(
      (row) => "fragments" in row,
    );
    const v14 = rows.find((row) => row.id === "wp2shell-bounty-v14-wide")!;
    const v16 = rows.find((row) => row.id === "wp2shell-bounty-v16-wide")!;
    expect(v16.fragments).toHaveLength(v14.fragments.length);
    expect(
      v16.fragments.flatMap((fragment, index) =>
        fragment.section === v14.fragments[index]!.section &&
        fragment.file === v14.fragments[index]!.file
          ? []
          : [index],
      ),
    ).toEqual([2]);
    expect(v16.fragments[2]).toEqual({
      section: "strategy",
      file: "sinks-v16",
    });

    const before =
      "Content the plugin imports from third-party services (for example, a social feed, external reviews, a webhook sender or a remote API response) is attacker-placeable input, and whoever can place that content is treated as an unauthenticated attacker.";
    const after =
      "Content the plugin imports from third-party services (for example, a social feed, external reviews, a webhook sender or a remote API response) is attacker-placeable input only when someone other than the service's vendor can place it, such as anyone who can post to a public page; whoever can place it is treated as an unauthenticated attacker, and content only the vendor can place is not attacker input.";
    const old = (await loadWordPressDiscoveryAsset("wp2shell-bounty-v14-wide"))
      .text;
    expect(old.split(before)).toHaveLength(2);
    const text = (await loadWordPressDiscoveryAsset("wp2shell-bounty-v16-wide"))
      .text;
    expect(text).toBe(old.replace(before, after));
    expect(
      text
        .trim()
        .split(/\n\s*\n/)
        .at(-1),
    ).toMatch(/^Stop when/);
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
        id === "wp2shell-bounty-v10" ||
        id === "wp2shell-bounty-v11" ||
        id === "wp2shell-bounty-v10-wide" ||
        id === "wp2shell-bounty-v11-wide" ||
        id === "wp2shell-bounty-v12-wide" ||
        id === "wp2shell-bounty-v13-wide" ||
        id === "wp2shell-bounty-v14-wide" ||
        id === "wp2shell-bounty-v15-wide" ||
        id === "wp2shell-bounty-v16-wide"
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
