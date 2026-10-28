import { describe, expect, it } from "vitest";

import { enumerateWordPressOrgCandidates } from "../../../src/profiles/wordpress/selection/wordpress-org-candidate-enumerator.js";

const now = "2026-10-12T00:00:00.000Z";
const clock = () => new Date(now);

function listing(slugs: readonly string[], date = now): Response {
  return new Response(
    JSON.stringify({
      info: { page: 1, pages: 1, results: slugs.length },
      plugins: slugs.map((slug) => ({ slug, active_installs: 10_000 })),
    }),
    { status: 200, headers: { Date: new Date(date).toUTCString() } },
  );
}

describe("WordPress.org public candidate enumeration", () => {
  it("reads beyond twenty popular pages until the install floor and exhausts each tag", async () => {
    const result = await enumerateWordPressOrgCandidates({
      tags: ["forms"],
      minimumActiveInstallations: 10_000,
      perPage: 1,
      clock,
      fetch: async (input) => {
        const url = new URL(String(input));
        const page = Number(url.searchParams.get("request[page]"));
        const tag = url.searchParams.get("request[tag]") ?? "popular";
        return new Response(
          JSON.stringify({
            info: { page, pages: 99, results: 99 },
            plugins: [
              {
                slug: `${tag}-${page}`,
                active_installs:
                  page <= (tag === "popular" ? 21 : 2) ? 10_000 : 9_000,
              },
            ],
          }),
        );
      },
    });
    expect(result.status).toBe("available");
    expect(result.candidates).toHaveLength(23);
    expect(result.candidates.some(({ slug }) => slug === "popular-21")).toBe(
      true,
    );
    expect(result.listings).toHaveLength(25);
  });

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

      perPage: 5,

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

  it("reports an incomplete population when any listing fails", async () => {
    const result = await enumerateWordPressOrgCandidates({
      tags: ["login"],
      clock,
      fetch: async (input) =>
        String(input).includes("request%5Btag%5D")
          ? listing(["login-plugin"])
          : new Response("rate limited", { status: 429 }),
    });
    expect(result.status).toBe("unavailable");
    expect(result.candidates).toEqual([]);
    expect(result.listings.map((item) => item.status)).toEqual([
      "unavailable",
      "available",
    ]);
  });

  it("does not silently truncate a population still above the upstream browse limit", async () => {
    const result = await enumerateWordPressOrgCandidates({
      clock,
      perPage: 1,
      fetch: async (input) => {
        const page = Number(
          new URL(String(input)).searchParams.get("request[page]"),
        );
        return new Response(
          JSON.stringify({
            info: { page, pages: 99 },
            plugins: [{ slug: `item-${page}`, active_installs: 10_000 }],
          }),
        );
      },
    });
    expect(result).toMatchObject({ status: "unavailable", candidates: [] });
    expect(result.listings.at(-1)).toMatchObject({
      reason: "pagination-limit",
    });
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
      enumerateWordPressOrgCandidates({ minimumActiveInstallations: -1 }),
    ).rejects.toThrow("minimumActiveInstallations");
    await expect(
      enumerateWordPressOrgCandidates({
        tags: Array.from({ length: 9 }, (_, i) => `tag-${i}`),
      }),
    ).rejects.toThrow("tags");
  });
});
