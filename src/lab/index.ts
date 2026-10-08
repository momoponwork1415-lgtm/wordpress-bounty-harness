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
    };

export interface LabProvisioner<Setup, Handle extends LabHandle> {
  provision(snapshot: unknown, setup: Setup): Promise<ProvisionResult<Handle>>;
  seedCanaries(handle: Handle): Promise<
    | { readonly status: "seeded"; readonly digest: string }
    | {
        readonly status: "incomplete";
        readonly reason: "provision";
        readonly nextStep: string;
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
