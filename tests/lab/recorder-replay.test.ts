import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { runHttpReplay } from "../../src/lab/recorder/replay-cli.js";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function proxy(
  respond: (
    request: IncomingMessage,
    body: string,
    response: ServerResponse,
  ) => void,
): Promise<number> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    respond(request, Buffer.concat(chunks).toString("utf8"), response);
  });
  server.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Fake recorder has no TCP address");
  return address.port;
}

describe("bounded HTTP route replay", () => {
  it("replaces response bindings and sends only newly issued cookies", async () => {
    const requests: {
      path: string;
      body: string;
      cookie: string | undefined;
      token: string | undefined;
    }[] = [];
    const port = await proxy((request, body, response) => {
      requests.push({
        path: request.url ?? "",
        body,
        cookie: request.headers.cookie,
        token: request.headers["x-token"] as string | undefined,
      });
      if (request.url === "/start?seed=sample") {
        response.writeHead(200, { "Set-Cookie": "session=fresh-one; Path=/" });
        response.end("token<sample-token>");
      } else {
        response.end("done");
      }
    });
    const result = await runHttpReplay(
      {
        initialBindings: { seed: "sample" },
        steps: [
          {
            method: "GET",
            path: "/start?seed={{seed}}",
            bindingsAfter: [
              {
                name: "token",
                left: "token<",
                right: ">",
                pattern: "[A-Za-z0-9-]+",
              },
            ],
          },
          {
            method: "POST",
            path: "/submit/{{token}}",
            headers: { "X-Token": "{{token}}" },
            body: "value={{token}}",
          },
        ],
      },
      { port },
    );
    expect(result).toEqual({ status: "completed", completedSteps: 2 });
    expect(requests).toEqual([
      {
        path: "/start?seed=sample",
        body: "",
        cookie: undefined,
        token: undefined,
      },
      {
        path: "/submit/sample-token",
        body: "value=sample-token",
        cookie: "session=fresh-one",
        token: "sample-token",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("sample-token");
    expect(JSON.stringify(result)).not.toContain("fresh-one");
  });

  it("uses the last response interval only when the recipe explicitly requests it", async () => {
    const paths: string[] = [];
    const port = await proxy((request, _body, response) => {
      paths.push(request.url ?? "");
      response.end(
        request.url === "/start" ? "key<first> key<second> key<final>" : "done",
      );
    });
    const route = (occurrence?: "last") => ({
      initialBindings: {},
      steps: [
        {
          method: "GET",
          path: "/start",
          bindingsAfter: [
            {
              name: "key",
              left: "key<",
              right: ">",
              ...(occurrence === undefined ? {} : { occurrence }),
            },
          ],
        },
        { method: "GET", path: "/use/{{key}}" },
      ],
    });
    expect(await runHttpReplay(route(), { port })).toEqual({
      status: "incomplete",
      completedSteps: 1,
      reason: "ambiguous-binding",
    });
    expect(await runHttpReplay(route("last"), { port })).toEqual({
      status: "completed",
      completedSteps: 2,
    });
    expect(paths).toEqual(["/start", "/start", "/use/final"]);
  });

  it("stops after a missing binding without sending later requests", async () => {
    const paths: string[] = [];
    const port = await proxy((request, _body, response) => {
      paths.push(request.url ?? "");
      response.end("ordinary response");
    });
    const result = await runHttpReplay(
      {
        initialBindings: {},
        steps: [
          {
            method: "GET",
            path: "/first",
            bindingsAfter: [
              { name: "key", left: "key<", right: ">", occurrence: "last" },
            ],
          },
          { method: "GET", path: "/use/{{key}}" },
        ],
      },
      { port },
    );
    expect(result).toEqual({
      status: "incomplete",
      completedSteps: 1,
      reason: "ambiguous-binding",
    });
    expect(paths).toEqual(["/first"]);
  });

  it("rejects a stale Cookie header before making any request", async () => {
    let requests = 0;
    const port = await proxy((_request, _body, response) => {
      requests++;
      response.end("done");
    });
    const result = await runHttpReplay(
      {
        initialBindings: {},
        steps: [
          { method: "GET", path: "/first" },
          { method: "GET", path: "/second", headers: { cOoKiE: "old=value" } },
        ],
      },
      { port },
    );
    expect(result).toEqual({
      status: "incomplete",
      completedSteps: 0,
      reason: "invalid-input",
    });
    expect(requests).toBe(0);
  });

  it("stops at the response body cap and exposes no response content", async () => {
    const port = await proxy((_request, _body, response) => {
      response.end("x".repeat(1024 * 1024 + 1));
    });
    const result = await runHttpReplay(
      { initialBindings: {}, steps: [{ method: "GET", path: "/large" }] },
      { port },
    );
    expect(result).toEqual({
      status: "incomplete",
      completedSteps: 0,
      reason: "response-too-large",
    });
    expect(JSON.stringify(result)).not.toContain("x".repeat(100));
  });
});
