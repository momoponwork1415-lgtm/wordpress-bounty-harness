import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ICruiseResult } from "dependency-cruiser";
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

const WORKSPACE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SOURCE_ROOT = join(WORKSPACE_ROOT, "src");
const run = promisify(execFile);

async function inspectDependencies(cwd: string): Promise<ICruiseResult> {
  const { stdout, stderr } = await run(
    process.execPath,
    [
      join(
        WORKSPACE_ROOT,
        "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs",
      ),
      "src",
      "--config",
      join(WORKSPACE_ROOT, ".dependency-cruiser.json"),
      "--output-type",
      "json",
    ],
    { cwd, maxBuffer: 8 * 1024 * 1024 },
  );
  // Unsupported compilers can otherwise yield exit 0 and an empty graph.
  expect(stderr).not.toContain("missing-tsc-transpiler");
  const result = JSON.parse(stdout) as ICruiseResult;
  const sources = (await listTypeScriptFiles(join(cwd, "src"))).map((file) =>
    relative(cwd, file).replaceAll("\\", "/"),
  );
  expect(sources.length).toBeGreaterThan(0);
  expect(new Set(result.modules.map((module) => module.source))).toEqual(
    new Set(sources),
  );
  return result;
}

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
    const result = await inspectDependencies(WORKSPACE_ROOT);
    expect(
      result.summary.violations.filter(({ rule }) => rule.severity === "error"),
    ).toEqual([]);
  }, 30_000);

  it("checks type imports, re-exports and dynamic imports, while excluding type-only cycles from runtime diagnostics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-boundaries-"));
    try {
      const files: Record<string, string> = {
        "tsconfig.json": JSON.stringify({
          compilerOptions: { verbatimModuleSyntax: true },
        }),
        "src/profiles/example.ts":
          "export interface Adapter {}\nexport const value = 1;\n",
        "src/cli/example.ts": "export const value = 1;\n",
        "src/review/type-import.ts":
          'import type { Adapter } from "../profiles/example.js";\nexport type Input = Adapter;\n',
        "src/review/re-export.ts":
          'export { value } from "../profiles/example.js";\n',
        "src/review/dynamic-import.ts":
          'export const load = () => import("../cli/example.js");\n',
        "src/infrastructure/type-a.ts":
          'import type { B } from "./type-b.js";\nexport interface A { b: B }\n',
        "src/infrastructure/type-b.ts":
          'import type { A } from "./type-a.js";\nexport interface B { a: A }\n',
        "src/infrastructure/mixed-a.ts":
          'import { b } from "./mixed-b.js";\nexport interface A {}\nexport const a = b;\n',
        "src/infrastructure/mixed-b.ts":
          'import type { A } from "./mixed-a.js";\nexport const b: A = {};\n',
        "src/infrastructure/runtime-a.ts":
          'import { b } from "./runtime-b.js";\nexport const a = () => b();\n',
        "src/infrastructure/runtime-b.ts":
          'import { a } from "./runtime-a.js";\nexport const b = () => a();\n',
      };
      await Promise.all(
        Object.entries(files).map(async ([path, content]) => {
          const file = join(directory, path);
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, content);
        }),
      );
      const result = await inspectDependencies(directory);
      const boundaryViolations = result.summary.violations.filter(
        ({ rule }) => rule.name === "generic-modules-do-not-import-adapters",
      );
      expect(boundaryViolations.map(({ from }) => from).sort()).toEqual([
        "src/review/dynamic-import.ts",
        "src/review/re-export.ts",
        "src/review/type-import.ts",
      ]);
      const runtimeCycles = result.summary.violations.filter(
        ({ rule }) => rule.name === "runtime-cycles",
      );
      expect(runtimeCycles).toHaveLength(1);
      expect(runtimeCycles[0]?.from).toMatch(/runtime-[ab]\.ts$/);
      expect(
        result.modules.find(({ source }) => source.endsWith("type-import.ts"))
          ?.dependencies[0]?.preCompilationOnly,
      ).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("generic modules do not name WordPress-specific concepts", async () => {
    // 語が現れたら profile へ移す合図（AGENTS.md）。コメントと文字列も含めて見る。
    // `proxy-capture` は WordPress 判定器が Private Evidence に置く file 名
    // （src/profiles/wordpress/verification/http-evidence.ts）。汎用側は
    // HttpEvidenceReader の seam を通して読む。
    // sandbox の mount 配置のうち `/workspace/wordpress`・`/workspace/php`・
    // `/workspace/dependencies` と、その read-path label は profile の
    // src/profiles/wordpress/sandbox-layout.ts が 1 回宣言し、汎用側は run の入力として受け取る。
    // `/workspace/main` と `/workspace/research` は sandbox 自身の契約なので汎用側に置く。
    const pattern =
      /\bwp_options\b|\bwp_ajax\b|admin-ajax\.php|\bwp-admin\b|\bwp-content\b|proxy-capture|\/workspace\/(?:wordpress|php|dependencies)\b|@(?:wordpress|php|dependencies)\//;
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
