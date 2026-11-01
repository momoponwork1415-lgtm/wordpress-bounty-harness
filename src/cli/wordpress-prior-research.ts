import { createHash } from "node:crypto";

import {
  MAX_PRIOR_RESEARCH_FILE_BYTES,
  PRIOR_RESEARCH_FILE_NAMES,
  priorResearchPath,
  priorResearchSection,
  researchArchiveSchema,
  type PriorResearchFileName,
  type ProviderAttachmentStore,
} from "../discovery/index.js";
import type { LedgerEventV1 } from "../ledger/index.js";
import { wordPressTargetSelectionSchema } from "../profiles/wordpress/selection/index.js";
import type { CliState } from "./index.js";
import { priorLeadSourceRefusal } from "./wordpress-prior-leads.js";

type StartedEvent = Extract<LedgerEventV1, { type: "discovery-run-started" }>;
type PriorResearchConfiguration = NonNullable<
  StartedEvent["configuration"]["priorResearch"]
>;
type PassedConfiguration = Extract<
  PriorResearchConfiguration,
  { sourceRunId: string }
>;

/** What a Trial receives under `## Prior research` (ADR 0048), or why nothing. */
export type ResolvedPriorResearch =
  | {
      readonly status: "passed";
      readonly section: string;
      /** Files for the sandbox, relative to `/workspace/research`. */
      readonly files: readonly {
        readonly path: string;
        readonly contentBase64: string;
      }[];
      readonly configuration: PassedConfiguration;
    }
  | {
      readonly status: "none";
      readonly configuration: Extract<
        PriorResearchConfiguration,
        { none: string }
      >;
    };

