import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import { openLabReconstruction } from "../../../review/reproduction-package.js";
import type { SnapshotReader } from "../../../snapshot/index.js";
import type { WordPressLab } from "./index.js";
import { setupSchema } from "./provision-input.js";

/** The Lab operations a human review session uses; observation stays with verification. */
export type WordPressReviewLabProvisioner = Pick<
  WordPressLab,
  | "provision"
  | "seedCanaries"
  | "reviewAdministrator"
  | "reviewReceiverIp"
  | "canaryLedger"
  | "prepareScriptCanary"
  | "teardown"
>;

export interface WordPressReviewLabSession {
  readonly endpoint: string;
  readonly networkName: string;
  readonly recorderIp: string;
  readonly receiverIp: string;
  readonly attackerAccounts: Readonly<{
    subscriber: { readonly username: string; readonly password: string };
    customer?: { readonly username: string; readonly password: string };
  }>;
  readonly administrator: {
    readonly username: string;
    readonly password: string;
  };
  readonly canaries: unknown;
  readonly browserImage: string;
  /** Removes the Lab; a second call is a no-op. The caller decides when. */
  close(): Promise<void>;
}

/** Builds one fresh review Lab from a sealed package without running discovery. */
export async function openWordPressReviewLab(input: {
  readonly packageDigest: string;
  readonly category: string;
  readonly store: PrivateArtifactStore;
  /** The frozen Snapshots the package must agree with. */
  readonly snapshots: SnapshotReader;
  readonly lab: WordPressReviewLabProvisioner;
  /** The pinned image a human's manual client runs on the Lab network. */
  readonly browserImage: string;
}): Promise<WordPressReviewLabSession> {
  const opened = await openLabReconstruction(input.store, input.packageDigest);
  if (opened.status !== "opened")
    throw new Error(
      `Review Lab reconstruction is unavailable: ${opened.reason}`,
    );
  const { reconstruction } = opened;
  // The Lab mounts the frozen Snapshot, not the package's copy; the reader re-verifies its digest.
  const frozen = await input.snapshots.load(reconstruction.snapshotDigest);
  if (frozen.status !== "loaded")
    throw new Error(
      `Frozen Snapshot artifact differs from the package: ${frozen.reason}`,
    );
  const setup = setupSchema.parse(reconstruction.setup);
  const provisioned = await input.lab.provision(frozen.snapshot, setup, {
    purpose: "verification",
  });
  if (provisioned.status !== "ready") throw new Error(provisioned.nextStep);
  const handle = provisioned.handle;
  let live = true;
  const close = async () => {
    if (!live) return;
    live = false;
    const removed = await input.lab.teardown(handle);
    if (removed.status !== "removed") throw new Error(removed.nextStep);
  };
  try {
    if (handle.setupDigest !== reconstruction.labSetupDigest)
      throw new Error("Review Lab setup digest differs from the package");
    const seeded = await input.lab.seedCanaries(handle);
    if (seeded.status !== "seeded") throw new Error(seeded.nextStep);
    const administrator = input.lab.reviewAdministrator(handle);
    if (administrator === null)
      throw new Error("Review administrator is unavailable");
    const receiverIp = input.lab.reviewReceiverIp(handle);
    if (receiverIp === null)
      throw new Error("Review canary receiver is unavailable");
    const ledger = input.lab.canaryLedger(handle);
    const script =
      input.category === "stored-xss"
        ? input.lab.prepareScriptCanary(handle)
        : null;
    if (input.category === "stored-xss" && script === null)
      throw new Error("Review script canary is unavailable");
    return {
      endpoint: handle.endpoint,
      networkName: handle.networkName,
      recorderIp: handle.recorderIp,
      receiverIp,
      attackerAccounts: handle.attackerAccounts,
      administrator,
      canaries: {
        ...(ledger === null ? {} : { ledger }),
        ...(script === null ? {} : { script }),
      },
      browserImage: input.browserImage,
      close,
    };
  } catch (error) {
    live = false;
    await input.lab.teardown(handle);
    throw error;
  }
}
