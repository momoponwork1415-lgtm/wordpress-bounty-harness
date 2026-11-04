import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  extractCandidateReport,
  mergeTurnReports,
} from "../../src/discovery/codex-native-agent-runtime.js";
import { ProviderAttachmentStore } from "../../src/discovery/provider-research-report.js";
import {
  createReportRecorder,
  type CandidateReport,
  type ReportRecorderContext,
} from "../../src/discovery/record-discovery-report.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";

const digest = `sha256:${"a".repeat(64)}`;
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it("retains child checks across turns while keeping old four-key reports readable", () => {
  const old = {
    findings: [],
    leads: [],
    examined: "source",
    unexamined: "none",
  };
  expect(extractCandidateReport(JSON.stringify(old))).toEqual(old);

  const first = { ...old, checks: [{ candidate: "one" }] };
  const second = {
    ...old,
    checks: [{ candidate: "one" }, { candidate: "two" }],
  };
  expect(
    mergeTurnReports([JSON.stringify(first), JSON.stringify(second)]),
  ).toEqual({
    ...second,
    checks: [{ candidate: "one" }, { candidate: "two" }],
  });
});

it("keeps repeated checks in chronological order so a later reversal wins", () => {
  const report = (verdict: string) =>
    JSON.stringify({
      findings: [],
      leads: [],
      examined: "source",
      unexamined: "none",
      checks: [{ candidate: "one", verdict }],
    });
  expect(
    mergeTurnReports([
      report("verified"),
      report("refuted"),
      report("verified"),
    ])?.checks,
  ).toEqual([
    { candidate: "one", verdict: "verified" },
    { candidate: "one", verdict: "refuted" },
    { candidate: "one", verdict: "verified" },
  ]);
});

it("passes child checks and run provenance to the profile and marks unchecked Root claims pending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wbh-report-checks-"));
  directories.push(directory);
  const attachments = new ProviderAttachmentStore(
    join(directory, "attachments"),
  );
  const evidence = new PrivateArtifactStore({
    rootDirectory: join(directory, "evidence"),
    maxEntries: 2,
    maxBytes: 1024,
  });
  const ledger = new Ledger({
    databasePath: join(directory, "ledger.sqlite"),
    artifactStore: evidence,
  });
  const report = {
    findings: [{ claim: "candidate" }],
    leads: [],
    examined: "source",
    unexamined: "none",
    checks: [{ candidate: "candidate", result: "verified" }],
  };
  const attachment = await attachments.put(
    "findings",
    Buffer.from(JSON.stringify(report)),
  );
  const state = {
    foundNew: false,
    heldBoundary: false,
    pendingAuditCheck: false,
  };
  const calls: {
    report: CandidateReport;
    context: ReportRecorderContext;
  }[] = [];
  const recorder = createReportRecorder({
    attachments,
    evidence,
    ledger,
    base: {
      schemaVersion: 1,
      campaignId: "campaign-1",
      snapshotDigest: digest,
      occurredAt: "2026-10-08T07:00:00Z",
    },
    snapshotDigest: digest,
    trialId: "trial-1",
    admissionContract: "checked/v1",
    seen: new Set(),
    state,
    onFindingRecorded: () => {},
    async recordReport(candidateReport, context) {
      calls.push({ report: candidateReport, context });
      return {
        candidates:
          context.runKind === "root"
            ? [
                {
                  kind: "finding",
                  index: 0,
                  outcome: "pending",
                  status: "appended",
                },
              ]
            : [],
      };
    },
  });

  await recorder("child-1", attachment, "child");
  expect(calls[0]?.report.checks).toEqual(report.checks);
  expect(calls[0]?.context).toMatchObject({
    runId: "child-1",
    runKind: "child",
    admissionContract: "checked/v1",
    trialId: "trial-1",
  });
  expect(state.pendingAuditCheck).toBe(false);

  await recorder("root-1", attachment, "root");
  expect(calls[1]?.report.checks).toBeUndefined();
  expect(calls[1]?.context.runKind).toBe("root");
  expect(state.pendingAuditCheck).toBe(true);

  const fourKey = await attachments.put(
    "findings",
    Buffer.from(
      JSON.stringify({
        findings: [{ claim: "preserved candidate" }],
        leads: [],
        examined: "source",
        unexamined: "none",
      }),
    ),
  );
  await expect(recorder("child-2", fourKey, "child")).rejects.toThrow(
    "Checked child report lacks checks",
  );
  expect(calls[2]?.report.findings).toHaveLength(1);
});
