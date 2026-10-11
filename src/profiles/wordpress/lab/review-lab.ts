import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  canonicalDigest,
  canonicalJson,
} from "../../../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import { snapshotSchema } from "../../../snapshot/index.js";
import { openMaterializedSources } from "../acquisition/materialized-sources.js";
import { openWordPressLab } from "./index.js";
import { setupSchema } from "./provision-input.js";

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
  readonly host: {
    readonly dockerExecutablePath: string;
    readonly workDirectory: string;
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
  const frozen = await readFile(
    join(
      input.host.workDirectory,
      "snapshots",
      `${snapshot.digest.slice(7)}.json`,
    ),
    "utf8",
  );
  if (frozen !== canonicalJson(snapshotBody))
    throw new Error("Frozen Snapshot artifact differs from the package");
  const lab = openWordPressLab({
    dockerExecutablePath: input.host.dockerExecutablePath,
    images: {
      database: input.host.images.database,
      wordpress: input.host.images.wordpress,
      wordpressCli: input.host.images.wordpressCli,
      browser: input.host.images.browser,
      recorder: input.host.images.broker,
    },
    source: openMaterializedSources({
      rootDirectory: join(input.host.workDirectory, "sources"),
    }),
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
    const canaries = lab.canaryLedger(handle);
    const script =
      input.category === "stored-xss" ? lab.prepareScriptCanary(handle) : null;
    return {
      endpoint: handle.endpoint,
      networkName: handle.networkName,
      recorderIp: handle.recorderIp,
      attackerAccounts: handle.attackerAccounts,
      administrator,
      canaries: {
        ...(canaries === null ? {} : { ledger: canaries }),
        ...(script === null ? {} : { script }),
      },
      browserImage: input.host.images.browser,
      async close() {
        if (!live) return;
        const removed = await lab.teardown(handle);
        if (removed.status !== "removed") throw new Error(removed.nextStep);
        live = false;
      },
      wait() {
        return new Promise<void>((resolve) => {
          const done = () => {
            process.off("SIGINT", done);
            process.off("SIGTERM", done);
            resolve();
          };
          process.once("SIGINT", done);
          process.once("SIGTERM", done);
        });
      },
    };
  } catch (error) {
    await lab.teardown(handle);
    live = false;
    throw error;
  }
}
