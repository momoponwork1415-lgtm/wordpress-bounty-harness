import { canonicalJson } from "../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";

/** A profile owns target-specific setup; the generic Lab boundary only carries receipts. */
export interface LabHandle {
  readonly id: string;
  readonly snapshotDigest: string;
  readonly setupDigest: string;
  readonly endpoint: string;
  /** Profile-owned, digest-pinned ordinary Lab scenario, when selected. */
  readonly scenario?: { readonly id: string; readonly digest: string };
}

/** The exception a Lab setup failed with, bounded before it enters Private Evidence (#284). */
export type LabFailureException = {
  readonly className: string;
  readonly message: string;
};

const LAB_EXCEPTION_MESSAGE_CHARACTERS = 500;

export function describeLabException(error: unknown): LabFailureException {
  const message = error instanceof Error ? error.message : String(error);
  return {
    className:
      error instanceof Error ? error.constructor.name || "Error" : typeof error,
    message: Array.from(message)
      .slice(0, LAB_EXCEPTION_MESSAGE_CHARACTERS)
      .join(""),
  };
}

export type ProvisionIncomplete = {
  readonly status: "incomplete";
  readonly reason: "provision" | "precondition";
  readonly nextStep: string;
  /** Private diagnostic data; callers store it outside the ledger. */
  readonly diagnostic?: string;
  /** Private, like `diagnostic`. */
  readonly exception?: LabFailureException;
};

export type ProvisionResult<Handle extends LabHandle> =
  { readonly status: "ready"; readonly handle: Handle } | ProvisionIncomplete;

/** A failed provision as a caller that caught its exception reports it. */
export function provisionThrew(error: unknown): ProvisionIncomplete {
  return {
    status: "incomplete",
    reason: "provision",
    nextStep: "Read the Lab diagnostic, then provision a fresh Lab",
    exception: describeLabException(error),
  };
}

/**
 * Seals why a Lab could not be set up in Private Evidence and returns the
 * digest the ledger's `lab-diagnostic` artifact refers to (#284).
 */
export async function storeLabDiagnostic(
  store: Pick<PrivateArtifactStore, "putFiles">,
  failureStage: "provision" | "seed" | "probe",
  failed: ProvisionIncomplete,
): Promise<string> {
  const { status: _status, diagnostic, ...summary } = failed;
  return store.putFiles({
    "lab-diagnostic.json": canonicalJson({ failureStage, ...summary }),
    ...(diagnostic === undefined ? {} : { "stderr.txt": diagnostic }),
  });
}

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
