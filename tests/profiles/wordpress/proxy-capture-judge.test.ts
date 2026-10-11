import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import { createWordPressJudges } from "../../../src/profiles/wordpress/verification/judges.js";
import {
  canaries,
  finding,
  handle,
  judgeOnce,
  quietLab,
  route,
  setupDigest,
  snapshotDigest,
} from "./judge-fixture.js";

const value = canaries.sqlCanary.value;
type Request = {
  readonly method: string;
  readonly path: string;
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
};
function capturedRequests(
  requests: readonly Request[],
  responseBody = "No canary in patched response",
): Buffer {
  return Buffer.from(
    requests
      .map(({ method, path, body = "", headers }) =>
        JSON.stringify({
          request: {
            method,
            path,
            headers: { host: "wordpress", ...headers },
            body,
            bodyBase64: Buffer.from(body).toString("base64"),
            truncated: false,
          },
          response: {
            statusCode: 200,
            headers: {},
            body: responseBody,
            bodyBase64: Buffer.from(responseBody).toString("base64"),
            truncated: false,
          },
        }),
      )
      .join("\n") + "\n",
  );
}

function captured(requestValue: string, responseValue = value): Buffer {
  return capturedRequests(
    [{ method: "GET", path: `/read?value=${requestValue}` }],
    `row:${responseValue}`,
  );
}

async function observe(
  requestValue: string,
  capture: Buffer | null = captured(requestValue),
  authoredResponse = `agent:${value}`,
) {
  return judgeOnce({
    impact: "sqli",
    lab: quietLab({
      async readCapture() {
        return capture === null
          ? { status: "unavailable" }
          : { status: "captured", bytes: capture, dropped: 0 };
      },
    }),
    files: {
      "route.json": JSON.stringify(route),
      "capture-marker.json": JSON.stringify({ marker: "0" }),
      "http.json": JSON.stringify({
        exchanges: [{ request: {}, response: { body: authoredResponse } }],
      }),
    },
  });
}

