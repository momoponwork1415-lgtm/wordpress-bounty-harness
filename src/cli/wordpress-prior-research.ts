import { createHash } from "node:crypto";

import {
  MAX_PRIOR_RESEARCH_FILE_BYTES,
  PRIOR_RESEARCH_DIRECTORIES,
  PRIOR_RESEARCH_FILE_NAMES,
  PRIOR_RESEARCH_STORES_FILE,
  capPriorResearch,
  isPriorResearchName,
  priorResearchPath,
  priorResearchSection,
  researchArchiveSchema,
  type ProviderAttachmentStore,
} from "../discovery/index.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import type { LedgerEventV1 } from "../ledger/index.js";
import { EXPLORATION_LAB_RECORD_FILE } from "../profiles/wordpress/lab/exploration-lab.js";
import {
  RESEARCH_STORES_FILE,
  buildResearchStores,
  researchStoresBytes,
  researchStoresSchema,
} from "../profiles/wordpress/lab/research-stores.js";
import { wordPressTargetSelectionSchema } from "../profiles/wordpress/selection/index.js";
import type { CliState } from "./index.js";

type StartedEvent = Extract<LedgerEventV1, { type: "discovery-run-started" }>;

/**
 * ADR 0048: a Trial's files are passed on only when its inputs were inside
 * invariant 1 — no ADR 0012 catalog and a `wp2shell-bounty` objective from
 * v8 on (no entry index, no fixed attack path).
 */
export function priorTrialInsideInvariantOne(
  started: Pick<StartedEvent, "history"> & {
    readonly configuration: Pick<
      StartedEvent["configuration"],
      "promptVariant"
    >;
  },
): boolean {
  if (started.history.mode !== "none") return false;
  const match = /^wp2shell-bounty-v(\d+)(?:-wide)?$/.exec(
    started.configuration.promptVariant,
  );
  return match !== null && Number(match[1]) >= 8;
}
type FinishedEvent = Extract<LedgerEventV1, { type: "discovery-run-finished" }>;
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

/**
 * Where the store table of a source Trial comes from: this state's sealed
 * `exploration-lab.json` (a local Trial, built at hand-over) or the
 * `research-stores` artifact `research import` built (an imported Trial).
 */
export type ResearchStoresSource = {
  readonly file:
    typeof EXPLORATION_LAB_RECORD_FILE | typeof RESEARCH_STORES_FILE;
  readonly digest: string;
};

/**
 * One ended Trial whose sealed notes a later Trial of the same target may
 * receive: a Root run of this ledger with `researchArtifact`, or a Trial of
 * another ledger `research import` admitted.
 */
