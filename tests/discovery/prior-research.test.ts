import { describe, expect, it } from "vitest";

import {
  MAX_PRIOR_RESEARCH_FILE_BYTES,
  PRIOR_RESEARCH_FILE_NAMES,
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

  it("lists one file alone and refuses nothing, duplicates and odd versions", () => {
    const one = priorResearchSection({
      priorVersion: "1.0",
      currentVersion: "1.1",
      files: [{ name: "recon-map.md", bytes: 1 }],
    });
    expect(one).toContain("recon-map.md");
    expect(one).not.toContain("lab-setup.md");
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
    expect(() =>
      priorResearchSection({
        priorVersion: "1.0 <script>",
        currentVersion: "1.1",
        files: [{ name: "recon-map.md", bytes: 1 }],
      }),
    ).toThrow(/version/);
  });

  it("fixes the names, the directory and the size bound", () => {
    expect(PRIOR_RESEARCH_FILE_NAMES).toEqual(["recon-map.md", "lab-setup.md"]);
    expect(priorResearchPath("recon-map.md")).toBe("prior/recon-map.md");
    expect(MAX_PRIOR_RESEARCH_FILE_BYTES).toBe(65_536);
  });
});
