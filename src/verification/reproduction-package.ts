import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { measureCanonicalSourceTree } from "../infrastructure/canonical-source-tree.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const id = z.string().min(1).max(128);
/** Only the digests are checked here; the profile renderer parses the whole route. */
const routeEnvelopeSchema = z.looseObject({
  snapshotDigest: digest,
  labSetupDigest: digest,
});
const packageDocumentReferenceSchema = z.strictObject({
  id,
  version: z.number().int().positive(),
  digest,
});

export type PackageDocumentReference = z.infer<
  typeof packageDocumentReferenceSchema
>;

/** What the judge itself observed: roles used and reached, configuration, and so on. */
const conditionsSchema = z
  .record(
    z.string().regex(/^[a-z][A-Za-z0-9-]{0,63}$/),
    z.string().min(1).max(256),
  )
  .refine((value) => Object.keys(value).length <= 20)
  .default({});

export const verificationResultV1Schema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("runtime-confirmed"),
    judgeId: id,
    proofKind: z.literal("nonce-canary"),
    conditions: conditionsSchema,
    evidenceDigest: digest,
    reproductionPackageDigest: digest,
    /** Absent on packages recorded before the profile introduced templates. */
    acceptanceCriteria: packageDocumentReferenceSchema.optional(),
    reproductionTemplate: packageDocumentReferenceSchema.optional(),
  }),
  z.strictObject({
    status: z.literal("reproduced"),
    reproducerId: id,
    proofKind: z.literal("captured-script-observation"),
    conditions: conditionsSchema,
    evidenceDigest: digest,
    reproductionPackageDigest: digest,
    /** A fixed release does not exist for a current, unpatched target. */
    negativeControl: z.enum([
      "unavailable-no-fixed-release",
      "pending-fixed-version",
    ]),
    acceptanceCriteria: packageDocumentReferenceSchema.optional(),
    reproductionTemplate: packageDocumentReferenceSchema.optional(),
  }),
  z.strictObject({
    status: z.literal("contradicted"),
    judgeId: id,
    evidenceDigest: digest,
    refutationDigest: digest.optional(),
  }),
  z.strictObject({
    status: z.literal("incomplete"),
    reason: z.enum([
      "provision",
      "precondition",
      "recipe",
      "provider",
      "sandbox",
      "observation",
      "evidence",
      "cleanup",
      "digest-mismatch",
      "no-judge",
    ]),
    nextStep: z.string().min(1).max(2000),
    /** Lab teardown failed; retain opaque ids so a resumed campaign can inspect them. */
    cleanupLabIds: z.array(id).min(1).max(2).optional(),
    /** A profile found an ordinary Lab scenario to try before human review. */
    nextScenarioId: id.optional(),
    evidenceDigest: digest.optional(),
    refutationDigest: digest.optional(),
  }),
]);

export type VerificationResultV1 = z.infer<typeof verificationResultV1Schema>;

const judgeResultSchema = z.discriminatedUnion("status", [
  verificationResultV1Schema.options[0].omit({
    reproductionPackageDigest: true,
    acceptanceCriteria: true,
    reproductionTemplate: true,
  }),
  verificationResultV1Schema.options[1].omit({
    reproductionPackageDigest: true,
    negativeControl: true,
    acceptanceCriteria: true,
    reproductionTemplate: true,
  }),
  verificationResultV1Schema.options[2],
  verificationResultV1Schema.options[3],
]);

export interface ReproductionRenderer<Reconstruction> {
  render(input: {
    /** Finding classification; its original claim may be agent-authored. */
    readonly category: string;
    readonly judgeId: string;
    readonly proofKind: "nonce-canary" | "captured-script-observation";
    readonly conditions: Readonly<Record<string, string>>;
    readonly route: unknown;
    readonly snapshotDigest: string;
    readonly reconstruction: Reconstruction;
    readonly labSetupDigest: string;
    readonly evidenceDigest: string;
    readonly store: PrivateArtifactStore;
    readonly setup?: unknown;
    readonly snapshot?: unknown;
    readonly negativeControl?:
      "unavailable-no-fixed-release" | "pending-fixed-version";
  }): Promise<{
    readonly manual: string;
    readonly script: string;
    readonly reconstruction: unknown;
    readonly evidence: unknown;
    readonly acceptanceCriteria?: PackageDocumentReference;
    readonly reproductionTemplate?: PackageDocumentReference;
    /** Private sidecars. The publisher currently admits only agent-authored.json. */
    readonly auxiliaryFiles?: Readonly<Record<string, string>>;
  }>;
}