export interface ResearchTrial {
  readonly runId: string;
  readonly campaignId: string;
  readonly snapshotDigest: string;
  readonly targetId: string;
  readonly version: string;
  readonly researchDigest: string;
  readonly explorationLabDigest?: string;
  readonly stores?: ResearchStoresSource;
  /** The Trial's finish, which orders candidates (latest first). */
  readonly finishedAt: string;
  /** The state directory (basename) the Trial was imported from; absent for this ledger's own. */
  readonly sourceState?: string;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const MAX_EXPLORATION_LAB_RECORD_BYTES = 48 * 1024 * 1024;

/**
 * This ledger's own ended Trials with sealed notes whose inputs were inside
 * invariant 1 (the same check as ADR 0044), with the version their selection
 * record names. `targetId` narrows the selections read; without it every
 * target's Trials are listed (`research import` reads another ledger so).
 */
export async function localResearchTrials(
  state: Pick<CliState, "ledger" | "store">,
  filter: { readonly targetId?: string } = {},
): Promise<readonly ResearchTrial[]> {
  const selections = new Map<
    string,
    Extract<LedgerEventV1, { type: "target-selected" }>
  >();
  for (const { event } of state.ledger.readAll({ type: "target-selected" }))
    if (
      event.type === "target-selected" &&
      (filter.targetId === undefined ||
        event.selectionId.startsWith(`${filter.targetId}@`))
    )
      selections.set(`${event.campaignId}\n${event.snapshotDigest}`, event);
  if (selections.size === 0) return [];
  const starts = new Map<string, StartedEvent>();
  for (const { event } of state.ledger.readAll({
    type: "discovery-run-started",
  }))
    if (
      event.type === "discovery-run-started" &&
      selections.has(`${event.campaignId}\n${event.snapshotDigest}`)
    )
      starts.set(event.runId, event);
  if (starts.size === 0) return [];
  const trials: ResearchTrial[] = [];
  const versions = new Map<
    string,
    Promise<{ targetId: string; version: string } | undefined>
  >();
  for (const { event } of state.ledger.readAll({
    type: "discovery-run-finished",
  })) {
    if (event.type !== "discovery-run-finished") continue;
    const started = starts.get(event.runId);
    if (started === undefined || event.researchArtifact === undefined) continue;
    if (!priorTrialInsideInvariantOne(started)) continue;
    const key = `${started.campaignId}\n${started.snapshotDigest}`;
    const selection = selections.get(key)!;
    let version = versions.get(key);
    if (version === undefined) {
      version = recordedVersion(state, selection, filter.targetId);
      versions.set(key, version);
    }
    const resolved = await version;
    if (resolved === undefined) continue;
    const explorationLabDigest = event.artifacts.find(
      ({ kind }) => kind === "exploration-lab",
    )?.digest;
    trials.push({
      runId: event.runId,
      campaignId: event.campaignId,
      snapshotDigest: event.snapshotDigest,
      targetId: resolved.targetId,
      version: resolved.version,
      researchDigest: event.researchArtifact.digest,
      ...(explorationLabDigest === undefined
        ? {}
        : {
            explorationLabDigest,
            stores: {
              file: EXPLORATION_LAB_RECORD_FILE,
              digest: explorationLabDigest,
            },
          }),
      finishedAt: event.occurredAt,
    });
  }
  return trials;
}

/** The Trials of other ledgers `research import` admitted into this one (ADR 0049 D). */
export function importedResearchTrials(
  state: Pick<CliState, "ledger">,
  filter: { readonly targetId?: string } = {},
): readonly ResearchTrial[] {
  const trials: ResearchTrial[] = [];
  for (const { event } of state.ledger.readAll({ type: "research-imported" })) {
    if (event.type !== "research-imported") continue;
    if (filter.targetId !== undefined && event.targetId !== filter.targetId)
      continue;
    const stores = event.artifacts.find(
      ({ kind }) => kind === "research-stores",
    )?.digest;
    trials.push({
      runId: event.fromRunId,
      campaignId: event.fromCampaignId,
      snapshotDigest: event.snapshotDigest,
      targetId: event.targetId,
      version: event.targetVersion,
      researchDigest: event.researchDigest,
      ...(event.explorationLabDigest === undefined
        ? {}
        : { explorationLabDigest: event.explorationLabDigest }),
      ...(stores === undefined
        ? {}
        : { stores: { file: RESEARCH_STORES_FILE, digest: stores } }),
      finishedAt: event.sourceFinishedAt,
      sourceState: event.fromState,
    });
  }
  return trials;
}

/**
 * ADR 0048 / ADR 0049 D: the latest earlier Trial on another Snapshot of the
 * same target (this ledger's own or imported) whose notes were sealed and
 * whose inputs were inside invariant 1, and from its archive the whole map,
 * setup record, registry, assumption tables and walks, plus the store table
 * built from its Lab lookups, each complete, UTF-8 and within size, together
 * within the total cap. Nothing here reads the files' meaning.
 */
export async function resolveWordPressPriorResearch(
  state: Pick<CliState, "ledger" | "store">,
  attachments: Pick<ProviderAttachmentStore, "readByDigest">,
  query: PriorResearchQuery,
): Promise<ResolvedPriorResearch> {
  const local = await localResearchTrials(state, { targetId: query.targetId });
  const imported = importedResearchTrials(state, { targetId: query.targetId });
  // Latest finish first. At an equal instant this ledger's own Trial wins
  // over an imported one, and among its own the later-appended wins.
  const ordered = [
    ...local.map((trial, index) => ({ trial, order: index })),
    ...imported.map((trial, index) => ({ trial, order: -1 - index })),
  ]
    .filter(({ trial }) => trial.snapshotDigest !== query.snapshotDigest)
    .sort(
      (a, b) =>
        (a.trial.finishedAt < b.trial.finishedAt
          ? 1
          : a.trial.finishedAt > b.trial.finishedAt
            ? -1
            : 0) || b.order - a.order,
    )
    .map(({ trial }) => trial);
  if (ordered.length === 0) return none("no-earlier-trial");
  for (const trial of ordered) {
    const collected = await collectPriorResearch(state, attachments, trial);
    if (collected === undefined) return none("no-files");
    const section = priorResearchSection({
      priorVersion: trial.version,
      currentVersion: query.currentVersion,
      files: collected.kept.map(({ name, content }) => ({
        name,
        bytes: content.byteLength,
      })),
      withheld: collected.withheld.map(({ name }) => name),
    });
    return {
      status: "passed",
      section,
      files: collected.kept.map(({ name, content }) => ({
        path: priorResearchPath(name),
        contentBase64: content.toString("base64"),
      })),
      configuration: {
        sourceRunId: trial.runId,
        ...(trial.sourceState === undefined
          ? {}
          : { sourceState: trial.sourceState }),
        sourceSnapshotDigest: trial.snapshotDigest,
        sourceVersion: trial.version,
        files: collected.kept.map(({ name, content }) => ({
          name,
          digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
          bytes: content.byteLength,
        })),
        ...(collected.withheld.length === 0
          ? {}
          : { withheld: collected.withheld.map(({ name }) => name) }),
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
  const source =
    recorded.sourceState === undefined
      ? localSource(state, recorded.sourceRunId)
      : importedResearchTrials(state).find(
          (trial) =>
            trial.sourceState === recorded.sourceState &&
            trial.runId === recorded.sourceRunId,
        );
  if (source === undefined) return undefined;
  const collected = await collectPriorResearch(state, attachments, source);
  if (collected === undefined) return undefined;
  return priorResearchSection({
    priorVersion: recorded.sourceVersion,
    currentVersion,
    files: collected.kept.map(({ name, content }) => ({
      name,
      bytes: content.byteLength,
    })),
    withheld: collected.withheld.map(({ name }) => name),
  });
}

/** The archive and Lab record this ledger's own finished run left, by run id. */
function localSource(
  state: Pick<CliState, "ledger">,
  runId: string,
): Pick<ResearchTrial, "researchDigest" | "stores"> | undefined {
  const finished = state.ledger
    .readAll({ type: "discovery-run-finished" })
    .map(({ event }) => event)
    .find(
      (event): event is FinishedEvent =>
        event.type === "discovery-run-finished" && event.runId === runId,
    );
  if (finished?.researchArtifact === undefined) return undefined;
  const explorationLabDigest = finished.artifacts.find(
    ({ kind }) => kind === "exploration-lab",
  )?.digest;
  return {
    researchDigest: finished.researchArtifact.digest,
    ...(explorationLabDigest === undefined
      ? {}
      : {
          stores: {
            file: EXPLORATION_LAB_RECORD_FILE,
            digest: explorationLabDigest,
          },
        }),
  };
}

function none(
  reason: Extract<PriorResearchConfiguration, { none: string }>["none"],
): ResolvedPriorResearch {
  return { status: "none", configuration: { none: reason } };
}

/** The target and version the selection record names; `targetId`, when given, must match. */
async function recordedVersion(
  state: Pick<CliState, "store">,
  selected: Extract<LedgerEventV1, { type: "target-selected" }>,
  targetId: string | undefined,
): Promise<{ targetId: string; version: string } | undefined> {
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
    return targetId === undefined || target.targetId === targetId
      ? { targetId: target.targetId, version: target.version }
      : undefined;
  } catch {
    return undefined;
  }
}

type CollectedFile = { readonly name: string; readonly content: Buffer };

/**
 * The source Trial's files within the per-file bounds, plus its store table,
 * then the total cap; undefined when nothing is left to pass.
 */
async function collectPriorResearch(
  state: Pick<CliState, "store">,
  attachments: Pick<ProviderAttachmentStore, "readByDigest">,
  source: Pick<ResearchTrial, "researchDigest" | "stores">,
): Promise<
  | {
      readonly kept: readonly CollectedFile[];
      readonly withheld: readonly CollectedFile[];
    }
  | undefined
> {
  const files = await archivedFiles(attachments, source.researchDigest);
  if (source.stores !== undefined) {
    const stores = await researchStoresFile(state.store, source.stores);
    if (stores !== undefined) files.push(stores);
  }
  if (files.length === 0) return undefined;
  const capped = capPriorResearch(
    files.map((file) => ({ ...file, bytes: file.content.byteLength })),
  );
  return capped.kept.length === 0 ? undefined : capped;
}

/**
 * The store table as `stores.json`: built here from this state's sealed Lab
 * record, or read back from the artifact `research import` built. Absent
 * when the record is unavailable or answered no `find` / `trace`.
 */
export async function researchStoresFile(
  store: Pick<PrivateArtifactStore, "readFile">,
  source: ResearchStoresSource,
): Promise<CollectedFile | undefined> {
  const file = await store.readFile(
    source.digest,
    source.file,
    MAX_EXPLORATION_LAB_RECORD_BYTES,
  );
  if (file.status !== "resolved") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.bytes.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
  const stores =
    source.file === RESEARCH_STORES_FILE
      ? researchStoresSchema.safeParse(parsed).data
      : buildResearchStores(parsed);
  if (stores === undefined) return undefined;
  const content = researchStoresBytes(stores);
  if (content.byteLength > MAX_PRIOR_RESEARCH_FILE_BYTES) return undefined;
  return { name: PRIOR_RESEARCH_STORES_FILE, content };
}

/**
 * The admitted files of the archive: the root names and the `.md` files one
 * level under the listed directories, each whole, non-empty, UTF-8 and bounded.
 */
async function archivedFiles(
  attachments: Pick<ProviderAttachmentStore, "readByDigest">,
  digest: string,
): Promise<CollectedFile[]> {
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
  const files: CollectedFile[] = [];
  const seen = new Set<string>();
  for (const entry of parsed.data.entries) {
    if (entry.type !== "file" || entry.truncated) continue;
    const name = entry.path;
    const admitted =
      (PRIOR_RESEARCH_FILE_NAMES as readonly string[]).includes(name) ||
      PRIOR_RESEARCH_DIRECTORIES.some((directory) =>
        name.startsWith(`${directory}/`),
      );
    if (!admitted || !isPriorResearchName(name) || seen.has(name)) continue;
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
    seen.add(name);
    files.push({ name, content });
  }
  return files;
}