export interface PriorResearchQuery {
  readonly targetId: string;
  /** The Snapshot this Trial reads; a Trial on it is not an earlier Trial. */
  readonly snapshotDigest: string;
  readonly currentVersion: string;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * ADR 0048: the latest earlier Trial on another Snapshot of the same target
 * whose notes were sealed and whose inputs were inside invariant 1, and from
 * its archive the whole `recon-map.md` and `lab-setup.md` when each is
 * complete, UTF-8 and within size. Nothing here reads the files' meaning.
 */
export async function resolveWordPressPriorResearch(
  state: Pick<CliState, "ledger" | "store">,
  attachments: Pick<ProviderAttachmentStore, "readByDigest">,
  query: PriorResearchQuery,
): Promise<ResolvedPriorResearch> {
  const prefix = `${query.targetId}@`;
  const selections = new Map<
    string,
    Extract<LedgerEventV1, { type: "target-selected" }>
  >();
  for (const { event } of state.ledger.readAll({ type: "target-selected" }))
    if (
      event.type === "target-selected" &&
      event.selectionId.startsWith(prefix) &&
      event.snapshotDigest !== query.snapshotDigest
    )
      selections.set(`${event.campaignId}\n${event.snapshotDigest}`, event);
  if (selections.size === 0) return none("no-earlier-trial");
  const starts = new Map<string, StartedEvent>();
  for (const { event } of state.ledger.readAll({
    type: "discovery-run-started",
  }))
    if (
      event.type === "discovery-run-started" &&
      selections.has(`${event.campaignId}\n${event.snapshotDigest}`)
    )
      starts.set(event.runId, event);
  if (starts.size === 0) return none("no-earlier-trial");
  // Latest first: the ledger is append-only, so the last finish is the newest.
  const candidates: {
    readonly started: StartedEvent;
    readonly digest: string;
  }[] = [];
  for (const { event } of state.ledger.readAll({
    type: "discovery-run-finished",
  })) {
    if (event.type !== "discovery-run-finished") continue;
    const started = starts.get(event.runId);
    if (started === undefined || event.researchArtifact === undefined) continue;
    if (priorLeadSourceRefusal(started) !== undefined) continue;
    candidates.push({ started, digest: event.researchArtifact.digest });
  }
  if (candidates.length === 0) return none("no-earlier-trial");
  for (const candidate of candidates.reverse()) {
    const selection = selections.get(
      `${candidate.started.campaignId}\n${candidate.started.snapshotDigest}`,
    )!;
    const version = await recordedVersion(state, selection, query.targetId);
    if (version === undefined) continue;
    const files = await archivedFiles(attachments, candidate.digest);
    if (files.length === 0) return none("no-files");
    const section = priorResearchSection({
      priorVersion: version,
      currentVersion: query.currentVersion,
      files: files.map(({ name, content }) => ({
        name,
        bytes: content.byteLength,
      })),
    });
    return {
      status: "passed",
      section,
      files: files.map(({ name, content }) => ({
        path: priorResearchPath(name),
        contentBase64: content.toString("base64"),
      })),
      configuration: {
        sourceRunId: candidate.started.runId,
        sourceSnapshotDigest: candidate.started.snapshotDigest,
        sourceVersion: version,
        files: files.map(({ name, content }) => ({
          name,
          digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
          bytes: content.byteLength,
        })),
        sectionDigest: `sha256:${createHash("sha256").update(section).digest("hex")}`,
      },
    };
  }
  return none("no-earlier-trial");
}

/**
 * A resumed segment rebuilds the section its Trial recorded from the same
 * source run (ADR 0048); the caller compares the section digest.
 */
export async function rebuildWordPressPriorResearch(
  state: Pick<CliState, "ledger" | "store">,
  attachments: Pick<ProviderAttachmentStore, "readByDigest">,
  recorded: PassedConfiguration,
  currentVersion: string,
): Promise<string | undefined> {
  const finished = state.ledger
    .readAll({ type: "discovery-run-finished" })
    .map(({ event }) => event)
    .find(
      (event) =>
        event.type === "discovery-run-finished" &&
        event.runId === recorded.sourceRunId,
    );
  if (
    finished?.type !== "discovery-run-finished" ||
    finished.researchArtifact === undefined
  )
    return undefined;
  const files = await archivedFiles(
    attachments,
    finished.researchArtifact.digest,
  );
  if (files.length === 0) return undefined;
  return priorResearchSection({
    priorVersion: recorded.sourceVersion,
    currentVersion,
    files: files.map(({ name, content }) => ({
      name,
      bytes: content.byteLength,
    })),
  });
}

function none(
  reason: Extract<PriorResearchConfiguration, { none: string }>["none"],
): ResolvedPriorResearch {
  return { status: "none", configuration: { none: reason } };
}

/** The version the selection record names, after its target id is confirmed. */
async function recordedVersion(
  state: Pick<CliState, "store">,
  selected: Extract<LedgerEventV1, { type: "target-selected" }>,
  targetId: string,
): Promise<string | undefined> {
  const ref = selected.artifacts.find(
    ({ kind }) => kind === "target-selection",
  );
  if (ref === undefined) return undefined;
  const file = await state.store.readFile(
    ref.digest,
    "target-selection.json",
    1024 * 1024,
  );
  if (file.status !== "resolved") return undefined;
  try {
    const target = wordPressTargetSelectionSchema.parse(
      JSON.parse(file.bytes.toString("utf8")),
    );
    return target.targetId === targetId ? target.version : undefined;
  } catch {
    return undefined;
  }
}

/** The two named files at the archive root, each whole, non-empty, UTF-8 and bounded. */
async function archivedFiles(
  attachments: Pick<ProviderAttachmentStore, "readByDigest">,
  digest: string,
): Promise<
  { readonly name: PriorResearchFileName; readonly content: Buffer }[]
> {
  const stored = await attachments.readByDigest("research", digest);
  if (stored.status !== "resolved") return [];
  const parsed = researchArchiveSchema.safeParse(
    (() => {
      try {
        return JSON.parse(stored.bytes.toString("utf8")) as unknown;
      } catch {
        return undefined;
      }
    })(),
  );
  if (!parsed.success) return [];
  const files: { name: PriorResearchFileName; content: Buffer }[] = [];
  for (const name of PRIOR_RESEARCH_FILE_NAMES) {
    const entry = parsed.data.entries.find(
      (candidate) => candidate.path === name && candidate.type === "file",
    );
    if (entry === undefined || entry.type !== "file" || entry.truncated)
      continue;
    const content = Buffer.from(entry.contentBase64, "base64");
    if (
      content.byteLength === 0 ||
      content.byteLength > MAX_PRIOR_RESEARCH_FILE_BYTES
    )
      continue;
    try {
      utf8.decode(content);
    } catch {
      continue;
    }
    files.push({ name, content });
  }
  return files;
}
