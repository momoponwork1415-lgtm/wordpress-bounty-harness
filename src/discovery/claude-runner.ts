/**
 * What a hook tells the model when it refuses a tool call; both are in the
 * PR's source map. `{n}` is the campaign's `discovery.maxChildren`.
 */
export const CLAUDE_RUNNER_DENIALS = {
  outsideSurface: "Tool is outside the Trial surface.",
  childLimit: "At most {n} children can run at once in this Trial.",
} as const;

export const claudeRunnerChildLimitDenial = (maxChildren: number): string =>
  CLAUDE_RUNNER_DENIALS.childLimit.replace("{n}", String(maxChildren));

/**
 * Runs inside the disposable gVisor container, never on the host. It drives
 * Claude Code through the Agent SDK pinned in the image: one Root session,
 * at most `maxChildren` live children (the campaign's ceiling), and the
 * same Root session resumed with the pinned directive until the wall floor
 * (ADR 0033); a 0 floor (the `wide` mode, ADR 0039) runs the first turn only. Only compact Root events
 * reach stdout; full transcripts stay in the mounted Claude config directory.
 * With `resumeSessionId`, the first turn resumes that restored session with
 * the pinned directive instead of sending the objective again (ADR 0036).
 * With `skills`, the Skill tool is offered and the SDK lists exactly those names from the staged
 * config directory (ADR 0043).
 */
