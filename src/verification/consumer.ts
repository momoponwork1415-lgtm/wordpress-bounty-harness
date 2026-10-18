import type {
  Ledger,
  LedgerEventV1,
  LedgerReadQuery,
  LedgerRecord,
} from "../ledger/index.js";
import type { VerificationResultV1 } from "./reproduction-package.js";

type Finding = Extract<LedgerEventV1, { type: "finding-recorded" }>;
type Finished = Extract<LedgerEventV1, { type: "verification-finished" }>;
export type VerificationRecord = { sequence: number; event: Finished };
type IncompleteReason = Extract<
  VerificationResultV1,
  { status: "incomplete" }
>["reason"];

const inFlight = new Set<string>();

function readAll(
  ledger: Pick<Ledger, "read">,
  query: Omit<LedgerReadQuery, "limit" | "afterSequence">,
): LedgerRecord[] {
  const records: LedgerRecord[] = [];
  for (let afterSequence = 0; ;) {
    const page = ledger.read({ ...query, afterSequence, limit: 1000 });
    records.push(...page);
    if (page.length < 1000) return records;
    afterSequence = page.at(-1)!.sequence;
  }
}

export function shouldAutomaticallyRetryVerification(input: {
  readonly reason: IncompleteReason;
  readonly attemptsForReason: number;
  readonly sameLabSetup: boolean;
  readonly previousScenarioId?: string | null | undefined;
  readonly currentScenarioId?: string | null | undefined;
}): boolean {
  switch (input.reason) {
    case "recipe":
    case "observation":
      return input.sameLabSetup && input.attemptsForReason < 3;
    case "provision":
    case "provider":
      return input.sameLabSetup && input.attemptsForReason < 2;
    case "precondition":
      return (
        input.previousScenarioId !== undefined &&
        input.currentScenarioId !== undefined &&
        input.previousScenarioId !== input.currentScenarioId
      );
    default:
      return false;
  }
}

export function scenarioForVerification(
  previous: VerificationRecord,
  labs: readonly LedgerRecord[],
  snapshotDigest: string,
): string | null | undefined {
  const verificationLab = labs.find(
    ({ event }) =>
      event.identity === `verification-lab-${previous.event.verificationId}`,
  );
  if (verificationLab?.event.type === "lab-provisioned")
    return verificationLab.event.status === "ready"
      ? (verificationLab.event.scenario?.id ?? null)
      : undefined;
  const discoveryLab = labs
    .filter(
      ({ sequence, event }) =>
        sequence < previous.sequence &&
        event.type === "lab-provisioned" &&
        event.snapshotDigest === snapshotDigest &&
        event.purpose === "discovery",
    )
    .at(-1);
  return discoveryLab?.event.type === "lab-provisioned"
    ? (discoveryLab.event.scenario?.id ?? null)
    : undefined;
}

export type VerificationTicket = {
  readonly finding: Finding;
  readonly history: readonly VerificationRecord[];
  release(): void;
};

export function createVerificationConsumer(options: {
  readonly ledger: Pick<Ledger, "read">;
  readonly promptVersion: string | undefined;
  readonly currentScenarioId?: (
    snapshotDigest: string,
  ) => Promise<string | null>;
}) {
  const reserve = (finding: Pick<Finding, "campaignId" | "findingId">) => {
    const key = `${finding.campaignId}\0${finding.findingId}`;
    if (inFlight.has(key)) return null;
    inFlight.add(key);
    let released = false;
    return () => {
      if (!released) inFlight.delete(key);
      released = true;
    };
  };
  const pullNext = async (
    filter: {
      readonly campaignId?: string;
      readonly campaignPrefix?: string;
      readonly snapshotDigest?: string;
    } = {},
  ): Promise<VerificationTicket | null> => {
    const query =
      filter.campaignId === undefined ? {} : { campaignId: filter.campaignId };
    const findings = readAll(options.ledger, {
      ...query,
      type: "finding-recorded",
    });
    const verifications = readAll(options.ledger, {
      ...query,
      type: "verification-finished",
    });
    const parked = new Set(
      readAll(options.ledger, { ...query, type: "finding-parked" }).flatMap(
        ({ event }) =>
          event.type === "finding-parked"
            ? [`${event.campaignId}\0${event.findingId}`]
            : [],
      ),
    );
    const labs = readAll(options.ledger, { ...query, type: "lab-provisioned" });
    for (const { event } of findings) {
      if (
        event.type !== "finding-recorded" ||
        event.derivationKind === "fixed-version-control"
      )
        continue;
      if (
        filter.snapshotDigest !== undefined &&
        event.snapshotDigest !== filter.snapshotDigest
      )
        continue;
      if (
        filter.campaignPrefix !== undefined &&
        !event.campaignId.startsWith(`${filter.campaignPrefix}-`)
      )
        continue;
      const key = `${event.campaignId}\0${event.findingId}`;
      if (parked.has(key) || inFlight.has(key)) continue;
      const history = verifications.filter(
        (record): record is VerificationRecord =>
          record.event.type === "verification-finished" &&
          record.event.campaignId === event.campaignId &&
          record.event.findingId === event.findingId &&
          record.event.snapshotDigest === event.snapshotDigest &&
          record.event.basis === undefined,
      );
      const previous = history.at(-1);
      if (previous !== undefined) {
        if (
          previous.event.result.status !== "incomplete" ||
          previous.event.promptVersion !== options.promptVersion
        )
          continue;
        const reason = previous.event.result.reason;
        const attemptsForReason = history.filter(
          ({ event: prior }) =>
            prior.result.status === "incomplete" &&
            prior.result.reason === reason &&
            prior.labSetupDigest === previous.event.labSetupDigest &&
            prior.promptVersion === previous.event.promptVersion,
        ).length;
        const previousScenarioId = scenarioForVerification(
          previous,
          labs,
          event.snapshotDigest,
        );
        const currentScenarioId =
          reason === "precondition"
            ? await options.currentScenarioId?.(event.snapshotDigest)
            : previousScenarioId;
        if (
          !shouldAutomaticallyRetryVerification({
            reason,
            attemptsForReason,
            sameLabSetup: true,
            previousScenarioId,
            currentScenarioId,
          })
        )
          continue;
      }
      const release = reserve(event);
      if (release === null) continue;
      return { finding: event, history, release };
    }
    return null;
  };
  return { pullNext, reserve };
}
