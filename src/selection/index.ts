/** Public selection contract. Target-specific observations stay in the profile. */
export interface TargetSelection {
  readonly targetId: string;
  readonly version: string;
  readonly score: number;
  readonly selectedAt: string;
  readonly policy: { readonly id: string; readonly digest: string };
}

export interface Selection<
  TPolicy,
  TTarget extends TargetSelection,
  TInspection,
> {
  select(policy: TPolicy): Promise<readonly TTarget[]>;
  inspect(policy: TPolicy): Promise<readonly TInspection[]>;
}
