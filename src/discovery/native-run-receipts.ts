import { z } from "zod";

import {
  canonicalDigest,
  canonicalJson,
} from "../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import type { LedgerEventV1 } from "../ledger/index.js";
import {
  agentRuntimeProfileSchema,
  type AgentRuntimeProfile,
} from "./agent-runtime-profile.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** A Codex thread id as the CLI prints it in `thread.started`. */
export const codexThreadIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
/**
 * A session file's path relative to `$CODEX_HOME/sessions`: dated directories
 * and one `rollout-*.jsonl`, no `.` or `..` segments. `codex exec resume`
 * finds the thread by this layout, so a restored file must keep its path.
 */
export function isCodexSessionPath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false;
  const segments = path.split("/");
  if (segments.length > 6) return false;
  const file = segments.at(-1)!;
  return (
    segments
      .slice(0, -1)
      .every(
        (segment) =>
          /^[A-Za-z0-9_.-]+$/.test(segment) &&
          segment !== "." &&
          segment !== "..",
      ) && /^rollout-[A-Za-z0-9_.-]+\.jsonl$/.test(file)
  );
}
const codexSessionPathSchema = z.string().refine(isCodexSessionPath, {
  message: "Codex session path is not a sessions-relative rollout file",
});
const reported = z.union([
  z.string().min(1).max(128),
  z.literal("unavailable"),
]);
const count = z.number().int().nonnegative();
const usage = z.strictObject({
  inputTokens: z.union([count, z.literal("unavailable")]),
  cachedInputTokens: z.union([count, z.literal("unavailable")]),
  outputTokens: z.union([count, z.literal("unavailable")]),
  reasoningOutputTokens: z.union([count, z.literal("unavailable")]),
});
const observed = z.strictObject({
  toolCalls: count,
  filesRead: count,
  uniqueFilesRead: count,
  labRequests: count,
  dbQueries: count,
});
const bodySchema = z.strictObject({
  kind: z.literal("native-run-receipt"),
  schemaVersion: z.literal(1),
  runId: z.string().min(1).max(128),
  targetSnapshotDigest: digest,
  runtimeProfileDigest: digest,
  requestedModelId: reported,
  requestedEffort: reported,
  codexCliVersion: reported,
  bundledCatalogDigest: z.union([digest, z.literal("unavailable")]),
  authenticationMethod: reported,
  cyberAccessProgram: reported,
  serviceTier: reported,
  subagent: z.strictObject({ modelId: reported, effort: reported }),
  usage,
  observed: observed.optional(),
  /** Unique direct child threads seen in the Root rollout. */
  childThreadsObserved: count.optional(),
  /** Direct child threads captured across all waves (at most 255 session files). */
  childThreadsAdmitted: count.optional(),
  brokerMetrics: z
    .strictObject({
      forwardedRequests: count,
      requestLimitExceeded: count,
      unauthorizedRequests: count,
      upstreamSuccess: count.optional(),
      upstreamClientError: count.optional(),
      upstreamServerError: count.optional(),
      relayFailures: count.optional(),
      responseLimitExceeded: count.optional(),
    })
    .optional(),
  sandboxExitCode: z.number().int().optional(),
  diagnosticArtifactDigest: digest.optional(),
  /**
   * The cooperative Root thread and the session files Private Evidence holds
   * for it (ADR 0036). An operator may resume the same thread in a new
   * disposable sandbox from these; receipts without it are not resumable.
   */
  session: z
    .strictObject({
      rootThreadId: codexThreadIdSchema,
      /** Root turns this segment started (`thread.started` events); the last one is the one that failed. */
      rootTurns: count,
      /** Which resume segment this receipt records; the original run is 0. */
      segment: count,
      files: z
        .array(
          z.strictObject({
            path: codexSessionPathSchema,
            threadId: codexThreadIdSchema,
            kind: z.enum(["root", "child"]),
            diagnosticArtifactDigest: digest,
          }),
        )
        .max(256),
    })
    .optional(),
  terminal: z.enum(["completed", "incomplete"]),
  reason: z.union([
    z.enum([
      "provider",
      "schema",
      "sandbox",
      "policy",
      "evidence",
      "wall",
      "operator",
      /** The host process died mid-run; recovered from the sandbox's leftovers (ADR 0036). */
      "interrupted",
    ]),
    z.literal("unavailable"),
  ]),
  reasonDetail: z
    .string()
    .regex(/^[a-z0-9][a-z0-9:_-]{0,127}$/)
    .optional(),
  /** The subscription refused the run; the campaign stops instead of retrying. */
  providerLimit: z.enum(["rate-limit", "quota"]).optional(),
  startedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }),
  isolation: z.strictObject({
    backend: z.literal("gvisor"),
    runtime: z.literal("runsc"),
    fallbackUsed: z.literal(false),
  }),
  grantReceiptDigest: z.union([digest, z.literal("unavailable")]),
  reportArtifactDigest: z.union([digest, z.literal("unavailable")]),
});

