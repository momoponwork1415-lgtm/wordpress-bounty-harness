import { z } from "zod";

import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import type { Ledger } from "../ledger/index.js";
import type { DiscoveryTransportResult } from "./codex-native-agent-runtime.js";
import type { ProviderAttachmentStore } from "./provider-research-report.js";
import { DiscoveryReportError } from "./recover-agent-reports.js";

const providerReportSchema = z.object({
  findings: z.array(z.unknown()),
  leads: z.array(z.unknown()).default([]),
  examined: z.string().default(""),
  unexamined: z.string().default(""),
});

/** The candidate arrays of one agent report, exactly as the agent wrote them. */
export type CandidateReport = {
  readonly findings: readonly unknown[];
  readonly leads: readonly unknown[];
};

/** Where one report's candidates are recorded and which run they belong to. */
export type ReportRecorderContext = {
  readonly ledger: Ledger;
  readonly evidence: PrivateArtifactStore;
  readonly base: {
    readonly schemaVersion: 1;
    readonly campaignId: string;
    readonly snapshotDigest: string;
    readonly occurredAt: string;
  };
  readonly runId: string;
  readonly trialId: string;
  readonly snapshotDigest: string;
  readonly reportArtifactDigest: string;
  /** ADR 0042: the partition the reporting tracer was assigned; absent outside partitioned Trials. */
  readonly partition?: string;
};

export type RecordedCandidate = {
  readonly kind: "finding" | "lead";
  readonly index: number;
  /** ADR 0018: a candidate is recorded, parked outside the queues, or held; never rejected. */
  readonly outcome: "recorded" | "parked" | "held";
  /** `existing` when an identical event was already in the ledger. */
  readonly status: "appended" | "existing";
  /** Dedupe signature of a recorded claim; the campaign compares it across Trials. */
  readonly signature?: string;
};

export type RecordedReport = {
  readonly candidates: readonly RecordedCandidate[];
};

/**
 * Profile-owned admission: normalize each candidate, admit it against the
 * profile's claim schema, then record, park or hold it in the ledger. The
 * generic campaign only reads the summary.
 */
export type ReportRecorder = (
  report: CandidateReport,
  context: ReportRecorderContext,
) => Promise<RecordedReport>;

type RecorderOptions = {
  readonly attachments: ProviderAttachmentStore;
  readonly evidence: PrivateArtifactStore;
  readonly ledger: Ledger;
  readonly base: ReportRecorderContext["base"];
  readonly snapshotDigest: string;
  readonly trialId: string;
  readonly seen: Set<string>;
  readonly state: { foundNew: boolean; heldBoundary: boolean };
  readonly onFindingRecorded: (count: number) => void;
  readonly recordReport: ReportRecorder;
};

/** Preserve every individual candidate, including malformed and held output. */
export function createReportRecorder(options: RecorderOptions) {
  return async (
    ownerRunId: string,
    attachment: NonNullable<DiscoveryTransportResult["attachment"]>,
  ): Promise<void> => {
    const stored = await options.attachments.read(attachment);
    if (stored.status !== "resolved")
      throw new DiscoveryReportError(
        "Discovery report attachment is unavailable",
      );
    let report: z.infer<typeof providerReportSchema>;
    try {
      report = providerReportSchema.parse(
        JSON.parse(stored.bytes.toString("utf8")) as unknown,
      );
    } catch {
      throw new DiscoveryReportError("Discovery report is malformed");
    }
    const recorded = await options.recordReport(
      { findings: report.findings, leads: report.leads },
      {
        ledger: options.ledger,
        evidence: options.evidence,
        base: options.base,
        runId: ownerRunId,
        trialId: options.trialId,
        snapshotDigest: options.snapshotDigest,
        reportArtifactDigest: attachment.digest,
      },
    );
    for (const candidate of recorded.candidates) {
      if (candidate.outcome === "held") options.state.heldBoundary = true;
      if (
        candidate.kind === "finding" &&
        candidate.outcome === "recorded" &&
        candidate.status === "appended"
      )
        options.onFindingRecorded(1);
      if (candidate.signature !== undefined) {
        if (!options.seen.has(candidate.signature))
          options.state.foundNew = true;
        options.seen.add(candidate.signature);
      }
    }
  };
}
