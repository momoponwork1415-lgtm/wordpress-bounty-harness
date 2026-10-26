import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { liveLabOwner } from "../../../infrastructure/lab-owner-record.js";
import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import type { Ledger } from "../../../ledger/index.js";
import {
  MANUAL_LAB_RECEIPT_FILE,
  recordManualObservationLabReady,
} from "../../../review/manual-observation.js";
import { openLabReconstruction } from "../../../review/reproduction-package.js";
import type { HeldVerificationLab } from "../../../verification/index.js";
import type { SnapshotReader } from "../../../snapshot/index.js";
import { hostGatewayName, type WordPressLab } from "./index.js";
import type { WordPressLabHandle } from "./contract.js";
import { observedReviewLabPackage } from "./observed-review-lab.js";
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
  readonly labId: string;
  /** The Lab on host loopback for a human's browser and curl, as the handoff Lab (#586). */
  readonly host: {
    readonly url: string;
    readonly hostHeader: string;
    readonly port: number;
  };
  /** Removes the Lab; a second call is a no-op. The caller decides when. */
  close(): Promise<void>;
}

/**
 * WordPress redirects to its own address without a port, so only port 80
 * opens in a browser (#592); when it is taken, a free port still serves curl.
 */
async function exposeForBrowser(
  lab: Pick<WordPressLab, "exposeToHost">,
  handle: WordPressLabHandle,
) {
  const exposed = await lab.exposeToHost(handle, {
    httpPort: 80,
    via: "recorder",
  });
  return exposed.status === "exposed"
    ? exposed
    : lab.exposeToHost(handle, { httpPort: 0, via: "recorder" });
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
    const exposed = await exposeForBrowser(input.lab, handle);
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
      labId: handle.id,
      host: {
        url: `http://127.0.0.1:${exposed.httpPort}`,
        hostHeader: new URL(handle.endpoint).host,
        port: exposed.httpPort,
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

/**
 * The Lab a foreground process holds for a person, `lab down` reads it: a
 * review Lab from `lab up --for-review` (#592), or the verification Lab
 * `verify next --handoff` keeps after recording the attempt (#600).
 */
const reviewLabRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  labId: z.string().regex(/^[0-9a-f-]{36}$/),
  network: z.string().min(1),
  gateway: z.string().min(1),
  httpPort: z.number().int().min(1).max(65535),
  startedAt: z.iso.datetime(),
  /** Absent for a review Lab. */
  labKind: z.literal("verification").optional(),
});
const reviewLabRecordPath = (stateDirectory: string) =>
  join(stateDirectory, "review-lab.json");

async function readReviewLabRecord(stateDirectory: string) {
  try {
    return reviewLabRecordSchema.parse(
      JSON.parse(
        await readFile(reviewLabRecordPath(stateDirectory), "utf8"),
      ) as unknown,
    );
  } catch {
    return null;
  }
}