export const nativeRunReceiptSchema = bodySchema
  .extend({ digest })
  .superRefine((receipt, context) => {
    const { digest: actual, ...body } = receipt;
    if (actual !== canonicalDigest(body))
      context.addIssue({
        code: "custom",
        path: ["digest"],
        message: "Receipt digest mismatch",
      });
    if (receipt.providerLimit !== undefined && receipt.reason !== "provider")
      context.addIssue({
        code: "custom",
        path: ["providerLimit"],
        message: "Only a provider failure carries a provider limit",
      });
    if (
      (receipt.terminal === "completed") !==
      (receipt.reason === "unavailable")
    ) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Terminal and reason mismatch",
      });
    }
    if (
      (receipt.childThreadsObserved === undefined) !==
      (receipt.childThreadsAdmitted === undefined)
    )
      context.addIssue({
        code: "custom",
        path: ["childThreadsAdmitted"],
        message: "Child counts must be recorded together",
      });
    if (
      receipt.childThreadsAdmitted !== undefined &&
      (receipt.childThreadsAdmitted > 255 ||
        (receipt.childThreadsObserved !== undefined &&
          receipt.childThreadsAdmitted > receipt.childThreadsObserved))
    )
      context.addIssue({
        code: "custom",
        path: ["childThreadsAdmitted"],
        message: "Admitted child count exceeds observed count or limit",
      });
  });
export type NativeRunReceipt = z.infer<typeof nativeRunReceiptSchema>;
export type NativeRunSession = NonNullable<NativeRunReceipt["session"]>;

export interface NativeRunIdentity {
  readonly runId: string;
  readonly targetSnapshotDigest: string;
  readonly profile: AgentRuntimeProfile;
}

export function createNativeRunReceipt(
  input: NativeRunIdentity & {
    readonly terminal: "completed" | "incomplete";
    readonly reason: NativeRunReceipt["reason"];
    readonly reasonDetail?: string;
    readonly providerLimit?: "rate-limit" | "quota";
    readonly startedAt: string;
    readonly completedAt: string;
    readonly usage?: z.infer<typeof usage>;
    readonly observed?: z.infer<typeof observed>;
    readonly childThreadsObserved?: number;
    readonly childThreadsAdmitted?: number;
    readonly brokerMetrics?: NativeRunReceipt["brokerMetrics"];
    readonly sandboxExitCode?: number;
    readonly diagnosticArtifactDigest?: string;
    readonly session?: NativeRunSession;
    readonly grantReceiptDigest?: string;
    readonly reportArtifactDigest?: string;
  },
): NativeRunReceipt {
  const profile = agentRuntimeProfileSchema.parse(input.profile);
  const body = bodySchema.parse({
    kind: "native-run-receipt",
    schemaVersion: 1,
    runId: input.runId,
    targetSnapshotDigest: input.targetSnapshotDigest,
    runtimeProfileDigest: profile.digest,
    requestedModelId: profile.requestedModelId,
    requestedEffort: profile.requestedEffort,
    codexCliVersion: profile.codexCliVersion,
    bundledCatalogDigest: profile.bundledCatalogDigest,
    authenticationMethod: profile.authenticationMethod,
    cyberAccessProgram: profile.cyberAccessProgram,
    serviceTier: profile.serviceTier,
    subagent: profile.subagent,
    usage: input.usage ?? {
      inputTokens: "unavailable",
      cachedInputTokens: "unavailable",
      outputTokens: "unavailable",
      reasoningOutputTokens: "unavailable",
    },
    ...(input.observed === undefined ? {} : { observed: input.observed }),
    ...(input.childThreadsObserved === undefined
      ? {}
      : { childThreadsObserved: input.childThreadsObserved }),
    ...(input.childThreadsAdmitted === undefined
      ? {}
      : { childThreadsAdmitted: input.childThreadsAdmitted }),
    ...(input.brokerMetrics === undefined
      ? {}
      : { brokerMetrics: input.brokerMetrics }),
    ...(input.sandboxExitCode === undefined
      ? {}
      : { sandboxExitCode: input.sandboxExitCode }),
    ...(input.diagnosticArtifactDigest === undefined
      ? {}
      : { diagnosticArtifactDigest: input.diagnosticArtifactDigest }),
    ...(input.session === undefined ? {} : { session: input.session }),
    terminal: input.terminal,
    reason: input.reason,
    ...(input.reasonDetail === undefined
      ? {}
      : { reasonDetail: input.reasonDetail }),
    ...(input.providerLimit === undefined
      ? {}
      : { providerLimit: input.providerLimit }),
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    isolation: { backend: "gvisor", runtime: "runsc", fallbackUsed: false },
    grantReceiptDigest: input.grantReceiptDigest ?? "unavailable",
    reportArtifactDigest: input.reportArtifactDigest ?? "unavailable",
  });
  return nativeRunReceiptSchema.parse({
    ...body,
    digest: canonicalDigest(body),
  });
}

