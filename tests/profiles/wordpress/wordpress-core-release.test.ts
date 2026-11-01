import { describe, expect, it } from "vitest";

import {
  openWordPressCoreRelease,
  WORDPRESS_CORE_VERSION_CHECK_URL,
} from "../../../src/profiles/wordpress/acquisition/wordpress-core-release.js";

// #741: WordPress.org の version-check から最新の安定版だけを読む。

const body = JSON.stringify({
  offers: [
    { response: "upgrade", current: "7.1.4", php_version: "7.2.24" },
    { response: "autoupdate", current: "7.1.4" },
  ],
  translations: [],
});
const clock = () => new Date("2026-11-01T09:00:00.000Z");
const answer = (status: number, text: string) =>
  new Response(text, {
    status,
    headers: { "content-type": "application/json" },
  });

describe("WordPress core release observation", () => {
  it("reads offers[0].current, the time and a digest of the body, from the version-check URL only", async () => {
    const urls: string[] = [];
    const observe = openWordPressCoreRelease({
      clock,
      fetch: async (input) => {
        urls.push(String(input));
        return answer(200, body);
      },
    });
    expect(await observe()).toEqual({
      status: "observed",
      version: "7.1.4",
      observedAt: "2026-11-01T09:00:00.000Z",
      sourceUrl: WORDPRESS_CORE_VERSION_CHECK_URL,
      responseDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(urls).toEqual([WORDPRESS_CORE_VERSION_CHECK_URL]);
  });

  it.each([
    ["network", async () => Promise.reject(new Error("offline"))],
    ["status", async () => answer(503, "")],
    ["malformed", async () => answer(200, "not json")],
    ["malformed", async () => answer(200, JSON.stringify({ offers: [] }))],
    [
      "malformed",
      async () =>
        answer(200, JSON.stringify({ offers: [{ current: "7.1.4; rm" }] })),
    ],
    ["too-large", async () => answer(200, body)],
  ] as const)("is unavailable with reason %s", async (reason, fetch) => {
    const observe = openWordPressCoreRelease({
      clock,
      fetch: fetch as typeof globalThis.fetch,
      ...(reason === "too-large" ? { maximumBytes: 10 } : {}),
    });
    expect(await observe()).toEqual({ status: "unavailable", reason });
  });
});
