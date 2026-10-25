import { randomUUID } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import type { Ledger, LedgerEventV1 } from "../ledger/index.js";
import { digest, id, refSchema, type ReviewRef } from "./records.js";

export const MANUAL_LAB_RECEIPT_FILE = "manual-lab-session.json";
export const MANUAL_OBSERVATION_EVIDENCE_FILE =
  "manual-observation-evidence.bin";

/** Projection never treats a missing or corrupt private artifact as usable proof. */
export async function manualObservationEvidenceStatus(
  store: PrivateArtifactStore,
  record: {
    readonly sessionReceiptDigest: string;
    readonly evidenceDigest: string;
  },
): Promise<"available" | "unavailable"> {
  const [receipt, evidence] = await Promise.all([
    store.readFile(
      record.sessionReceiptDigest,
      MANUAL_LAB_RECEIPT_FILE,
      10_000,
    ),
    store.readFile(
      record.evidenceDigest,
      MANUAL_OBSERVATION_EVIDENCE_FILE,
      10_000_000,
    ),
  ]);
  return receipt.status === "resolved" && evidence.status === "resolved"
    ? "available"
    : "unavailable";
}

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
    (latest.result.reason !== "observation" &&
      latest.result.reason !== "awaiting-human-observation")
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

type ReadyEvent = Extract<
  LedgerEventV1,
  { type: "manual-observation-lab-ready" }
>;
type ResultEvent = Extract<
  LedgerEventV1,
  { type: "manual-observation-recorded" }
>;

function latestReady(
  ledger: Ledger,
  ref: ReviewRef,
  verification: FinishedVerification,
): { event: ReadyEvent; sequence: number } | null {
  const verificationSequence = ledger
    .readAll({
      campaignId: ref.campaignId,
      findingId: ref.findingId,
      type: "verification-finished",
    })
    .at(-1)?.sequence;
  if (verificationSequence === undefined) return null;
  return (
    (ledger
      .readAll({
        campaignId: ref.campaignId,
        findingId: ref.findingId,
        type: "manual-observation-lab-ready",
      })
      .filter(
        ({ event, sequence }) =>
          event.type === "manual-observation-lab-ready" &&
          sequence > verificationSequence &&
          event.verificationId === ref.verificationId &&
          event.snapshotDigest === ref.snapshotDigest &&
          event.labSetupDigest === verification.labSetupDigest,
      )
      .at(-1) as { event: ReadyEvent; sequence: number } | undefined) ?? null
  );
}

function matchingReady(
  ledger: Ledger,
  ref: ReviewRef,
  verification: FinishedVerification,
  packageDigest: string,
  receiptDigest: string,
): { event: ReadyEvent; sequence: number } | null {
  const latest = latestReady(ledger, ref, verification);
  return latest?.event.packageDigest === packageDigest &&
    latest.event.sessionReceiptDigest === receiptDigest
    ? latest
    : null;
}