/** The one file of a sealed receipt artifact in Private Evidence. */
export const NATIVE_RUN_RECEIPT_FILE = "receipt.json";
/** Every receipt string is at most 128 characters; a sealed receipt stays far below this. */
const NATIVE_RUN_RECEIPT_MAX_BYTES = 64 * 1024;

/** Seals one validated receipt into Private Evidence; the digest is what the ledger references. */
export async function sealNativeRunReceipt(
  evidence: Pick<PrivateArtifactStore, "putFiles">,
  receipt: NativeRunReceipt,
): Promise<string> {
  return evidence.putFiles({
    [NATIVE_RUN_RECEIPT_FILE]: canonicalJson(
      nativeRunReceiptSchema.parse(receipt),
    ),
  });
}

/**
 * Reads a sealed receipt back by its artifact digest. Absent or unreadable
 * evidence is `undefined`; content that is not a receipt throws, since a
 * `native-run-receipt` artifact holding anything else is a Harness defect.
 */
export async function readNativeRunReceipt(
  evidence: Pick<PrivateArtifactStore, "readJson">,
  artifactDigest: string,
): Promise<NativeRunReceipt | undefined> {
  const file = await evidence.readJson(
    artifactDigest,
    NATIVE_RUN_RECEIPT_FILE,
    nativeRunReceiptSchema,
    NATIVE_RUN_RECEIPT_MAX_BYTES,
  );
  if (file.status === "malformed")
    throw new Error(`Private run receipt is malformed (${file.reason})`);
  if (file.status !== "resolved") return undefined;
  return file.value;
}

type RunFinishedEvent = Extract<
  LedgerEventV1,
  { type: "discovery-run-finished" }
>;

/** The wall the receipt itself records; never negative. */
export function receiptWallTimeMs(receipt: NativeRunReceipt): number {
  return Math.max(
    0,
    Date.parse(receipt.completedAt) - Date.parse(receipt.startedAt),
  );
}

/**
 * The `discovery-run-finished` fields a receipt supplies, optional ones only
 * when present. Root and child finishes both copy a receipt through here, so a
 * new receipt field reaches the ledger by one line.
 */
export function runFinishedFieldsFrom(
  receipt: NativeRunReceipt,
): Pick<
  RunFinishedEvent,
  | "usage"
  | "observed"
  | "childThreadsObserved"
  | "childThreadsAdmitted"
  | "brokerMetrics"
  | "sandboxExitCode"
  | "diagnosticArtifactDigest"
> {
  return {
    usage: receipt.usage,
    ...(receipt.observed === undefined ? {} : { observed: receipt.observed }),
    ...(receipt.childThreadsObserved === undefined
      ? {}
      : { childThreadsObserved: receipt.childThreadsObserved }),
    ...(receipt.childThreadsAdmitted === undefined
      ? {}
      : { childThreadsAdmitted: receipt.childThreadsAdmitted }),
    ...(receipt.brokerMetrics === undefined
      ? {}
      : { brokerMetrics: receipt.brokerMetrics }),
    ...(receipt.sandboxExitCode === undefined
      ? {}
      : { sandboxExitCode: receipt.sandboxExitCode }),
    ...(receipt.diagnosticArtifactDigest === undefined
      ? {}
      : { diagnosticArtifactDigest: receipt.diagnosticArtifactDigest }),
  };
}
