import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import { canonicalDigest } from "../../../src/infrastructure/canonical-json.js";
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
  statusCode = 200,
  responseHeaders: Readonly<Record<string, string>> = {},
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
            statusCode,
            headers: responseHeaders,
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
    finding: { ...finding("sqli"), attackerPosition: "unauthenticated" },
    lab: quietLab({
      async readCapture() {
        return capture === null
          ? { status: "unavailable" }
          : { status: "captured", bytes: capture, dropped: 0 };
      },
    }),
    files: {
      "route.json": JSON.stringify({
        ...route,
        role: "unauthenticated",
        account: "none",
        steps: [
          {
            kind: "http",
            method: "GET",
            path: `/read?value=${requestValue}`,
            expected: "Synthetic row response",
          },
        ],
      }),
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
  currentRoute: unknown = replayRoute,
  freshNonces: readonly string[] = [],
  scenario?: { readonly id: string; readonly digest: string },
  canaryChanged = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "wbh-route-control-"));
  try {
    const store = new PrivateArtifactStore({
      rootDirectory: join(directory, "evidence"),
      maxEntries: 10,
      maxBytes: 1024 * 1024,
    });
    const lab = quietLab({
      issuedScriptNonces: () => freshNonces,
      async observeCanaryTable() {
        return { status: canaryChanged ? "changed" : "intact" };
      },
      async readCapture() {
        return capture === null
          ? { status: "unavailable" }
          : { status: "captured", bytes: capture, dropped: 0 };
      },
    });
    const candidate = {
      ...finding("sqli"),
      attackerPosition: "unauthenticated" as const,
    };
    const judge = createWordPressJudges({ store, lab }).for(candidate);
    if (judge === null) throw new Error("SQL judge is unavailable");
    const recipeDigest = await store.putFiles({
      "route.json": JSON.stringify(currentRoute),
      "capture-marker.json": JSON.stringify({ marker: "0" }),
      "http.json": JSON.stringify({
        exchanges: [{ request: {}, response: { body: "No canary" } }],
      }),
    });
    const observed = await judge.observe({
      finding: candidate,
      lab: scenario === undefined ? handle : { ...handle, scenario },
      recipeDigest,
      referenceRoute,
    });
    if (observed.evidenceDigest === undefined) return observed;
    return {
      ...observed,
      receipt: JSON.parse(
        (
          await evidenceFile(
            store,
            observed.evidenceDigest,
            "canary-observation.json",
          )
        ).toString("utf8"),
      ) as unknown,
    };
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
  role: "unauthenticated",
  account: "none",
  defaultSettings: true,
  configurationChanges: [],
  steps: [
    {
      kind: "http",
      method: "GET",
      path: "/first",
      body: "value=1",
      headers: { "x-route": "first" },
      expected: "First",
    },
    {
      kind: "http",
      method: "POST",
      path: "/second",
      body: "value=1",
      expected: "Second",
    },
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
const boundReplayRoute = {
  ...replayRoute,
  comparisonKind: "fixed-version",
  capturedRoute: {
    schemaVersion: 1,
    scenario: null,
    issuedScriptNonces: [],
    requests: [
      {
        method: "GET",
        path: "/first",
        body: "value=1",
        headers: { host: "wordpress", "x-route": "first" },
        statusCode: 200,
      },
      {
        method: "POST",
        path: "/second",
        body: "value=1",
        headers: { host: "wordpress" },
        statusCode: 200,
      },
    ],
  },
};
const oldScriptNonce = "11111111-1111-4111-8111-111111111111";
const freshScriptNonce = "22222222-2222-4222-8222-222222222222";
const encodedOldNonce = oldScriptNonce.replaceAll("-", "%2D");
const encodedFreshNonce = freshScriptNonce.replaceAll("-", "%2D");
const scriptBody = (token: string) =>
  `content=canary%3A8080%2Fb%2F${token}&title=same`;
const scriptRoute = (token: string) => ({
  ...replayRoute,
  steps: [
    {
      kind: "http" as const,
      method: "POST" as const,
      path: "/save",
      body: scriptBody(token),
      expected: "A stored script is saved",
    },
    { kind: "browser" as const, path: "/view", expected: "The script fires" },
  ],
  victim: { role: "administrator" as const, paths: ["/view"] },
});
const boundScriptRoute = {
  ...scriptRoute(encodedOldNonce),
  comparisonKind: "fixed-version",
  capturedRoute: {
    schemaVersion: 1,
    scenario: { id: "ordinary-page-v1", digest: setupDigest },
    issuedScriptNonces: [oldScriptNonce],
    requests: [
      {
        method: "POST",
        path: "/save",
        body: scriptBody(encodedOldNonce),
        headers: { host: "wordpress" },
        statusCode: 200,
      },
    ],
  },
};

describe("WordPress judges with proxy capture", () => {
  it("uses proxy response evidence ahead of the agent record", async () => {
    const { observed, store } = await observe("ordinary");
    expect(observed).toMatchObject({
      status: "observed",
      evidenceCapture: "harness-captured",
      conditions: { observedVia: "canary-row-read" },
    });
    if (observed?.status !== "observed") return;
    const confirmedRoute = JSON.parse(
      (
        await evidenceFile(
          store,
          observed.evidenceDigest,
          "confirmed-route.json",
        )
      ).toString("utf8"),
    ) as { capturedRoute: unknown };
    expect(confirmedRoute).toMatchObject({
      evidence: [
        {
          kind: "http",
          path: "proxy-capture.jsonl",
          capture: "harness-captured",
        },
        { kind: "canary", path: "canary-observation.json" },
      ],
      capturedRoute: {
        schemaVersion: 1,
        scenario: null,
        requests: [
          {
            method: "GET",
            path: "/read?value=ordinary",
            body: "",
            headers: { host: "wordpress" },
            statusCode: 200,
          },
        ],
      },
    });
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
      capturedRouteDigest: canonicalDigest(confirmedRoute.capturedRoute),
    });
    expect(
      await evidenceFile(store, observed.evidenceDigest, "proxy-capture.jsonl"),
    ).toBeDefined();
  });

  it("does not bind a positive capture with undeclared traffic or ambiguous authentication", async () => {
    for (const capture of [
      capturedRequests(
        [
          { method: "GET", path: "/unlisted" },
          { method: "GET", path: "/read?value=ordinary" },
        ],
        `row:${value}`,
      ),
      capturedRequests(
        [
          {
            method: "GET",
            path: "/read?value=ordinary",
            headers: { Cookie: "wordpress_logged_in_example=unknown" },
          },
        ],
        `row:${value}`,
      ),
      capturedRequests(
        [{ method: "GET", path: "/read?value=ordinary" }],
        `row:${value}`,
        500,
      ),
      capturedRequests(
        [{ method: "GET", path: "/read?value=ordinary" }],
        `row:${value}`,
        403,
      ),
      capturedRequests(
        [{ method: "GET", path: "/read?value=ordinary" }],
        `row:${value}`,
        302,
        { location: "/wp-login.php" },
      ),
    ]) {
      const { observed, store } = await observe("ordinary", capture);
      expect(observed).toMatchObject({ status: "observed" });
      if (observed?.status !== "observed") continue;
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
      ).toMatchObject({ capturedRoute: null });
    }
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

  it.each([
    [
      "HTML without a success witness",
      "<html>Page loaded</html>",
      { "content-type": "text/html" },
    ],
    [
      "JSON success:true without a verified effect",
      '{"success":true,"data":"Request accepted"}',
      { "content-type": "application/json" },
    ],
  ] as const)(
    "keeps an identical 200 route incomplete with %s",
    async (_case, responseBody, headers) => {
      const observed = await observeReference(
        boundReplayRoute,
        capturedRequests(
          [firstRequest, secondRequest],
          responseBody,
          200,
          headers,
        ),
      );
      expect(observed).toMatchObject({
        status: "incomplete",
        reason: "observation",
        evidenceDigest: expect.stringMatching(/^sha256:/),
        receipt: {
          status: "incomplete",
          canaryObserved: false,
          processingWitness: "unavailable",
          referenceResponseStatuses: [200, 200],
          capturedResponseStatuses: [200, 200],
        },
      });
    },
  );

  it("keeps a bound reference incomplete without a comparison marker", async () => {
    expect(
      await observeReference(
        { ...boundReplayRoute, comparisonKind: undefined },
        capturedRequests([firstRequest, secondRequest]),
      ),
    ).toMatchObject({
      status: "incomplete",
      reason: "observation",
      evidenceDigest: expect.stringMatching(/^sha256:/),
    });
  });

  it.each(["GET", "POST"] as const)(
    "keeps an unlisted %s request incomplete even when declared steps replay",
    async (method) => {
      const observed = await observeReference(
        boundReplayRoute,
        capturedRequests([
          { method, path: "/unlisted" },
          firstRequest,
          secondRequest,
        ]),
      );
      expect(observed).toMatchObject({
        status: "incomplete",
        reason: "observation",
      });
    },
  );

  it("keeps an authenticated or failed fixed response incomplete", async () => {
    for (const capture of [
      capturedRequests([
        {
          ...firstRequest,
          headers: { ...firstRequest.headers, Cookie: "session=other" },
        },
        secondRequest,
      ]),
      capturedRequests([firstRequest, secondRequest], "Server error", 500),
      capturedRequests([firstRequest, secondRequest], "Denied", 403),
      capturedRequests(
        [firstRequest, secondRequest],
        "Redirecting to login",
        302,
        { location: "/wp-login.php" },
      ),
    ])
      expect(await observeReference(boundReplayRoute, capture)).toMatchObject({
        status: "incomplete",
        reason: "observation",
      });
  });

  it.each([
    ["403 rejection", 403, "Denied", {}],
    ["302 login redirect", 302, "Redirecting", { location: "/wp-login.php" }],
    [
      "200 JSON application rejection",
      200,
      '{"success":false,"data":"Invalid nonce"}',
      { "content-type": "application/json" },
    ],
  ] as const)(
    "keeps a stale-token %s fixed replay incomplete",
    async (_case, statusCode, responseBody, headers) => {
      const staleBody = "action=save&_wpnonce=stale-lab-token";
      const staleRequest = {
        method: "POST",
        path: "/save",
        body: staleBody,
      };
      const staleRoute = {
        ...replayRoute,
        steps: [{ kind: "http", ...staleRequest, expected: "Saved" }],
      };
      const boundStaleRoute = {
        ...staleRoute,
        comparisonKind: "fixed-version",
        capturedRoute: {
          schemaVersion: 1,
          scenario: null,
          issuedScriptNonces: [],
          requests: [
            {
              ...staleRequest,
              headers: { host: "wordpress" },
              statusCode: 200,
            },
          ],
        },
      };
      expect(
        await observeReference(
          boundStaleRoute,
          capturedRequests([staleRequest], responseBody, statusCode, headers),
          staleRoute,
        ),
      ).toMatchObject({
        status: "incomplete",
        reason: "observation",
      });
    },
  );

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
      boundReplayRoute,
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
    const noCapture = await observeReference(boundReplayRoute, null);
    expect(noCapture).toMatchObject({
      status: "incomplete",
      reason: "observation",
    });
  });

  it("accepts only the Lab-issued script nonce rotation in the captured attack body", async () => {
    const scenario = { id: "ordinary-page-v1", digest: setupDigest };
    const replay = capturedRequests([
      { method: "POST", path: "/save", body: scriptBody(encodedFreshNonce) },
    ]);
    expect(
      await observeReference(
        boundScriptRoute,
        replay,
        scriptRoute(encodedFreshNonce),
        [freshScriptNonce],
        scenario,
      ),
    ).toMatchObject({
      status: "incomplete",
      reason: "observation",
      evidenceDigest: expect.stringMatching(/^sha256:/),
    });
    expect(
      await observeReference(
        boundScriptRoute,
        replay,
        scriptRoute(encodedFreshNonce),
        ["33333333-3333-4333-8333-333333333333"],
        scenario,
      ),
    ).toMatchObject({ status: "incomplete", reason: "observation" });
    expect(
      await observeReference(
        boundScriptRoute,
        capturedRequests([
          {
            method: "POST",
            path: "/save",
            body: scriptBody(encodedFreshNonce).replace(
              "title=same",
              "title=changed",
            ),
          },
        ]),
        {
          ...scriptRoute(encodedFreshNonce),
          steps: [
            {
              kind: "http",
              method: "POST",
              path: "/save",
              body: scriptBody(encodedFreshNonce).replace(
                "title=same",
                "title=changed",
              ),
              expected: "Saved",
            },
            { kind: "browser", path: "/view", expected: "Fires" },
          ],
        },
        [freshScriptNonce],
        scenario,
      ),
    ).toMatchObject({ status: "incomplete", reason: "observation" });
  });

  it("keeps a changed role, scenario, or legacy unbound route incomplete", async () => {
    const capture = capturedRequests([firstRequest, secondRequest]);
    for (const reference of [
      { ...boundReplayRoute, role: "subscriber" },
      {
        ...boundReplayRoute,
        capturedRoute: {
          ...boundReplayRoute.capturedRoute,
          scenario: { id: "other", digest: setupDigest },
        },
      },
      replayRoute,
    ])
      expect(await observeReference(reference, capture)).toMatchObject({
        status: "incomplete",
        reason: "observation",
      });
  });

  it("does not treat a canary on a different fixed-version route as the same control", async () => {
    expect(
      await observeReference(
        boundReplayRoute,
        capturedRequests([
          { method: "POST", path: "/different", body: "value=1" },
        ]),
        replayRoute,
        [],
        undefined,
        true,
      ),
    ).toMatchObject({ status: "incomplete", reason: "observation" });
  });
});