/** Publishes only a judge-owned confirmed route; the renderer cannot promote a finding. */
export async function publishReproductionPackage<Reconstruction>(input: {
  readonly store: PrivateArtifactStore;
  readonly renderer: ReproductionRenderer<Reconstruction>;
  readonly category: string;
  readonly findingSnapshotDigest: string;
  readonly labSnapshotDigest: string;
  readonly labSetupDigest: string;
  readonly judgeResult: unknown;
  readonly reconstruction: Reconstruction;
  readonly negativeControl?:
    "unavailable-no-fixed-release" | "pending-fixed-version";
  readonly setup?: unknown;
  readonly snapshot?: unknown;
}): Promise<VerificationResultV1> {
  const judge = judgeResultSchema.parse(input.judgeResult);
  if (
    !digest.safeParse(input.findingSnapshotDigest).success ||
    !digest.safeParse(input.labSnapshotDigest).success ||
    !digest.safeParse(input.labSetupDigest).success ||
    input.findingSnapshotDigest !== input.labSnapshotDigest
  ) {
    return {
      status: "incomplete",
      reason: "digest-mismatch",
      nextStep: "Repeat verification against the finding snapshot",
    };
  }
  if (judge.status !== "runtime-confirmed" && judge.status !== "reproduced") {
    return {
      status: "incomplete",
      reason: "precondition",
      nextStep: "A Harness observation is required before packaging",
    };
  }
  const routeFile = await input.store.readJson(
    judge.evidenceDigest,
    judge.status === "runtime-confirmed"
      ? "confirmed-route.json"
      : "reproduced-route.json",
    routeEnvelopeSchema,
    64 * 1024,
  );
  if (routeFile.status === "malformed") {
    return {
      status: "incomplete",
      reason: "evidence",
      nextStep: "Repair the confirmed route or evidence and repeat packaging",
    };
  }
  if (routeFile.status !== "resolved") {
    return {
      status: "incomplete",
      reason: "evidence",
      nextStep: "Restore the judge-owned confirmed route and repeat packaging",
    };
  }
  let staging: Awaited<ReturnType<PrivateArtifactStore["stage"]>> | undefined;
  try {
    const route = routeFile.value;
    if (
      route.snapshotDigest !== input.findingSnapshotDigest ||
      route.labSetupDigest !== input.labSetupDigest
    ) {
      return {
        status: "incomplete",
        reason: "digest-mismatch",
        nextStep: "Repeat verification against the finding snapshot",
      };
    }
    const rendered = await input.renderer.render({
      route,
      category: input.category,
      judgeId:
        judge.status === "runtime-confirmed"
          ? judge.judgeId
          : judge.reproducerId,
      proofKind: judge.proofKind,
      conditions: judge.conditions,
      snapshotDigest: input.findingSnapshotDigest,
      reconstruction: input.reconstruction,
      labSetupDigest: input.labSetupDigest,
      evidenceDigest: judge.evidenceDigest,
      store: input.store,
      ...(input.setup === undefined ? {} : { setup: input.setup }),
      ...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
      ...(input.negativeControl === undefined
        ? {}
        : { negativeControl: input.negativeControl }),
    });
    const auxiliaryFiles = rendered.auxiliaryFiles ?? {};
    const auxiliaryNames = Object.keys(auxiliaryFiles);
    if (
      auxiliaryNames.length > 1 ||
      auxiliaryNames.some((name) => name !== "agent-authored.json")
    )
      throw new Error("Unsupported reproduction package auxiliary file");
    const acceptanceCriteria =
      rendered.acceptanceCriteria === undefined
        ? undefined
        : packageDocumentReferenceSchema.parse(rendered.acceptanceCriteria);
    const reproductionTemplate =
      rendered.reproductionTemplate === undefined
        ? undefined
        : packageDocumentReferenceSchema.parse(rendered.reproductionTemplate);
    if (reproductionTemplate === undefined)
      throw new Error("A versioned reproduction template is required");
    const packageStaging = await input.store.stage();
    staging = packageStaging;
    await Promise.all([
      writeFile(
        join(packageStaging.contentDirectory, "manual.md"),
        rendered.manual,
        {
          mode: 0o600,
        },
      ),
      writeFile(
        join(packageStaging.contentDirectory, "reproduce.py"),
        rendered.script,
        { mode: 0o600 },
      ),
      writeFile(
        join(packageStaging.contentDirectory, "lab.json"),
        JSON.stringify(rendered.reconstruction),
        { mode: 0o600 },
      ),
      writeFile(
        join(packageStaging.contentDirectory, "evidence.json"),
        JSON.stringify(rendered.evidence),
        { mode: 0o600 },
      ),
      ...auxiliaryNames.map((name) =>
        writeFile(
          join(packageStaging.contentDirectory, name),
          auxiliaryFiles[name]!,
          { mode: 0o600 },
        ),
      ),
    ]);
    const measured = await measureCanonicalSourceTree(
      packageStaging.contentDirectory,
      {
        maxEntries: 5,
        maxBytes: 1024 * 1024,
      },
    );
    const committed = await input.store.commit(measured.digest, packageStaging);
    if (committed.status === "conflict")
      throw new Error("Package artifact conflict");
    staging = undefined;
    const packaged = {
      conditions: judge.conditions,
      evidenceDigest: judge.evidenceDigest,
      reproductionPackageDigest: committed.artifact.digest,
      ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
      ...(reproductionTemplate === undefined ? {} : { reproductionTemplate }),
    };
    return judge.status === "runtime-confirmed"
      ? {
          ...packaged,
          status: "runtime-confirmed",
          judgeId: judge.judgeId,
          proofKind: judge.proofKind,
        }
      : {
          ...packaged,
          status: "reproduced",
          reproducerId: judge.reproducerId,
          proofKind: judge.proofKind,
          negativeControl: input.negativeControl ?? "pending-fixed-version",
        };
  } catch {
    return {
      status: "incomplete",
      reason: "evidence",
      nextStep: "Repair the confirmed route or evidence and repeat packaging",
    };
  } finally {
    if (staging !== undefined)
      await rm(staging.rootDirectory, { recursive: true, force: true });
  }
}
