/**
 * What the generic campaign pipeline needs from a selected target. How targets
 * are chosen belongs to the profile (`profiles/wordpress/selection`) and is not
 * generalised until a second profile exists (ADR 0011).
 */
export interface TargetSelection {
  readonly targetId: string;
  readonly version: string;
  readonly score: number;
  readonly selectedAt: string;
  readonly policy: { readonly id: string; readonly digest: string };
}