export const CLAUDE_RUNNER_SOURCE = String.raw`
import { query } from "@anthropic-ai/claude-agent-sdk";

const ALL_TOOLS = ["Read", "Glob", "Grep", "Bash", "Write", "Edit", "Agent"];
// The SDK gives the Root this tool for the json_schema report; children answer in text.
const REPORT_TOOL = "StructuredOutput";
const MAX_FINAL_MESSAGE = 64 * 1024;
const DENIALS = ${JSON.stringify(CLAUDE_RUNNER_DENIALS)};

const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
// Harness records carry the wall-clock time the hook or turn saw (A2).
const now = () => new Date().toISOString();
let raw = "";
for await (const chunk of process.stdin) raw += chunk.toString();
const config = JSON.parse(raw);
if (
  typeof config.prompt !== "string" || config.prompt.length === 0 ||
  typeof config.resumePrompt !== "string" || config.resumePrompt.length === 0 ||
  !Number.isSafeInteger(config.minimumActiveMs) || config.minimumActiveMs < 0 ||
  !Number.isSafeInteger(config.maxChildren) || config.maxChildren < 1 ||
  typeof config.outputSchema !== "object" || config.outputSchema === null ||
  typeof config.model !== "string" || typeof config.effort !== "string" ||
  (config.outputSchema !== undefined &&
    (typeof config.outputSchema !== "object" || config.outputSchema === null)) ||
  (config.resumeSessionId !== undefined &&
    (typeof config.resumeSessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(config.resumeSessionId))) ||
  (config.skills !== undefined &&
    (!Array.isArray(config.skills) || config.skills.length === 0 || config.skills.length > 8 ||
      config.skills.some((name) => typeof name !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(name))))
) process.exit(2);
const MAX_CHILDREN = config.maxChildren;
// ADR 0043: the skills the Harness staged under the config directory. The SDK
// lists only these names, reads them only with the user setting source (the
// staged, otherwise empty home), and needs the Skill tool on the surface.
const SKILLS = config.skills ?? [];
const TOOLS = [
  ...ALL_TOOLS,
  ...(SKILLS.length === 0 ? [] : ["Skill"]),
];
const CHILD_LIMIT = DENIALS.childLimit.replace("{n}", String(MAX_CHILDREN));

let pending = 0;
const live = new Set();
const deny = (reason) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  },
});
const preToolUse = async (input) => {
  if (input.tool_name === REPORT_TOOL)
    return input.agent_id === undefined ? {} : deny(DENIALS.outsideSurface);
  if (!TOOLS.includes(input.tool_name)) return deny(DENIALS.outsideSurface);
  if (input.tool_name !== "Agent") return {};
  if (input.agent_id !== undefined || MAX_CHILDREN === 0) return deny(DENIALS.outsideSurface);
  if (pending + live.size >= MAX_CHILDREN) {
    emit({ type: "harness.child-decision", at: now(), decision: "child-limit", live: live.size, pending });
    return deny(CHILD_LIMIT);
  }
  emit({ type: "harness.child-decision", at: now(), decision: "allow", live: live.size, pending });
  pending += 1;
  return {};
};
const subagentStart = async (input) => {
  pending = Math.max(0, pending - 1);
  live.add(input.agent_id);
  emit({ type: "harness.child-start", at: now(), agentId: input.agent_id, agentType: input.agent_type });
  return {};
};
const subagentStop = async (input) => {
  live.delete(input.agent_id);
  emit({
    type: "harness.child-stop",
    at: now(),
    agentId: input.agent_id,
    transcriptPath: input.agent_transcript_path,
    ...(typeof input.last_assistant_message === "string"
      ? { finalMessage: input.last_assistant_message.slice(0, MAX_FINAL_MESSAGE) }
      : {}),
  });
  return {};
};

function compact(message) {
  if (message.type === "result") return message;
  if (message.type === "system" && message.subtype === "init")
    return { type: "system", subtype: "init", session_id: message.session_id, model: message.model, claude_code_version: message.claude_code_version };
  if (message.type !== "assistant" || message.parent_tool_use_id) return undefined;
  const body = message.message ?? {};
  return {
    type: "assistant",
    session_id: message.session_id,
    ...(message.error === undefined ? {} : { error: message.error }),
    message: {
      id: body.id,
      model: body.model,
      stop_reason: body.stop_reason,
      usage: body.usage,
      content: (Array.isArray(body.content) ? body.content : []).map((block) =>
        block.type === "text"
          ? { type: "text", text: block.text }
          : block.type === "tool_use"
            ? { type: "tool_use", name: block.name, input: block.input }
            : { type: block.type },
      ),
    },
  };
}

const abortController = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => abortController.abort());
// An operator's resume (ADR 0036) starts on the restored session instead of a new one.
let sessionId = config.resumeSessionId;
let turns = 0;
async function turn(prompt) {
  turns += 1;
  let result;
  for await (const message of query({
    prompt,
    options: {
      model: config.model,
      effort: config.effort,
      cwd: "/workspace/main",
      tools: TOOLS,
      allowedTools: [...TOOLS, REPORT_TOOL],
      permissionMode: "default",
      settingSources: SKILLS.length === 0 ? [] : ["user"],
      ...(SKILLS.length === 0 ? {} : { skills: SKILLS }),
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
      persistSession: true,
      strictMcpConfig: true,
      mcpServers: {},
      ...(config.outputSchema === undefined
        ? {}
        : { outputFormat: { type: "json_schema", schema: config.outputSchema } }),
      hooks: {
        PreToolUse: [{ hooks: [preToolUse] }],
        SubagentStart: [{ hooks: [subagentStart] }],
        SubagentStop: [{ hooks: [subagentStop] }],
      },
      abortController,
      ...(sessionId === undefined ? {} : { resume: sessionId }),
    },
  })) {
    if (typeof message.session_id === "string") sessionId = message.session_id;
    const event = compact(message);
    if (event !== undefined) emit(event);
    if (message.type === "result") result = message;
  }
  emit({ type: "harness.turn", at: now(), turn: turns, sessionId: sessionId ?? null });
  return result?.subtype === "success" && result.is_error !== true;
}

const startedAt = Date.now();
try {
  // A resumed session already holds the objective; it gets the pinned directive
  // only, after any Harness-generated facts for this segment (a fresh Lab).
  if (!(await turn(
    config.resumeSessionId === undefined
      ? config.prompt
      : typeof config.resumeNotice === "string" && config.resumeNotice.length > 0
        ? config.resumeNotice + "\n\n" + config.resumePrompt
        : config.resumePrompt,
  )))
    process.exit(3);
  while (Date.now() - startedAt < config.minimumActiveMs)
    if (!(await turn(config.resumePrompt))) process.exit(3);
} catch (error) {
  emit({ type: "harness.runner-error", message: error instanceof Error ? error.message.slice(0, 2048) : "unknown" });
  process.exit(1);
}
`;
