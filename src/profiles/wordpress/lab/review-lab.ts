import { z } from "zod";

import { canonicalDigest } from "../../../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import {
  snapshotSchema,
  type SnapshotReader,
} from "../../../snapshot/index.js";
import { openWordPressLab, type WordPressSourceResolver } from "./index.js";
import { setupSchema } from "./provision-input.js";
import { createReviewLabWaiter } from "./review-lab-wait.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const manifestSchema = z.looseObject({
  snapshotDigest: digest,
  labSetupDigest: digest,
  snapshot: snapshotSchema.safeExtend({ digest }),
  setup: setupSchema,
});

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
  close(): Promise<void>;
  wait(): Promise<void>;
}

/** Builds one fresh review Lab from a sealed package without running discovery. */
export async function openWordPressReviewLab(input: {
  readonly packageDigest: string;
  readonly category: string;
  readonly store: PrivateArtifactStore;
  /** The frozen Snapshots the package must agree with. */
  readonly snapshots: SnapshotReader;
  /** The materialized source trees the Lab mounts. */
  readonly source: WordPressSourceResolver;
  readonly host: {
    readonly dockerExecutablePath: string;
    readonly images: {
      readonly database: string;
      readonly wordpress: string;
      readonly wordpressCli: string;
      readonly browser: string;
      readonly broker: string;
    };
  };
}): Promise<WordPressReviewLabSession> {
  const file = await input.store.readFile(
    input.packageDigest,
    "lab.json",
    1024 * 1024,
  );
  if (file.status !== "resolved")
    throw new Error("Review Lab setup manifest is missing");
  const manifest = manifestSchema.parse(
    JSON.parse(file.bytes.toString("utf8")) as unknown,
  );
  const snapshot = manifest.snapshot;
  const snapshotBody = snapshotSchema.parse({
    kind: snapshot.kind,
    schemaVersion: snapshot.schemaVersion,
    target: snapshot.target,
    dependencies: snapshot.dependencies,
  });
  if (
    snapshot.digest !== manifest.snapshotDigest ||
    canonicalDigest(snapshotBody) !== snapshot.digest ||
    manifest.setup.snapshotDigest !== snapshot.digest
  )
    throw new Error("Review Lab Snapshot digest mismatch");
  // The frozen artifact is re-verified against the same digest the package carries.
  const frozen = await input.snapshots.load(snapshot.digest);
  if (frozen.status !== "loaded")
    throw new Error(
      `Frozen Snapshot artifact differs from the package: ${frozen.reason}`,
    );
  const lab = openWordPressLab({
    dockerExecutablePath: input.host.dockerExecutablePath,
    images: {
      database: input.host.images.database,
      wordpress: input.host.images.wordpress,
      wordpressCli: input.host.images.wordpressCli,
      browser: input.host.images.browser,
      recorder: input.host.images.broker,
    },
    source: input.source,
  });
  const provisioned = await lab.provision(snapshot, manifest.setup, {
    purpose: "verification",
  });
  if (provisioned.status !== "ready") throw new Error(provisioned.nextStep);
  const handle = provisioned.handle;
  let live = true;
  try {
    if (handle.setupDigest !== manifest.labSetupDigest)
      throw new Error("Review Lab setup digest differs from the package");
    const seeded = await lab.seedCanaries(handle);
    if (seeded.status !== "seeded") throw new Error(seeded.nextStep);
    const administrator = lab.reviewAdministrator(handle);
    if (administrator === null)
      throw new Error("Review administrator is unavailable");
    const receiverIp = lab.reviewReceiverIp(handle);
    if (receiverIp === null)
      throw new Error("Review canary receiver is unavailable");
    const canaries = lab.canaryLedger(handle);
    const script =
      input.category === "stored-xss" ? lab.prepareScriptCanary(handle) : null;
    if (input.category === "stored-xss" && script === null)
      throw new Error("Review script canary is unavailable");
    const waiter = createReviewLabWaiter();
    return {
      endpoint: handle.endpoint,
      networkName: handle.networkName,
      recorderIp: handle.recorderIp,
      receiverIp,
      attackerAccounts: handle.attackerAccounts,
      administrator,
      canaries: {
        ...(canaries === null ? {} : { ledger: canaries }),
        ...(script === null ? {} : { script }),
      },
      browserImage: input.host.images.browser,
      async close() {
        waiter.release();
        if (!live) return;
        const removed = await lab.teardown(handle);
        if (removed.status !== "removed") throw new Error(removed.nextStep);
        live = false;
      },
      wait() {
        return waiter.wait();
      },
    };
  } catch (error) {
    await lab.teardown(handle);
    live = false;
    throw error;
  }
}
