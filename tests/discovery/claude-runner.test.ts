import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_RUNNER_DENIALS,
  CLAUDE_RUNNER_SOURCE,
  claudeRunnerChildLimitDenial,
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

/** A stand-in SDK whose Root asks for five children at once and then ends its turn. */
const FIVE_CHILDREN_SDK = `
export async function* query({ options }) {
  const hook = options.hooks.PreToolUse[0].hooks[0];
  for (let index = 0; index < 5; index += 1) await hook({ tool_name: "Agent" });
  yield { type: "result", subtype: "success", is_error: false, session_id: "s" };
}
`;

/** A stand-in SDK whose Root asks for three children before any of them starts. */
const AGENT_SDK = `
export async function* query({ options }) {
  const hook = options.hooks.PreToolUse[0].hooks[0];
  const decisions = [];
  for (let call = 0; call < 3; call += 1) {
    const answer = await hook({ tool_name: "Agent" });
    decisions.push(answer.hookSpecificOutput?.permissionDecisionReason ?? "allow");
  }
  yield { type: "result", subtype: "success", is_error: false, session_id: "s", decisions };
}
`;

/** A stand-in SDK that reports the tools it was offered and the hook's answer to an Agent call. */
const ONE_SHOT_SDK = `
export async function* query({ options }) {
  const hook = options.hooks.PreToolUse[0].hooks[0];
  const agent = await hook({ tool_name: "Agent" });
  yield {
    type: "result", subtype: "success", is_error: false, session_id: "s",
    tools: options.tools, allowedTools: options.allowedTools,
    outputFormat: options.outputFormat ?? null,
    agentDecision: agent.hookSpecificOutput?.permissionDecisionReason ?? "allow",
  };
}
`;

async function runWith(
  sdkSource: string,
  minimumActiveMs = 1,
  maxChildren = 4,
) {
  return runWithConfig(sdkSource, {
    prompt: "p",
    resumePrompt: "r",
    minimumActiveMs,
    maxChildren,
    model: "m",
    effort: "high",
    outputSchema: { type: "object" },
  });
}

async function runWithConfig(sdkSource: string, config: unknown) {
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
  await writeFile(join(sdk, "index.js"), sdkSource);
  await writeFile(join(root, "runner.mjs"), CLAUDE_RUNNER_SOURCE);
  const child = run(process.execPath, [join(root, "runner.mjs")]);
  child.child.stdin?.end(JSON.stringify(config));
  const { stdout } = await child;
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

let root: string | undefined;
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe("Claude runner", () => {
  it("lets the Root hand in its report through StructuredOutput and keeps it from children", async () => {
    const result = (await runWith(FAKE_SDK)).find(
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

  it("stamps child-spawn decisions and turns with the time the runner saw them", async () => {
    const events = await runWith(FIVE_CHILDREN_SDK);
    const decisions = events.filter(
      (event) => event.type === "harness.child-decision",
    );
    // The 1 ms floor may start a second turn; the first turn's five calls decide.
    expect(decisions.slice(0, 5).map((event) => event.decision)).toEqual([
      "allow",
      "allow",
      "allow",
      "allow",
      "child-limit",
    ]);
    for (const event of [
      ...decisions,
      ...events.filter((event) => event.type === "harness.turn"),
    ])
      expect(Number.isFinite(Date.parse(String(event.at)))).toBe(true);
  });

  it("accepts a 0 floor and runs the first turn only (wide mode, ADR 0039)", async () => {
    const events = await runWith(FAKE_SDK, 0);
    expect(
      events
        .filter((event) => event.type === "harness.turn")
        .map(({ at: _at, ...rest }) => rest),
    ).toEqual([{ type: "harness.turn", turn: 1, sessionId: "s" }]);
  });

  it("denies a child beyond the campaign's maxChildren with that number", async () => {
    const result = (await runWith(AGENT_SDK, 0, 2)).find(
      (event) => event.type === "result",
    );
    expect(result?.decisions).toEqual([
      "allow",
      "allow",
      claudeRunnerChildLimitDenial(2),
    ]);
    expect(claudeRunnerChildLimitDenial(2)).toBe(
      "At most 2 children can run at once in this Trial.",
    );
  });

  it("refuses to start without a positive maxChildren", async () => {
    await expect(runWith(FAKE_SDK, 0, 0)).rejects.toThrow();
  });

  it("runs a one-shot role as one turn without the Agent tool and without a report schema (ADR 0042)", async () => {
    const events = await runWithConfig(ONE_SHOT_SDK, {
      prompt: "p",
      minimumActiveMs: 0,
      maxChildren: 0,
      oneShot: true,
      model: "m",
      effort: "high",
    });
    const result = events.find((event) => event.type === "result");
    expect(result?.tools).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Bash",
      "Write",
      "Edit",
    ]);
    expect(result?.allowedTools).not.toContain("Agent");
    expect(result?.outputFormat).toBeNull();
    expect(result?.agentDecision).toBe(CLAUDE_RUNNER_DENIALS.outsideSurface);
    expect(
      events.filter((event) => event.type === "harness.turn"),
    ).toHaveLength(1);
  });

  it("refuses a one-shot config that still names children or a resume prompt", async () => {
    await expect(
      runWithConfig(ONE_SHOT_SDK, {
        prompt: "p",
        minimumActiveMs: 0,
        maxChildren: 1,
        oneShot: true,
        model: "m",
        effort: "high",
      }),
    ).rejects.toThrow();
    await expect(
      runWithConfig(ONE_SHOT_SDK, {
        prompt: "p",
        resumePrompt: "r",
        minimumActiveMs: 0,
        maxChildren: 0,
        oneShot: true,
        model: "m",
        effort: "high",
      }),
    ).rejects.toThrow();
  });
});
