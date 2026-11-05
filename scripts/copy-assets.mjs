// Copies the prompt, policy and tool files the compiled modules read next to themselves.
import { cp, readdir } from "node:fs/promises";
import { join } from "node:path";

const source = new URL("../src/", import.meta.url);
const target = new URL("../dist/", import.meta.url);

for (const entry of await readdir(source, {
  recursive: true,
  withFileTypes: true,
})) {
  if (!entry.isFile() || !/\.(md|json|sh)$/.test(entry.name)) continue;
  const relative = join(entry.parentPath, entry.name).slice(
    source.pathname.length,
  );
  await cp(new URL(relative, source), new URL(relative, target));
}

// The recorder is mounted alone into the Lab's pinned Node image.
await cp(
  new URL("../dist/lab/recorder/", import.meta.url),
  new URL("../dist/lab-recorder/", import.meta.url),
  { recursive: true },
);

// So is the exploration Lab's control endpoint (labctl).
await cp(
  new URL("../dist/lab/control/", import.meta.url),
  new URL("../dist/lab-control/", import.meta.url),
  { recursive: true },
);
