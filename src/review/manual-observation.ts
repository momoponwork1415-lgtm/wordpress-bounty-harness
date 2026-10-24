import { randomUUID } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import type { Ledger, LedgerEventV1 } from "../ledger/index.js";
import { digest, refSchema, type ReviewRef } from "./records.js";

export const MANUAL_LAB_RECEIPT_FILE = "manual-lab-session.json";

const receiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ref: refSchema,
  labSetupDigest: digest,
  packageDigest: digest,
  sessionId: z.uuid(),
  /** The fresh Lab's network, not a credential or a host target URL. */
  sessionLabel: z.string().min(1).max(256),
  readyAt: z.iso.datetime({ offset: true }),
});

type FinishedVerification = Extract<
  LedgerEventV1,
  { type: "verification-finished" }
>;
/** A later attempt or a newer derived Finding cannot reuse this Lab. */
export function currentObservationVerification(
  ledger: Ledger,
  ref: ReviewRef,
): FinishedVerification | null {
  const parsed = refSchema.parse(ref);
  const finding = ledger
    .read({
      campaignId: parsed.campaignId,
      findingId: parsed.findingId,
      type: "finding-recorded",
      limit: 1,
    })
    .at(0)?.event;
  if (
    finding?.type !== "finding-recorded" ||
    finding.snapshotDigest !== parsed.snapshotDigest ||
    ledger
      .activeParked({ campaignId: parsed.campaignId })
      .some((event) => event.findingId === parsed.findingId)
  )
    return null;
  const latest = ledger
    .readAll({
      campaignId: parsed.campaignId,
      findingId: parsed.findingId,
      type: "verification-finished",
    })
    .at(-1)?.event;
  if (
    latest?.type !== "verification-finished" ||
    latest.verificationId !== parsed.verificationId ||
    latest.snapshotDigest !== parsed.snapshotDigest ||
    latest.result.status !== "incomplete" ||
    latest.result.reason !== "observation"
  )
    return null;

  const findings = ledger
    .readAll({ campaignId: parsed.campaignId, type: "finding-recorded" })
    .map(({ event }) => event)
    .filter((event) => event.type === "finding-recorded");
  const byId = new Map(findings.map((event) => [event.findingId, event]));
  const rootOf = (findingId: string): string => {
    let current = findingId;
    const seen = new Set<string>();
    while (!seen.has(current)) {
      seen.add(current);
      const parent = byId.get(current)?.derivedFromFindingId;
      if (parent === undefined) break;
      current = parent;
    }
    return current;
  };
  const root = rootOf(parsed.findingId);
  const newestLatest = findings
    .filter(
      (event) =>
        event.derivationKind === "latest-version" &&
        rootOf(event.findingId) === root,
    )
    .at(-1);
  return newestLatest === undefined ||
    newestLatest.findingId === parsed.findingId
    ? latest
    : null;
}

/** One sealed receipt after a new review Lab actually reaches ready. */
export async function recordManualObservationLabReady(input: {
  readonly ledger: Ledger;
  readonly store: PrivateArtifactStore;
  readonly ref: ReviewRef;
  readonly packageDigest: string;
  readonly sessionLabel: string;
  readonly clock?: () => Date;
}): Promise<string> {
  const ref = refSchema.parse(input.ref);
  const verification = currentObservationVerification(input.ledger, ref);
  if (verification === null)
    throw new Error("A current incomplete observation is required");
  if (
    verification.evidenceCapture !== "harness-captured" ||
    !verification.artifacts.some(
      (artifact) =>
        artifact.kind === "review-lab-reconstruction" &&
        artifact.digest === input.packageDigest,
    )
  )
    throw new Error("A matching captured review Lab package is required");
  const receipt = receiptSchema.parse({
    schemaVersion: 1,
    ref,
    labSetupDigest: verification.labSetupDigest,
    packageDigest: input.packageDigest,
    sessionId: randomUUID(),
    sessionLabel: input.sessionLabel,
    readyAt: (input.clock ?? (() => new Date()))().toISOString(),
  });
  const sessionReceiptDigest = await input.store.putFiles({
    [MANUAL_LAB_RECEIPT_FILE]: canonicalJson(receipt),
  });
  const appended = await input.ledger.append({
    schemaVersion: 1,
    identity: `manual-observation-lab:${receipt.sessionId}`,
    campaignId: ref.campaignId,
    findingId: ref.findingId,
    verificationId: ref.verificationId,
    snapshotDigest: ref.snapshotDigest,
    labSetupDigest: verification.labSetupDigest,
    packageDigest: input.packageDigest,
    sessionReceiptDigest,
    occurredAt: receipt.readyAt,
    type: "manual-observation-lab-ready",
    artifacts: [{ kind: "manual-lab-session", digest: sessionReceiptDigest }],
  });
  if (appended.status !== "appended")
    throw new Error("Manual Lab session ledger conflict");
  return sessionReceiptDigest;
}
