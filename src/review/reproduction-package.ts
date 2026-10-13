import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import { z } from "zod";
import {
  verificationResultV1Schema,
  type VerificationResultV1,
} from "../verification/reproduction-package.js";

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
  const files = await Promise.all(
    ["manual.md", "reproduce.py", "lab.json", "evidence.json"].map((name) =>
      store.readFile(result.reproductionPackageDigest, name, 1024 * 1024),
    ),
  );
  if (files.some((file) => file.status !== "resolved"))
    return { status: "unavailable" };
  const [manual, script, lab, evidence] = files;
  if (
    manual?.status !== "resolved" ||
    script?.status !== "resolved" ||
    lab?.status !== "resolved" ||
    evidence?.status !== "resolved"
  )
    return { status: "unavailable" };
  try {
    const evidenceRecord: unknown = JSON.parse(evidence.bytes.toString("utf8"));
    const evidenceRef = z
      .object({
        judgeEvidenceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      })
      .safeParse(evidenceRecord);
    if (
      !evidenceRef.success ||
      evidenceRef.data.judgeEvidenceDigest !== result.evidenceDigest
    )
      return { status: "unavailable" };
    const sidecar = await store.readFile(
      result.reproductionPackageDigest,
      "agent-authored.json",
      1024 * 1024,
    );
    if (sidecar.status !== "resolved" && sidecar.status !== "missing")
      return { status: "unavailable" };
    return {
      status: "opened",
      manual: manual.bytes.toString("utf8"),
      script: script.bytes.toString("utf8"),
      reconstruction: JSON.parse(lab.bytes.toString("utf8")) as unknown,
      evidence: evidenceRecord,
      agentAuthored:
        sidecar.status === "resolved"
          ? (JSON.parse(sidecar.bytes.toString("utf8")) as unknown)
          : null,
      ...(result.acceptanceCriteria === undefined
        ? {}
        : { acceptanceCriteria: result.acceptanceCriteria }),
      ...(result.reproductionTemplate === undefined
        ? {}
        : { reproductionTemplate: result.reproductionTemplate }),
    };
  } catch {
    return { status: "unavailable" };
  }
}
