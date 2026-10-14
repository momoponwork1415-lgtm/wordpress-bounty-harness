import type { CliState } from "../../cli/index.js";
import type { ReviewExportCheck } from "../../discovery/continuous-child-assessment.js";
import { readWordPressFinding } from "./discovery/finding.js";

/** Validate the private WordPress Finding body and its ledger identity. */
export async function wordPressReviewFindingReady(
  state: CliState,
  request: Parameters<ReviewExportCheck>[0],
): Promise<boolean> {
  const event = state.ledger.read({
    campaignId: request.campaignId,
    findingId: request.findingId,
    type: "finding-recorded",
    limit: 1,
  })[0]?.event;
  if (
    event?.type !== "finding-recorded" ||
    event.snapshotDigest !== request.snapshotDigest
  )
    return false;
  const reference = event.artifacts.find((item) => item.kind === "finding");
  if (reference === undefined) return false;
  const file = await state.store.readFile(
    reference.digest,
    "finding.json",
    1024 * 1024,
  );
  if (file.status !== "resolved") return false;
  try {
    const finding = readWordPressFinding(
      JSON.parse(file.bytes.toString("utf8")) as unknown,
    );
    return (
      finding.findingId === request.findingId &&
      finding.discoveryRunId === event.runId &&
      finding.snapshotDigest === request.snapshotDigest
    );
  } catch {
    return false;
  }
}
