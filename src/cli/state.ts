import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import { Ledger } from "../ledger/index.js";

export type CliState = {
  readonly ledger: Ledger;
  /** Private Evidence on this host (outside Git); printed paths come from it. */
  readonly store: PrivateArtifactStore;
  /** The state root; `lab up` keeps its one record file here. */
  readonly stateDirectory: string;
  readonly clock: () => Date;
  readonly newId: () => string;
};

/** The one layout of a private state directory: `ledger.sqlite` beside `private-evidence/`. */
export async function openState(
  directory: string,
  environment: {
    readonly clock?: () => Date;
    readonly newId?: () => string;
  } = {},
  options: { readonly readOnly?: boolean } = {},
): Promise<CliState> {
  const root = resolve(directory);
  if (options.readOnly !== true)
    await mkdir(root, { recursive: true, mode: 0o700 });
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "private-evidence"),
    readOnly: options.readOnly ?? false,
    maxEntries: 64,
    // A bounded capture and its supporting evidence fit in one artifact.
    maxBytes: 72 * 1024 * 1024,
  });
  return {
    store,
    stateDirectory: root,
    ledger: new Ledger({
      databasePath: join(root, "ledger.sqlite"),
      artifactStore: store,
      readOnly: options.readOnly ?? false,
    }),
    clock: environment.clock ?? (() => new Date()),
    newId: environment.newId ?? randomUUID,
  };
}
