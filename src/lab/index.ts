/** A profile owns target-specific setup; the generic Lab boundary only carries receipts. */
export interface LabHandle {
  readonly id: string;
  readonly snapshotDigest: string;
  readonly setupDigest: string;
  readonly endpoint: string;
  /** Profile-owned, digest-pinned ordinary Lab scenario, when selected. */
  readonly scenario?: { readonly id: string; readonly digest: string };
}

export type ProvisionResult<Handle extends LabHandle> =
  | { readonly status: "ready"; readonly handle: Handle }
  | {
      readonly status: "incomplete";
      readonly reason: "provision" | "precondition";
      readonly nextStep: string;
      /** Private diagnostic data; callers store it outside the ledger. */
      readonly diagnostic?: string;
    };

export type LabReachability = {
  readonly http: "ok" | "failed";
  readonly database: "ok" | "failed" | "not-exposed";
};

export interface LabProvisioner<Setup, Handle extends LabHandle> {
  provision(
    snapshot: unknown,
    setup: Setup,
    context?: { readonly purpose: "discovery" | "verification" },
  ): Promise<ProvisionResult<Handle>>;
  probe?(handle: Handle): Promise<LabReachability>;
  seedCanaries(handle: Handle): Promise<
    | { readonly status: "seeded"; readonly digest: string }
    | {
        readonly status: "incomplete";
        readonly reason: "provision";
        readonly nextStep: string;
        readonly diagnostic?: string;
      }
  >;
  teardown(handle: Handle): Promise<
    | { readonly status: "removed" }
    | {
        readonly status: "incomplete";
        readonly reason: "cleanup";
        readonly nextStep: string;
      }
  >;
}

/**
 * A Lab attached to one discovery Trial (ADR 0003, 2026-10-25 addendum). The
 * Harness only serves the control endpoint and seals what it observed; it
 * draws no conclusion from the Lab.
 */
export interface TrialLab {
  readonly labId: string;
  /** Takes the first state and starts answering the control endpoint. */
  open(): Promise<void>;
  /** Stops answering, seals the capture and states in Private Evidence; never throws. */
  seal(): Promise<TrialLabRecord>;
}

/** What one Trial's Lab saw, as the finish event records it. */
export interface TrialLabRecord {
  /** Private Evidence bundle: HTTP capture, states before and after each reset. */
  readonly artifactDigest?: string;
  /** HTTP exchanges that passed the Lab recorder, including those past its cap. */
  readonly requests: number;
  /** Exchanges the recorder counted but did not keep once its cap was reached. */
  readonly droppedRequests: number;
  readonly resets: number;
  /** Reset requests answered with a refusal (budget spent or Lab unavailable). */
  readonly refusedResets: number;
  /** Commands whose answer did not reach the control endpoint, even after one retry. */
  readonly droppedAnswers: number;
  /** Observer visits the Lab ran for the agent (`POST /observe`, Phase D2). */
  readonly observations: number;
  /** Observe requests refused (invalid, budget spent, role or Lab unavailable). */
  readonly refusedObservations: number;
}
