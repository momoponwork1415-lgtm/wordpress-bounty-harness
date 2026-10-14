import { describe, expect, it } from "vitest";

import { enumerateWordPressOrgCandidates } from "../../../src/profiles/wordpress/selection/wordpress-org-candidate-enumerator.js";

const now = "2026-10-12T00:00:00.000Z";
const clock = () => new Date(now);

function listing(slugs: readonly string[], date = now, page = 1): Response {
  return new Response(
    JSON.stringify({
      info: { page, pages: 1, results: slugs.length },
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
      listings: [{ status: "stale", checkedAt: now, reason: "old-response" }],
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

  it("rejects a listing whose Date header is far in the future", async () => {
    const result = await enumerateWordPressOrgCandidates({
      tags: [],
      clock,
      fetch: async () => listing(["future-plugin"], "2026-10-12T01:00:00.000Z"),
    });
    expect(result).toMatchObject({
      status: "unavailable",
      candidates: [],
      listings: [
        { status: "unavailable", checkedAt: now, reason: "invalid-response" },
      ],
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

  it("continues beyond 500 distinct listing slugs with a listing-bound cursor", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("request[page]"));
      const group = url.searchParams.get("request[tag]") ?? "popular";
      const slugs = Array.from(
        { length: 50 },
        (_, index) => `${group}-${page}-${index}`,
      );
      return listing(slugs, now, page);
    };
    const options = {
      tags: ["login", "forms"],
      popularPages: 5,
      pagesPerTag: 5,
      perPage: 50,
      maxCandidates: 500,
      clock,
      fetch: fetcher,
    };
    const first = await enumerateWordPressOrgCandidates(options);
    expect(first.candidates).toHaveLength(500);
    expect(first.traversal).toMatchObject({
      offset: 0,
      observedUniqueCandidates: 750,
      complete: false,
      nextCursor: { nextIndex: 500 },
    });
    const cursor = first.traversal.nextCursor;
    if (cursor === undefined) throw new Error("Expected continuation cursor");
    const second = await enumerateWordPressOrgCandidates({
      ...options,
      cursor,
    });
    expect(second.candidates).toHaveLength(250);
    expect(second.traversal).toMatchObject({
      offset: 500,
      observedUniqueCandidates: 750,
      complete: true,
    });
    expect(second.traversal.nextCursor).toBeUndefined();
    expect(
      new Set(
        [...first.candidates, ...second.candidates].map((item) => item.slug),
      ).size,
    ).toBe(750);
    await expect(
      enumerateWordPressOrgCandidates({
        ...options,
        cursor,
        fetch: async (input) => {
          const response = await fetcher(input);
          if (String(input).includes("request%5Bbrowse%5D=popular"))
            return listing(
              ["changed"],
              now,
              Number(new URL(String(input)).searchParams.get("request[page]")),
            );
          return response;
        },
      }),
    ).rejects.toThrow("listing set changed");
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
