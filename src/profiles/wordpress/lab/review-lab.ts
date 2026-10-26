import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import { openLabReconstruction } from "../../../review/reproduction-package.js";
import type { SnapshotReader } from "../../../snapshot/index.js";
import type { WordPressLab } from "./index.js";
import { setupSchema } from "./provision-input.js";

/** The Lab operations a human review session uses; observation stays with verification. */
export type WordPressReviewLabProvisioner = Pick<
  WordPressLab,
  | "provision"
  | "reviewAdministrator"
  | "reviewReceiverIp"
  | "exposeToHost"
  | "withdrawFromHost"
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
  readonly browserImage: string;
  /** The Lab on host loopback for a human's browser and curl, as the handoff Lab (#586). */
  readonly host: { readonly url: string; readonly hostHeader: string };
  /** Removes the Lab; a second call is a no-op. The caller decides when. */
  close(): Promise<void>;
}

/** Builds one fresh review Lab from a sealed package without running discovery. */
export async function openWordPressReviewLab(input: {
  readonly packageDigest: string;
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
  if (setup.snapshotDigest !== reconstruction.snapshotDigest)
    throw new Error(
      "Review Lab setup Snapshot digest differs from the package",
    );
  const provisioned = await input.lab.provision(frozen.snapshot, setup, {
    purpose: "verification",
  });
  if (provisioned.status !== "ready") throw new Error(provisioned.nextStep);
  const handle = provisioned.handle;
  let live = true;
  const close = async () => {
    if (!live) return;
    live = false;
    // The gateway keeps the Lab network in use, so it goes before teardown.
    await input.lab.withdrawFromHost(handle);
    const removed = await input.lab.teardown(handle);
    if (removed.status !== "removed") throw new Error(removed.nextStep);
  };
  try {
    if (handle.setupDigest !== reconstruction.labSetupDigest)
      throw new Error("Review Lab setup digest differs from the package");
    const administrator = input.lab.reviewAdministrator(handle);
    if (administrator === null)
      throw new Error("Review administrator is unavailable");
    const receiverIp = input.lab.reviewReceiverIp(handle);
    if (receiverIp === null)
      throw new Error("Review Lab receiver is unavailable");
    // A free loopback port, so a review Lab never collides with a handoff Lab (#432).
    const exposed = await input.lab.exposeToHost(handle, {
      httpPort: 0,
      via: "recorder",
    });
    if (exposed.status !== "exposed")
      throw new Error(
        `The review Lab could not be published on the host: ${exposed.diagnostic}`,
      );
    return {
      endpoint: handle.endpoint,
      networkName: handle.networkName,
      recorderIp: handle.recorderIp,
      receiverIp,
      attackerAccounts: handle.attackerAccounts,
      administrator,
      browserImage: input.browserImage,
      host: {
        url: `http://127.0.0.1:${exposed.httpPort}`,
        hostHeader: new URL(handle.endpoint).host,
      },
      close,
    };
  } catch (error) {
    live = false;
    await input.lab.withdrawFromHost(handle);
    await input.lab.teardown(handle);
    throw error;
  }
}
