import { exportReviewBundle } from "../review/index.js";
import type { ReviewExportCheck } from "../discovery/continuous-child-assessment.js";
import type { CliProfile, CliState } from "./index.js";

/** Check the actual Private Evidence behind a review export, without writing it. */
export function continuousReviewExportCheck(
  state: CliState,
  profile?: CliProfile,
  findingRecordReady?: ReviewExportCheck,
): ReviewExportCheck {
  return async (request) => {
    const { campaignId, findingId } = request;
    const bundle = await exportReviewBundle({
      ledger: state.ledger,
      store: state.store,
      evidenceDirectory: state.evidenceDirectory,
      campaignId,
      findingId,
      ...(profile === undefined
        ? {}
        : { stateDiff: profile.stateDiffReader(state) }),
      clock: state.clock,
    });
    // The human review exporter intentionally substitutes a placeholder when
    // finding.json is absent or malformed. A runner must treat that as missing
    // evidence rather than advancing to the next batch.
    return (
      bundle.snapshotDigest === request.snapshotDigest &&
      bundle.finding.path !== null &&
      bundle.finding.claim !== "(finding.json unavailable)" &&
      bundle.finding.brokenProperty !== "(finding.json unavailable)" &&
      findingRecordReady !== undefined &&
      (await findingRecordReady(request))
    );
  };
}
