// Copies the prompt and policy files the compiled modules read next to themselves.
import { cp, readdir } from "node:fs/promises";
import { join } from "node:path";

const source = new URL("../src/", import.meta.url);
const target = new URL("../dist/", import.meta.url);

for (const entry of await readdir(source, {
  recursive: true,
  withFileTypes: true,
})) {
  if (!entry.isFile() || !/\.(md|json)$/.test(entry.name)) continue;
  const relative = join(entry.parentPath, entry.name).slice(
    source.pathname.length,
  );
  await cp(new URL(relative, source), new URL(relative, target));
}