/** Only a named human may record a result; the verification result stays incomplete. */
export async function recordManualObservation(input: {
  readonly ledger: Ledger;
  readonly store: PrivateArtifactStore;
  readonly ref: ReviewRef;
  readonly packageDigest: string;
  readonly sessionReceiptDigest: string;
  readonly evidence: Uint8Array;
  readonly result: "match" | "mismatch" | "unavailable";
  readonly recordedBy: string;
  readonly clock?: () => Date;
}): Promise<ResultEvent> {
  const ref = refSchema.parse(input.ref);
  const packageDigest = digest.parse(input.packageDigest);
  const receiptDigest = digest.parse(input.sessionReceiptDigest);
  const result = z
    .enum(["match", "mismatch", "unavailable"])
    .parse(input.result);
  const recordedBy = id.parse(input.recordedBy.trim());
  if (
    ["ai", "agent", "automation", "system"].includes(recordedBy.toLowerCase())
  )
    throw new Error("A named human actor is required");
  if (input.evidence.byteLength === 0 || input.evidence.byteLength > 10_000_000)
    throw new Error("Manual observation evidence must be 1-10000000 bytes");
  const verification = currentObservationVerification(input.ledger, ref);
  if (verification === null)
    throw new Error("A current incomplete observation is required");
  if (
    verification.evidenceCapture !== "harness-captured" ||
    !verification.artifacts.some(
      (artifact) =>
        artifact.kind === "review-lab-reconstruction" &&
        artifact.digest === packageDigest,
    )
  )
    throw new Error("A matching captured review Lab package is required");
  const ready = matchingReady(
    input.ledger,
    ref,
    verification,
    packageDigest,
    receiptDigest,
  );
  if (ready === null)
    throw new Error("A matching ready manual Lab receipt is required");
  const stored = await input.store.readJson(
    receiptDigest,
    MANUAL_LAB_RECEIPT_FILE,
    receiptSchema,
    10_000,
  );
  if (
    stored.status !== "resolved" ||
    stored.value.ref.campaignId !== ref.campaignId ||
    stored.value.ref.findingId !== ref.findingId ||
    stored.value.ref.verificationId !== ref.verificationId ||
    stored.value.ref.snapshotDigest !== ref.snapshotDigest ||
    stored.value.labSetupDigest !== verification.labSetupDigest ||
    stored.value.packageDigest !== packageDigest ||
    stored.value.readyAt !== ready.event.occurredAt
  )
    throw new Error(
      "Manual Lab receipt content does not match the current attempt",
    );
  const evidenceDigest = await input.store.putFiles({
    [MANUAL_OBSERVATION_EVIDENCE_FILE]: input.evidence,
  });
  const event: ResultEvent = {
    schemaVersion: 1,
    identity: `manual-observation:${randomUUID()}`,
    campaignId: ref.campaignId,
    findingId: ref.findingId,
    verificationId: ref.verificationId,
    snapshotDigest: ref.snapshotDigest,
    labSetupDigest: verification.labSetupDigest,
    packageDigest,
    sessionReceiptDigest: receiptDigest,
    evidenceDigest,
    result,
    recordedBy,
    occurredAt: (input.clock ?? (() => new Date()))().toISOString(),
    type: "manual-observation-recorded",
    artifacts: [
      { kind: "manual-lab-session", digest: receiptDigest },
      { kind: "manual-observation-evidence", digest: evidenceDigest },
    ],
  };
  const appended = await input.ledger.append(event);
  if (appended.status !== "appended")
    throw new Error("Manual observation ledger conflict");
  return event;
}

export function currentManualObservation(
  ledger: Ledger,
  ref: ReviewRef,
): ResultEvent | null {
  const verification = currentObservationVerification(ledger, ref);
  if (verification === null) return null;
  const ready = latestReady(ledger, ref, verification);
  if (ready === null) return null;
  return (
    (ledger
      .readAll({
        campaignId: ref.campaignId,
        findingId: ref.findingId,
        type: "manual-observation-recorded",
      })
      .filter(
        ({ event, sequence }) =>
          event.type === "manual-observation-recorded" &&
          event.verificationId === ref.verificationId &&
          event.snapshotDigest === ref.snapshotDigest &&
          event.labSetupDigest === verification.labSetupDigest &&
          event.packageDigest === ready.event.packageDigest &&
          event.sessionReceiptDigest === ready.event.sessionReceiptDigest &&
          ready.sequence < sequence,
      )
      .at(-1)?.event as ResultEvent | undefined) ?? null
  );
}

/**
 * #525 (ADR 0040): with no judge, a new result is a submission basis only
 * through people. The latest attempt awaits a human observation, kept the
 * Harness capture, and a named person recorded `match` for it in a fresh
 * review Lab. The package digest is that sealed review Lab package.
 */
export function humanObservedBasis(
  ledger: Ledger,
  ref: ReviewRef,
): {
  readonly verification: FinishedVerification;
  readonly packageDigest: string;
  readonly observation: ResultEvent;
} | null {
  const verification = currentObservationVerification(ledger, ref);
  if (
    verification === null ||
    verification.result.status !== "incomplete" ||
    verification.result.reason !== "awaiting-human-observation" ||
    verification.evidenceCapture !== "harness-captured"
  )
    return null;
  const observation = currentManualObservation(ledger, ref);
  if (observation === null || observation.result !== "match") return null;
  return {
    verification,
    packageDigest: observation.packageDigest,
    observation,
  };
}

/** The same basis once the reviewer's own `review decide --reproduced match` is recorded for it. */
export function humanReproducedBasis(
  ledger: Ledger,
  ref: ReviewRef,
): ReturnType<typeof humanObservedBasis> {
  const observed = humanObservedBasis(ledger, ref);
  if (observed === null) return null;
  const reproduction = ledger
    .readAll({
      campaignId: ref.campaignId,
      findingId: ref.findingId,
      type: "human-reproduction-recorded",
    })
    .filter(
      ({ event }) =>
        event.type === "human-reproduction-recorded" &&
        event.verificationId === ref.verificationId &&
        event.reproductionPackageDigest === observed.packageDigest,
    )
    .at(-1)?.event;
  return reproduction?.type === "human-reproduction-recorded" &&
    reproduction.result === "match"
    ? observed
    : null;
}
