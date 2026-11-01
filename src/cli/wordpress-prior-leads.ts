import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import {
  priorLeadsSection,
  type PriorLeadsConfiguration,
} from "../discovery/index.js";
import { canonicalDigest } from "../infrastructure/canonical-json.js";
import type { LedgerEventV1 } from "../ledger/index.js";
import { readWordPressLead } from "../profiles/wordpress/discovery/lead.js";
import {
  wordPressPriorLead,
  wordPressPromptAdmitsPriorLeads,
} from "../profiles/wordpress/discovery/prior-leads.js";
import {
  wordPressTargetSelectionSchema,
  type WordPressTargetSelection,
} from "../profiles/wordpress/selection/index.js";
import { targetSelectionId } from "../selection/index.js";
import type { CliState } from "./index.js";
import {
  MAX_PRIOR_LEADS_PER_SNAPSHOT,
  type WordPressPriorLeadsTarget,
} from "./wordpress-session.js";

/** One named Snapshot of a second Trial, ready to run (ADR 0044). */
export type ResolvedPriorLeads = {
  readonly snapshotDigest: string;
  /** The selection recorded with the Snapshot; the Snapshot is not frozen again. */
  readonly target: WordPressTargetSelection;
  /** The generated `## Prior leads` section. */
  readonly section: string;
  /** What `discovery-run-started.configuration.priorLeads` records. */
  readonly configuration: PriorLeadsConfiguration;
};

/** Why a named second Trial does not start; the campaign stops before any Lab. */
export class PriorLeadsRefusal extends Error {
  constructor(
    readonly reason: string,
    detail: string,
  ) {
    super(`discovery.priorLeads refused (${reason}): ${detail}`);
  }
}

type StartedEvent = Extract<LedgerEventV1, { type: "discovery-run-started" }>;

/**
 * ADR 0044: a Lead is passed on only when the Trial that reported it had
 * inputs inside invariant 1 — no ADR 0012 catalog and a `wp2shell-bounty`
 * objective from v8 on.
 */
export function priorLeadSourceRefusal(
  started: Pick<StartedEvent, "history"> & {
    readonly configuration: Pick<
      StartedEvent["configuration"],
      "promptVariant"
    >;
  },
): "prior-lead-history-catalog" | "prior-lead-prompt-before-v8" | undefined {
  if (started.history.mode !== "none") return "prior-lead-history-catalog";
  if (!wordPressPromptAdmitsPriorLeads(started.configuration.promptVariant))
    return "prior-lead-prompt-before-v8";
  return undefined;
}

/** The fields of `scripts/lead-groups.mjs --json` this reader needs. */
const leadGroupsFileSchema = z.object({
  summary: z.object({ rule: z.string() }),
  groups: z.array(
    z.object({
      snapshotDigest: z.string(),
      representative: z.object({ kind: z.string(), id: z.string() }),
    }),
  ),
});

/** The Lead ids a target names, read from its groups file when it gives one. */
async function namedLeadIds(
  target: WordPressPriorLeadsTarget,
): Promise<readonly string[]> {
  if (target.leadIds !== undefined) return target.leadIds;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(target.groupsPath!, "utf8")) as unknown;
  } catch {
    value = undefined;
  }
  const parsed = leadGroupsFileSchema.safeParse(value);
  if (!parsed.success)
    throw new PriorLeadsRefusal(
      "prior-leads-groups-unreadable",
      `${target.groupsPath} is not lead-groups.mjs --json output`,
    );
  if (parsed.data.summary.rule !== "pair")
    throw new PriorLeadsRefusal(
      "prior-leads-groups-rule",
      `${target.groupsPath} was grouped with --rule ${parsed.data.summary.rule}; ADR 0044 uses pair`,
    );
  const ids = [
    ...new Set(
      parsed.data.groups
        .filter(
          (group) =>
            group.snapshotDigest === target.snapshotDigest &&
            group.representative.kind === "lead",
        )
        .map((group) => group.representative.id),
    ),
  ];
  if (ids.length === 0)
    throw new PriorLeadsRefusal(
      "prior-leads-empty",
      `${target.groupsPath} has no Lead-represented group of ${target.snapshotDigest}`,
    );
  if (ids.length > MAX_PRIOR_LEADS_PER_SNAPSHOT)
    throw new PriorLeadsRefusal(
      "prior-leads-too-many",
      `${target.groupsPath} has ${ids.length} Lead-represented groups of ${target.snapshotDigest}; name at most ${MAX_PRIOR_LEADS_PER_SNAPSHOT} with leadIds`,
    );
  return ids;
}

/**
 * Resolve every named Snapshot of `discovery.priorLeads` from the ledger and
 * Private Evidence (ADR 0044), refusing before any Lab when a Lead is unknown,
 * on another Snapshot, unreadable, or from a Trial outside invariant 1, when
 * the Snapshot was never frozen, or when another campaign already ran this
 * Snapshot with the same representatives. `only` resolves one Snapshot (a
 * resumed segment). Nothing here chooses Leads; the configuration names them.
 */
