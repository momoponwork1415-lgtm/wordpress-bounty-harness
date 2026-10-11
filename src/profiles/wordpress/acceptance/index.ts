import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { z } from "zod";

const categorySchema = z.enum(["stored-xss", "sqli", "account-takeover"]);
const programmeCriteriaSchema = z.strictObject({
  wordfence: z.array(z.string().min(1)).min(1),
  patchstack: z.array(z.string().min(1)).min(1),
});
const criteriaSchema = z.strictObject({
  id: z.enum(["stored-xss-v1", "sqli-v1", "account-takeover-v1"]),
  version: z.literal(1),
  category: categorySchema,
  judgeSuccessCriterion: z.string().min(1),
  programmeCriteria: programmeCriteriaSchema,
});
const templateSchema = z.strictObject({
  id: z.literal("reproduction-package-v1"),
  version: z.literal(1),
  sections: z.tuple([
    z.strictObject({
      id: z.literal("acceptance"),
      heading: z.literal("受理基準の充足"),
    }),
    z.strictObject({
      id: z.literal("observation"),
      heading: z.literal("期待する観測と実際の観測"),
    }),
    z.strictObject({
      id: z.literal("negative-control"),
      heading: z.literal("修正版での負の対照"),
    }),
    z.strictObject({
      id: z.literal("steps"),
      heading: z.literal("再現手順"),
    }),
  ]),
});

const assets = {
  "stored-xss": {
    id: "stored-xss-v1",
    digest:
      "sha256:fb25cb7be36b854baf59ec5e40a462f750ed364a65e0d1ff5f001bb82a8003d4",
  },
  sqli: {
    id: "sqli-v1",
    digest:
      "sha256:e00c8d9d9ed91d2bec012b66b2dcb1f0d1ea3c6cef377f3712d9e44080d0c255",
  },
  "account-takeover": {
    id: "account-takeover-v1",
    digest:
      "sha256:196d6a84c670872a8bdb8bc92d7e11d8420ea36ae8ffdaa7dd035308b039c60d",
  },
} as const;
const template = {
  id: "reproduction-package-v1",
  digest:
    "sha256:9dcad9770edec62a1213928846866557309096926db0ac414ac591965c6d4926",
} as const;

export type WordPressAcceptanceCategory = z.infer<typeof categorySchema>;
export type WordPressAcceptanceCriteria = z.infer<typeof criteriaSchema> & {
  readonly digest: `sha256:${string}`;
  readonly text: string;
};
export type WordPressReproductionTemplate = z.infer<typeof templateSchema> & {
  readonly digest: `sha256:${string}`;
  readonly text: string;
};

async function loadPinnedAsset(
  id: string,
  expectedDigest: `sha256:${string}`,
  blockKind: "criteria-v1" | "template-v1",
): Promise<{
  readonly data: unknown;
  readonly digest: `sha256:${string}`;
  readonly text: string;
}> {
  const bytes = await readFile(new URL(`./${id}.md`, import.meta.url));
  const digest =
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
  if (digest !== expectedDigest) {
    throw new Error(`WordPress acceptance asset digest mismatch: ${id}`);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.includes(`Asset ID: \`${id}\``)) {
    throw new Error(`WordPress acceptance asset ID mismatch: ${id}`);
  }
  const matches = [
    ...text.matchAll(
      new RegExp("```json " + blockKind + "\\n([\\s\\S]*?)\\n```", "g"),
    ),
  ];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new Error(
      `WordPress acceptance asset block missing or duplicated: ${id}`,
    );
  }
  return { data: JSON.parse(matches[0][1]) as unknown, digest, text };
}

/** Returns null for categories without a versioned acceptance criterion yet. */
export async function loadWordPressAcceptanceCriteria(
  category: string,
): Promise<WordPressAcceptanceCriteria | null> {
  const parsedCategory = categorySchema.safeParse(category);
  if (!parsedCategory.success) return null;
  const asset = assets[parsedCategory.data];
  const loaded = await loadPinnedAsset(asset.id, asset.digest, "criteria-v1");
  const criteria = criteriaSchema.parse(loaded.data);
  if (criteria.id !== asset.id || criteria.category !== parsedCategory.data) {
    throw new Error(
      `WordPress acceptance asset category mismatch: ${asset.id}`,
    );
  }
  return { ...criteria, digest: loaded.digest, text: loaded.text };
}

/** The four headings are in the human reading order fixed by ADR 0028. */
export async function loadWordPressReproductionTemplate(): Promise<WordPressReproductionTemplate> {
  const loaded = await loadPinnedAsset(
    template.id,
    template.digest,
    "template-v1",
  );
  const parsedTemplate = templateSchema.parse(loaded.data);
  for (const [index, section] of parsedTemplate.sections.entries()) {
    if (!loaded.text.includes(`## ${index + 1}. ${section.heading}`)) {
      throw new Error(
        `WordPress reproduction template section mismatch: ${section.id}`,
      );
    }
  }
  return { ...parsedTemplate, digest: loaded.digest, text: loaded.text };
}
