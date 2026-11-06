import {
  CONTINUATION_FILE,
  latestSegment,
  priorResearchPath,
  type ContinuationConfiguration,
  type ProviderAttachmentStore,
} from "../discovery/index.js";
import { canonicalDigest } from "../infrastructure/canonical-json.js";
import type { LedgerEventV1 } from "../ledger/index.js";
import { targetSelectionId } from "../selection/index.js";
import {
  wordPressTargetSelectionSchema,
  type WordPressTargetSelection,
} from "../profiles/wordpress/selection/index.js";
import { continuableFinish, type ContinuationTarget } from "./continuous.js";
import type { CliState } from "./index.js";
import {
  resolveWordPressPriorResearch,
  type ResolvedPriorResearch,
} from "./wordpress-prior-research.js";

type StartedEvent = Extract<LedgerEventV1, { type: "discovery-run-started" }>;
type FinishedEvent = Extract<LedgerEventV1, { type: "discovery-run-finished" }>;

/** ADR 0052: one continuation Trial ready to run, resolved before any Lab. */
export type ResolvedContinuation = {
  readonly snapshotDigest: string;
  readonly target: WordPressTargetSelection;
  readonly configuration: ContinuationConfiguration;
  readonly priorResearch: Extract<ResolvedPriorResearch, { status: "passed" }>;
};

class ContinuationRefusal extends Error {
  constructor(
    readonly reason: string,
    detail: string,
  ) {
    super(detail);
  }
}

/** The identity of `continuation-scheduled`: one per campaign and Snapshot. */
function scheduledIdentity(campaignId: string, snapshotDigest: string): string {
  return `continuation-scheduled-${canonicalDigest({ campaignId, snapshotDigest }).slice(7, 39)}`;
}

/**
 * ADR 0052: the continuation campaign's Trials. Each Snapshot gets its
 * `continuation-scheduled` before it resolves, so a refused or failed one is
 * never scheduled again; then its selection record (from the campaign of the
 * continued run) and the continued run's notes under `## Prior research`,
 * which must include `continuation.json`. A refusal is recorded as
 * `target-skipped` (`continuation-refused`), logged and left out.
 */
export async function resolveWordPressContinuation(
  state: Pick<CliState, "ledger" | "store" | "clock" | "newId">,
  attachments: Pick<ProviderAttachmentStore, "readByDigest">,
  campaignId: string,
  continuation: {
    readonly targets: readonly ContinuationTarget[];
    log(line: string): void;
  },
): Promise<readonly ResolvedContinuation[]> {
  const scheduled = new Set(
    state.ledger
      .readAll({ campaignId, type: "continuation-scheduled" })
      .map(({ event }) => event.snapshotDigest),
  );
  const refused = new Set(
    state.ledger
      .readAll({ campaignId, type: "target-skipped" })
      .flatMap(({ event }) =>
        event.type === "target-skipped" &&
        event.reason === "continuation-refused"
          ? [event.snapshotDigest]
          : [],
      ),
  );
  const resolved: ResolvedContinuation[] = [];
  for (const target of continuation.targets) {
    const { snapshotDigest } = target;
    if (refused.has(snapshotDigest)) continue;
    if (!scheduled.has(snapshotDigest)) {
      const appended = await state.ledger.append({
        schemaVersion: 1,
        identity: scheduledIdentity(campaignId, snapshotDigest),
        campaignId,
        snapshotDigest,
        occurredAt: state.clock().toISOString(),
        type: "continuation-scheduled",
        ofRunId: target.ofRunId,
        ofCampaignId: target.ofCampaignId,
        ordinal: target.ordinal,
        openRouteCount: target.openRouteCount,
        ...(target.manual === true ? { manual: true } : {}),
      });
      if (appended.status === "conflict")
        throw new Error(
          `Continuation schedule of ${snapshotDigest} conflicted`,
        );
      scheduled.add(snapshotDigest);
    }
    try {
      const selection = await recordedTarget(
        state,
        target.ofCampaignId,
        snapshotDigest,
      );
      if (targetSelectionId(selection) !== target.selectionId)
        throw new ContinuationRefusal(
          "continuation-snapshot-unavailable",
          `the selection of ${snapshotDigest} does not match ${target.selectionId}`,
        );
      const priorResearch = await resolveWordPressPriorResearch(
        state,
        attachments,
        {
          targetId: selection.targetId,
          snapshotDigest,
          currentVersion: selection.version,
          continuationOf: target.ofRunId,
        },
      );
      if (
        priorResearch.status !== "passed" ||
        !priorResearch.files.some(
          ({ path }) => path === priorResearchPath(CONTINUATION_FILE),
        )
      )
        throw new ContinuationRefusal(
          "continuation-file-unavailable",
          `run ${target.ofRunId} left no passable ${CONTINUATION_FILE}`,
        );
      resolved.push({
        snapshotDigest,
        target: selection,
        configuration: {
          of: target.ofRunId,
          ordinal: target.ordinal,
          openRouteCount: target.openRouteCount,
          passedIdDigests: [...target.passedIdDigests],
        },
        priorResearch,
      });
    } catch (error) {
      if (!(error instanceof ContinuationRefusal)) throw error;
      continuation.log(
        `continuation refused campaign=${campaignId} snapshot=${snapshotDigest} of=${target.ofRunId} reason=${error.reason}`,
      );
      await state.ledger.append({
        schemaVersion: 1,
        identity: `target-skipped-${state.newId()}`,
        campaignId,
        snapshotDigest,
        occurredAt: state.clock().toISOString(),
        type: "target-skipped",
        selectionId: target.selectionId,
        stage: "discovery",
        reason: "continuation-refused",
        reasonDetail: error.reason,
      });
    }
  }
  return resolved;
}

