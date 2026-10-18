import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import { z } from "zod";
import {
  verificationResultV1Schema,
  type VerificationResultV1,
} from "../verification/reproduction-package.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const PACKAGE_FILE_LIMIT = 1024 * 1024;

/**
 * What a review Lab needs from `lab.json`: the frozen Snapshot and Lab setup
 * digests the Lab must reproduce, and the setup and Snapshot it was built from.
 * A profile reads `setup` and `snapshot` with its own schema; the rest of the
 * file is passed through as written.
 */
export const labReconstructionSchema = z.looseObject({
  snapshotDigest: digest,
  labSetupDigest: digest,
  setup: z.unknown(),
  snapshot: z.unknown(),
});
export type LabReconstruction = z.infer<typeof labReconstructionSchema>;

/** A review Lab is rebuilt from the sealed package alone; the ledger holds only its digest. */
export async function openLabReconstruction(
  store: PrivateArtifactStore,
  packageDigest: string,
): Promise<
  | { readonly status: "opened"; readonly reconstruction: LabReconstruction }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "missing"
        | "malformed"
        | "integrity-mismatch"
        | "size-limit-exceeded"
        | "unsafe";
    }
> {
  const file = await store.readJson(
    packageDigest,
    "lab.json",
    labReconstructionSchema,
    PACKAGE_FILE_LIMIT,
  );
  return file.status === "resolved"
    ? { status: "opened", reconstruction: file.value }
    : { status: "unavailable", reason: file.status };
}

/** Review opens the sealed private artifact through its digest, never ledger text. */
export async function openReproductionPackage(
  store: PrivateArtifactStore,
  candidate: VerificationResultV1,
): Promise<
  | { readonly status: "unavailable" }
  | {
      readonly status: "opened";
      readonly manual: string;
      readonly script: string;
      /** Passed through as written; older packages carry less than `labReconstructionSchema`. */
      readonly reconstruction: unknown;
      readonly evidence: unknown;
      /** Null for packages sealed before agent-authored sidecars were added. */
      readonly agentAuthored: unknown | null;
      readonly acceptanceCriteria?: Extract<
        VerificationResultV1,
        { status: "runtime-confirmed" }
      >["acceptanceCriteria"];
      readonly reproductionTemplate?: Extract<
        VerificationResultV1,
        { status: "runtime-confirmed" }
      >["reproductionTemplate"];
    }
> {
  const result = verificationResultV1Schema.parse(candidate);
  if (result.status !== "runtime-confirmed" && result.status !== "reproduced")
    return { status: "unavailable" };
  const digest = result.reproductionPackageDigest;
  const limit = PACKAGE_FILE_LIMIT;
  const [manual, script, lab, evidence, sidecar] = await Promise.all([
    store.readFile(digest, "manual.md", limit),
    store.readFile(digest, "reproduce.py", limit),
    store.readJson(digest, "lab.json", z.unknown(), limit),
    store.readJson(digest, "evidence.json", evidenceFileSchema, limit),
    store.readJson(digest, "agent-authored.json", z.unknown(), limit),
  ]);
  if (
    manual.status !== "resolved" ||
    script.status !== "resolved" ||
    lab.status !== "resolved" ||
    evidence.status !== "resolved" ||
    evidence.value.judgeEvidenceDigest !== result.evidenceDigest ||
    (sidecar.status !== "resolved" && sidecar.status !== "missing")
  )
    return { status: "unavailable" };
  return {
    status: "opened",
    manual: manual.bytes.toString("utf8"),
    script: script.bytes.toString("utf8"),
    reconstruction: lab.value,
    evidence: evidence.value,
    agentAuthored: sidecar.status === "resolved" ? sidecar.value : null,
    ...(result.acceptanceCriteria === undefined
      ? {}
      : { acceptanceCriteria: result.acceptanceCriteria }),
    ...(result.reproductionTemplate === undefined
      ? {}
      : { reproductionTemplate: result.reproductionTemplate }),
  };
}

/** Only the back-reference is checked; the rest of the file is passed through as written. */
const evidenceFileSchema = z.looseObject({
  judgeEvidenceDigest: digest,
});
