/** A profile owns target-specific setup; the generic Lab boundary only carries receipts. */
export interface LabHandle {
  readonly id: string;
  readonly snapshotDigest: string;
  readonly setupDigest: string;
  readonly endpoint: string;
  /** Profile-owned, digest-pinned ordinary Lab scenario, when selected. */
  readonly scenario?: { readonly id: string; readonly digest: string };
}

export interface LabExceptionSummary {
  readonly className: string;
  readonly message: string;
}

/** Exception detail is bounded before it enters a private diagnostic artifact. */
export function describeLabException(error: unknown): LabExceptionSummary {
  const message = error instanceof Error ? error.message : String(error);
  return {
    className:
      error instanceof Error ? error.constructor.name || "Error" : typeof error,
    message: Array.from(message).slice(0, 500).join(""),
  };
}

export type ProvisionResult<Handle extends LabHandle> =
  | { readonly status: "ready"; readonly handle: Handle }
  | {
      readonly status: "incomplete";
      readonly reason: "provision" | "precondition";
      readonly nextStep: string;
      /** Private diagnostic data; callers store it outside the ledger. */
      readonly diagnostic?: string;
      readonly exception?: LabExceptionSummary;
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
        readonly exception?: LabExceptionSummary;
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