export async function resolveWordPressPriorLeads(
  state: Pick<CliState, "ledger" | "store">,
  targets: readonly WordPressPriorLeadsTarget[],
  campaignId: string,
  only?: string,
): Promise<readonly ResolvedPriorLeads[]> {
  const recorded = new Map<
    string,
    Extract<LedgerEventV1, { type: "lead-recorded" }>
  >();
  for (const { event } of state.ledger.readAll({ type: "lead-recorded" }))
    if (event.type === "lead-recorded" && !recorded.has(event.leadId))
      recorded.set(event.leadId, event);
  const starts = state.ledger
    .readAll({ type: "discovery-run-started" })
    .flatMap(({ event }) =>
      event.type === "discovery-run-started" ? [event] : [],
    );
  const resolved: ResolvedPriorLeads[] = [];
  for (const target of targets) {
    if (only !== undefined && target.snapshotDigest !== only) continue;
    const leadIds = await namedLeadIds(target);
    const leads = [];
    let origin: string | undefined;
    for (const leadId of leadIds) {
      const event = recorded.get(leadId);
      if (event === undefined)
        throw new PriorLeadsRefusal(
          "prior-lead-unknown",
          `${leadId} is not a recorded Lead`,
        );
      if (event.snapshotDigest !== target.snapshotDigest)
        throw new PriorLeadsRefusal(
          "prior-lead-snapshot-differs",
          `${leadId} was reported on ${event.snapshotDigest}, not ${target.snapshotDigest}`,
        );
      // The run that recorded it, or another run of the same Trial (a child's
      // report); every run of a Trial has the same objective and history.
      const inCampaign = starts.filter(
        (run) => run.campaignId === event.campaignId,
      );
      const started =
        inCampaign.find((run) => run.runId === event.runId) ??
        inCampaign.find((run) => run.trialId === event.trialId);
      if (started === undefined)
        throw new PriorLeadsRefusal(
          "prior-lead-run-unrecorded",
          `${leadId} has no recorded run ${event.runId}`,
        );
      const refusal = priorLeadSourceRefusal(started);
      if (refusal !== undefined)
        throw new PriorLeadsRefusal(
          refusal,
          `${leadId} came from ${started.configuration.promptVariant} with history ${started.history.mode}`,
        );
      const artifact = event.artifacts.find(({ kind }) => kind === "lead");
      const file =
        artifact === undefined
          ? undefined
          : await state.store.readFile(
              artifact.digest,
              "lead.json",
              1024 * 1024,
            );
      let lead;
      try {
        if (file?.status !== "resolved") throw new Error("unavailable");
        lead = readWordPressLead(JSON.parse(file.bytes.toString("utf8")));
      } catch {
        throw new PriorLeadsRefusal(
          "prior-lead-unreadable",
          `${leadId} has no readable Lead in Private Evidence`,
        );
      }
      if (
        lead.leadId !== leadId ||
        lead.snapshotDigest !== target.snapshotDigest
      )
        throw new PriorLeadsRefusal(
          "prior-lead-snapshot-differs",
          `${leadId} in Private Evidence does not match the ledger`,
        );
      origin ??= event.campaignId;
      leads.push(wordPressPriorLead(lead));
    }
    const representativesDigest = canonicalDigest({
      snapshotDigest: target.snapshotDigest,
      leadIds: [...leadIds].sort(),
    });
    const earlier = starts.find(
      (run) =>
        run.campaignId !== campaignId &&
        run.snapshotDigest === target.snapshotDigest &&
        run.configuration.priorLeads?.representativesDigest ===
          representativesDigest,
    );
    if (earlier !== undefined)
      throw new PriorLeadsRefusal(
        "prior-leads-already-run",
        `campaign ${earlier.campaignId} already ran ${target.snapshotDigest} with these representatives`,
      );
    resolved.push({
      snapshotDigest: target.snapshotDigest,
      target: await recordedTarget(state, origin!, target.snapshotDigest),
      ...sectionOf(leads, leadIds, representativesDigest),
    });
  }
  // One target version gets one second Trial, whichever of its Snapshots is named.
  const versions = resolved.map(({ target }) => targetSelectionId(target));
  const repeated = versions.find(
    (version, index) => versions.indexOf(version) !== index,
  );
  if (repeated !== undefined)
    throw new PriorLeadsRefusal(
      "prior-leads-target-repeated",
      `${repeated} is named with more than one Snapshot`,
    );
  return resolved;
}

function sectionOf(
  leads: Parameters<typeof priorLeadsSection>[0],
  leadIds: readonly string[],
  representativesDigest: string,
): Pick<ResolvedPriorLeads, "section" | "configuration"> {
  const { text, gapWithheld } = priorLeadsSection(leads);
  return {
    section: text,
    configuration: {
      representatives: leadIds.length,
      representativesDigest,
      leadIds: [...leadIds],
      gapWithheld,
      sectionDigest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
    },
  };
}

/** The selection and freeze the Lead's campaign recorded for the Snapshot. */
async function recordedTarget(
  state: Pick<CliState, "ledger" | "store">,
  campaignId: string,
  snapshotDigest: string,
): Promise<WordPressTargetSelection> {
  const unavailable = (detail: string) =>
    new PriorLeadsRefusal("prior-leads-snapshot-unavailable", detail);
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
  const target = wordPressTargetSelectionSchema.parse(
    JSON.parse(file.bytes.toString("utf8")),
  );
  if (targetSelectionId(target) !== selected.selectionId)
    throw unavailable(
      `the selection of ${snapshotDigest} does not match the ledger`,
    );
  return target;
}