async function observeReference(
  referenceRoute: unknown,
  capture: Buffer | null,
) {
  const directory = await mkdtemp(join(tmpdir(), "wbh-route-control-"));
  try {
    const store = new PrivateArtifactStore({
      rootDirectory: join(directory, "evidence"),
      maxEntries: 10,
      maxBytes: 1024 * 1024,
    });
    const lab = quietLab({
      async readCapture() {
        return capture === null
          ? { status: "unavailable" }
          : { status: "captured", bytes: capture, dropped: 0 };
      },
    });
    const judge = createWordPressJudges({ store, lab }).for(finding("sqli"));
    if (judge === null) throw new Error("SQL judge is unavailable");
    const recipeDigest = await store.putFiles({
      "route.json": JSON.stringify(route),
      "capture-marker.json": JSON.stringify({ marker: "0" }),
      "http.json": JSON.stringify({
        exchanges: [{ request: {}, response: { body: "No canary" } }],
      }),
    });
    return await judge.observe({
      finding: finding("sqli"),
      lab: handle,
      recipeDigest,
      referenceRoute,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function evidenceFile(
  store: PrivateArtifactStore,
  digest: string,
  name: string,
): Promise<Buffer> {
  const file = await store.readFile(digest, name, 100_000);
  if (file.status !== "resolved") throw new Error(`${name} is unavailable`);
  return file.bytes;
}

const replayRoute = {
  steps: [
    {
      kind: "http",
      method: "GET",
      path: "/first",
      body: "value=1",
      headers: { "x-route": "first" },
      expected: "First",
    },
    { kind: "http", method: "POST", path: "/second", expected: "Second" },
  ],
} as const;
const firstRequest = {
  method: "GET",
  path: "/first",
  body: "value=1",
  headers: { "X-Route": "first" },
} satisfies Request;
const secondRequest = {
  method: "POST",
  path: "/second",
  body: "value=1",
} satisfies Request;

describe("WordPress judges with proxy capture", () => {
  it("uses proxy response evidence ahead of the agent record", async () => {
    const { observed, store } = await observe("ordinary");
    expect(observed).toMatchObject({
      status: "observed",
      evidenceCapture: "harness-captured",
      conditions: { observedVia: "canary-row-read" },
    });
    if (observed?.status !== "observed") return;
    expect(
      JSON.parse(
        (
          await evidenceFile(
            store,
            observed.evidenceDigest,
            "confirmed-route.json",
          )
        ).toString("utf8"),
      ) as unknown,
    ).toMatchObject({
      evidence: [
        {
          kind: "http",
          path: "proxy-capture.jsonl",
          capture: "harness-captured",
        },
        { kind: "canary", path: "canary-observation.json" },
      ],
    });
    expect(
      await evidenceFile(store, observed.evidenceDigest, "proxy-capture.jsonl"),
    ).toBeDefined();
  });

  it.each([
    value,
    encodeURIComponent(value).replaceAll("c", "%63"),
    Buffer.from(value).toString("base64"),
    Buffer.from(value).toString("hex"),
  ])("does not credit a value present in the request", async (requestValue) => {
    expect((await observe(requestValue)).observed).toMatchObject({
      status: "not-observed",
      evidenceCapture: "harness-captured",
    });
  });

  it("falls back to the agent record only when capture is absent", async () => {
    expect((await observe("ordinary", null)).observed).toMatchObject({
      status: "observed",
      evidenceCapture: "agent-authored",
    });
    expect(
      (await observe("ordinary", null, "patched response without canary"))
        .observed,
    ).toEqual({ status: "not-observed" });
  });

  it("keeps a patched-version negative control unconfirmed despite an agent claim", async () => {
    const patchedResponse = captured(
      "ordinary",
      "the patched route returned no canary",
    );
    const { observed, store } = await observe("ordinary", patchedResponse);
    expect(observed).toMatchObject({
      status: "not-observed",
      evidenceCapture: "harness-captured",
      evidenceDigest: expect.stringMatching(/^sha256:/),
    });
    if (
      observed?.status !== "not-observed" ||
      !("evidenceDigest" in observed) ||
      typeof observed.evidenceDigest !== "string"
    )
      throw new Error("The negative control has no captured evidence");
    expect(
      await evidenceFile(store, observed.evidenceDigest, "proxy-capture.jsonl"),
    ).toEqual(patchedResponse);
    expect(
      JSON.parse(
        (
          await evidenceFile(
            store,
            observed.evidenceDigest,
            "canary-observation.json",
          )
        ).toString("utf8"),
      ) as unknown,
    ).toMatchObject({
      judgeId: "wordpress-sql-canary",
      status: "not-observed",
      snapshotDigest,
      labSetupDigest: setupDigest,
    });
  });

  it("treats a partial proxy record as incomplete", async () => {
    const incomplete = Buffer.from(
      captured("ordinary")
        .toString("utf8")
        .replace('"truncated":false', '"truncated":true'),
    );
    expect((await observe("ordinary", incomplete)).observed).toMatchObject({
      status: "incomplete",
      reason: "evidence",
    });
  });

  it("accepts an ordered replay of the confirmed HTTP steps with unrelated requests between them", async () => {
    const observed = await observeReference(
      replayRoute,
      capturedRequests([
        { method: "GET", path: "/unrelated" },
        firstRequest,
        { method: "HEAD", path: "/between" },
        secondRequest,
      ]),
    );
    expect(observed).toMatchObject({
      status: "not-observed",
      evidenceCapture: "harness-captured",
      evidenceDigest: expect.stringMatching(/^sha256:/),
    });
  });

  it.each([
    ["method", [{ ...firstRequest, method: "POST" }, secondRequest]],
    ["path", [{ ...firstRequest, path: "/other" }, secondRequest]],
    ["body", [{ ...firstRequest, body: "wrong" }, secondRequest]],
    [
      "header",
      [{ ...firstRequest, headers: { "X-Route": "wrong" } }, secondRequest],
    ],
    ["order", [secondRequest, firstRequest]],
  ] as const)("keeps a %s mismatch incomplete", async (_name, requests) => {
    const observed = await observeReference(
      replayRoute,
      capturedRequests(requests),
    );
    expect(observed).toMatchObject({
      status: "incomplete",
      reason: "observation",
    });
  });

  it("keeps a route without HTTP steps or without proxy capture incomplete", async () => {
    const noHttp = await observeReference(
      { steps: [{ kind: "browser", path: "/view", expected: "View" }] },
      capturedRequests([{ method: "GET", path: "/view" }]),
    );
    expect(noHttp).toMatchObject({
      status: "incomplete",
      reason: "observation",
    });
    const noCapture = await observeReference(replayRoute, null);
    expect(noCapture).toMatchObject({
      status: "incomplete",
      reason: "observation",
    });
  });
});
