import { canonicalJson } from "../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import {
  SourceAcquisitionError,
  type SourceAcquisitionFailureKind,
} from "../snapshot/index.js";

export type TargetSkipReason = SourceAcquisitionFailureKind | "other";

/** The profile's reason code, lifted beside `kind` so the operator reads why without unpacking `detail`. */
function reasonOf(detail: unknown): { readonly reason?: string } {
  if (typeof detail !== "object" || detail === null) return {};
  const { reason, reasons } = detail as Record<string, unknown>;
  if (typeof reason === "string") return { reason };
  if (
    Array.isArray(reasons) &&
    reasons.length > 0 &&
    reasons.every((item) => typeof item === "string")
  )
    return { reason: reasons.join(",") };
  return {};
}

/** Never put an exception or URL in the ledger; store the detail privately. */
export async function storeTargetSkipDiagnostic(
  store: PrivateArtifactStore,
  error: unknown,
): Promise<{ readonly reason: TargetSkipReason; readonly digest: string }> {
  const diagnostic =
    error instanceof SourceAcquisitionError
      ? {
          kind: error.kind,
          ...reasonOf(error.diagnostic),
          detail: error.diagnostic,
        }
      : error instanceof Error
        ? {
            name: error.name,
            message: error.message.slice(0, 4096),
            stack: error.stack?.slice(0, 8192) ?? null,
          }
        : { message: String(error).slice(0, 4096) };
  return {
    reason: error instanceof SourceAcquisitionError ? error.kind : "other",
    digest: await store.putFiles({
      "target-skip-diagnostic.json": canonicalJson(diagnostic),
    }),
  };
}
