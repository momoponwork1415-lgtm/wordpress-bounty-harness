import { describe, expect, it } from "vitest";

import {
  admitAnthropicRequest,
  admittedAnthropicBetas,
} from "../../src/discovery/anthropic-request-policy.js";

const model = "claude-opus-5-5";
const decide = (body: Record<string, unknown>) =>
  admitAnthropicRequest({ model, ...body }, model);
const user = (content: unknown) => ({
  messages: [{ role: "user", content }],
});

describe("Anthropic request policy", () => {
  it("admits a Claude Code turn with client tools, a tool call and base64 media", () => {
    expect(
      decide({
        max_tokens: 32000,
        stream: true,
        system: [
          { type: "text", text: "s", cache_control: { type: "ephemeral" } },
        ],
        tools: [
          { name: "Read", description: "d", input_schema: { type: "object" } },
          { type: "custom", name: "Bash", input_schema: { type: "object" } },
        ],
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        context_management: { edits: [] },
        metadata: { user_id: "u" },
        messages: [
          { role: "user", content: "objective" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "t1",
                name: "Write",
                // Arguments the client runs are not provider fetches.
                input: { content: { source: { type: "url", url: "x" } } },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: [
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: "image/png",
                      data: "AA",
                    },
                  },
                ],
              },
            ],
          },
        ],
      }).status,
    ).toBe("admitted");
  });

  it("strips server-side model fallback before forwarding", () => {
    expect(decide({ fallbacks: "default", max_tokens: 1 })).toEqual({
      status: "admitted",
      body: { model, max_tokens: 1 },
    });
  });

  it.each([
    ["another model", { model: "claude-haiku-4-5" }, "model-not-admitted"],
    [
      "an MCP server",
      {
        mcp_servers: [
          { type: "url", url: "https://example.invalid/sse", name: "x" },
        ],
      },
      "request-field-not-admitted",
    ],
    [
      "a code-execution container",
      { container: "c1" },
      "request-field-not-admitted",
    ],
    ["an unknown field", { thread: { id: "t" } }, "request-field-not-admitted"],
    [
      "a web fetch tool",
      { tools: [{ type: "web_fetch_20250910", name: "web_fetch" }] },
      "server-tool-not-admitted",
    ],
    [
      "a code execution tool",
      { tools: [{ type: "code_execution_20250825", name: "code_execution" }] },
      "server-tool-not-admitted",
    ],
    [
      "an MCP toolset",
      { tools: [{ type: "mcp_toolset", mcp_server_name: "x" }] },
      "server-tool-not-admitted",
    ],
    [
      "an image fetched by URL",
      user([
        {
          type: "image",
          source: { type: "url", url: "https://example.invalid/a.png" },
        },
      ]),
      "remote-source-not-admitted",
    ],
    [
      "a document fetched by URL inside a tool result",
      user([
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [
            {
              type: "document",
              source: { type: "url", url: "https://example.invalid/a.pdf" },
            },
          ],
        },
      ]),
      "remote-source-not-admitted",
    ],
    [
      "a Files API reference",
      user([{ type: "document", source: { type: "file", file_id: "file_1" } }]),
      "remote-source-not-admitted",
    ],
    [
      "a server tool call replayed in history",
      {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "server_tool_use",
                id: "s",
                name: "web_fetch",
                input: {},
              },
            ],
          },
        ],
      },
      "server-content-not-admitted",
    ],
    [
      "an MCP tool result",
      user([{ type: "mcp_tool_result", tool_use_id: "m", content: [] }]),
      "server-content-not-admitted",
    ],
  ])("refuses %s", (_name, body, reason) => {
    expect(decide(body as Record<string, unknown>)).toEqual({
      status: "refused",
      reason,
    });
  });

  it("forwards only admitted betas and always the OAuth capability", () => {
    expect(
      admittedAnthropicBetas(
        "claude-code-20250219, mcp-client-2025-04-04,files-api-2025-04-14,web-search-2025-03-05,server-side-fallback-2026-06-01",
        "oauth-2025-04-20",
      ),
    ).toEqual({
      admitted: ["claude-code-20250219", "oauth-2025-04-20"],
      dropped: [
        "mcp-client-2025-04-04",
        "files-api-2025-04-14",
        "web-search-2025-03-05",
        "server-side-fallback-2026-06-01",
      ],
    });
  });
});
