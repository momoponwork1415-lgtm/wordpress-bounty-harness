import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import { wordpressFindingClaimSchema } from "../../../src/profiles/wordpress/discovery/finding.js";
import type { WordPressFinding } from "../../../src/profiles/wordpress/discovery/finding.js";
import { isWordPressProgrammeImpact } from "../../../src/profiles/wordpress/discovery/programme-impacts.js";
import { createWordPressJudges } from "../../../src/profiles/wordpress/verification/judges.js";
import { finding, quietLab } from "./judge-fixture.js";

const coverageFile = new URL(
  "../../../docs/reviews/2026-10-16-programme-impact-coverage.md",
  import.meta.url,
);

function coverageRows() {
  const lines = readFileSync(coverageFile, "utf8").split("\n");
  const header = lines.findIndex(
    (line) => line === "| Impact | Lab observer | Judge ID |",
  );
  expect(header).toBeGreaterThan(-1);
  const rows: {
    impact: string;
    observers: string[];
    judgeId: string | null;
  }[] = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    expect(cells).toHaveLength(3);
    const [impact, observer, judge] = cells;
    expect(impact).toMatch(/^`[^`]+`$/);
    expect(observer).toMatch(/^(?:—|`[^`]+`(?:, `[^`]+`)*)$/);
    expect(judge).toMatch(/^(?:—|`[^`]+`)$/);
    rows.push({
      impact: impact!.slice(1, -1),
      observers:
        observer === "—"
          ? []
          : [...observer!.matchAll(/`([^`]+)`/g)].map((match) => match[1]!),
      judgeId: judge === "—" ? null : judge!.slice(1, -1),
    });
  }
  return rows;
}

describe("Programme impact observer / judge coverage (#277)", () => {
  it("accounts for every in-programme impact and exposes missing judges", () => {
    const impactProperty = z
      .object({
        properties: z.object({
          impact: z.object({ enum: z.array(z.string()) }),
        }),
      })
      .parse(z.toJSONSchema(wordpressFindingClaimSchema, { io: "output" }))
      .properties.impact;
    const programmeImpacts = impactProperty.enum
      .filter(isWordPressProgrammeImpact)
      .sort();
    const rows = coverageRows();
    expect(rows.map((row) => row.impact).sort()).toEqual(programmeImpacts);

    const lab = quietLab();
    const judges = createWordPressJudges({
      store: new PrivateArtifactStore({
        rootDirectory: join(tmpdir(), "wbh-coverage-matrix-unused"),
        maxEntries: 1,
        maxBytes: 1,
      }),
      lab,
    });
    for (const row of rows) {
      const judge = judges.for(
        finding(row.impact as WordPressFinding["impact"]),
      );
      expect(judge?.id ?? null, row.impact).toBe(row.judgeId);
      expect(row.observers.length === 0, row.impact).toBe(judge === null);
      for (const observer of row.observers)
        expect(typeof lab[observer as keyof typeof lab], row.impact).toBe(
          "function",
        );
    }
    expect(
      rows
        .filter((row) => row.judgeId === null)
        .map((row) => row.impact)
        .sort(),
    ).toEqual(["content-deletion", "rfi"]);
  });
});
