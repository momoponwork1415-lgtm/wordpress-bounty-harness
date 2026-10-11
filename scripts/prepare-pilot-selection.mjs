import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** Historical entry point; target nomination now belongs to `harness select`. */
const { values } = parseArgs({
  options: {
    config: { type: "string" },
    host: { type: "string" },
    state: { type: "string" },
  },
});

const main = fileURLToPath(new URL("../dist/cli/main.js", import.meta.url));
const policy = fileURLToPath(
  new URL("../src/profiles/wordpress/policy/selection.json", import.meta.url),
);
const args = [
  main,
  ...(values.host === undefined ? [] : ["--host", values.host]),
  ...(values.state === undefined ? [] : ["--state", values.state]),
  "select",
  "--config",
  values.config ?? policy,
];

const child = spawn(process.execPath, args, { stdio: "inherit" });
process.exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolve(code ?? 1));
});
