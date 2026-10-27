/**
 * The values the Harness enforces for one Trial (redesign 2026-10-25 §7):
 * the wall, the active floor, the ceiling on live children and the Lab
 * budget, plus the runtime that runs the Root.
 */
export interface RunParameters {
  readonly wallMinutes: number;
  /** 0 means no floor; the section then says so explicitly. */
  readonly minimumActiveMinutes: number;
  readonly maxChildren: number;
  readonly lab: {
    readonly mode: "none" | "attached";
    readonly maxResets: number;
    /** Attached Labs only (Phase D2); not stated in the section. */
    readonly maxObservations?: number;
  };
  readonly runtime: {
    readonly transportKind: string;
    readonly model: string;
    readonly effort: string;
  };
}

/**
 * The Harness-generated `## Run parameters` section (ADR 0019 pattern). It
 * states the enforced values only and says nothing about how to explore.
 * Agent-facing text: changes need `owner-approved`.
 */
export function runParametersSection(parameters: RunParameters): string {
  const { runtime, lab } = parameters;
  return [
    "## Run parameters",
    [
      "The Harness sets and enforces these values for this Trial.",
      `- Runtime: ${runtime.transportKind}, model ${runtime.model}, effort ${runtime.effort}.`,
      `- Wall time: ${parameters.wallMinutes} minutes.`,
      parameters.minimumActiveMinutes > 0
        ? `- Minimum active exploration time: ${parameters.minimumActiveMinutes} minutes.`
        : "- Minimum active exploration time: 0 minutes (no minimum).",
      `- Maximum concurrent child agents: ${parameters.maxChildren}.`,
      lab.mode === "none"
        ? "- Lab: none."
        : `- Lab: attached, at most ${lab.maxResets} resets.`,
    ].join("\n"),
  ].join("\n\n");
}

/** The values the Harness enforces on an enumerator's proposal (ADR 0042). */
export interface PartitionLimitParameters {
  readonly maxEntriesPerPartition: number;
  readonly maxPartitions: number;
  readonly maxResubmits: number;
  /** Where a sent-back proposal and its reasons arrive, as absolute sandbox paths. */
  readonly sentBack: { readonly previous: string; readonly reasons: string };
}

/**
 * The Harness-generated `## Partition limits` section of an enumerator's
 * prompt (ADR 0042). It states the enforced limits and the files a send-back
 * arrives with; it says nothing about how to enumerate or partition.
 * Agent-facing text: changes need `owner-approved`.
 */
export function partitionLimitsSection(
  limits: PartitionLimitParameters,
): string {
  return [
    "## Partition limits",
    [
      "The Harness checks the proposal's shape against these values and sends it back with the reasons when they are exceeded.",
      `- Maximum rows per partition: ${limits.maxEntriesPerPartition}.`,
      `- Maximum partitions: ${limits.maxPartitions}.`,
      `- Send-backs: at most ${limits.maxResubmits}. A sent-back proposal arrives again with the previous submission at ${limits.sentBack.previous} and the reasons at ${limits.sentBack.reasons}.`,
    ].join("\n"),
  ].join("\n\n");
}
