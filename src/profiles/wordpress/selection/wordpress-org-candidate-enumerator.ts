import { z } from "zod";

import {
  fetchBounded,
  ResponseTooLargeError,
} from "../../../infrastructure/bounded-fetch.js";
import { bytesDigest } from "../../../infrastructure/content-digest.js";

const endpoint = "https://api.wordpress.org/plugins/info/1.2/";
const maximumResponseBytes = 1_000_000;
const dayMilliseconds = 86_400_000;
const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const listingSchema = z.object({
  info: z.object({
    page: z.number().int().positive(),
    pages: z.number().int().nonnegative(),
  }),
  plugins: z
    .array(
      z.object({
        slug: slugSchema,
        active_installs: z.number().int().nonnegative(),
      }),
    )
    .max(50),
});

export interface WordPressOrgCandidate {
  readonly slug: string;
  readonly sourceKind: "popular" | "tag";
  readonly sourceTag?: string;
  readonly sourcePage: number;
  readonly sourceUrl: string;
  readonly observedAt: string;
  readonly contentDigest: string;
}

interface ListingIdentity {
  readonly kind: "popular" | "tag";
  readonly tag?: string;
  readonly page: number;
  readonly sourceUrl: string;
}

type UnavailableReason =
  | "http-error"
  | "network-failure"
  | "invalid-response"
  | "too-large"
  | "pagination-limit";

export type WordPressOrgListingObservation = ListingIdentity & {
  readonly checkedAt: string;
} & (
    | {
        readonly status: "available";
        readonly observedAt: string;
        readonly contentDigest: string;
        readonly end?: "installation-floor" | "last-page";
      }
    | {
        readonly status: "stale";
        readonly observedAt: string;
        readonly reason: "old-response";
      }
    | { readonly status: "unavailable"; readonly reason: UnavailableReason }
  );

export interface WordPressOrgCandidateEnumeration {
  readonly status: "available" | "unavailable" | "stale";
  readonly candidates: readonly WordPressOrgCandidate[];
  readonly listings: readonly WordPressOrgListingObservation[];
}

export interface EnumerateWordPressOrgCandidatesOptions {
  readonly tags?: readonly string[];
  readonly minimumActiveInstallations?: number;
  readonly maxAgeDays?: number;
  readonly perPage?: number;
  readonly fetch?: typeof fetch;
  readonly clock?: () => Date;
}

type ListingRequest = ListingIdentity;

function boundedInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function listingUrl(
  kind: "popular" | "tag",
  page: number,
  pageSize: number,
  tag?: string,
): string {
  const url = new URL(endpoint);
  url.searchParams.set("action", "query_plugins");
  url.searchParams.set("request[page]", String(page));
  url.searchParams.set("request[per_page]", String(pageSize));
  if (kind === "popular") url.searchParams.set("request[browse]", "popular");
  else if (tag !== undefined) url.searchParams.set("request[tag]", tag);
  url.searchParams.set("request[fields][active_installs]", "1");
  for (const field of [
    "description",
    "sections",
    "short_description",
    "banners",
    "icons",
  ]) {
    url.searchParams.set(`request[fields][${field}]`, "0");
  }
  return url.toString();
}

function unavailable(
  request: ListingRequest,
  reason: UnavailableReason,
  checkedAt: string,
): WordPressOrgListingObservation {
  return { ...request, checkedAt, status: "unavailable", reason };
}