/** Opens a review Lab and records it in the state directory until it is closed. */
export async function openRecordedWordPressReviewLab(
  input: Parameters<typeof openWordPressReviewLab>[0] & {
    readonly stateDirectory: string;
    readonly clock: () => Date;
  },
): Promise<WordPressReviewLabSession> {
  const path = reviewLabRecordPath(input.stateDirectory);
  if ((await readFile(path).catch(() => null)) !== null)
    throw new Error(
      "A review Lab is already recorded in this state directory; run lab down first",
    );
  const session = await openWordPressReviewLab(input);
  try {
    await writeFile(
      path,
      JSON.stringify(
        reviewLabRecordSchema.parse({
          schemaVersion: 1,
          labId: session.labId,
          network: session.networkName,
          gateway: hostGatewayName(session.labId),
          httpPort: session.host.port,
          startedAt: input.clock().toISOString(),
        }),
      ),
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    await session.close();
    throw error;
  }
  return {
    ...session,
    async close() {
      await session.close();
      await rm(path, { force: true });
    },
  };
}

/**
 * `lab down` for a recorded review Lab: asks its living foreground owner to
 * close it (withdraw, then teardown), then removes by Lab id whatever is left,
 * the host gateway first. Null when no review Lab is recorded.
 */
export async function wordPressReviewLabDown(input: {
  readonly stateDirectory: string;
  readonly lab: Pick<WordPressLab, "cleanupLeftovers">;
  readonly ownerOf?: (labId: string) => Promise<number | null>;
  readonly signal?: (pid: number) => void;
  readonly waitMs?: number;
}) {
  const record = await readReviewLabRecord(input.stateDirectory);
  if (record === null) return null;
  const ownerOf = input.ownerOf ?? ((labId) => liveLabOwner(labId));
  const owner = await ownerOf(record.labId);
  if (owner !== null) {
    (input.signal ?? ((pid) => process.kill(pid, "SIGTERM")))(owner);
    const deadline = Date.now() + (input.waitMs ?? 180_000);
    while (
      Date.now() < deadline &&
      (await readReviewLabRecord(input.stateDirectory)) !== null &&
      (await ownerOf(record.labId)) !== null
    )
      await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const removed = await input.lab.cleanupLeftovers({
    remove: true,
    labId: record.labId,
  });
  const remaining = await input.lab.cleanupLeftovers({
    remove: false,
    labId: record.labId,
  });
  if (
    remaining.containers.length === 0 &&
    remaining.networks.length === 0 &&
    remaining.volumes.length === 0
  )
    await rm(reviewLabRecordPath(input.stateDirectory), { force: true });
  return {
    labId: record.labId,
    ...(owner === null ? {} : { ownerStopped: owner }),
    removed,
    remaining,
  };
}

/** What `verify next --handoff` shows a person about the Lab it keeps for them (#600). */
export interface HeldVerificationLabSession {
  readonly ref: {
    readonly campaignId: string;
    readonly findingId: string;
    readonly verificationId: string;
  };
  readonly labId: string;
  readonly endpoint: string;
  readonly attackerAccounts: WordPressLabHandle["attackerAccounts"];
  /** Fresh since `setup-done`; the person's victim side, not the operator's. */
  readonly administrator: {
    readonly username: string;
    readonly password: string;
  };
  readonly host: {
    readonly url: string;
    readonly hostHeader: string;
    readonly port: number;
  };
  /** The digest `review observe --receipt` takes, and where its file is. */
  readonly receipt: { readonly digest: string; readonly path: string };
  /** The Lab is removed then unless `lab down` or an interrupt comes first. */
  readonly expiresAt: string;
}

/**
 * #600: keeps a recorded attempt's verification Lab up for a person: the
 * Lab already holds what setup made and what the route sent. Publishes it
 * on host loopback as a review Lab (port 80 first), records it for `lab
 * down`, seals a `manual-observation-lab-ready` receipt, then waits in
 * `present`. Says why when it did not hold the Lab; the caller's
 * Verification removes the Lab either way, then `releaseHeldLabRecord`.
 */
export async function holdWordPressVerificationLab(input: {
  readonly held: HeldVerificationLab<WordPressLabHandle>;
  readonly lab: Pick<
    WordPressLab,
    "exposeToHost" | "withdrawFromHost" | "reviewAdministrator"
  >;
  readonly ledger: Ledger;
  readonly store: PrivateArtifactStore;
  readonly stateDirectory: string;
  readonly clock: () => Date;
  readonly wallMs: number;
  readonly present: (session: HeldVerificationLabSession) => Promise<void>;
}): Promise<
  | { readonly status: "held" }
  | { readonly status: "not-held"; readonly reason: string }
> {
  const { held, lab } = input;
  const handle = held.lab;
  const notHeld = (reason: string) => ({ status: "not-held", reason }) as const;
  const manual = await observedReviewLabPackage({
    ledger: input.ledger,
    store: input.store,
    ref: held.ref,
  });
  if (manual === null)
    return notHeld("the attempt has no captured observation package");
  const administrator = lab.reviewAdministrator(handle);
  if (administrator === null)
    return notHeld("the Lab administrator is unavailable");
  const path = reviewLabRecordPath(input.stateDirectory);
  if ((await readFile(path).catch(() => null)) !== null)
    return notHeld(
      "another Lab is held for a person in this state directory; run lab down first",
    );
  const exposed = await exposeForBrowser(lab, handle);
  if (exposed.status !== "exposed")
    return notHeld(
      `the Lab could not be published on the host: ${exposed.diagnostic}`,
    );
  try {
    const startedAt = input.clock();
    await writeFile(
      path,
      JSON.stringify(
        reviewLabRecordSchema.parse({
          schemaVersion: 1,
          labId: handle.id,
          network: handle.networkName,
          gateway: hostGatewayName(handle.id),
          httpPort: exposed.httpPort,
          startedAt: startedAt.toISOString(),
          labKind: "verification",
        }),
      ),
      { flag: "wx", mode: 0o600 },
    );
    const receipt = await recordManualObservationLabReady({
      ledger: input.ledger,
      store: input.store,
      ref: held.ref,
      packageDigest: manual.packageDigest,
      sessionLabel: handle.networkName,
      labKind: "verification",
      clock: input.clock,
    });
    await input.present({
      ref: {
        campaignId: held.ref.campaignId,
        findingId: held.ref.findingId,
        verificationId: held.ref.verificationId,
      },
      labId: handle.id,
      endpoint: handle.endpoint,
      attackerAccounts: handle.attackerAccounts,
      administrator,
      host: {
        url: `http://127.0.0.1:${exposed.httpPort}`,
        hostHeader: new URL(handle.endpoint).host,
        port: exposed.httpPort,
      },
      receipt: {
        digest: receipt,
        path: `${input.store.contentPath(receipt)}/${MANUAL_LAB_RECEIPT_FILE}`,
      },
      expiresAt: new Date(startedAt.getTime() + input.wallMs).toISOString(),
    });
    return { status: "held" };
  } finally {
    // The gateway keeps the Lab network in use, so it goes before teardown.
    await lab.withdrawFromHost(handle);
  }
}

/** Forgets a held Lab once its resources are gone; another Lab's record stays. */
export async function releaseHeldLabRecord(input: {
  readonly stateDirectory: string;
  readonly labId: string;
  readonly lab: Pick<WordPressLab, "cleanupLeftovers">;
}): Promise<void> {
  const record = await readReviewLabRecord(input.stateDirectory);
  if (record?.labId !== input.labId) return;
  const remaining = await input.lab.cleanupLeftovers({
    remove: false,
    labId: input.labId,
  });
  if (
    remaining.containers.length === 0 &&
    remaining.networks.length === 0 &&
    remaining.volumes.length === 0
  )
    await rm(reviewLabRecordPath(input.stateDirectory), { force: true });
}
