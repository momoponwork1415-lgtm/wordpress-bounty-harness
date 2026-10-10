import { describe, expect, it } from "vitest";

import { canaries, judgeOnce, quietLab, route } from "./judge-fixture.js";

const privatePost = canaries.sensitiveCanaries[0]!;
const userMeta = canaries.sensitiveCanaries[1]!;

function capture(
  body: string,
  headers: Record<string, string> = {},
  requestBody = "",
) {
  return Buffer.from(
    `${JSON.stringify({
      request: {
        method: "GET",
        path: "/synthetic",
        headers,
        body: requestBody,
        bodyBase64: Buffer.from(requestBody).toString("base64"),
        truncated: false,
      },
      response: {
        statusCode: 200,
        headers: {},
        body,
        bodyBase64: Buffer.from(body).toString("base64"),
        truncated: false,
      },
    })}\n`,
  );
}

async function observe(bytes: Buffer | null, sessionLogin?: string) {
  return judgeOnce({
    impact: "sensitive-object-access",
    lab: quietLab({
      async readCapture() {
        return bytes === null
          ? { status: "unavailable" }
          : { status: "captured", bytes, dropped: 0 };
      },
      async observeSessionUser() {
        return sessionLogin === undefined
          ? { status: "none" }
          : { status: "user", login: sessionLogin };
      },
    }),
    files: {
      "route.json": JSON.stringify(route),
      "http.json": JSON.stringify({
        exchanges: [{ request: {}, response: { body: privatePost.value } }],
      }),
      "capture-marker.json": JSON.stringify({ marker: "0" }),
    },
  });
}

describe("sensitive object judge", () => {
  it("confirms a private-post canary in a captured unauthenticated response", async () => {
    const { judgeId, observed } = await observe(capture(privatePost.value));
    expect(judgeId).toBe("wordpress-sensitive-object-canary");
    expect(observed).toMatchObject({
      status: "observed",
      evidenceCapture: "harness-captured",
      conditions: {
        observedVia: "sensitive-canary-access",
        objectKind: "private-post",
        attackerRole: "unauthenticated",
      },
    });
  });

  it("confirms another user's metadata only for a validated low-privilege session", async () => {
    const cookie = "wordpress_logged_in_abc=synthetic-session";
    const low = await observe(
      capture(userMeta.value, { cookie }),
      "lab-subscriber",
    );
    expect(low.observed).toMatchObject({
      status: "observed",
      conditions: { objectKind: "other-user-meta", attackerRole: "subscriber" },
    });
    const admin = await observe(
      capture(userMeta.value, { cookie }),
      "harness-admin",
    );
    expect(admin.observed).toEqual({ status: "not-observed" });
  });

  it("rejects reflected input and response-shape differences", async () => {
    expect(
      (await observe(capture(privatePost.value, {}, privatePost.value)))
        .observed,
    ).toEqual({
      status: "not-observed",
    });
    expect(
      (await observe(capture("count=1; length=24; error=denied"))).observed,
    ).toEqual({
      status: "not-observed",
    });
  });

  it("requires a Harness capture and refuses unknown authentication headers", async () => {
    expect((await observe(null)).observed).toMatchObject({
      status: "incomplete",
      reason: "evidence",
    });
    expect(
      (
        await observe(
          capture(privatePost.value, { authorization: "Bearer unknown" }),
        )
      ).observed,
    ).toMatchObject({ status: "incomplete", reason: "evidence" });
  });

  it("keeps the unclassified other impact without a judge", async () => {
    const result = await judgeOnce({
      impact: "other",
      lab: quietLab(),
      files: { "route.json": JSON.stringify(route), "http.json": "{}" },
    });
    expect(result.judgeId).toBeNull();
  });
});
