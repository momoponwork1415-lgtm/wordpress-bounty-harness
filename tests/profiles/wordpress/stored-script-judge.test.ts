import { describe, expect, it } from "vitest";

import { httpCapture } from "../../../src/lab/capture.js";
import type {
  WordPressStoredScriptObservation,
  WordPressVictimRoute,
} from "../../../src/profiles/wordpress/lab/index.js";
import {
  finding as syntheticFinding,
  judgeOnce,
  quietLab,
  route,
  type JudgeLab,
} from "./judge-fixture.js";

const nonce = "synthetic-script-nonce";
const requestBody = `value=${nonce}`;
const defaultHeaders = {
  cookie: "wordpress_logged_in_fixture=attacker-session",
};

function exchange(
  headers: Record<string, string>,
  body = requestBody,
  statusCode = 200,
  responseHeaders: Record<string, string> = {},
  responseBody = "saved",
) {
  return {
    request: {
      method: "POST",
      path: "/synthetic",
      headers,
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
  };
}

function captureSequence(...exchanges: ReturnType<typeof exchange>[]) {
  return {
    status: "captured" as const,
    ...httpCapture(
      Buffer.from(
        exchanges.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      ),
      0,
    ),
  };
}

function capture(
  headers: Record<string, string>,
  body = requestBody,
  statusCode = 200,
  responseHeaders: Record<string, string> = {},
  responseBody = "saved",
) {
  return captureSequence(
    exchange(headers, body, statusCode, responseHeaders, responseBody),
  );
}

const browserRoute = {
  ...route,
  steps: [
    {
      kind: "http",
      method: "POST",
      path: "/synthetic",
      body: requestBody,
      expected: "Synthetic observation",
    },
    { kind: "browser", path: "/?p=7", expected: "Beacon reaches the receiver" },
  ],
};
const observerBytes = Buffer.from("synthetic observer output");

async function judge(
  observation: WordPressStoredScriptObservation,
  victim?: WordPressVictimRoute,
  overrides: Partial<JudgeLab> = {},
  position: "subscriber" | "unauthenticated" = "subscriber",
) {
  const visited: (readonly string[])[] = [];
  const victims: (WordPressVictimRoute | undefined)[] = [];
  const result = await judgeOnce({
    impact: "stored-xss",
    finding: { ...syntheticFinding("stored-xss"), attackerPosition: position },
    lab: quietLab({
      readCapture: async () => capture(defaultHeaders),
      issuedScriptNonces: () => [nonce],
      observeSessionUser: async () => ({
        status: "user",
        login: "lab-subscriber",
      }),
      async observeStoredScript(_lab, input) {
        visited.push(input.routePaths);
        victims.push(input.victim);
        return observation;
      },
      ...overrides,
    }),
    files: {
      "route.json": JSON.stringify({
        ...browserRoute,
        role: position,
        account: position === "unauthenticated" ? "none" : "lab-subscriber",
        victim,
      }),
      "capture-marker.json": JSON.stringify({ marker: "0" }),
      "http.json": JSON.stringify({
        exchanges: [
          {
            request: { method: "POST", path: "/synthetic" },
            response: { status: 200, body: "saved" },
          },
        ],
      }),
      "notes.md": "The Verifier saw an alert box.\n",
    },
  });
  return { ...result, visited, victims };
}

describe("WordPress stored script judge", () => {
  const fired = {
    status: "observed" as const,
    contexts: ["front" as const],
    screenshot: observerBytes,
  };

  it("confirms a beacon from the front page or every admin screen and records the contexts", async () => {
    const { judgeId, observed, visited } = await judge({
      status: "observed",
      contexts: ["front", "admin-all"],
      screenshot: observerBytes,
    });
    expect(judgeId).toBe("wordpress-stored-script");
    expect(visited).toEqual([["/?p=7"]]);
    expect(observed).toEqual({
      status: "observed",
      evidenceDigest: expect.stringMatching(/^sha256:/),
      evidenceCapture: "harness-captured",
      conditions: {
        observedVia: "canary-beacon",
        firedContexts: "front,admin-all",
        siteWide: "yes",
        attackerRole: "subscriber",
        defaultSettings: "true",
      },
    });
  });

  it("requires the issued nonce in a Harness-captured attacker request", async () => {
    const missingCapture = await judge(fired, undefined, {
      readCapture: async () => ({ status: "unavailable" }),
    });
    expect(missingCapture.observed).toMatchObject({
      status: "incomplete",
      reason: "evidence",
      nextStep: expect.stringContaining("HTTP capture"),
    });
    const missingNonce = await judge(fired, undefined, {
      readCapture: async () => capture(defaultHeaders, "ordinary"),
    });
    expect(missingNonce.observed).toMatchObject({
      status: "incomplete",
      reason: "evidence",
      nextStep: expect.stringContaining("issued script canary"),
    });
  });

  it("rejects a canary-bearing request from another or unknown principal", async () => {
    const wrongActor = await judge(fired, undefined, {
      observeSessionUser: async () => ({
        status: "user",
        login: "harness-admin",
      }),
    });
    expect(wrongActor.observed).toMatchObject({
      status: "incomplete",
      reason: "evidence",
      nextStep: expect.stringContaining("session differs"),
    });
    const noSession = await judge(fired, undefined, {
      readCapture: async () => capture({}),
    });
    expect(noSession.observed).toMatchObject({
      status: "incomplete",
      reason: "evidence",
      nextStep: expect.stringContaining("verifiable attacker session"),
    });
  });

  it("rejects a canary-free administrator request anywhere after setup", async () => {
    for (const exchanges of [
      [
        exchange(
          { cookie: "wordpress_logged_in_fixture=admin-session" },
          "ordinary",
        ),
        exchange(defaultHeaders),
      ],
      [
        exchange(defaultHeaders),
        exchange(
          { cookie: "wordpress_logged_in_fixture=admin-session" },
          "ordinary",
        ),
      ],
    ]) {
      const { observed } = await judge(fired, undefined, {
        readCapture: async () => captureSequence(...exchanges),
        observeSessionUser: async (_lab, cookie) => ({
          status: "user",
          login:
            cookie === "admin-session" ? "harness-admin" : "lab-subscriber",
        }),
      });
      expect(observed).toMatchObject({
        status: "incomplete",
        reason: "evidence",
        nextStep: expect.stringContaining("post-setup request session differs"),
      });
    }
  });

  it("accepts a canary-bearing write followed by a same-origin redirect", async () => {
    for (const location of ["/", "http://wordpress/?finished=1"]) {
      const { observed } = await judge(fired, undefined, {
        readCapture: async () =>
          capture({ ...defaultHeaders, host: "wordpress" }, requestBody, 302, {
            location,
          }),
      });
      expect(observed).toMatchObject({
        status: "observed",
        conditions: { attackerRole: "subscriber" },
      });
    }
  });

  it("still requires the issued nonce in a redirected attack request", async () => {
    const { observed } = await judge(fired, undefined, {
      readCapture: async () =>
        capture({ ...defaultHeaders, host: "wordpress" }, "ordinary", 302, {
          location: "/",
        }),
    });
    expect(observed).toMatchObject({
      status: "incomplete",
      reason: "evidence",
      nextStep: expect.stringContaining("issued script canary"),
    });
  });

  it("keeps missing or external redirects and rejected writes incomplete", async () => {
    for (const [statusCode, responseHeaders, responseBody] of [
      [302, {}, "saved"],
      [302, { location: "https://other.example/" }, "saved"],
      [302, { location: "http://wordpress.other.example/" }, "saved"],
      [302, { location: "//other.example/" }, "saved"],
      [302, { location: "https://wordpress/" }, "saved"],
      [302, { location: "/wp-login.php" }, "saved"],
      [302, { location: "/" }, '{"success":false}'],
      [403, {}, "denied"],
      [200, {}, '{"success":false}'],
    ] as const) {
      const { observed } = await judge(fired, undefined, {
        readCapture: async () =>
          capture(
            { ...defaultHeaders, host: "wordpress" },
            requestBody,
            statusCode,
            responseHeaders,
            responseBody,
          ),
      });
      expect(observed).toMatchObject({
        status: "incomplete",
        reason: "evidence",
        nextStep: expect.stringContaining("completed attacker route step"),
      });
    }
  });

  it("rejects unsupported authentication headers and elevated attacker roles", async () => {
    const unknownHeader = await judge(fired, undefined, {
      readCapture: async () =>
        capture({ ...defaultHeaders, authorization: "Bearer synthetic" }),
    });
    expect(unknownHeader.observed).toMatchObject({
      status: "incomplete",
      reason: "evidence",
      nextStep: expect.stringContaining("unsupported authentication header"),
    });
    const unknownAuthCookie = await judge(fired, undefined, {
      readCapture: async () =>
        capture({
          ...defaultHeaders,
          cookie: `${defaultHeaders.cookie}; plugin_admin_auth=opaque`,
        }),
    });
    expect(unknownAuthCookie.observed).toMatchObject({
      status: "incomplete",
      reason: "evidence",
      nextStep: expect.stringContaining("unsupported authentication cookie"),
    });
    const elevated = await judge(fired, undefined, {
      observeAccountRoles: async () => ({
        status: "roles",
        roles: ["subscriber", "administrator"],
      }),
    });
    expect(elevated.observed).toMatchObject({
      status: "incomplete",
      reason: "evidence",
      nextStep: expect.stringContaining("declared low privilege role"),
    });
    const shopManager = await judge(fired, undefined, {
      observeAccountRoles: async () => ({
        status: "roles",
        roles: ["subscriber", "shop_manager"],
      }),
    });
    expect(shopManager.observed).toMatchObject({
      status: "incomplete",
      reason: "evidence",
      nextStep: expect.stringContaining("declared low privilege role"),
    });
  });

  it("accepts an unauthenticated canary-bearing request only without auth", async () => {
    const anonymous = await judge(
      fired,
      undefined,
      { readCapture: async () => capture({}) },
      "unauthenticated",
    );
    expect(anonymous.observed).toMatchObject({
      status: "observed",
      conditions: { attackerRole: "unauthenticated" },
    });
    const loggedIn = await judge(fired, undefined, {}, "unauthenticated");
    expect(loggedIn.observed).toMatchObject({
      status: "incomplete",
      reason: "evidence",
      nextStep: expect.stringContaining("logged-in WordPress session"),
    });
  });

  it("allows form-state cookies without treating them as WordPress authentication", async () => {
    const { observed } = await judge(
      fired,
      undefined,
      {
        readCapture: async () =>
          capture({ cookie: "PHPSESSID=form-state; form_session=draft" }),
      },
      "unauthenticated",
    );
    expect(observed).toMatchObject({
      status: "observed",
      conditions: { attackerRole: "unauthenticated" },
    });
  });

  it("rejects WordPress authentication even beside a legitimate form cookie", async () => {
    const { observed } = await judge(
      fired,
      undefined,
      {
        readCapture: async () =>
          capture({
            cookie:
              "PHPSESSID=form-state; wordpress_logged_in_fixture=admin-session",
          }),
      },
      "unauthenticated",
    );
    expect(observed).toMatchObject({
      status: "incomplete",
      reason: "evidence",
      nextStep: expect.stringContaining("logged-in WordPress session"),
    });
    const malformed = await judge(
      fired,
      undefined,
      {
        readCapture: async () =>
          capture({ cookie: "wordpress_logged_in_=opaque" }),
      },
      "unauthenticated",
    );
    expect(malformed.observed).toMatchObject({
      status: "incomplete",
      reason: "evidence",
      nextStep: expect.stringContaining("logged-in WordPress session"),
    });
  });

  it("confirms a beacon from an affected page and records limited scope", async () => {
    for (const contexts of [["route-page"], ["admin-partial"]] as const) {
      const { observed } = await judge({
        status: "observed",
        contexts,
        screenshot: observerBytes,
      });
      expect(observed).toMatchObject({
        status: "observed",
        conditions: {
          observedVia: "canary-beacon",
          firedContexts: contexts[0],
          siteWide: "no",
        },
      });
    }
  });

  it("records a victim-role screen separately from site-wide firing", async () => {
    const victim = {
      role: "administrator" as const,
      paths: ["/wp-admin/admin.php?page=fixture"],
    };
    const { observed, victims } = await judge(
      {
        status: "observed",
        contexts: ["victim-route-page"],
        victimRole: "administrator",
        screenshot: observerBytes,
      },
      victim,
    );
    expect(victims).toEqual([victim]);
    expect(observed).toMatchObject({
      status: "observed",
      conditions: {
        firedContexts: "victim-route-page",
        victimRole: "administrator",
        victimPrincipal: "separate",
        siteWide: "no",
      },
    });
  });

  it("does not confirm a script observed in the attacker's own account", async () => {
    const { observed, store } = await judge(
      {
        status: "observed",
        contexts: ["victim-route-page"],
        victimRole: "self",
        screenshot: observerBytes,
      },
      { role: "subscriber", paths: ["/account"] },
    );
    expect(observed).toMatchObject({
      status: "incomplete",
      reason: "precondition",
      nextStep: expect.stringContaining("victimRole: self"),
      evidenceDigest: expect.stringMatching(/^sha256:/),
    });
    if (observed?.status !== "incomplete" || !observed.evidenceDigest)
      throw new Error("Expected private self-observation evidence");
    const evidence = await store.readFile(
      observed.evidenceDigest,
      "canary-observation.json",
      1024 * 1024,
    );
    expect(evidence.status).toBe("resolved");
    if (evidence.status === "resolved")
      expect(JSON.parse(evidence.bytes.toString("utf8"))).toMatchObject({
        status: "self-observed",
        victimRole: "self",
      });
  });

  it("keeps a separate front-page observation when a self page also fires", async () => {
    const { observed } = await judge(
      {
        status: "observed",
        contexts: ["front", "victim-route-page"],
        victimRole: "self",
        screenshot: observerBytes,
      },
      { role: "subscriber", paths: ["/account"] },
    );
    expect(observed).toMatchObject({
      status: "observed",
      conditions: {
        firedContexts: "front",
        siteWide: "yes",
      },
    });
    if (observed?.status === "observed")
      expect(observed.conditions.victimRole).toBeUndefined();
  });

  it("requires the Lab to identify the victim principal", async () => {
    const { observed } = await judge(
      {
        status: "observed",
        contexts: ["victim-route-page"],
        screenshot: observerBytes,
      },
      { role: "administrator", paths: ["/wp-admin/"] },
    );
    expect(observed).toMatchObject({
      status: "incomplete",
      reason: "evidence",
    });
  });

  it("requires a Lab account for a declared customer victim", async () => {
    const { observed } = await judge(
      {
        status: "observed",
        contexts: ["victim-route-page"],
        screenshot: observerBytes,
      },
      { role: "customer", paths: ["/account"] },
    );
    expect(observed).toMatchObject({
      status: "incomplete",
      reason: "precondition",
    });
  });

  it("does not fire when no beacon arrived, whatever the Verifier saw", async () => {
    expect(
      (await judge({ status: "observed", contexts: [] })).observed,
    ).toMatchObject({ status: "not-observed" });
  });

  it("keeps a non-firing victim visit incomplete with a diagnostic screenshot only in Private Evidence", async () => {
    const { observed, store } = await judge(
      { status: "observed", contexts: [], screenshot: observerBytes },
      { role: "administrator", paths: ["/wp-admin/admin.php?page=fixture"] },
    );
    expect(observed).toMatchObject({
      status: "incomplete",
      reason: "observation",
      evidenceDigest: expect.stringMatching(/^sha256:/),
      nextStep: expect.stringContaining("diagnostic screenshot"),
    });
    expect(JSON.stringify(observed)).not.toContain("page=fixture");
    expect(JSON.stringify(observed)).not.toContain("synthetic observer output");
    if (observed?.status !== "incomplete" || !observed.evidenceDigest)
      throw new Error("Expected private diagnostic evidence");
    const receipt = await store.readFile(
      observed.evidenceDigest,
      "canary-observation.json",
      8192,
    );
    const screenshot = await store.readFile(
      observed.evidenceDigest,
      "victim-screen-diagnostic.png",
      1024 * 1024,
    );
    expect(receipt.status).toBe("resolved");
    expect(screenshot.status).toBe("resolved");
    if (receipt.status === "resolved") {
      expect(JSON.parse(receipt.bytes.toString("utf8"))).toMatchObject({
        status: "victim-visited-without-beacon",
        phase: "victim-page",
        victimRole: "administrator",
        completedVictimVisits: 1,
        screenshotVisit: 1,
      });
      expect(receipt.bytes.toString("utf8")).not.toContain("page=fixture");
    }
    if (screenshot.status === "resolved")
      expect(screenshot.bytes).toEqual(observerBytes);
  });

  it("keeps a fired beacon incomplete when the Lab screenshot is missing", async () => {
    expect(
      (await judge({ status: "observed", contexts: ["front"] })).observed,
    ).toMatchObject({ status: "incomplete", reason: "evidence" });
  });

  it("stays incomplete without an issued script canary or a working observer", async () => {
    expect((await judge({ status: "not-prepared" })).observed).toMatchObject({
      status: "incomplete",
      reason: "precondition",
    });
    expect((await judge({ status: "unavailable" })).observed).toMatchObject({
      status: "incomplete",
      reason: "observation",
    });
  });

  it("keeps a victim browser failure incomplete with a bounded diagnostic", async () => {
    const { observed } = await judge(
      {
        status: "unavailable",
        phase: "victim-page",
        failureCode: "victim-action-not-visible",
      },
      { role: "administrator", paths: ["/wp-admin/admin.php?page=fixture"] },
    );
    expect(observed).toMatchObject({
      status: "incomplete",
      reason: "observation",
      nextStep: expect.stringContaining("victim-action-not-visible"),
    });
    expect(JSON.stringify(observed)).not.toContain("page=fixture");
  });

  it("stores unclassified browser stderr only in Private Evidence", async () => {
    const diagnostic = Buffer.from("private browser detail");
    const { observed, store } = await judge(
      {
        status: "unavailable",
        phase: "victim-page",
        failureCode: "browser-visit",
        privateDiagnostic: diagnostic,
      },
      { role: "administrator", paths: ["/wp-admin/admin.php?page=fixture"] },
    );
    expect(observed).toMatchObject({
      status: "incomplete",
      reason: "observation",
      evidenceDigest: expect.stringMatching(/^sha256:/),
    });
    expect(JSON.stringify(observed)).not.toContain(diagnostic.toString());
    if (observed?.status !== "incomplete" || !observed.evidenceDigest)
      throw new Error("Expected private browser diagnostic evidence");
    const privateBytes = await store.readFile(
      observed.evidenceDigest,
      "browser-stderr.txt",
      16 * 1024,
    );
    expect(privateBytes.status).toBe("resolved");
    if (privateBytes.status === "resolved")
      expect(privateBytes.bytes).toEqual(diagnostic);
  });
});
