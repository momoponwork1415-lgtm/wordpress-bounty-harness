import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import type { Ledger } from "../ledger/index.js";
import {
  nativeRunReceiptSchema,
  type NativeRunReceipt,
} from "./native-run-receipts.js";

export type RecordedRuntime = Pick<
  NativeRunReceipt,
  | "requestedModelId"
  | "requestedEffort"
  | "codexCliVersion"
  | "bundledCatalogDigest"
  | "serviceTier"
  | "cyberAccessProgram"
  | "authenticationMethod"
>;

export type RecordedRuntimeGroup = {
  readonly runtime: RecordedRuntime;
  readonly runs: number;
  readonly firstDay: string;
  readonly lastDay: string;
};

/** Groups finished runs by the runtime their stored receipts record, oldest first. */
export async function summarizeRecordedRuntimes(options: {
  readonly ledger: Ledger;
  readonly store: PrivateArtifactStore;
  readonly campaignId?: string;
}): Promise<readonly RecordedRuntimeGroup[]> {
  const groups = new Map<
    string,
    {
      runtime: RecordedRuntime;
      runs: number;
      firstDay: string;
      lastDay: string;
    }
  >();
  let afterSequence = 0;
  for (;;) {
    const page = options.ledger.read({
      ...(options.campaignId === undefined
        ? {}
        : { campaignId: options.campaignId }),
      type: "discovery-run-finished",
      afterSequence,
      limit: 1000,
    });
    for (const { event } of page) {
      const reference = event.artifacts.find(
        (artifact) => artifact.kind === "native-run-receipt",
      );
      if (reference === undefined) continue;
      const file = await options.store.readFile(
        reference.digest,
        "receipt.json",
        64 * 1024,
      );
      if (file.status !== "resolved") continue;
      const receipt = nativeRunReceiptSchema.parse(
        JSON.parse(file.bytes.toString("utf8")) as unknown,
      );
      const runtime: RecordedRuntime = {
        requestedModelId: receipt.requestedModelId,
        requestedEffort: receipt.requestedEffort,
        codexCliVersion: receipt.codexCliVersion,
        bundledCatalogDigest: receipt.bundledCatalogDigest,
        serviceTier: receipt.serviceTier,
        cyberAccessProgram: receipt.cyberAccessProgram,
        authenticationMethod: receipt.authenticationMethod,
      };
      const day = new Date(event.occurredAt).toISOString().slice(0, 10);
      const key = JSON.stringify(runtime);
      const group = groups.get(key) ?? {
        runtime,
        runs: 0,
        firstDay: day,
        lastDay: day,
      };
      groups.set(key, group);
      group.runs++;
      if (day < group.firstDay) group.firstDay = day;
      if (day > group.lastDay) group.lastDay = day;
    }
    if (page.length < 1000) break;
    afterSequence = page[page.length - 1]!.sequence;
  }
  return [...groups.values()];
}
