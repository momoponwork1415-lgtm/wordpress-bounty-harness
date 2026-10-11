import { z } from "zod";

import {
  canonicalDigest,
  canonicalJson,
} from "../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import type { Ledger } from "../ledger/index.js";
import type { DiscoveryTransportResult } from "./codex-native-agent-runtime.js";
import type { AdmittedFinding, AdmittedLead } from "./campaign.js";
import type { ProviderAttachmentStore } from "./provider-research-report.js";
import { DiscoveryReportError } from "./recover-agent-reports.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const providerReportSchema = z.object({
  findings: z.array(z.unknown()),
  leads: z.array(z.unknown()).default([]),
  examined: z.string().default(""),
  unexamined: z.string().default(""),
});

type RecorderOptions = {
  readonly attachments: ProviderAttachmentStore;
  readonly evidence: PrivateArtifactStore;
  readonly ledger: Ledger;
  readonly base: {
    readonly schemaVersion: 1;
    readonly campaignId: string;
    readonly snapshotDigest: string;
    readonly occurredAt: string;
  };
  readonly snapshotDigest: string;
  readonly trialId: string;
  readonly seen: Set<string>;
  readonly state: { foundNew: boolean; heldBoundary: boolean };
  readonly onFindingRecorded: (count: number) => void;
  readonly admitFinding: (
    candidate: unknown,
    context: {
      runId: string;
      snapshotDigest: string;
      reportArtifactDigest: string;
    },
  ) => AdmittedFinding;
  readonly normalizeCandidate?: (candidate: unknown) => {
    value: unknown;
    changes: { path: string; operation: string }[];
  };
  readonly classifyCandidate?: (
    candidate: unknown,
    kind: "finding" | "lead",
  ) => {
    impact?: string;
    primitive?: string;
    missingEdge?: string;
  };
  readonly admitLead?: (
    candidate: unknown,
    context: {
      runId: string;
      trialId: string;
      snapshotDigest: string;
      reportArtifactDigest: string;
    },
  ) => AdmittedLead;
  readonly leadSignature?: (lead: AdmittedLead) => string;
};

async function holdCandidate(
  options: RecorderOptions,
  ownerRunId: string,
  candidateKind: "finding" | "lead",
  candidateIndex: number,
  candidate: unknown,
  rawDigest: string,
  error: unknown,
) {
  options.state.heldBoundary = true;
  const issuePaths =
    error instanceof z.ZodError
      ? error.issues.map((issue) => issue.path.join("."))
      : [
          error instanceof Error &&
          error.message === "Candidate identity mismatch"
            ? "identity"
            : "admission",
        ];
  const classification =
    options.classifyCandidate?.(candidate, candidateKind) ?? {};
  const appended = await options.ledger.append({
    ...options.base,
    identity: `candidate-held-${ownerRunId}-${candidateKind}-${candidateIndex}`,
    type: "candidate-held",
    runId: ownerRunId,
    candidateKind,
    candidateIndex,
    issuePaths,
    ...classification,
    artifacts: [{ kind: "candidate", digest: rawDigest }],
  });
  if (appended.status === "conflict")
    throw new Error("Candidate hold identity conflict");
}

async function prepareCandidate(
  options: RecorderOptions,
  ownerRunId: string,
  kind: "finding" | "lead",
  index: number,
  raw: unknown,
) {
  const rawDigest = await options.evidence.putFiles({
    "candidate.json": canonicalJson(raw),
  });
  const normalized = options.normalizeCandidate?.(raw) ?? {
    value: raw,
    changes: [],
  };
  const appended = await options.ledger.append({
    ...options.base,
    identity: `candidate-normalized-${ownerRunId}-${kind}-${index}`,
    type: "candidate-normalized",
    runId: ownerRunId,
    candidateKind: kind,
    candidateIndex: index,
    changes: normalized.changes,
    artifacts: [{ kind: "candidate", digest: rawDigest }],
  });
  if (appended.status === "conflict")
    throw new Error("Candidate normalization identity conflict");
  return { ...normalized, rawDigest };
}

