import { describe, expect, it } from "vitest";

import { enumerateWordPressOrgCandidates } from "../../../src/profiles/wordpress/selection/wordpress-org-candidate-enumerator.js";

const now = "2026-10-12T00:00:00.000Z";
const clock = () => new Date(now);

function listing(slugs: readonly string[], date = now): Response {
  return new Response(
    JSON.stringify({
      info: { page: 1, pages: 1, results: slugs.length },
      plugins: slugs.map((slug) => ({ slug })),
    }),
    { status: 200, headers: { Date: new Date(date).toUTCString() } },
  );
}

describe("WordPress.org public candidate enumeration", () => {
  it("queries popular and tag listings, deduplicates, and retains source and observation time", async () => {
    const requests: URL[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      return url.searchParams.has("request[tag]")
        ? listing(["second", "third"])
        : listing(["first", "second"]);
    };
    const result = await enumerateWordPressOrgCandidates({
      tags: ["File Upload"],
      popularPages: 1,
      pagesPerTag: 1,
      perPage: 5,
      maxCandidates: 10,
      clock,
      fetch: fetcher,
    });

    expect(result.status).toBe("available");
    expect(result.candidates.map((item) => item.slug)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(result.candidates[0]).toMatchObject({
      sourceKind: "popular",
      sourcePage: 1,
      observedAt: now,
      contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(result.candidates[2]).toMatchObject({
      sourceKind: "tag",
      sourceTag: "file-upload",
      sourcePage: 1,
      observedAt: now,
    });
    expect(result.listings.map((item) => item.status)).toEqual([
      "available",
      "available",
    ]);
    expect(requests[0]?.origin).toBe("https://api.wordpress.org");
    expect(requests[0]?.searchParams.get("action")).toBe("query_plugins");
    expect(requests[0]?.searchParams.get("request[browse]")).toBe("popular");
    expect(requests[1]?.searchParams.get("request[tag]")).toBe("file-upload");
    expect(requests[1]?.searchParams.get("request[per_page]")).toBe("5");
  });

  it("never nominates a candidate from a stale listing", async () => {
    const result = await enumerateWordPressOrgCandidates({
      tags: [],
      maxAgeDays: 2,
      clock,
      fetch: async () => listing(["stale-plugin"], "2026-10-01T00:00:00.000Z"),
    });
    expect(result).toMatchObject({
      status: "stale",
      candidates: [],
      listings: [{ status: "stale", reason: "old-response" }],
    });
  });

  it("treats a cached listing with an old Age header as stale even without Date", async () => {
    const response = new Response(
      JSON.stringify({
        info: { page: 1 },
        plugins: [{ slug: "cached-plugin" }],
      }),
      { headers: { Age: "604800" } },
    );
    const result = await enumerateWordPressOrgCandidates({
      tags: [],
      maxAgeDays: 1,
      clock,
      fetch: async () => response,
    });
    expect(result).toMatchObject({
      status: "stale",
      candidates: [],
      listings: [{ status: "stale", reason: "old-response" }],
    });
  });

  it("draws from both listing types when the candidate cap is small", async () => {
    const result = await enumerateWordPressOrgCandidates({
      tags: ["login"],
      maxCandidates: 2,
      clock,
      fetch: async (input) =>
        String(input).includes("request%5Btag%5D")
          ? listing(["tag-first", "tag-second"])
          : listing(["popular-first", "popular-second"]),
    });
    expect(
      result.candidates.map((item) => [item.slug, item.sourceKind]),
    ).toEqual([
      ["popular-first", "popular"],
      ["tag-first", "tag"],
    ]);
  });

  it("keeps valid candidates from a current source when another source fails", async () => {
    const result = await enumerateWordPressOrgCandidates({
      tags: ["login"],
      clock,
      fetch: async (input) =>
        String(input).includes("request%5Btag%5D")
          ? listing(["login-plugin"])
          : new Response("rate limited", { status: 429 }),
    });
    expect(result.status).toBe("available");
    expect(result.candidates.map((item) => item.slug)).toEqual([
      "login-plugin",
    ]);
    expect(result.listings.map((item) => item.status)).toEqual([
      "unavailable",
      "available",
    ]);
  });

  it("rejects malformed listings and bounds request counts", async () => {
    const invalid = await enumerateWordPressOrgCandidates({
      clock,
      fetch: async () => new Response('{"plugins":[{"slug":"../../bad"}]}'),
    });
    expect(invalid).toMatchObject({
      status: "unavailable",
      candidates: [],
      listings: [{ status: "unavailable", reason: "invalid-response" }],
    });
    await expect(
      enumerateWordPressOrgCandidates({ popularPages: 6 }),
    ).rejects.toThrow("popularPages");
    await expect(
      enumerateWordPressOrgCandidates({
        tags: Array.from({ length: 9 }, (_, i) => `tag-${i}`),
      }),
    ).rejects.toThrow("tags");
  });
});
