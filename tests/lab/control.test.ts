import { once } from "node:events";
import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  answerControlRequest,
  createControlServer,
  nextControlRequest,
} from "../../src/lab/control/index.js";

const servers: Server[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(options: { answerTimeoutMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "wbh-control-"));
  directories.push(directory);
  const server = createControlServer({ directory, pollMs: 10, ...options });
  server.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Control endpoint has no TCP address");
  const call = async (method: string, path: string, body?: string) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      ...(body === undefined ? {} : { body }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { directory, call };
}

describe("exploration Lab control endpoint", () => {
  it("relays a reset to the host and returns the host's answer", async () => {
    const { directory, call } = await fixture();
    const pending = call("POST", "/reset");
    const request = await nextControlRequest(directory, 2_000, 10);
    expect(request).toMatchObject({ command: "reset" });
    expect(request?.id).toMatch(/^[a-f0-9]{32}$/);
    // A second command while the first waits is refused, not queued.
    expect(await call("POST", "/reset")).toEqual({
      status: 409,
      body: { status: "busy" },
    });
    answerControlRequest(directory, request!.id, {
      statusCode: 200,
      body: { status: "reset", resetsUsed: 1, maxResets: 2 },
    });
    expect(await pending).toEqual({
      status: 200,
      body: { status: "reset", resetsUsed: 1, maxResets: 2 },
    });
    // Answered and removed: nothing is pending any more.
    expect(await nextControlRequest(directory, 50, 10)).toBeNull();
  });

  it("names its commands for anything else and decides nothing itself", async () => {
    const { directory, call } = await fixture();
    for (const [method, path] of [
      ["GET", "/reset"],
      ["POST", "/screenshot"],
      ["GET", "/"],
    ] as const)
      expect(await call(method, path)).toEqual({
        status: 404,
        body: {
          status: "unknown-command",
          commands: ["POST /reset", "POST /observe"],
        },
      });
    expect(await nextControlRequest(directory, 50, 10)).toBeNull();
  });

  it("relays an observe request's JSON body as it came and refuses bodies it cannot pass on", async () => {
    const { directory, call } = await fixture();
    const pending = call(
      "POST",
      "/observe",
      JSON.stringify({ role: "visitor", path: "/", extra: [1] }),
    );
    const request = await nextControlRequest(directory, 2_000, 10);
    // The endpoint does not check the shape; the host does.
    expect(request).toMatchObject({
      command: "observe",
      body: { role: "visitor", path: "/", extra: [1] },
    });
    answerControlRequest(directory, request!.id, {
      statusCode: 400,
      body: { status: "refused", reason: "invalid-request" },
    });
    expect((await pending).status).toBe(400);
    expect(await call("POST", "/observe", "{not json")).toEqual({
      status: 400,
      body: { status: "invalid-json" },
    });
    expect(
      await call("POST", "/observe", JSON.stringify({ a: "x".repeat(17_000) })),
    ).toEqual({
      status: 413,
      body: { status: "body-too-large", maxBytes: 16_384 },
    });
    expect(await nextControlRequest(directory, 50, 10)).toBeNull();
  });

  it("answers 504 when the host never answers", async () => {
    const { call } = await fixture({ answerTimeoutMs: 50 });
    expect(await call("POST", "/reset")).toEqual({
      status: 504,
      body: { status: "no-answer" },
    });
  });

  it("refuses an answer for a malformed request id", async () => {
    const { directory } = await fixture();
    expect(() =>
      answerControlRequest(directory, "../escape", {
        statusCode: 200,
        body: {},
      }),
    ).toThrow("Control request id is invalid");
  });
});
