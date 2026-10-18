import type {
  AgentRuntimeProfile,
  DiscoveryTransportRun,
  DiscoveryTransportResult,
  ProviderAttachmentStore,
} from "../../../discovery/index.js";
import type { ExpectedSourceTree } from "../../../infrastructure/canonical-source-tree.js";
import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import type { Ledger, LedgerEventV1 } from "../../../ledger/index.js";
import { readWordPressFinding } from "../discovery/finding.js";
import {
  wordPressRefutationOutputContract,
  wordPressRefutationSchema,
} from "../discovery/refutation.js";

type RecordedFinding = Extract<LedgerEventV1, { type: "finding-recorded" }>;

export interface RefuteOptions {
  readonly campaignId: string;
  readonly findingId?: string;
  readonly ledger: Ledger;
  readonly store: PrivateArtifactStore;
  readonly attachments: ProviderAttachmentStore;
  readonly profile: AgentRuntimeProfile;
  readonly prompt: {
    readonly id: "refute-v1";
    readonly digest: string;
    readonly text: string;
  };
  readonly resolveSource: (snapshotDigest: string) => Promise<{
    readonly directory: string;
    readonly tree: ExpectedSourceTree;
    readonly dependency?: {
      readonly directory: string;
      readonly tree: ExpectedSourceTree;
    };
  }>;
  readonly runtime: {
    execute(run: DiscoveryTransportRun): Promise<DiscoveryTransportResult>;
  };
  readonly clock: () => Date;
  readonly newId: () => string;
}

function readAll(
  ledger: Ledger,
  campaignId: string,
  type: "finding-recorded" | "finding-parked" | "refutation-recorded",
) {
  const events: LedgerEventV1[] = [];
  let afterSequence = 0;
  for (;;) {
    const page = ledger.read({ campaignId, type, afterSequence, limit: 1000 });
    events.push(...page.map(({ event }) => event));
    if (page.length < 1000) return events;
    afterSequence = page.at(-1)!.sequence;
  }
}

/** Runs once per unprocessed Finding. Transport failures leave the Finding pending. */
export async function refutePendingFindings(options: RefuteOptions): Promise<
  readonly {
    findingId: string;
    verdict: "refuted" | "upheld" | "undecided";
  }[]
> {
  const { ledger, campaignId } = options;
  const parked = new Set(
    readAll(ledger, campaignId, "finding-parked")
      .filter((event) => event.type === "finding-parked")
      .map((event) => event.findingId),
  );
  const done = new Set(
    readAll(ledger, campaignId, "refutation-recorded")
      .filter((event) => event.type === "refutation-recorded")
      .map((event) => event.findingId),
  );
  const findings = readAll(ledger, campaignId, "finding-recorded").filter(
    (event): event is RecordedFinding =>
      event.type === "finding-recorded" &&
      event.derivationKind !== "fixed-version-control" &&
      (options.findingId === undefined ||
        event.findingId === options.findingId) &&
      !parked.has(event.findingId) &&
      !done.has(event.findingId),
  );
  if (
    options.findingId !== undefined &&
    !readAll(ledger, campaignId, "finding-recorded").some(
      (event) =>
        event.type === "finding-recorded" &&
        event.findingId === options.findingId,
    )
  )
    throw new Error("Finding is not recorded in this campaign");
  const results: {
    findingId: string;
    verdict: "refuted" | "upheld" | "undecided";
  }[] = [];
  for (const event of findings) {
    const ref = event.artifacts.find((item) => item.kind === "finding");
    if (ref === undefined) continue;
    const stored = await options.store.readFile(
      ref.digest,
      "finding.json",
      1024 * 1024,
    );
    if (stored.status !== "resolved") continue;
    let finding: ReturnType<typeof readWordPressFinding>;
    try {
      finding = readWordPressFinding(
        JSON.parse(stored.bytes.toString("utf8")) as unknown,
      );
    } catch {
      continue;
    }
    if (
      finding.findingId !== event.findingId ||
      finding.snapshotDigest !== event.snapshotDigest
    )
      continue;
    const {
      claim,
      attackerPosition,
      impact,
      configurationPrecondition,
      brokenProperty,
      sourceTrace,
      existingControls,
    } = finding;
    const source = await options
      .resolveSource(event.snapshotDigest)
      .catch(() => undefined);
    if (source === undefined) continue;
    const runId = options.newId();
    const contract = wordPressRefutationOutputContract();
    const run: DiscoveryTransportRun = {
      runId,
      targetSnapshotDigest: event.snapshotDigest,
      profile: options.profile,
      prompt: `${options.prompt.text}\n\n${contract.text}`,
      coordination: "solo",
      outputKind: "refutation",
      refutationClaim: {
        claim,
        attackerPosition,
        impact,
        configurationPrecondition,
        brokenProperty,
        sourceTrace,
        existingControls,
      },
      sourceDirectory: source.directory,
      sourceTree: source.tree,
      ...(source.dependency === undefined
        ? {}
        : { dependencySource: source.dependency }),
      // The transport's legacy CampaignInput lab digest is metadata only here.
      campaignInput: {
        schemaVersion: 1,
        snapshotDigest: event.snapshotDigest,
        trustBoundary: { version: "refutation-v1", text: "source-only" },
        programmeBoundary: { version: "refutation-v1", text: "source-only" },
        modelProfileDigest: options.profile.digest,
        promptDigest: options.prompt.digest,
        stopRules: { maxRuns: 1, noFindingRuns: 1 },
        lab: { setupDigest: event.snapshotDigest },
        history: { mode: "none" },
      },
      expiresAt: new Date(
        options.clock().getTime() + 10 * 60_000,
      ).toISOString(),
    };
    const result = await options.runtime.execute(run).catch(() => undefined);
    if (result === undefined) continue;
    if (
      result.receipt.terminal !== "completed" ||
      result.attachment?.kind !== "refutation" ||
      result.receipt.reportArtifactDigest !== result.attachment.digest
    )
      continue;
    const attachment = await options.attachments.read(result.attachment);
    if (attachment.status !== "resolved") continue;
    let parsed: ReturnType<typeof wordPressRefutationSchema.safeParse>;
    try {
      parsed = wordPressRefutationSchema.safeParse(
        JSON.parse(attachment.bytes.toString("utf8")) as unknown,
      );
    } catch {
      continue;
    }
    if (!parsed.success) continue;
    const verdict = parsed.data.verdict;
    const recorded = await ledger.append({
      schemaVersion: 1,
      identity: `refutation-${event.findingId}`,
      campaignId,
      snapshotDigest: event.snapshotDigest,
      occurredAt: options.clock().toISOString(),
      type: "refutation-recorded",
      findingId: event.findingId,
      runId,
      verdict,
      reasonCode: parsed.data.reasonCode,
      promptVersion: options.prompt.id,
      promptDigest: options.prompt.digest,
      reportDigest: result.attachment.digest,
    });
    if (recorded.status === "conflict")
      throw new Error("Refutation ledger conflict");
    if (verdict === "refuted") {
      const parked = await ledger.append({
        schemaVersion: 1,
        identity: `refuted-${event.findingId}`,
        campaignId,
        snapshotDigest: event.snapshotDigest,
        occurredAt: options.clock().toISOString(),
        type: "finding-parked",
        findingId: event.findingId,
        runId: event.runId,
        category: event.category,
        reason: "refuted",
        artifacts: event.artifacts,
      });
      if (parked.status === "conflict")
        throw new Error("Refutation park conflict");
    }
    results.push({ findingId: event.findingId, verdict });
  }
  return results;
}
