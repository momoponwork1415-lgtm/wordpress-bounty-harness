import { describe, expect, it } from "vitest";

import {
  CONTINUATION_SECTION_SENTENCE,
  FOCUS_SECTION_SENTENCE,
  MAX_OPERATOR_FOCUS_BYTES,
  MAX_PRIOR_RESEARCH_FILE_BYTES,
  MAX_PRIOR_RESEARCH_FILES,
  MAX_PRIOR_RESEARCH_TOTAL_BYTES,
  OPERATOR_FOCUS_FILE,
  PRIOR_RESEARCH_DIRECTORIES,
  PRIOR_RESEARCH_FILE_NAMES,
  PRIOR_RESEARCH_STORES_FILE,
  capPriorResearch,
  isPriorResearchName,
  isPriorResearchPath,
  priorResearchPath,
  priorResearchSection,
} from "../../src/discovery/prior-research.js";

describe("Prior research section (ADR 0048)", () => {
  it("names the two files, the versions, and where the files are", () => {
    const text = priorResearchSection({
      priorVersion: "3.3.1",
      currentVersion: "3.4.0",
      files: [
        { name: "lab-setup.md", bytes: 2048 },
        { name: "recon-map.md", bytes: 9000 },
      ],
    });
    expect(text.startsWith("## Prior research\n\n")).toBe(true);
    expect(text).toContain(
      "An earlier Trial on version 3.3.1 of this same plugin",
    );
    expect(text).toContain("This Trial reads version 3.4.0.");
    // Files in the fixed order of the registry, each with its size.
    expect(text).toContain(
      "- /workspace/research/prior/recon-map.md: the map of the plugin that wbh-recon wrote (9000 bytes).\n- /workspace/research/prior/lab-setup.md: the record of the Lab's ordinary use that wbh-setup wrote (2048 bytes).",
    );
    // The section states facts; it tells the agent nothing to try.
    for (const word of ["should", "must", "try", "look for"])
      expect(text.toLowerCase()).not.toContain(word);
  });

  it("lists the wider set (ADR 0049 D) by path and size only, in the fixed order, and names withheld files", () => {
    const text = priorResearchSection({
      priorVersion: "3.3.1",
      currentVersion: "3.4.0",
      files: [
        { name: "walks/auth.md", bytes: 300 },
        { name: "assumptions/rest.md", bytes: 200 },
        { name: "stores.json", bytes: 50 },
        { name: "REGISTRY.md", bytes: 400 },
        { name: "assumptions/ajax.md", bytes: 100 },
        { name: "recon-map.md", bytes: 9000 },
      ],
      withheld: ["walks/settings.md", "assumptions/upload.md"],
    });
    const [, prose, list] = text.split("\n\n");
    // The prose is the 2026-11-01 text, unchanged.
    expect(prose).toBe(
      "An earlier Trial on version 3.3.1 of this same plugin wrote the files below from that version's pinned source, with the same skills. This Trial reads version 3.4.0. The files describe the earlier version, not this one: a part of the plugin that changed since may differ from what they say, and nothing in them is confirmed. This Trial's own files go to /workspace/research as the skills describe; the prior files stay where they are.",
    );
    expect(list!.split("\n")).toEqual([
      "- /workspace/research/prior/recon-map.md: the map of the plugin that wbh-recon wrote (9000 bytes).",
      "- /workspace/research/prior/REGISTRY.md (400 bytes).",
      "- /workspace/research/prior/stores.json (50 bytes).",
      "- /workspace/research/prior/assumptions/ajax.md (100 bytes).",
      "- /workspace/research/prior/assumptions/rest.md (200 bytes).",
      "- /workspace/research/prior/walks/auth.md (300 bytes).",
      "- Withheld for size, not placed: assumptions/upload.md, walks/settings.md.",
    ]);
    for (const word of ["should", "must", "try", "look for"])
      expect(new RegExp(`\\b${word}\\b`, "i").test(text)).toBe(false);
  });

  it("places operator-focus.md right after continuation.json and ends with the focus sentence only when the note was passed (ADR 0052, 2026-11-06)", () => {
    const files = [
      { name: "stores.json", bytes: 50 },
      { name: "operator-focus.md", bytes: 120 },
      { name: "continuation.json", bytes: 80 },
      { name: "recon-map.md", bytes: 9000 },
    ];
    const text = priorResearchSection({
      priorVersion: "3.4.0",
      currentVersion: "3.4.0",
      files,
      continuation: true,
      focus: true,
    });
    const parts = text.split("\n\n");
    expect(parts[2]!.split("\n")).toEqual([
      "- /workspace/research/prior/recon-map.md: the map of the plugin that wbh-recon wrote (9000 bytes).",
      "- /workspace/research/prior/continuation.json (80 bytes).",
      "- /workspace/research/prior/operator-focus.md (120 bytes).",
      "- /workspace/research/prior/stores.json (50 bytes).",
    ]);
    expect(parts.slice(3)).toEqual([
      CONTINUATION_SECTION_SENTENCE,
      FOCUS_SECTION_SENTENCE,
    ]);
    // Without the note the section is byte-for-byte the continuation one.
    const without = priorResearchSection({
      priorVersion: "3.4.0",
      currentVersion: "3.4.0",
      files: files.filter(({ name }) => name !== "operator-focus.md"),
      continuation: true,
    });
    expect(without.endsWith(CONTINUATION_SECTION_SENTENCE)).toBe(true);
    expect(without).not.toContain(FOCUS_SECTION_SENTENCE);
    expect(without).not.toContain("operator-focus.md");
    expect(capPriorResearch(files).kept.map(({ name }) => name)).toEqual([
      "recon-map.md",
      "continuation.json",
      "operator-focus.md",
      "stores.json",
    ]);
  });

  it("lists one file alone and refuses nothing, duplicates, names outside the set and odd versions", () => {
    const one = priorResearchSection({
      priorVersion: "1.0",
      currentVersion: "1.1",
      files: [{ name: "recon-map.md", bytes: 1 }],
    });
    expect(one).toContain("recon-map.md");
    expect(one).not.toContain("lab-setup.md");
    expect(one).not.toContain("Withheld");
    expect(() =>
      priorResearchSection({
        priorVersion: "1.0",
        currentVersion: "1.1",
        files: [],
      }),
    ).toThrow(/No prior research/);
    expect(() =>
      priorResearchSection({
        priorVersion: "1.0",
        currentVersion: "1.1",
        files: [
          { name: "recon-map.md", bytes: 1 },
          { name: "recon-map.md", bytes: 2 },
        ],
      }),
    ).toThrow(/named twice/);
    for (const name of ["sql.md", "tools/hooks.tsv", "traces/x.md"])
      expect(() =>
        priorResearchSection({
          priorVersion: "1.0",
          currentVersion: "1.1",
          files: [{ name, bytes: 1 }],
        }),
      ).toThrow(/outside the set/);
    expect(() =>
      priorResearchSection({
        priorVersion: "1.0",
        currentVersion: "1.1",
        files: [{ name: "recon-map.md", bytes: 1 }],
        withheld: ["MERGED.md"],
      }),
    ).toThrow(/outside the set/);
    expect(() =>
      priorResearchSection({
        priorVersion: "1.0 <script>",
        currentVersion: "1.1",
        files: [{ name: "recon-map.md", bytes: 1 }],
      }),
    ).toThrow(/version/);
  });

  it("fixes the names, the directories, the sandbox paths and the size bounds", () => {
    expect(PRIOR_RESEARCH_FILE_NAMES).toEqual([
      "recon-map.md",
      "lab-setup.md",
      "REGISTRY.md",
      "continuation.json",
      "operator-focus.md",
    ]);
    expect(OPERATOR_FOCUS_FILE).toBe("operator-focus.md");
    expect(MAX_OPERATOR_FOCUS_BYTES).toBe(8192);
    expect(PRIOR_RESEARCH_DIRECTORIES).toEqual(["assumptions", "walks"]);
    expect(PRIOR_RESEARCH_STORES_FILE).toBe("stores.json");
    expect(priorResearchPath("recon-map.md")).toBe("prior/recon-map.md");
    expect(priorResearchPath("walks/auth.md")).toBe("prior/walks/auth.md");
    expect(MAX_PRIOR_RESEARCH_FILE_BYTES).toBe(65_536);
    expect(MAX_PRIOR_RESEARCH_TOTAL_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_PRIOR_RESEARCH_FILES).toBe(64);
    for (const name of [
      "recon-map.md",
      "lab-setup.md",
      "REGISTRY.md",
      "stores.json",
      "assumptions/rest-api.md",
      "walks/Upload_v2.md",
    ]) {
      expect(isPriorResearchName(name)).toBe(true);
      expect(isPriorResearchPath(`prior/${name}`)).toBe(true);
    }
    for (const name of [
      "sql.md",
      "MERGED.md",
      "tools/hooks.tsv",
      "traces/x.md",
      "assumptions/nested/x.md",
      "assumptions/.hidden.md",
      "assumptions/x.txt",
      "walks/",
      "assumptions/../recon-map.md",
      "notes/recon-map.md",
    ]) {
      expect(isPriorResearchName(name)).toBe(false);
      expect(isPriorResearchPath(`prior/${name}`)).toBe(false);
    }
    expect(isPriorResearchPath("recon-map.md")).toBe(false);
    expect(isPriorResearchPath("prior/../recon-map.md")).toBe(false);
  });

  it("withholds the largest files first past the total size or count, and keeps both lists in the fixed order", () => {
    const files = [
      { name: "recon-map.md", bytes: 9_000 },
      { name: "stores.json", bytes: 2_000 },
      ...Array.from({ length: 40 }, (_, index) => ({
        name: `walks/w${String(index).padStart(2, "0")}.md`,
        bytes: 60_000 - index,
      })),
    ];
    const { kept, withheld } = capPriorResearch(files);
    const total = kept.reduce((sum, file) => sum + file.bytes, 0);
    expect(total).toBeLessThanOrEqual(MAX_PRIOR_RESEARCH_TOTAL_BYTES);
    expect(kept.length + withheld.length).toBe(files.length);
    // The small map and table survive; the withheld walks are the largest files.
    expect(kept[0]!.name).toBe("recon-map.md");
    expect(kept[1]!.name).toBe("stores.json");
    expect(withheld.map(({ name }) => name)).toEqual(
      withheld.map(({ name }) => name).sort(),
    );
    expect(
      Math.min(...withheld.map(({ bytes }) => bytes)),
    ).toBeGreaterThanOrEqual(
      Math.max(...kept.slice(2).map(({ bytes }) => bytes)),
    );
    const many = capPriorResearch(
      Array.from({ length: 70 }, (_, index) => ({
        name: `assumptions/a${index}.md`,
        bytes: 10,
      })),
    );
    expect(many.kept.length).toBe(MAX_PRIOR_RESEARCH_FILES);
    expect(many.withheld.length).toBe(6);
    expect(capPriorResearch([])).toEqual({ kept: [], withheld: [] });
  });
});
