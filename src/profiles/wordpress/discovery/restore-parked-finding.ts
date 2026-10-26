import { z } from "zod";

import { canonicalJson } from "../../../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import { admitFindingGroup } from "../../../ledger/finding-groups.js";
import type { Ledger } from "../../../ledger/index.js";
import { classifyWordPressPrecondition } from "../verification/precondition-class.js";
import { readWordPressFinding, wordPressFindingGroupKeys } from "./finding.js";
import { isWordPressProgrammeImpact } from "./programme-impacts.js";

type RestoreOptions = {
  readonly ledger: Ledger;
  readonly evidence: PrivateArtifactStore;
  readonly campaignId: string;
  readonly findingId: string;
  readonly clock?: () => Date;
  /**
   * #529: who restored it and why. Kept in Private Evidence and referenced from
   * the marker's artifacts, so the event shape that older runners read stays.
   */
  readonly note?: { readonly restoredBy: string; readonly reason: string };
};

async function assessCorrection(options: RestoreOptions) {
  const { ledger, evidence, campaignId, findingId } = options;
  const history = ledger.readAll({ campaignId, findingId });
  const admissionPark = history.find(
    ({ event }) =>
      event.type === "finding-parked" &&
      event.identity === `discovery-finding-parked-${findingId}`,
  );
  const parked = admissionPark?.event;
  if (parked?.type !== "finding-parked" || admissionPark === undefined)
    throw new Error("Finding has no admission park event");
  if (
    history.some(
      ({ event, sequence }) =>
        event.type === "finding-recorded" && sequence < admissionPark.sequence,
    )
  )
    throw new Error("Finding was recorded before its admission park");
  if (parked.reason !== "admin-configuration-precondition")
    throw new Error("Programme Boundary parks cannot be restored here");
  const active = ledger
    .activeParked({ campaignId })
    .find((event) => event.findingId === findingId);
  if (active === undefined) return { status: "already-restored" as const };
  if (active.identity !== parked.identity)
    throw new Error("Active park differs from the admission park");

  const reference = parked.artifacts.find(
    (artifact) => artifact.kind === "finding",
  );
  if (reference === undefined)
    throw new Error("Parked Finding has no evidence reference");
  const stored = await evidence.readJson(
    reference.digest,
    "finding.json",
    z.unknown(),
    1024 * 1024,
  );
  if (stored.status !== "resolved")
    throw new Error(`Parked Finding evidence is ${stored.status}`);
  const finding = readWordPressFinding(stored.value);
  if (
    finding.findingId !== findingId ||
    finding.discoveryRunId !== parked.runId ||
    finding.snapshotDigest !== parked.snapshotDigest ||
    finding.impact !== parked.category
  )
    throw new Error("Parked Finding does not match its recorded identity");
  if (!isWordPressProgrammeImpact(finding.impact))
    throw new Error("Finding is outside the Programme Boundary");
  const { preconditionClass } = classifyWordPressPrecondition({
    configurationPrecondition: finding.configurationPrecondition,
  });

  const recordedIdentity = `discovery-finding-${findingId}`;
  const existing = ledger
    .readAll({ campaignId, findingId, type: "finding-recorded" })
    .map(({ event }) => event)
    .find((event) => event.type === "finding-recorded");
  if (existing !== undefined) {
    if (
      existing.type !== "finding-recorded" ||
      existing.identity !== recordedIdentity ||
      existing.snapshotDigest !== parked.snapshotDigest ||
      existing.runId !== parked.runId ||
      existing.category !== parked.category ||
      existing.preconditionClass !== preconditionClass ||
      existing.artifacts.find((artifact) => artifact.kind === "finding")
        ?.digest !== reference.digest
    )
      throw new Error(
        "Existing recorded Finding does not match the correction",
      );
  }
  return {
    status: "ready" as const,
    parked,
    reference,
    finding,
    preconditionClass,
    recordedIdentity,
    existing,
  };
}

/** Read-only check against the exact private Finding and the current rule. */
export async function inspectParkedWordPressFinding(options: RestoreOptions) {
  const assessed = await assessCorrection(options);
  return assessed.status === "already-restored"
    ? { status: "already-restored" as const }
    : {
        status: "ready" as const,
        preconditionClass: assessed.preconditionClass,
        snapshotDigest: assessed.parked.snapshotDigest,
        parkedIdentity: assessed.parked.identity,
        recordedIdentity: assessed.recordedIdentity,
        partialRecord: assessed.existing !== undefined,
      };
}

/**
 * Restore an admission park caused by the retired configuration gate. The old
 * event and Private Evidence remain intact; the new events restore its queue
 * position. Programme Boundary parks cannot pass this operation.
 */
export async function restoreParkedWordPressFinding(
  options: RestoreOptions,
): Promise<{ readonly status: "restored" | "already-restored" }> {
  const assessed = await assessCorrection(options);
  if (assessed.status === "already-restored")
    return { status: "already-restored" };
  const {
    parked,
    reference,
    finding,
    preconditionClass,
    recordedIdentity,
    existing,
  } = assessed;
  const { ledger, campaignId, findingId } = options;
  if (existing === undefined) {
    const appended = await ledger.append({
      schemaVersion: 1,
      identity: recordedIdentity,
      campaignId,
      snapshotDigest: parked.snapshotDigest,
      occurredAt: (options.clock ?? (() => new Date()))().toISOString(),
      artifacts: [reference],
      type: "finding-recorded",
      findingId,
      runId: parked.runId,
      category: parked.category,
      preconditionClass,
      ...(finding.historyRecordId === undefined
        ? {}
        : { historyRecordId: finding.historyRecordId }),
      group: admitFindingGroup(ledger, {
        campaignId,
        snapshotDigest: parked.snapshotDigest,
        findingId,
        keys: wordPressFindingGroupKeys(finding),
      }),
    });
    if (appended.status === "conflict")
      throw new Error("Restored Finding identity conflict");
  }
  const occurredAt = (options.clock ?? (() => new Date()))().toISOString();
  const note =
    options.note === undefined
      ? []
      : [
          {
            kind: "restore-note",
            digest: await options.evidence.putFiles({
              "restore-note.json": canonicalJson({
                findingId,
                parkedIdentity: parked.identity,
                restoredBy: options.note.restoredBy,
                reason: options.note.reason,
                restoredAt: occurredAt,
              }),
            }),
          },
        ];
  const marker = await ledger.append({
    schemaVersion: 1,
    identity: `discovery-finding-park-restored-${findingId}`,
    campaignId,
    snapshotDigest: parked.snapshotDigest,
    occurredAt,
    artifacts: [reference, ...note],
    type: "finding-park-restored",
    findingId,
    parkedIdentity: parked.identity,
    recordedIdentity,
    reason: "admission-correction",
  });
  if (marker.status === "conflict")
    throw new Error("Restored Finding marker identity conflict");
  return { status: "restored" };
}
