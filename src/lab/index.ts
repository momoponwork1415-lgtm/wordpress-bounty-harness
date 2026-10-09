/** A profile owns target-specific setup; the generic Lab boundary only carries receipts. */
export interface LabHandle {
  readonly id: string;
  readonly snapshotDigest: string;
  readonly setupDigest: string;
  readonly endpoint: string;
}

export type ProvisionResult<Handle extends LabHandle> =
  | { readonly status: "ready"; readonly handle: Handle }
  | {
      readonly status: "incomplete";
      readonly reason: "provision";
      readonly nextStep: string;
      /** Private diagnostic data; callers store it outside the ledger. */
      readonly diagnostic?: string;
    };

export type LabReachability = {
  readonly http: "ok" | "failed";
  readonly database: "ok" | "failed" | "not-exposed";
};

export interface LabProvisioner<Setup, Handle extends LabHandle> {
  provision(snapshot: unknown, setup: Setup): Promise<ProvisionResult<Handle>>;
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
