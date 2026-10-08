import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { measureCanonicalSourceTree } from "../infrastructure/canonical-source-tree.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const id = z.string().min(1).max(128);

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
  }),
  z.strictObject({
    status: z.literal("contradicted"),
    judgeId: id,
    evidenceDigest: digest,
  }),
  z.strictObject({
    status: z.literal("incomplete"),
    reason: z.enum([
      "provision",
      "precondition",
      "recipe",
      "observation",
      "evidence",
      "cleanup",
      "digest-mismatch",
      "no-judge",
    ]),
    nextStep: z.string().min(1).max(2000),
  }),
]);

export type VerificationResultV1 = z.infer<typeof verificationResultV1Schema>;

const judgeResultSchema = z.discriminatedUnion("status", [
  verificationResultV1Schema.options[0].omit({
    reproductionPackageDigest: true,
  }),
  verificationResultV1Schema.options[1],
  verificationResultV1Schema.options[2],
]);

export interface ReproductionRenderer<Reconstruction> {
  render(input: {
    readonly route: unknown;
    readonly snapshotDigest: string;
    readonly reconstruction: Reconstruction;
    readonly labSetupDigest: string;
    readonly evidenceDigest: string;
    readonly store: PrivateArtifactStore;
  }): Promise<{
    readonly manual: string;
    readonly script: string;
    readonly reconstruction: unknown;
    readonly evidence: unknown;
  }>;
}

/** Publishes only a judge-owned confirmed route; the renderer cannot promote a finding. */
export async function publishReproductionPackage<Reconstruction>(input: {
  readonly store: PrivateArtifactStore;
  readonly renderer: ReproductionRenderer<Reconstruction>;
  readonly findingSnapshotDigest: string;
  readonly labSnapshotDigest: string;
  readonly labSetupDigest: string;
  readonly judgeResult: unknown;
  readonly reconstruction: Reconstruction;
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
  if (judge.status !== "runtime-confirmed") {
    return {
      status: "incomplete",
      reason: "precondition",
      nextStep:
        "A Harness judge must confirm the nonce canary before packaging",
    };
  }
  const routeFile = await input.store.readFile(
    judge.evidenceDigest,
    "confirmed-route.json",
    64 * 1024,
  );
  if (routeFile.status !== "resolved") {
    return {
      status: "incomplete",
      reason: "evidence",
      nextStep: "Restore the judge-owned confirmed route and repeat packaging",
    };
  }
  let staging: Awaited<ReturnType<PrivateArtifactStore["stage"]>> | undefined;
  try {
    const route: unknown = JSON.parse(routeFile.bytes.toString("utf8"));
    const routeEnvelope = z
      .object({
        snapshotDigest: digest,
        labSetupDigest: digest,
      })
      .safeParse(route);
    if (!routeEnvelope.success)
      throw new Error("Judge route has no snapshot digest");
    if (
      routeEnvelope.data.snapshotDigest !== input.findingSnapshotDigest ||
      routeEnvelope.data.labSetupDigest !== input.labSetupDigest
    ) {
      return {
        status: "incomplete",
        reason: "digest-mismatch",
        nextStep: "Repeat verification against the finding snapshot",
      };
    }
    const rendered = await input.renderer.render({
      route,
      snapshotDigest: input.findingSnapshotDigest,
      reconstruction: input.reconstruction,
      labSetupDigest: input.labSetupDigest,
      evidenceDigest: judge.evidenceDigest,
      store: input.store,
    });
    staging = await input.store.stage();
    await Promise.all([
      writeFile(join(staging.contentDirectory, "manual.md"), rendered.manual, {
        mode: 0o600,
      }),
      writeFile(
        join(staging.contentDirectory, "reproduce.py"),
        rendered.script,
        { mode: 0o600 },
      ),
      writeFile(
        join(staging.contentDirectory, "lab.json"),
        JSON.stringify(rendered.reconstruction),
        { mode: 0o600 },
      ),
      writeFile(
        join(staging.contentDirectory, "evidence.json"),
        JSON.stringify(rendered.evidence),
        { mode: 0o600 },
      ),
    ]);
    const measured = await measureCanonicalSourceTree(
      staging.contentDirectory,
      {
        maxEntries: 4,
        maxBytes: 1024 * 1024,
      },
    );
    const committed = await input.store.commit(measured.digest, staging);
    if (committed.status === "conflict")
      throw new Error("Package artifact conflict");
    staging = undefined;
    return {
      status: "runtime-confirmed",
      judgeId: judge.judgeId,
      proofKind: judge.proofKind,
      conditions: judge.conditions,
      evidenceDigest: judge.evidenceDigest,
      reproductionPackageDigest: committed.artifact.digest,
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