async function observeListing(
  request: ListingRequest,
  fetcher: typeof fetch,
  clock: () => Date,
  maxAgeDays: number,
  minimumActiveInstallations: number,
): Promise<{
  listing: WordPressOrgListingObservation;
  slugs: readonly string[];
}> {
  const checkedAt = clock().toISOString();
  let response: Response;
  let readBody: () => Promise<Uint8Array>;
  try {
    ({ response, readBody } = await fetchBounded(fetcher, request.sourceUrl, {
      timeoutMs: 15_000,
      redirect: "error",
      credentials: "omit",
      headers: { Accept: "application/json" },
      maximumBytes: maximumResponseBytes,
    }));
  } catch {
    return {
      listing: unavailable(request, "network-failure", checkedAt),
      slugs: [],
    };
  }
  if (!response.ok)
    return {
      listing: unavailable(request, "http-error", checkedAt),
      slugs: [],
    };

  const fetchedAt = clock().getTime();
  const responseDate = response.headers.get("date");
  const ageHeader = response.headers.get("age");
  const ageSeconds = ageHeader === null ? 0 : Number(ageHeader);
  const dateObserved =
    responseDate === null ? fetchedAt : Date.parse(responseDate);
  const observed = Math.min(dateObserved, fetchedAt - ageSeconds * 1000);
  if (
    !Number.isFinite(fetchedAt) ||
    !Number.isFinite(ageSeconds) ||
    ageSeconds < 0 ||
    !Number.isFinite(dateObserved) ||
    dateObserved > fetchedAt + 300_000 ||
    !Number.isFinite(observed)
  ) {
    return {
      listing: unavailable(request, "invalid-response", checkedAt),
      slugs: [],
    };
  }
  if (fetchedAt - observed > maxAgeDays * dayMilliseconds) {
    return {
      listing: {
        ...request,
        checkedAt,
        status: "stale",
        observedAt: new Date(observed).toISOString(),
        reason: "old-response",
      },
      slugs: [],
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = await readBody();
  } catch (error) {
    return {
      listing: unavailable(
        request,
        error instanceof ResponseTooLargeError
          ? "too-large"
          : "network-failure",
        checkedAt,
      ),
      slugs: [],
    };
  }
  try {
    const parsed = listingSchema.parse(
      JSON.parse(Buffer.from(bytes).toString("utf8")),
    );
    if (parsed.info.page !== request.page) {
      return {
        listing: unavailable(request, "invalid-response", checkedAt),
        slugs: [],
      };
    }
    const contentDigest = bytesDigest(bytes);
    const belowFloor =
      parsed.plugins.length > 0 &&
      parsed.plugins.every(
        (plugin) => plugin.active_installs < minimumActiveInstallations,
      );
    const lastPage =
      request.page >= parsed.info.pages || parsed.plugins.length === 0;
    // The upstream popular view caps at 99 pages; do not claim it exhausted a still-eligible population.
    if (
      !belowFloor &&
      parsed.plugins.length > 0 &&
      (request.page >= 999 ||
        (request.kind === "popular" && request.page >= 99))
    )
      return {
        listing: unavailable(request, "pagination-limit", checkedAt),
        slugs: [],
      };
    return {
      listing: {
        ...request,
        checkedAt,
        status: "available",
        observedAt: new Date(observed).toISOString(),
        contentDigest,
        ...(belowFloor
          ? { end: "installation-floor" as const }
          : lastPage
            ? { end: "last-page" as const }
            : {}),
      },
      slugs: parsed.plugins
        .filter(
          (plugin) => plugin.active_installs >= minimumActiveInstallations,
        )
        .map((plugin) => plugin.slug),
    };
  } catch {
    return {
      listing: unavailable(request, "invalid-response", checkedAt),
      slugs: [],
    };
  }
}

/** Read install-ordered public listings through the floor or their final page (#533). */
export async function enumerateWordPressOrgCandidates(
  options: EnumerateWordPressOrgCandidatesOptions = {},
): Promise<WordPressOrgCandidateEnumeration> {
  const minimumActiveInstallations =
    options.minimumActiveInstallations ?? 10_000;
  if (
    !Number.isSafeInteger(minimumActiveInstallations) ||
    minimumActiveInstallations < 0
  )
    throw new Error("minimumActiveInstallations must be a nonnegative integer");
  const perPage = boundedInteger(options.perPage ?? 20, "perPage", 50);
  const maxAgeDays = options.maxAgeDays ?? 2;
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    throw new Error("maxAgeDays must be positive");
  }
  const tags = [
    ...new Set(
      (options.tags ?? []).map((tag) =>
        tag.trim().toLowerCase().replace(/\s+/g, "-"),
      ),
    ),
  ];
  if (
    tags.length > 8 ||
    tags.some((tag) => !/^[a-z0-9][a-z0-9-]*$/.test(tag))
  ) {
    throw new Error("tags must be at most eight valid tag slugs");
  }
  const fetcher = options.fetch ?? fetch;
  const clock = options.clock ?? (() => new Date());
  const listings: WordPressOrgListingObservation[] = [];
  const candidates: WordPressOrgCandidate[] = [];
  const seen = new Set<string>();
  for (const tag of [undefined, ...tags]) {
    const kind = tag === undefined ? "popular" : "tag";
    for (let page = 1; page <= 999; page++) {
      const request: ListingRequest = {
        kind,
        ...(tag === undefined ? {} : { tag }),
        page,
        sourceUrl: listingUrl(kind, page, perPage, tag),
      };
      const result = await observeListing(
        request,
        fetcher,
        clock,
        maxAgeDays,
        minimumActiveInstallations,
      );
      const listing = result.listing;
      listings.push(listing);
      if (listing.status !== "available") break;
      for (const slug of result.slugs) {
        if (seen.has(slug)) continue;
        seen.add(slug);
        candidates.push({
          slug,
          sourceKind: kind,
          ...(tag === undefined ? {} : { sourceTag: tag }),
          sourcePage: page,
          sourceUrl: listing.sourceUrl,
          observedAt: listing.observedAt,
          contentDigest: listing.contentDigest,
        });
      }
      if (listing.end !== undefined) break;
    }
  }
  // A failed source leaves an incomplete population, never an apparently empty queue.
  const status = listings.some((listing) => listing.status === "unavailable")
    ? "unavailable"
    : listings.some((listing) => listing.status === "stale")
      ? "stale"
      : "available";
  if (status !== "available") candidates.length = 0;
  return { status, candidates, listings };
}
