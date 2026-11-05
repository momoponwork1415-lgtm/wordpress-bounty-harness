import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { wordpressFindingClaimSchema } from "../../../src/profiles/wordpress/discovery/finding.js";
import { wordpressLeadClaimSchema } from "../../../src/profiles/wordpress/discovery/lead.js";
import { wordPressDiscoveryOutputContractV4 } from "../../../src/profiles/wordpress/discovery/output-contract.js";

import {
  loadWordPressDiscoveryAsset,
  WORDPRESS_CURRENT_DISCOVERY_PROMPT_ID,
  WORDPRESS_CURRENT_DISCOVERY_PROMPT_IDS,
  WORDPRESS_DISCOVERY_ASSET_IDS,
  WORDPRESS_DISCOVERY_MODES,
  WORDPRESS_DISCOVERY_PROMPT_IDS,
  WORDPRESS_DISCOVERY_PROMPTS,
  WORDPRESS_LAUNCHABLE_DISCOVERY_PROMPT_IDS,
  WORDPRESS_OBJECTIVE_ONLY_PROMPT_IDS,
  WORDPRESS_TRUST_BOUNDARIES,
  WORDPRESS_TRUST_BOUNDARY,
  wordPressTrustBoundaryId,
} from "../../../src/profiles/wordpress/prompts/index.js";

const promptsUrl = new URL(
  "../../../src/profiles/wordpress/prompts/",
  import.meta.url,
);

