import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// ADR 0011 / AGENTS.md: 汎用モジュールは profile の型だけに依存し、WordPress の型や path を import しない。
const GENERIC_MODULES = [
  "selection",
  "snapshot",
  "lab",
  "discovery",
  "verification",
  "ledger",
  "review",
  "infrastructure",
];

const SOURCE_ROOT = new URL("../../src/", import.meta.url).pathname;

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && /\.ts$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("module boundary (ADR 0011)", () => {
  it("generic modules do not import from src/profiles or src/cli", async () => {
    const offenders: string[] = [];
    for (const module of GENERIC_MODULES) {
      for (const file of await listTypeScriptFiles(join(SOURCE_ROOT, module))) {
        const text = await readFile(file, "utf8");
        for (const match of text.matchAll(
          /(?:from|import)\s*\(?\s*["']([^"']+)["']/g,
        )) {
          const specifier = match[1] ?? "";
          if (/(^|\/)profiles(\/|$)|(^|\/)cli(\/|$)/.test(specifier)) {
            offenders.push(`${relative(SOURCE_ROOT, file)} -> ${specifier}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("generic modules do not name WordPress-specific concepts", async () => {
    // 語が現れたら profile へ移す合図（AGENTS.md）。コメントと文字列も含めて見る。
    // `proxy-capture` は WordPress 判定器が Private Evidence に置く file 名
    // （src/profiles/wordpress/verification/http-evidence.ts）。汎用側は
    // HttpEvidenceReader の seam を通して読む。
    const pattern =
      /\bwp_options\b|\bwp_ajax\b|admin-ajax\.php|\bwp-admin\b|\bwp-content\b|proxy-capture/;
    const offenders: string[] = [];
    for (const module of GENERIC_MODULES) {
      for (const file of await listTypeScriptFiles(join(SOURCE_ROOT, module))) {
        const text = await readFile(file, "utf8");
        const line = text.split("\n").findIndex((l) => pattern.test(l));
        if (line >= 0)
          offenders.push(`${relative(SOURCE_ROOT, file)}:${line + 1}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
