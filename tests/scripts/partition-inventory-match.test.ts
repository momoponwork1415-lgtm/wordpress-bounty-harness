import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test } from "vitest";

const script = fileURLToPath(
  new URL("../../scripts/partition-inventory-match.mjs", import.meta.url),
);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

test("prints only how many records land on an inventory row (ADR 0042 acceptance)", async () => {
  const root = await mkdtemp(join(tmpdir(), "wbh-inventory-match-"));
  roots.push(root);
  const inventory = join(root, "inventory.json");
  const records = join(root, "records.json");
  await writeFile(
    inventory,
    JSON.stringify({
      rows: [
        {
          id: "a",
          origin: "script",
          kind: "k",
          file: "x.php",
          line: 10,
          text: "t",
        },
        { id: "b", origin: "agent", kind: "k", file: "y.php", text: "t" },
      ],
    }),
  );
  await writeFile(
    records,
    JSON.stringify({
      records: [
        { file: "x.php", line: 10 },
        { file: "x.php", line: 11 },
        { file: "y.php", line: 99 },
        { file: "z.php", line: 1 },
        { file: "x.php" },
      ],
    }),
  );
  const result = spawnSync(
    process.execPath,
    [script, "--inventory", inventory, "--records", records],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  // x.php:10 matches, x.php:11 does not, y.php has no line so any line matches,
  // z.php is absent, a record without a line matches its file.
  expect(result.stdout).toBe("records matched: 3 / 5\n");
  expect(result.stdout).not.toContain("php");
});

test("exits with usage when a flag is missing", () => {
  const result = spawnSync(process.execPath, [script, "--records", "x"], {
    encoding: "utf8",
  });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("usage:");
});