/**
 * ADR 0052, `campaign continue --run`: the continuation of a named run. Its
 * Trial's latest segment must have sealed a valid `continuation.json` with
 * open routes; the chain cap and the progress rule do not apply.
 */
export function namedContinuationTarget(
  state: Pick<CliState, "ledger">,
  runId: string,
):
  | {
      readonly status: "refused";
      readonly reason: string;
      readonly detail?: string;
    }
  | { readonly status: "ok"; readonly target: ContinuationTarget } {
  const named = state.ledger
    .readAll({ type: "discovery-run-started" })
    .map(({ event }) => event)
    .find(
      (event): event is StartedEvent =>
        event.type === "discovery-run-started" && event.runId === runId,
    );
  if (named === undefined || (named.runKind ?? "explore") !== "explore")
    return { status: "refused", reason: "run-unknown" };
  const { campaignId, snapshotDigest } = named;
  const starts = state.ledger
    .readAll({ campaignId, type: "discovery-run-started" })
    .map(({ event }) => event)
    .filter(
      (event): event is StartedEvent =>
        event.type === "discovery-run-started" &&
        (event.runKind ?? "explore") === "explore",
    );
  let head = named;
  const seen = new Set([head.runId]);
  while (head.resumesRun !== undefined && !seen.has(head.resumesRun)) {
    seen.add(head.resumesRun);
    const earlier = starts.find((event) => event.runId === head.resumesRun);
    if (earlier === undefined) break;
    head = earlier;
  }
  const latest = latestSegment(starts, head.runId);
  const finished = state.ledger
    .readAll({ campaignId, type: "discovery-run-finished" })
    .map(({ event }) => event)
    .find(
      (event): event is FinishedEvent =>
        event.type === "discovery-run-finished" && event.runId === latest,
    );
  if (!continuableFinish(finished))
    return {
      status: "refused",
      reason: "not-continuable",
      detail:
        finished === undefined
          ? `run ${latest} has not finished`
          : `run ${latest} left no valid continuation.json with open routes`,
    };
  const selected = state.ledger
    .readAll({ campaignId, type: "target-selected" })
    .map(({ event }) => event)
    .find(
      (event) =>
        event.type === "target-selected" &&
        event.snapshotDigest === snapshotDigest,
    );
  if (selected?.type !== "target-selected")
    return {
      status: "refused",
      reason: "continuation-snapshot-unavailable",
      detail: `campaign ${campaignId} has no selection of ${snapshotDigest}`,
    };
  return {
    status: "ok",
    target: {
      snapshotDigest,
      selectionId: selected.selectionId,
      ofRunId: latest,
      ofCampaignId: campaignId,
      ordinal: (head.configuration.continuation?.ordinal ?? 1) + 1,
      openRouteCount: finished.continuation.openRouteCount,
      passedIdDigests: [...finished.continuation.openRouteIdDigests],
      manual: true,
    },
  };
}

/** The selection record a campaign froze for a Snapshot, read back and checked. */
async function recordedTarget(
  state: Pick<CliState, "ledger" | "store">,
  campaignId: string,
  snapshotDigest: string,
): Promise<WordPressTargetSelection> {
  const unavailable = (detail: string) =>
    new ContinuationRefusal("continuation-snapshot-unavailable", detail);
  const selected = state.ledger
    .readAll({ campaignId, type: "target-selected" })
    .map(({ event }) => event)
    .find(
      (event) =>
        event.type === "target-selected" &&
        event.snapshotDigest === snapshotDigest,
    );
  const frozen = state.ledger
    .readAll({ campaignId, type: "snapshot-frozen" })
    .some(({ event }) => event.snapshotDigest === snapshotDigest);
  if (selected?.type !== "target-selected" || !frozen)
    throw unavailable(
      `campaign ${campaignId} has no recorded selection and freeze of ${snapshotDigest}`,
    );
  const ref = selected.artifacts.find(
    ({ kind }) => kind === "target-selection",
  );
  const file =
    ref === undefined
      ? undefined
      : await state.store.readFile(
          ref.digest,
          "target-selection.json",
          1024 * 1024,
        );
  if (file?.status !== "resolved")
    throw unavailable(`the selection of ${snapshotDigest} is unreadable`);
  let target: WordPressTargetSelection;
  try {
    target = wordPressTargetSelectionSchema.parse(
      JSON.parse(file.bytes.toString("utf8")),
    );
  } catch {
    throw unavailable(`the selection of ${snapshotDigest} is unreadable`);
  }
  if (targetSelectionId(target) !== selected.selectionId)
    throw unavailable(
      `the selection of ${snapshotDigest} does not match the ledger`,
    );
  return target;
}
