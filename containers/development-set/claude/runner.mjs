import { readFile } from "node:fs/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";

const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const allowed = new Set([
  "Read",
  "Glob",
  "Grep",
  "Bash",
  "Agent",
  "SendMessage",
]);
let childCount = 0;
const childIds = new Set();

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function input() {
  const parts = [];
  for await (const part of process.stdin) parts.push(part);
  const value = JSON.parse(Buffer.concat(parts).toString("utf8"));
  if (
    typeof value.prompt !== "string" ||
    !value.prompt ||
    value.model !== "claude-opus-5-5" ||
    !["low", "medium", "high", "xhigh", "max"].includes(value.effort) ||
    typeof value.outputSchema !== "object" ||
    value.outputSchema === null
  )
    throw new Error("Claude runner input is invalid");
  return value;
}

const preToolUse = async (hookInput) => {
  const tool = hookInput.tool_name;
  if (!allowed.has(tool))
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Tool is outside the Trial surface",
      },
    };
  if (tool === "Agent") {
    if (
      hookInput.agent_id ||
      hookInput.tool_input?.subagent_type !== "worker" ||
      hookInput.tool_input?.name !== undefined
    )
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "Only direct Root-to-worker delegation is admitted",
        },
      };
    if (childCount >= 3)
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Three-child Trial limit reached",
        },
      };
    childCount += 1;
    emit({ type: "harness.child-start", ordinal: childCount });
  }
  if (tool === "SendMessage") {
    if (hookInput.agent_id || !childIds.has(hookInput.tool_input?.to))
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "Only this Trial's children can receive follow-ups",
        },
      };
  }
  return {};
};

const subagentStart = async (hookInput) => {
  if (
    hookInput.agent_type === "worker" &&
    typeof hookInput.agent_id === "string"
  ) {
    childIds.add(hookInput.agent_id);
    emit({ type: "harness.child-id", agentId: hookInput.agent_id });
  }
  return {};
};

const subagentStop = async (hookInput) => {
  const path = hookInput.agent_transcript_path;
  const finalMessage =
    typeof hookInput.last_assistant_message === "string"
      ? hookInput.last_assistant_message.slice(0, MAX_TRANSCRIPT_BYTES)
      : "";
  if (typeof path !== "string" || !path.startsWith("/tmp/")) {
    emit({
      type: "harness.child-transcript-failed",
      agentId: hookInput.agent_id,
      finalMessage,
    });
    return {};
  }
  try {
    const bytes = await readFile(path);
    if (bytes.length <= MAX_TRANSCRIPT_BYTES)
      emit({
        type: "harness.child-transcript",
        agentId: hookInput.agent_id,
        transcript: bytes.toString("utf8"),
        finalMessage,
      });
    else
      emit({
        type: "harness.child-transcript-limit",
        agentId: hookInput.agent_id,
        finalMessage,
      });
  } catch {
    emit({
      type: "harness.child-transcript-failed",
      agentId: hookInput.agent_id,
      finalMessage,
    });
  }
  return {};
};

try {
  const config = await input();
  for await (const message of query({
    prompt: config.prompt,
    options: {
      model: config.model,
      effort: config.effort,
      cwd: "/workspace/main",
      tools: [...allowed],
      allowedTools: ["Read", "Glob", "Grep", "Bash", "Agent", "SendMessage"],
      permissionMode: "default",
      settingSources: [],
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
      persistSession: true,
      strictMcpConfig: true,
      mcpServers: {},
      outputFormat: { type: "json_schema", schema: config.outputSchema },
      agents: {
        worker: {
          description:
            "Investigate a source area delegated by the Root and report source-grounded candidates.",
          prompt: config.prompt,
          tools: ["Read", "Glob", "Grep", "Bash"],
          model: config.model,
          effort: config.effort,
          omitClaudeMd: true,
        },
      },
      hooks: {
        PreToolUse: [{ hooks: [preToolUse] }],
        SubagentStart: [{ hooks: [subagentStart] }],
        SubagentStop: [{ hooks: [subagentStop] }],
      },
      env: {
        ...process.env,
        CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1",
        CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "3",
        CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      },
    },
  }))
    emit(message);
} catch (error) {
  emit({
    type: "harness.runner-error",
    message: error instanceof Error ? error.message : "unknown",
  });
  process.exitCode = 1;
}
