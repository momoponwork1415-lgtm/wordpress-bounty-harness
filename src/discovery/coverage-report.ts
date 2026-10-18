import { z } from "zod";

import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import type { Ledger, LedgerEventV1 } from "../ledger/index.js";

/** Private Evidence file of a run's `read-paths` artifact: sorted source-relative paths. */
export const READ_PATHS_FILE = "read-paths.json";
/** Profile-supplied files of one Target Snapshot: all source files, and those holding index entries. */
export type SourceFileSets = {
  readonly all: readonly string[];
  readonly indexed: readonly string[];
};
export type CoverageRatio =
  { readonly covered: number; readonly total: number } | "unavailable";
export type EntryCoverage =
  | {
      readonly observed: number;
      readonly blocked: number;
      readonly unvisited: number;
      readonly blockedReasons: Readonly<Record<string, number>>;
    }
  | "unavailable";
export type CoverageRow = {
  readonly entries: EntryCoverage;
  readonly sourceFiles: CoverageRatio;
  readonly indexedFiles: CoverageRatio;
  /** Recorded Leads by `missingEdge`; producer, consumer and unclassified are always present. */
  readonly missingEdges: Readonly<Record<string, number>>;
};
export type CampaignCoverage = {
  readonly campaignId: string;
  readonly runs: readonly (CoverageRow & {
    readonly runId: string;
    readonly runKind: string;
  })[];
  readonly total: CoverageRow;
};

// The profile validated the record before storing it; only the status tally is read here.
const coverageRecordSchema = z.object({
  entries: z.array(
    z.object({
      status: z.enum(["observed", "blocked", "unvisited"]),
      reason: z.string().nullable(),
    }),
  ),
});
const readPathsSchema = z.array(z.string());
type Finished = Extract<LedgerEventV1, { type: "discovery-run-finished" }>;

const edges = (): Record<string, number> => ({
  producer: 0,
  consumer: 0,
  unclassified: 0,
});
const add = (tally: Record<string, number>, key: string, count = 1) => {
  tally[key] = (tally[key] ?? 0) + count;
};
const ratio = (read: Iterable<string>, files: readonly string[]) => {
  const seen = new Set(read);
  return {
    covered: files.filter((file) => seen.has(file)).length,
    total: files.length,
  };
};

/** Exploration coverage of one campaign; a missing record or file set is "unavailable", never an error. */
export async function summarizeCampaignCoverage(options: {
  readonly ledger: Ledger;
  readonly store: Pick<PrivateArtifactStore, "readFile">;
  readonly campaignId: string;
  readonly sourceFiles?: (
    snapshotDigest: string,
  ) => Promise<SourceFileSets | null>;
}): Promise<CampaignCoverage> {
  const runKinds = new Map<string, string>();
  const finished: Finished[] = [];
  const leads = new Map<string, { runId: string; missingEdge: string }>();
  for (let afterSequence = 0; ;) {
    const page = options.ledger.read({
      campaignId: options.campaignId,
      afterSequence,
      limit: 1000,
    });
    for (const { event } of page) {
      if (event.type === "discovery-run-started")
        runKinds.set(event.runId, event.runKind ?? "explore");
      else if (event.type === "discovery-run-finished") finished.push(event);
      else if (event.type === "lead-recorded" && !leads.has(event.leadId))
        leads.set(event.leadId, event);
    }
    if (page.length < 1000) break;
    afterSequence = page[page.length - 1]!.sequence;
  }
  const readJson = async <T>(
    event: Finished,
    kind: string,
    file: string,
    schema: z.ZodType<T>,
  ): Promise<T | undefined> => {
    const ref = event.artifacts.find((artifact) => artifact.kind === kind);
    if (ref === undefined) return undefined;
    const stored = await options.store.readFile(ref.digest, file, 4 << 20);
    if (stored.status !== "resolved") return undefined;
    try {
      const parsed = schema.safeParse(
        JSON.parse(stored.bytes.toString("utf8")),
      );
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  };
  const fileSets = new Map<string, Promise<SourceFileSets | null>>();
  const filesOf = (digest: string) => {
    if (!fileSets.has(digest))
      fileSets.set(
        digest,
        (options.sourceFiles?.(digest) ?? Promise.resolve(null)).catch(
          () => null,
        ),
      );
    return fileSets.get(digest)!;
  };
  const totalEdges = edges();
  const edgesByRun = new Map<string, Record<string, number>>();
  for (const { runId, missingEdge } of leads.values()) {
    if (!edgesByRun.has(runId)) edgesByRun.set(runId, edges());
    add(edgesByRun.get(runId)!, missingEdge);
    add(totalEdges, missingEdge);
  }
  const runs: CampaignCoverage["runs"][number][] = [];
  const totalEntries = { observed: 0, blocked: 0, unvisited: 0 };
  const totalReasons: Record<string, number> = {};
  let entriesSeen = false;
  const readBySnapshot = new Map<string, Set<string>>();
  for (const event of finished) {
    const record = await readJson(
      event,
      "coverage",
      "coverage.json",
      coverageRecordSchema,
    );
    let entries: EntryCoverage = "unavailable";
    if (record !== undefined) {
      const counts = { observed: 0, blocked: 0, unvisited: 0 };
      const blockedReasons: Record<string, number> = {};
      for (const { status, reason } of record.entries) {
        counts[status]++;
        totalEntries[status]++;
        if (status !== "blocked") continue;
        add(blockedReasons, reason ?? "unclassified");
        add(totalReasons, reason ?? "unclassified");
      }
      entries = { ...counts, blockedReasons };
      entriesSeen = true;
    }
    const read = await readJson(
      event,
      "read-paths",
      READ_PATHS_FILE,
      readPathsSchema,
    );
    const files =
      read === undefined ? null : await filesOf(event.snapshotDigest);
    if (read !== undefined && files !== null) {
      const union = readBySnapshot.get(event.snapshotDigest) ?? new Set();
      read.forEach((path) => union.add(path));
      readBySnapshot.set(event.snapshotDigest, union);
    }
    runs.push({
      runId: event.runId,
      runKind: runKinds.get(event.runId) ?? "explore",
      entries,
      sourceFiles: files === null ? "unavailable" : ratio(read!, files.all),
      indexedFiles:
        files === null ? "unavailable" : ratio(read!, files.indexed),
      missingEdges: edgesByRun.get(event.runId) ?? edges(),
    });
  }
  // A Trial's runs share one Snapshot; the total counts each file once per Snapshot.
  const sum = async (pick: (sets: SourceFileSets) => readonly string[]) => {
    if (readBySnapshot.size === 0) return "unavailable" as const;
    const total = { covered: 0, total: 0 };
    for (const [digest, read] of readBySnapshot) {
      const part = ratio(read, pick((await filesOf(digest))!));
      total.covered += part.covered;
      total.total += part.total;
    }
    return total;
  };
  return {
    campaignId: options.campaignId,
    runs,
    total: {
      entries: entriesSeen
        ? { ...totalEntries, blockedReasons: totalReasons }
        : "unavailable",
      sourceFiles: await sum((sets) => sets.all),
      indexedFiles: await sum((sets) => sets.indexed),
      missingEdges: totalEdges,
    },
  };
}
