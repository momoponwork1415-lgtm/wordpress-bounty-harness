import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRecorderServer } from "../../src/lab/recorder/index.js";

const servers: Server[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Recorder has no TCP address");
  return address.port;
}

async function fixture(
  limits: { bodyLimitBytes?: number; captureLimitBytes?: number } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "wbh-recorder-"));
  directories.push(directory);
  const capturePath = join(directory, "capture.jsonl");
  const droppedPath = join(directory, "dropped");
  const upstreamPort = await listen(
    createServer(async (incoming, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      response.writeHead(302, {
        Location: "/next",
        "X-Seen-Host": incoming.headers.host ?? "",
      });
      response.end(Buffer.concat(chunks));
    }),
  );
  const proxyPort = await listen(
    createRecorderServer({
      upstreamHost: "127.0.0.1",
      upstreamPort,
      capturePath,
      droppedPath,
      ...limits,
    }),
  );
  const send = (path: string, body: string) =>
    new Promise<{ status: number; body: string; host: string }>(
      (resolve, reject) => {
        const outgoing = request(
          {
            host: "127.0.0.1",
            port: proxyPort,
            method: "POST",
            path,
            headers: { Host: "original.example", "Content-Type": "text/plain" },
          },
          (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
            incoming.on("end", () =>
              resolve({
                status: incoming.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
                host: String(incoming.headers["x-seen-host"] ?? ""),
              }),
            );
          },
        );
        outgoing.on("error", reject);
        outgoing.end(body);
      },
    );
  return { send, capturePath, droppedPath };
}

describe("Lab HTTP recorder", () => {
  it("forwards the untouched body and Host, records both sides, and leaves redirects alone", async () => {
    const { send, capturePath } = await fixture();
    expect(await send("/first?x=1", "synthetic-body")).toEqual({
      status: 302,
      body: "synthetic-body",
      host: "original.example",
    });
    const lines = (await readFile(capturePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const record: unknown = JSON.parse(lines[0] ?? "null");
    expect(record).toMatchObject({
      request: {
        method: "POST",
        path: "/first?x=1",
        body: "synthetic-body",
        headers: { host: "original.example" },
        truncated: false,
      },
      response: { statusCode: 302, body: "synthetic-body", truncated: false },
    });
  });

  it("bounds each body and counts dropped records after the total cap", async () => {
    const { send, capturePath } = await fixture({ bodyLimitBytes: 4 });
    expect((await send("/first", "abcdefgh")).body).toBe("abcdefgh");
    const first = (await readFile(capturePath, "utf8")).trim();
    expect(JSON.parse(first) as unknown).toMatchObject({
      request: { body: "abcd", truncated: true },
      response: { body: "abcd", truncated: true },
    });
    const capped = await fixture({ captureLimitBytes: 1 });
    await capped.send("/first", "abcdefgh");
    await capped.send("/second", "abcdefgh");
    expect(await readFile(capped.capturePath, "utf8")).toBe("");
    expect(await readFile(capped.droppedPath, "utf8")).toBe("2");
  });
});
