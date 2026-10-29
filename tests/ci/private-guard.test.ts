import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../scripts/check-private-evidence.sh", import.meta.url),
);
let directory: string;
let base: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
}

async function put(path: string, content: string): Promise<void> {
  const file = join(directory, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

function commit(): string {
  git("add", ".");
  git(
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "fixture",
  );
  return git("rev-parse", "HEAD");
}

function check(head: string) {
  return spawnSync("bash", [script], {
    cwd: directory,
    env: { ...process.env, BASE: base, HEAD: head },
    encoding: "utf8",
  });
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "wbh-private-guard-"));
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "CI fixture");
  git("config", "user.email", "ci-fixture@example.invalid");
  await put("README.md", "Public documentation.\n");
  base = commit();
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("private-guard command", () => {
  it("accepts public changes and an empty diff", async () => {
    expect(check(base).status).toBe(0);
    await put("docs/note.md", "Public implementation notes.\n");
    await put(
      "tests/fixture.ts",
      'const synthetic = "wbh-canary-synthetic-fixture";\n',
    );
    const result = check(commit());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("private-guard: ok");
  });

  it.each([
    "wbh-canary-synthetic-secret-0001",
    '{"request":{"method":"SYNTHETIC_PRIVATE_VALUE"}}',
    "-----BEGIN PRIVATE KEY----- SYNTHETIC_PRIVATE_VALUE",
    "wordpress_logged_in_0123456789abcdef0123456789abcdef=SYNTHETIC_PRIVATE_VALUE",
  ])("rejects private content without printing it (%#)", async (content) => {
    await put("docs/note.md", `${content}\n`);
    const result = check(commit());
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Private Evidence");
    expect(result.stdout + result.stderr).not.toContain(content);
    expect(result.stdout + result.stderr).not.toContain(
      "SYNTHETIC_PRIVATE_VALUE",
    );
  });

  it.each([
    "evidence/note.md",
    "notes/capture.har",
    "submission-package-test.json",
  ])("rejects the existing private path class %s", async (path) => {
    await put(path, "SYNTHETIC_PRIVATE_VALUE\n");
    const result = check(commit());
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(path);
    expect(result.stdout + result.stderr).not.toContain(
      "SYNTHETIC_PRIVATE_VALUE",
    );
  });

  it.each([524288, 524289])(
    "keeps the 512 KiB threshold (%i bytes)",
    async (size) => {
      await put("notes/large.txt", "x".repeat(size));
      expect(check(commit()).status).toBe(size > 524288 ? 1 : 0);
    },
  );

  it("ignores changes made only on a newer base branch", async () => {
    git("switch", "--quiet", "-c", "base-update");
    await put("docs/base-note.md", "wbh-canary-synthetic-base-only\n");
    base = commit();
    git("switch", "--quiet", "main");
    await put("docs/feature-note.md", "Public change.\n");
    expect(check(commit()).status).toBe(0);
  });

  it("fails when the comparison cannot be computed", () => {
    base = "missing-base-ref";
    const result = check(git("rev-parse", "HEAD"));
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("private-guard: ok");
  });
});
