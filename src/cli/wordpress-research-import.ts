import { basename, resolve } from "node:path";

import type { ProviderAttachmentStore } from "../discovery/index.js";
import type { LedgerEventInput } from "../ledger/index.js";
import { RESEARCH_STORES_FILE } from "../profiles/wordpress/lab/research-stores.js";
import { wordPressOrgPluginIdentity } from "../profiles/wordpress/target-identity.js";
import type { CliState } from "./index.js";
import { openState } from "./state.js";
import {
  localResearchTrials,
  researchStoresFile,
} from "./wordpress-prior-research.js";

export interface ResearchImportInput {
  /** The other state directory, opened read-only; only its basename is recorded. */
  readonly fromStateDirectory: string;
  /** One plugin's Trials only; every target otherwise. */
  readonly slug?: string;
  log(line: string): void;
}

export interface ResearchImportSummary {
  readonly imported: number;
  /** Already imported earlier; nothing written. */
  readonly existing: number;
  /** Notes not in the shared attachment store, or the state names collide; nothing written. */
  readonly skipped: number;
}

const STATE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The identity of the event one source Trial gets; a second import finds it and writes nothing. */
export function researchImportIdentity(
  fromState: string,
  fromRunId: string,
): string {
  return `research-imported:${fromState}:${fromRunId}`;
}

/**
 * ADR 0049 D: admits another state's ended Trials with sealed notes as
 * prior-research candidates of this ledger. The other ledger and its Private
 * Evidence are opened read-only; the notes themselves stay in the shared
 * attachment store and are referenced by digest. For a source Trial that had
 * a Lab, the store table is built from its sealed record and kept as a
 * `research-stores` artifact of this state (keys dropped, no answers copied).
 */
export async function importWordPressResearch(
  state: Pick<CliState, "ledger" | "store" | "clock" | "stateDirectory">,
  attachments: Pick<ProviderAttachmentStore, "readByDigest">,
  input: ResearchImportInput,
): Promise<ResearchImportSummary> {
  const fromState = basename(input.fromStateDirectory);
  if (!STATE_NAME.test(fromState))
    throw new Error("The other state directory's name is not a plain name");
  if (resolve(input.fromStateDirectory) === resolve(state.stateDirectory))
    throw new Error("A ledger cannot import its own research");
  const other = await openState(
    input.fromStateDirectory,
    {},
    { readOnly: true },
  );
  const targetId =
    input.slug === undefined
      ? undefined
      : wordPressOrgPluginIdentity(input.slug);
  const trials = await localResearchTrials(
    other,
    targetId === undefined ? {} : { targetId },
  );
  const existing = new Set<string>();
  for (const { event } of state.ledger.readAll({ type: "research-imported" }))
    existing.add(event.identity);
  let imported = 0;
  let already = 0;
  let skipped = 0;
  for (const trial of trials) {
    const identity = researchImportIdentity(fromState, trial.runId);
    if (existing.has(identity)) {
      already += 1;
      continue;
    }
    const notes = await attachments.readByDigest(
      "research",
      trial.researchDigest,
    );
    if (notes.status !== "resolved") {
      input.log(
        `skipped ${trial.runId} (${trial.targetId} ${trial.version}): research attachment ${trial.researchDigest} is not in the shared work directory`,
      );
      skipped += 1;
      continue;
    }
    const stores =
      trial.stores === undefined
        ? undefined
        : await researchStoresFile(other.store, trial.stores);
    const storesDigest =
      stores === undefined
        ? undefined
        : await state.store.putFiles({
            [RESEARCH_STORES_FILE]: stores.content,
          });
    const event: LedgerEventInput = {
      schemaVersion: 1,
      identity,
      campaignId: `research-import:${fromState}`,
      snapshotDigest: trial.snapshotDigest,
      occurredAt: state.clock().toISOString(),
      artifacts:
        storesDigest === undefined
          ? []
          : [{ kind: "research-stores", digest: storesDigest }],
      type: "research-imported",
      fromState,
      fromCampaignId: trial.campaignId,
      fromRunId: trial.runId,
      targetId: trial.targetId,
      targetVersion: trial.version,
      sourceFinishedAt: trial.finishedAt,
      researchDigest: trial.researchDigest,
      ...(trial.explorationLabDigest === undefined
        ? {}
        : { explorationLabDigest: trial.explorationLabDigest }),
    };
    const appended = await state.ledger.append(event);
    if (appended.status === "appended") {
      imported += 1;
      input.log(
        `imported ${trial.runId} (${trial.targetId} ${trial.version})${storesDigest === undefined ? "" : " with stores.json"}`,
      );
    } else already += 1;
  }
  return { imported, existing: already, skipped };
}
