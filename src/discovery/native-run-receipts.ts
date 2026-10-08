import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  canonicalDigest,
  canonicalJson,
} from "../infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import {
  agentRuntimeProfileSchema,
  type AgentRuntimeProfile,
} from "./agent-runtime-profile.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
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
  terminal: z.enum(["completed", "incomplete"]),
  reason: z.union([
    z.enum(["provider", "schema", "sandbox", "policy", "evidence"]),
    z.literal("unavailable"),
  ]),
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
  });
export type NativeRunReceipt = z.infer<typeof nativeRunReceiptSchema>;

export interface NativeRunIdentity {
  readonly runId: string;
  readonly targetSnapshotDigest: string;
  readonly profile: AgentRuntimeProfile;
}

export function createNativeRunReceipt(
  input: NativeRunIdentity & {
    readonly terminal: "completed" | "incomplete";
    readonly reason: NativeRunReceipt["reason"];
    readonly startedAt: string;
    readonly completedAt: string;
    readonly usage?: z.infer<typeof usage>;
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
    terminal: input.terminal,
    reason: input.reason,
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

export class NativeRunReceiptStore {
  readonly #artifacts: PrivateArtifactStore;

  constructor(rootDirectory: string) {
    this.#artifacts = new PrivateArtifactStore({
      rootDirectory,
      maxEntries: 1,
      maxBytes: 1024 * 1024,
    });
  }

  async finalize(
    identity: NativeRunIdentity,
    receipt: NativeRunReceipt,
  ): Promise<void> {
    nativeRunReceiptSchema.parse(receipt);
    if (
      receipt.runId !== identity.runId ||
      receipt.targetSnapshotDigest !== identity.targetSnapshotDigest ||
      receipt.runtimeProfileDigest !== identity.profile.digest
    ) {
      throw new Error("Receipt does not match the run identity");
    }
    const staging = await this.#artifacts.stage();
    try {
      await writeFile(
        join(staging.contentDirectory, "receipt.json"),
        canonicalJson(receipt),
        { flag: "wx", mode: 0o600 },
      );
      const stored = await this.#artifacts.commit(
        canonicalDigest(identity).slice(7),
        staging,
      );
      if (stored.status === "conflict")
        throw new Error("Native run receipt conflict");
    } catch (error: unknown) {
      await rm(staging.rootDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  async recover(
    identity: NativeRunIdentity,
  ): Promise<
    | { status: "recovered"; receipt: NativeRunReceipt }
    | { status: "missing" | "invalid" }
  > {
    const file = await this.#artifacts.readFile(
      canonicalDigest(identity).slice(7),
      "receipt.json",
      1024 * 1024,
    );
    if (file.status === "missing") return { status: "missing" };
    if (file.status !== "resolved") return { status: "invalid" };
    try {
      const encoded = file.bytes.toString("utf8");
      const receipt = nativeRunReceiptSchema.parse(
        JSON.parse(encoded) as unknown,
      );
      if (
        encoded !== canonicalJson(receipt) ||
        receipt.runId !== identity.runId ||
        receipt.targetSnapshotDigest !== identity.targetSnapshotDigest ||
        receipt.runtimeProfileDigest !== identity.profile.digest
      )
        return { status: "invalid" };
      return { status: "recovered", receipt };
    } catch {
      return { status: "invalid" };
    }
  }
}