describe("WordPress prompt table", () => {
  it("pins every prompt body to the digest recorded in its table row", async () => {
    // A changed `.md` body fails here until its row is re-pinned under a new version.
    for (const row of [
      ...WORDPRESS_DISCOVERY_PROMPTS,
      ...WORDPRESS_TRUST_BOUNDARIES,
    ]) {
      const asset = await loadWordPressDiscoveryAsset(row.id);
      const bytes = await readFile(new URL(`${row.id}.md`, promptsUrl));
      expect(asset.id).toBe(row.id);
      expect(asset.sourceUrl.pathname.endsWith(`/${row.id}.md`)).toBe(true);
      expect(asset.text).toBe(bytes.toString("utf8"));
      expect(asset.text.length).toBeGreaterThan(100);
      expect(asset.digest).toBe(
        `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      );
      expect(asset.digest).toBe(row.digest);
    }
  });

  it("keeps only the texts a new Trial receives; earlier versions live in history/ (2026-11-05)", async () => {
    const files = (await readdir(promptsUrl)).filter((name) =>
      name.endsWith(".md"),
    );
    expect(files.sort()).toEqual(
      [...WORDPRESS_DISCOVERY_ASSET_IDS].map((id) => `${id}.md`).sort(),
    );
  });

  it("derives the id lists and the current versions from the table", () => {
    expect(WORDPRESS_DISCOVERY_PROMPT_IDS).toEqual([
      "wp2shell-bounty-v26-wide",
    ]);
    expect(WORDPRESS_DISCOVERY_ASSET_IDS).toEqual([
      "wp2shell-bounty-v26-wide",
      "trust-boundary-v2",
    ]);
    expect(WORDPRESS_OBJECTIVE_ONLY_PROMPT_IDS).toEqual([
      "wp2shell-bounty-v26-wide",
    ]);
    // ADR 0039: exactly one current objective per launch mode.
    for (const mode of WORDPRESS_DISCOVERY_MODES)
      expect(
        WORDPRESS_DISCOVERY_PROMPTS.filter(
          (row) => row.status === "current" && row.mode === mode,
        ),
      ).toHaveLength(1);
    expect(WORDPRESS_CURRENT_DISCOVERY_PROMPT_IDS).toEqual({
      wide: "wp2shell-bounty-v26-wide",
    });
    expect(WORDPRESS_CURRENT_DISCOVERY_PROMPT_ID).toBe(
      "wp2shell-bounty-v26-wide",
    );
    expect(WORDPRESS_LAUNCHABLE_DISCOVERY_PROMPT_IDS).toEqual([
      "wp2shell-bounty-v26-wide",
    ]);
    expect(WORDPRESS_TRUST_BOUNDARY.id).toBe("trust-boundary-v2");
    expect(wordPressTrustBoundaryId("trust-boundary-v2")).toBe(
      "trust-boundary-v2",
    );
    // A Trial that recorded v1 or nothing is refused on resume.
    expect(wordPressTrustBoundaryId(undefined)).toBeUndefined();
    expect(wordPressTrustBoundaryId("trust-boundary-v1")).toBeUndefined();
  });

  it("ends every launchable objective with the resume directive its mode expects (ADR 0039; #731)", async () => {
    // `wordPressResumeParagraph` (src/cli/wordpress.ts) takes the last paragraph as the
    // directive early Root resumes receive and skips the target when the prefix is wrong.
    const prefix = { wide: "Stop when" } as const;
    for (const row of WORDPRESS_DISCOVERY_PROMPTS) {
      const text = (await loadWordPressDiscoveryAsset(row.id)).text;
      const last =
        text
          .trim()
          .split(/\n\s*\n/)
          .at(-1) ?? "";
      expect(`${row.id}: ${last.slice(0, 40)}`).toMatch(
        new RegExp(`^${row.id}: ${prefix[row.mode]}`),
      );
    }
  });
});

describe("WordPress discovery prompt assets", () => {
  it("keeps the July 30 objective independent from the six-phase skill and records open routes", async () => {
    const candidate = await loadWordPressDiscoveryAsset(
      "wp2shell-bounty-v26-wide",
    );
    expect(candidate.text).toContain("operational prior");
    expect(candidate.text).toContain(
      "The first surviving candidate is a checkpoint",
    );
    expect(candidate.text).toContain("/workspace/research/continuation.json");
    expect(candidate.text).toContain('"schemaVersion": 1');
    expect(candidate.text).not.toContain("wbh-audit");
    expect(candidate.text).not.toContain("wbh-lab");
  });

  it("pins the generated v4 contract and renders both claim schemas in it", () => {
    const contract = wordPressDiscoveryOutputContractV4();
    // Launchable rows since 2026-10-27 (ADR 0038 addendum 15).
    expect(contract.id).toBe("wordpress-discovery-contract-v4");
    expect(contract.digest).toBe(
      "sha256:5acd5157fc82cb76c35490af607513a1558477c4eb03acaa046fdf0a64c99883",
    );
    const schemaLine = (label: string) =>
      JSON.parse(
        contract.text.split(`${label} schema: `)[1]!.split("\n")[0]!,
      ) as unknown;
    // v4 keeps the Finding schema before the declared fields (#613).
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
    expect(schemaLine("Lead")).toEqual(
      z.toJSONSchema(wordpressLeadClaimSchema, { io: "output" }),
    );
    expect(contract.text).toContain("`@dependencies/<id>/`");
    expect(contract.text).toContain("every child spawn assignment");
    expect(contract.text).toContain("every follow-up to a child");
    expect(contract.text).toContain("Root's final report");
  });

  it("keeps the objective-only assets free of the claim contract", async () => {
    for (const id of WORDPRESS_OBJECTIVE_ONLY_PROMPT_IDS) {
      const { text } = await loadWordPressDiscoveryAsset(id);
      expect(text).toMatch(/Lead|Finding/);
      expect(text).not.toMatch(
        /sourceTrace|labObservations|JSON string|Each Finding is an object/,
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
    await expect(
      loadWordPressDiscoveryAsset("wp2shell-bounty-v22-wide" as never),
    ).rejects.toThrow("Unknown WordPress discovery asset");
  });

  it("leaves attacker positions and in-scope effects to the supplied sections", async () => {
    for (const id of WORDPRESS_DISCOVERY_PROMPT_IDS) {
      const { text } = await loadWordPressDiscoveryAsset(id);
      // Owner decision 2026-10-16: the trust boundary and Programme Boundary sections carry them.
      expect(text).toContain("trust boundary");
      expect(text).toContain("Programme Boundary");
      expect(text).not.toMatch(
        /\/flag|at least 6 hours|guaranteed vulnerability/i,
      );
    }
  });

  it("defines the human trust boundary", async () => {
    const trust = await loadWordPressDiscoveryAsset("trust-boundary-v2");
    expect(trust.text).toContain("human-authored declaration");
    expect(trust.text).toContain("contributor");
    expect(trust.text).toContain("administrator");
    expect(trust.text).toContain("unfiltered_html");
    expect(trust.text).toContain("named human's matching observation");
    expect(trust.text).toContain(
      "retained verification Lab or a new review Lab",
    );
    expect(trust.text).not.toContain("independent judge");
    expect(trust.text).not.toContain("canary checks");
  });
});
