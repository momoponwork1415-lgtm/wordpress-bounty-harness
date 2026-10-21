/**
 * What the Anthropic egress broker lets a Messages request carry upstream.
 *
 * The grant is visible to the agent's own shell (Claude Code's subprocess
 * scrubbing needs bubblewrap, which does not run under runsc), so the broker,
 * not Claude Code, decides what reaches the provider. Anything that would make
 * the provider fetch a URL, run a server tool, attach an MCP server or a
 * container, or answer with another model is refused (invariants 1, 2 and 8).
 */

/**
 * Betas forwarded upstream. Taken from the beta registry inside Claude Code
 * 2.1.296 (`@anthropic-ai/claude-code-linux-x64`), minus every beta that turns
 * on a server-side capability: web search, MCP servers, the Files API,
 * environments, remote sessions, the advisor tool, tool search, server-side
 * model fallback, message threads, auto-mode classifiers and internal latches.
 * Any other value is dropped before forwarding, not refused, so a beta Claude
 * Code adds for a request-shaping feature cannot fail a Trial on its own.
 */
export const ANTHROPIC_ADMITTED_BETAS: ReadonlySet<string> = new Set([
  "oauth-2025-04-20",
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "context-1m-2025-08-07",
  "context-management-2025-06-27",
  "structured-outputs-2025-12-15",
  "effort-2025-11-24",
  "task-budgets-2026-03-13",
  "prompt-caching-scope-2026-01-05",
  "prompt-caching-evict-2026-05-12",
  "cache-keepalive-2026-09-03",
  "extended-cache-ttl-2025-04-11",
  "fast-mode-2026-02-01",
  "redact-thinking-2026-02-12",
  "thinking-resumption-2026-07-17",
  "thinking-token-count-2026-05-13",
  "thinking-display-updates-2026-08-18",
  "thinking-binding-controls-2026-08-01",
  "cache-diagnosis-2026-04-07",
  "context-hint-2026-04-09",
  "mid-conversation-system-2026-04-07",
  "mid-conversation-system-clear-at-2026-08-21",
  "mid-conversation-tool-changes-2026-07-01",
  "per-turn-control-2026-07-01",
  "timing-2026-09-09",
]);

/** Top-level request fields Claude Code 2.1.296 builds for a Messages call. */
const ADMITTED_FIELDS: ReadonlySet<string> = new Set([
  "model",
  "messages",
  "system",
  "tools",
  "tool_choice",
  "metadata",
  "max_tokens",
  "thinking",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "stream",
  "context_management",
  "output_config",
  "output_format",
  "cache_control",
  "speed",
  "diagnostics",
]);

/** Server-side model fallback; removed so every answer comes from the bound model. */
const STRIPPED_FIELDS: ReadonlySet<string> = new Set(["fallbacks"]);

/** Content blocks only the provider's own tools produce or consume. */
const SERVER_BLOCK =
  /^(?:server_tool_use|mcp_tool_use|mcp_tool_result|container_upload|.*_tool_result)$/;

export type AnthropicRequestDecision =
  | { readonly status: "admitted"; readonly body: Record<string, unknown> }
  | { readonly status: "refused"; readonly reason: string };

/** Admitted betas of one `anthropic-beta` header, plus the OAuth capability. */
export function admittedAnthropicBetas(
  header: string | readonly string[] | undefined,
  oauthBeta: string,
): { readonly admitted: string[]; readonly dropped: string[] } {
  const joined = typeof header === "string" ? header : (header ?? []).join(",");
  const values = joined
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const admitted = new Set<string>();
  const dropped = new Set<string>();
  for (const value of values)
    (ANTHROPIC_ADMITTED_BETAS.has(value) ? admitted : dropped).add(value);
  admitted.add(oauthBeta);
  return { admitted: [...admitted], dropped: [...dropped] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A tool the client runs itself: no `type`, or the explicit `custom` type. */
function clientTool(tool: unknown): boolean {
  return isRecord(tool) && (tool.type === undefined || tool.type === "custom");
}

/** First reason a content tree would make the provider reach outside the Trial. */
function contentRefusal(value: unknown, depth = 0): string | undefined {
  if (depth > 64) return "request-content-too-deep";
  if (Array.isArray(value)) {
    for (const item of value) {
      const reason = contentRefusal(item, depth + 1);
      if (reason !== undefined) return reason;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (typeof value.type === "string" && SERVER_BLOCK.test(value.type))
    return "server-content-not-admitted";
  const source = value.source;
  if (
    isRecord(source) &&
    source.type !== "base64" &&
    source.type !== "text" &&
    source.type !== "content"
  )
    return "remote-source-not-admitted";
  for (const [key, child] of Object.entries(value)) {
    // A tool call's own arguments go to the client, not to the provider.
    if (key === "input" && value.type === "tool_use") continue;
    const reason = contentRefusal(child, depth + 1);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

/** Decide one parsed Messages request bound to the grant's `models`. */
export function admitAnthropicRequest(
  payload: unknown,
  models: readonly string[],
): AnthropicRequestDecision {
  if (
    !isRecord(payload) ||
    typeof payload.model !== "string" ||
    !models.includes(payload.model)
  )
    return { status: "refused", reason: "model-not-admitted" };
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (STRIPPED_FIELDS.has(key)) continue;
    if (!ADMITTED_FIELDS.has(key))
      return { status: "refused", reason: "request-field-not-admitted" };
    body[key] = value;
  }
  if (
    body.tools !== undefined &&
    !(Array.isArray(body.tools) && body.tools.every(clientTool))
  )
    return { status: "refused", reason: "server-tool-not-admitted" };
  const reason = contentRefusal(body.messages) ?? contentRefusal(body.system);
  return reason === undefined
    ? { status: "admitted", body }
    : { status: "refused", reason };
}
