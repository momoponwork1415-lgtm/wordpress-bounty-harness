import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../../src/infrastructure/canonical-json.js";
import {
  campaignInputV1Schema,
  createHistoryCatalog,
  historyForRun,
  validateEvaluationCampaignInput,
  validateProductionCampaignInput,
} from "../../src/discovery/campaign.js";

const record = {
  id: "public-1",
  kind: "sql-injection",
  affectedVersions: ["1.0 - 1.4"],
  fixedVersions: ["1.5"],
  publishedAt: "2026-01-01T00:00:00Z",
  title: "Synthetic public record",
  changedFiles: ["includes/handler.php"],
};

function input(history: ReturnType<typeof createHistoryCatalog>) {
  return {
    schemaVersion: 1 as const,
    snapshotDigest: `sha256:${"a".repeat(64)}`,
    trustBoundary: { version: "v1", text: "Untrusted HTTP request" },
    programmeBoundary: { version: "v1", text: "Allowed low privilege" },
    modelProfileDigest: `sha256:${"b".repeat(64)}`,
    promptDigest: `sha256:${"c".repeat(64)}`,
    stopRules: { maxRuns: 40, noFindingRuns: 4 },
    lab: { setupDigest: `sha256:${"d".repeat(64)}` },
    history,
  };
}

describe("CampaignInput public boundary", () => {
  it("admits only pre-cutoff catalog fields and checks the digest", () => {
    const history = createHistoryCatalog("2026-02-01T00:00:00Z", [record]);
    expect(history.digest).toBe(
      canonicalDigest({
        historyCutoff: history.historyCutoff,
        records: [record],
      }),
    );
    expect(campaignInputV1Schema.parse(input(history)).history).toEqual(
      history,
    );
    expect(() =>
      campaignInputV1Schema.parse(
        input({ ...history, digest: `sha256:${"e".repeat(64)}` }),
      ),
    ).toThrow();
    expect(() =>
      createHistoryCatalog("2026-01-01T00:00:00Z", [record]),
    ).toThrow();
    expect(() =>
      createHistoryCatalog("2026-02-01T00:00:00Z", [
        { ...record, payload: "secret" },
      ]),
    ).toThrow();
    expect(() =>
      createHistoryCatalog("2026-02-01T00:00:00Z", [
        { ...record, poc: "secret" },
      ]),
    ).toThrow();
  });

  it("rejects evaluation input when the cutoff differs from held-out publication", () => {
    const history = createHistoryCatalog("2026-02-01T00:00:00Z", [record]);
    expect(
      validateEvaluationCampaignInput(input(history), "2026-02-01T00:00:00Z")
        .history,
    ).toEqual(history);
    expect(() =>
      validateEvaluationCampaignInput(input(history), "2026-01-15T00:00:00Z"),
    ).toThrow();
    expect(
      validateProductionCampaignInput(input(history), "2026-02-01T00:00:00Z")
        .history,
    ).toEqual(history);
    expect(() =>
      validateProductionCampaignInput(input(history), "2026-03-01T00:00:00Z"),
    ).toThrow();
    const late = { ...record, publishedAt: "2026-02-01T00:00:00Z" };
    expect(() =>
      validateEvaluationCampaignInput(
        input({
          mode: "catalog",
          historyCutoff: "2026-02-01T00:00:00Z",
          records: [late],
          digest: canonicalDigest({
            historyCutoff: "2026-02-01T00:00:00Z",
            records: [late],
          }),
        }),
        "2026-02-01T00:00:00Z",
      ),
    ).toThrow();
  });

  it("allocates half of runs to history and records absence explicitly", () => {
    const history = createHistoryCatalog("2026-02-01T00:00:00Z", [record]);
    expect(
      Array.from(
        { length: 6 },
        (_, ordinal) => historyForRun(ordinal, 0.5, history).mode,
      ),
    ).toEqual(["none", "catalog", "none", "catalog", "none", "catalog"]);
    expect(historyForRun(0, 1, history)).toEqual(history);
    expect(historyForRun(0, 0, history)).toEqual({ mode: "none" });
  });
});