async function recordFindingCandidate(
  options: RecorderOptions,
  ownerRunId: string,
  attachmentDigest: string,
  index: number,
  candidate: unknown,
): Promise<void> {
  const prepared = await prepareCandidate(
    options,
    ownerRunId,
    "finding",
    index,
    candidate,
  );
  let finding: AdmittedFinding;
  try {
    finding = options.admitFinding(prepared.value, {
      runId: ownerRunId,
      snapshotDigest: options.snapshotDigest,
      reportArtifactDigest: attachmentDigest,
    });
  } catch (error) {
    await holdCandidate(
      options,
      ownerRunId,
      "finding",
      index,
      prepared.value,
      prepared.rawDigest,
      error,
    );
    return;
  }
  if (
    finding.discoveryRunId !== ownerRunId ||
    finding.snapshotDigest !== options.snapshotDigest
  ) {
    await holdCandidate(
      options,
      ownerRunId,
      "finding",
      index,
      prepared.value,
      prepared.rawDigest,
      new Error("Candidate identity mismatch"),
    );
    return;
  }
  const findingDigest = await options.evidence.putFiles({
    "finding.json": canonicalJson(finding),
  });
  const appended = await options.ledger.append({
    ...options.base,
    artifacts: [{ kind: "finding", digest: findingDigest }],
    identity: `discovery-finding-${finding.findingId}`,
    type: "finding-recorded",
    findingId: finding.findingId,
    runId: ownerRunId,
    category: finding.impact,
    ...(finding.historyRecordId === undefined
      ? {}
      : { historyRecordId: finding.historyRecordId }),
  });
  if (appended.status === "conflict")
    throw new Error("Finding identity conflict");
  options.onFindingRecorded(appended.status === "appended" ? 1 : 0);
  const signature = canonicalDigest({
    claim: finding.claim,
    impact: finding.impact,
    sourceTrace: finding.sourceTrace,
  });
  if (!options.seen.has(signature)) options.state.foundNew = true;
  options.seen.add(signature);
}

async function recordLeadCandidate(
  options: RecorderOptions,
  ownerRunId: string,
  attachmentDigest: string,
  index: number,
  candidate: unknown,
): Promise<void> {
  const prepared = await prepareCandidate(
    options,
    ownerRunId,
    "lead",
    index,
    candidate,
  );
  let lead: AdmittedLead;
  try {
    if (options.admitLead === undefined || options.leadSignature === undefined)
      throw new Error("Lead admission is unavailable");
    lead = options.admitLead(prepared.value, {
      runId: ownerRunId,
      trialId: options.trialId,
      snapshotDigest: options.snapshotDigest,
      reportArtifactDigest: attachmentDigest,
    });
  } catch (error) {
    await holdCandidate(
      options,
      ownerRunId,
      "lead",
      index,
      prepared.value,
      prepared.rawDigest,
      error,
    );
    return;
  }
  if (
    lead.discoveryRunId !== ownerRunId ||
    lead.trialId !== options.trialId ||
    lead.snapshotDigest !== options.snapshotDigest
  ) {
    await holdCandidate(
      options,
      ownerRunId,
      "lead",
      index,
      prepared.value,
      prepared.rawDigest,
      new Error("Candidate identity mismatch"),
    );
    return;
  }
  const leadDigest = await options.evidence.putFiles({
    "lead.json": canonicalJson(lead),
  });
  const appended = await options.ledger.append({
    ...options.base,
    artifacts: [{ kind: "lead", digest: leadDigest }],
    identity: `discovery-lead-${lead.leadId}`,
    type: "lead-recorded",
    leadId: lead.leadId,
    runId: ownerRunId,
    trialId: options.trialId,
    missingEdge: lead.missingEdge,
    primitive: lead.primitive,
    storageKind: lead.storage?.kind ?? "none",
  });
  if (appended.status === "conflict") throw new Error("Lead identity conflict");
  const signature = digest.parse(options.leadSignature!(lead));
  if (!options.seen.has(signature)) options.state.foundNew = true;
  options.seen.add(signature);
}

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
    for (const [index, candidate] of report.findings.entries())
      await recordFindingCandidate(
        options,
        ownerRunId,
        attachment.digest,
        index,
        candidate,
      );
    for (const [index, candidate] of report.leads.entries())
      await recordLeadCandidate(
        options,
        ownerRunId,
        attachment.digest,
        index,
        candidate,
      );
  };
}
