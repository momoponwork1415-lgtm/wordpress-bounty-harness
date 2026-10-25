import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_RUNNER_DENIALS,
  CLAUDE_RUNNER_SOURCE,
} from "../../src/discovery/claude-runner.js";

const run = promisify(execFile);

/** A stand-in SDK: asks the runner's PreToolUse hook about each call and reports the answers. */
const FAKE_SDK = `
export async function* query({ options }) {
  const hook = options.hooks.PreToolUse[0].hooks[0];
  const calls = [
    { tool_name: "StructuredOutput" },
    { tool_name: "StructuredOutput", agent_id: "child-1" },
    { tool_name: "WebFetch" },
    { tool_name: "Read" },
  ];
  const decisions = [];
  for (const call of calls) {
    const answer = await hook(call);
    decisions.push(answer.hookSpecificOutput?.permissionDecisionReason ?? "allow");
  }
  yield { type: "result", subtype: "success", is_error: false, session_id: "s", decisions, allowedTools: options.allowedTools };
}
`;

let root: string | undefined;
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

/** Runs the runner source against the stand-in SDK and returns its stdout events. */
async function runRunner(minimumActiveMs: number) {
  root = await mkdtemp(join(tmpdir(), "claude-runner-"));
  const sdk = join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  await mkdir(sdk, { recursive: true });
  await writeFile(
    join(sdk, "package.json"),
    JSON.stringify({
      name: "@anthropic-ai/claude-agent-sdk",
      type: "module",
      main: "index.js",
    }),
  );
  await writeFile(join(sdk, "index.js"), FAKE_SDK);
  await writeFile(join(root, "runner.mjs"), CLAUDE_RUNNER_SOURCE);
  const child = run(process.execPath, [join(root, "runner.mjs")]);
  child.child.stdin?.end(
    JSON.stringify({
      prompt: "p",
      resumePrompt: "r",
      minimumActiveMs,
      model: "m",
      effort: "high",
      outputSchema: { type: "object" },
    }),
  );
  const { stdout } = await child;
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("Claude runner", () => {
  it("lets the Root hand in its report through StructuredOutput and keeps it from children", async () => {
    const result = (await runRunner(1)).find(
      (event) => event.type === "result",
    );
    expect(result?.decisions).toEqual([
      "allow",
      CLAUDE_RUNNER_DENIALS.outsideSurface,
      CLAUDE_RUNNER_DENIALS.outsideSurface,
      "allow",
    ]);
    expect(result?.allowedTools).toContain("StructuredOutput");
  });

  it("accepts a 0 floor and runs the first turn only (wide mode, ADR 0039)", async () => {
    const events = await runRunner(0);
    expect(events.filter((event) => event.type === "harness.turn")).toEqual([
      { type: "harness.turn", turn: 1, sessionId: "s" },
    ]);
  });
});
