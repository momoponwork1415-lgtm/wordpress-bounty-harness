import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { presentHeldVerificationLab } from "../../src/cli/index.js";
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

/** #595: the skills quote the lines `verify next --handoff` prints for the Lab it keeps (#600). */
describe("held verification Lab lines the skills quote", () => {
  async function printed(): Promise<string[]> {
    const lines: string[] = [];
    const listeners: (() => void)[] = [];
    await presentHeldVerificationLab(
      {
        ref: { campaignId: "c", findingId: "f", verificationId: "v" },
        labId: "lab-1",
        endpoint: "http://wordpress",
        attackerAccounts: { subscriber: { username: "u", password: "p" } },
        administrator: { username: "a", password: "p" },
        host: {
          url: "http://127.0.0.1:80",
          hostHeader: "wordpress",
          port: 80,
        },
        receipt: { digest: `sha256:${"a".repeat(64)}`, path: "/receipt" },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      {
        stdout(line) {
          lines.push(line);
          if (line.startsWith("Run lab down"))
            for (const listener of listeners) listener();
        },
        stderr() {},
      },
      { on: (_signal, listener) => listeners.push(listener), off() {} },
    );
    return lines;
  }

  it.each([
    [
      "wbh-review",
      [
        "kept for a person's observation on",
        "manual observation receipt:",
        "attacker accounts:",
        "review administrator:",
      ],
    ],
    ["wbh-verify", ["review administrator:"]],
  ])("%s quotes only printed lines", async (skill, quoted) => {
    const lines = await printed();
    const text = await readFile(
      new URL(`../../.claude/skills/${skill}/SKILL.md`, import.meta.url),
      "utf8",
    );
    for (const phrase of quoted) {
      expect(text).toContain(phrase);
      expect(lines.some((line) => line.includes(phrase))).toBe(true);
    }
  });
});
