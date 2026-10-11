import { createHash } from "node:crypto";

import { z } from "zod";

const endpoint = "https://api.wordpress.org/plugins/info/1.2/";
const maximumResponseBytes = 1_000_000;
const dayMilliseconds = 86_400_000;
const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const listingSchema = z.object({
  info: z.object({ page: z.number().int().positive() }),
  plugins: z.array(z.object({ slug: slugSchema })).max(50),
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
  "http-error" | "network-failure" | "invalid-response" | "too-large";

export type WordPressOrgListingObservation = ListingIdentity &
  (
    | {
        readonly status: "available";
        readonly observedAt: string;
        readonly contentDigest: string;
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
  readonly maxCandidates?: number;
  readonly maxAgeDays?: number;
  readonly popularPages?: number;
  readonly pagesPerTag?: number;
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

function listingRequests(
  tags: readonly string[],
  popularPages: number,
  pagesPerTag: number,
  perPage: number,
): ListingRequest[] {
  const requests: ListingRequest[] = [];
  for (let page = 1; page <= Math.max(popularPages, pagesPerTag); page++) {
    if (page <= popularPages)
      requests.push({
        kind: "popular",
        page,
        sourceUrl: listingUrl("popular", page, perPage),
      });
    if (page <= pagesPerTag)
      for (const tag of tags)
        requests.push({
          kind: "tag",
          tag,
          page,
          sourceUrl: listingUrl("tag", page, perPage, tag),
        });
  }
  return requests;
}

async function readBounded(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maximumResponseBytes)
    throw new Error("too-large");
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumResponseBytes) throw new Error("too-large");
      parts.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function unavailable(
  request: ListingRequest,
  reason: UnavailableReason,
): WordPressOrgListingObservation {
  return { ...request, status: "unavailable", reason };
}

async function observeListing(
  request: ListingRequest,
  fetcher: typeof fetch,
  clock: () => Date,
  maxAgeDays: number,
): Promise<{
  listing: WordPressOrgListingObservation;
  slugs: readonly string[];
}> {
  let response: Response;
  try {
    response = await fetcher(request.sourceUrl, {
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
      credentials: "omit",
      headers: { Accept: "application/json" },
    });
  } catch {
    return { listing: unavailable(request, "network-failure"), slugs: [] };
  }
  if (!response.ok)
    return { listing: unavailable(request, "http-error"), slugs: [] };

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
    return { listing: unavailable(request, "invalid-response"), slugs: [] };
  }
  if (fetchedAt - observed > maxAgeDays * dayMilliseconds) {
    return {
      listing: {
        ...request,
        status: "stale",
        observedAt: new Date(observed).toISOString(),
        reason: "old-response",
      },
      slugs: [],
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = await readBounded(response);
  } catch (error) {
    return {
      listing: unavailable(
        request,
        error instanceof Error && error.message === "too-large"
          ? "too-large"
          : "network-failure",
      ),
      slugs: [],
    };
  }
  try {
    const parsed = listingSchema.parse(
      JSON.parse(Buffer.from(bytes).toString("utf8")),
    );
    if (parsed.info.page !== request.page) {
      return { listing: unavailable(request, "invalid-response"), slugs: [] };
    }
    const contentDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    return {
      listing: {
        ...request,
        status: "available",
        observedAt: new Date(observed).toISOString(),
        contentDigest,
      },
      slugs: parsed.plugins.map((plugin) => plugin.slug),
    };
  } catch {
    return { listing: unavailable(request, "invalid-response"), slugs: [] };
  }
}

/** Query bounded popular and tag pages. A stale or failed listing never contributes candidates. */
export async function enumerateWordPressOrgCandidates(
  options: EnumerateWordPressOrgCandidatesOptions = {},
): Promise<WordPressOrgCandidateEnumeration> {
  const maxCandidates = boundedInteger(
    options.maxCandidates ?? 100,
    "maxCandidates",
    500,
  );
  const popularPages = boundedInteger(
    options.popularPages ?? 1,
    "popularPages",
    5,
  );
  const pagesPerTag = boundedInteger(
    options.pagesPerTag ?? 1,
    "pagesPerTag",
    5,
  );
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
  const availableGroups: Array<{
    listing: Extract<WordPressOrgListingObservation, { status: "available" }>;
    slugs: readonly string[];
  }> = [];
  for (const request of listingRequests(
    tags,
    popularPages,
    pagesPerTag,
    perPage,
  )) {
    const result = await observeListing(request, fetcher, clock, maxAgeDays);
    listings.push(result.listing);
    if (result.listing.status === "available") {
      availableGroups.push({ listing: result.listing, slugs: result.slugs });
    }
  }
  const longestPage = Math.max(
    0,
    ...availableGroups.map((group) => group.slugs.length),
  );
  for (
    let position = 0;
    position < longestPage && candidates.length < maxCandidates;
    position++
  ) {
    for (const group of availableGroups) {
      const slug = group.slugs[position];
      if (
        slug === undefined ||
        seen.has(slug) ||
        candidates.length >= maxCandidates
      )
        continue;
      seen.add(slug);
      candidates.push({
        slug,
        sourceKind: group.listing.kind,
        ...(group.listing.tag === undefined
          ? {}
          : { sourceTag: group.listing.tag }),
        sourcePage: group.listing.page,
        sourceUrl: group.listing.sourceUrl,
        observedAt: group.listing.observedAt,
        contentDigest: group.listing.contentDigest,
      });
    }
  }
  const status = listings.some((listing) => listing.status === "available")
    ? "available"
    : listings.some((listing) => listing.status === "stale")
      ? "stale"
      : "unavailable";
  return { status, candidates, listings };
}
