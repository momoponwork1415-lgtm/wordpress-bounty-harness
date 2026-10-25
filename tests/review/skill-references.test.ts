import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { reviewExportV1Schema } from "../../src/review/export.js";
import { reviewExportV2Schema } from "../../src/review/manual-observation-export.js";

/** Every dotted path the export can hold, through nullable, arrays and unions. */
function paths(schema: z.ZodType, prefix = ""): string[] {
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })
    ._zod.def;
  switch (def.type) {
    case "nullable":
    case "optional":
    case "default":
      return paths(def.innerType as z.ZodType, prefix);
    case "array":
      return paths(def.element as z.ZodType, prefix);
    case "union":
      return (def.options as z.ZodType[]).flatMap((option) =>
        paths(option, prefix),
      );
    case "object":
      return Object.entries(def.shape as Record<string, z.ZodType>).flatMap(
        ([key, child]) => {
          const path = prefix === "" ? key : `${prefix}.${key}`;
          return [path, ...paths(child, path)];
        },
      );
    default:
      return [];
  }
}

const skills = [
  "wbh-review",
  "wbh-dedupe",
  "wbh-report",
  "wbh-destination",
  "wbh-screen",
];

/** Skills that read `review export --version 2` for the human Lab observation (#525). */
const readsV2 = new Set(["wbh-review", "wbh-report"]);

describe("review skills", () => {
  it.each(skills)(
    "%s reads only fields that the review export it names has",
    async (skill) => {
      const allowed = new Set(
        paths(readsV2.has(skill) ? reviewExportV2Schema : reviewExportV1Schema),
      );
      const text = await readFile(
        new URL(`../../.claude/skills/${skill}/SKILL.md`, import.meta.url),
        "utf8",
      );
      const references = [
        ...text.matchAll(
          /`([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+)`/g,
        ),
      ].map((match) => match[1]!);
      expect(references.length).toBeGreaterThan(0);
      expect(references.filter((path) => !allowed.has(path))).toEqual([]);
    },
  );
});
