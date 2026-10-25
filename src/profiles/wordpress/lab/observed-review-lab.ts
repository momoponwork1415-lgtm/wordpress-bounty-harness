import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import type { Ledger } from "../../../ledger/index.js";
import { openLabReconstruction } from "../../../review/reproduction-package.js";
import type { ReviewRef } from "../../../review/records.js";
import { z } from "zod";

import { createWordPressVerifierRecordReader } from "../verification/verifier-record.js";
import { setupSchema } from "./provision-input.js";

const boundDialog = z.looseObject({
  snapshotDigest: z.string(),
  labSetupDigest: z.string(),
});

/**
 * The review Lab package for a person's own observation. Since #525 every
 * finished attempt (`incomplete(awaiting-human-observation)`) gets one; an
 * older `incomplete(observation)` still needs its bound stored-XSS dialog.
 */
export async function observedReviewLabPackage(input: {
  readonly ledger: Ledger;
  readonly store: PrivateArtifactStore;
  readonly ref: ReviewRef;
}): Promise<{
  readonly packageDigest: string;
  readonly recipeDigest: string;
  readonly evidenceDigest: string;
} | null> {
  const { ledger, store, ref } = input;
  const finding = ledger
    .read({
      campaignId: ref.campaignId,
      findingId: ref.findingId,
      type: "finding-recorded",
      limit: 1,
    })
    .at(0)?.event;
  const verification = ledger
    .readAll({
      campaignId: ref.campaignId,
      findingId: ref.findingId,
      type: "verification-finished",
    })
    .map(({ event }) => event)
    .at(-1);
  if (
    finding?.type !== "finding-recorded" ||
    finding.snapshotDigest !== ref.snapshotDigest ||
    ledger
      .activeParked({ campaignId: ref.campaignId })
      .some((event) => event.findingId === ref.findingId) ||
    verification?.type !== "verification-finished" ||
    verification.verificationId !== ref.verificationId ||
    verification.snapshotDigest !== ref.snapshotDigest ||
    verification.result.status !== "incomplete" ||
    (verification.result.reason !== "observation" &&
      verification.result.reason !== "awaiting-human-observation") ||
    verification.result.evidenceDigest === undefined ||
    verification.evidenceCapture !== "harness-captured"
  )
    return null;
  const recipe = verification.artifacts.find(
    (entry) => entry.kind === "recipe",
  );
  const reconstruction = verification.artifacts.find(
    (entry) => entry.kind === "review-lab-reconstruction",
  );
  if (recipe === undefined || reconstruction === undefined) return null;
  const opened = await openLabReconstruction(store, reconstruction.digest);
  if (
    opened.status !== "opened" ||
    opened.reconstruction.snapshotDigest !== ref.snapshotDigest ||
    opened.reconstruction.labSetupDigest !== verification.labSetupDigest
  )
    return null;
  const setup = setupSchema.safeParse(opened.reconstruction.setup);
  if (!setup.success || setup.data.snapshotDigest !== ref.snapshotDigest)
    return null;
  const admitted = {
    packageDigest: reconstruction.digest,
    recipeDigest: recipe.digest,
    evidenceDigest: verification.result.evidenceDigest,
  };
  if (verification.result.reason === "awaiting-human-observation")
    return admitted;
  if (finding.category !== "stored-xss") return null;
  const dialog = await store.readJson(
    verification.result.evidenceDigest,
    "browser-dialog-observation.json",
    boundDialog,
    1024 * 1024,
  );
  if (
    dialog.status !== "resolved" ||
    dialog.value.snapshotDigest !== ref.snapshotDigest ||
    dialog.value.labSetupDigest !== verification.labSetupDigest
  )
    return null;
  const observed = await createWordPressVerifierRecordReader({ store }).read({
    recipeDigest: recipe.digest,
    evidenceDigest: verification.result.evidenceDigest,
  });
  const signal = observed.victim?.browserSignal;
  return signal?.status === "dialog-observed" &&
    signal.kind === "numeric-dialog" &&
    signal.capturedAttackerRequestMarkerMatch &&
    signal.verificationSequence === "post-setup-request-before-victim-visit" &&
    signal.victimPrincipal === "separate"
    ? admitted
    : null;
}
