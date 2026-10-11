import { describe, expect, it } from "vitest";

import { capturedSessionCookie } from "../../../src/profiles/wordpress/verification/smoke-replay-verifier.js";

function capture(...headers: unknown[]) {
  return headers.map((value) => ({
    request: { method: "GET", path: "/synthetic", truncated: false as const },
    response: {
      headers: { "Set-Cookie": value },
      truncated: false as const,
    },
  }));
}

describe("weekly smoke session evidence", () => {
  it("accepts one captured login session even when the same cookie is repeated", () => {
    expect(
      capturedSessionCookie(
        capture(
          "wordpress_logged_in_test=one|session; Path=/",
          "wordpress_logged_in_test=one|session; Path=/",
        ),
      ),
    ).toEqual({ status: "unique", cookie: "one|session" });
  });

  it("marks distinct captured login sessions ambiguous so they cannot support a negative control", () => {
    expect(
      capturedSessionCookie(
        capture(
          "wordpress_logged_in_test=attacker|session; Path=/",
          "wordpress_logged_in_test=administrator|session; Path=/",
        ),
      ),
    ).toEqual({ status: "ambiguous" });
  });

  it("distinguishes no login session from unreadable Set-Cookie evidence", () => {
    expect(capturedSessionCookie(capture("other=value; Path=/"))).toEqual({
      status: "none",
    });
    expect(capturedSessionCookie(capture({ unknown: true }))).toEqual({
      status: "ambiguous",
    });
  });
});
