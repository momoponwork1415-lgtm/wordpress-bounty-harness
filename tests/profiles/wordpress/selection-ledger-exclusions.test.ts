import { describe, expect, it } from "vitest";

import {
  ledgerEventV1Schema,
  type Ledger,
  type LedgerReadAllQuery,
  type LedgerRecord,
} from "../../../src/ledger/index.js";
import { inspectWordPressLedgerExclusions } from "../../../src/profiles/wordpress/selection/ledger-exclusions.js";

const digest = (letter: string): string => `sha256:${letter.repeat(64)}`;
const occurredAt = "2026-10-11T12:00:00Z";

function base(campaignId: string, snapshotDigest: string, identity: string) {
  return {
    schemaVersion: 1,
    campaignId,
    snapshotDigest,
    identity,
    occurredAt,
    artifacts: [],
  } as const;
}

function selected(
  slug: string,
  version: string,
  campaignId = "campaign-1",
  snapshotDigest = digest("a"),
) {
  return ledgerEventV1Schema.parse({
    ...base(campaignId, snapshotDigest, `selection-${campaignId}-${slug}`),
    type: "target-selected",
    selectionId: `wporg:${slug}@${version}`,
  });
}

function started(
  promptVariant: string,
  campaignId = "campaign-1",
  snapshotDigest = digest("a"),
) {
  return ledgerEventV1Schema.parse({
    ...base(campaignId, snapshotDigest, `run-${campaignId}-${promptVariant}`),
    type: "discovery-run-started",
    runId: `run-${campaignId}-${promptVariant}`,
    labId: "lab-1",
    history: { mode: "none" },
    configuration: {
      promptVariant,
      assignmentUnit: "target",
    },
  });
}

function finished(
  promptVariant: string,
  campaignId = "campaign-1",
  snapshotDigest = digest("a"),
) {
  return ledgerEventV1Schema.parse({
    ...base(
      campaignId,
      snapshotDigest,
      `finish-${campaignId}-${promptVariant}`,
    ),
    type: "discovery-run-finished",
    runId: `run-${campaignId}-${promptVariant}`,
    outcome: "completed",
    costUsd: "unavailable",
    wallTimeMs: 1000,
  });
}

function labFailed(campaignId = "campaign-1", snapshotDigest = digest("a")) {
  return ledgerEventV1Schema.parse({
    ...base(campaignId, snapshotDigest, `lab-${campaignId}-${snapshotDigest}`),
    type: "lab-provisioned",
    labId: "lab-1",
    status: "failed",
    purpose: "discovery",
    failureStage: "provision",
    reason: "provision",
  });
}

/** A selection with a completed exploration Trial. */
function trial(
  slug: string,
  version: string,
  campaignId = "campaign-1",
  snapshotDigest = digest("a"),
  promptVariant = "wp2shell-bounty-v2",
) {
  return [
    selected(slug, version, campaignId, snapshotDigest),
    started(promptVariant, campaignId, snapshotDigest),
    finished(promptVariant, campaignId, snapshotDigest),
  ];
}

function reader(
  events: readonly ReturnType<typeof selected>[],
): Pick<Ledger, "readAll"> {
  const records: readonly LedgerRecord[] = events.map((event, index) => ({
    sequence: index + 1,
    event,
  }));
  return {
    readAll(query: LedgerReadAllQuery = {}) {
      return records.filter(
        ({ event }) =>
          (query.type === undefined || event.type === query.type) &&
          (query.campaignId === undefined ||
            event.campaignId === query.campaignId),
      );
    },
  };
}

function inspect(
  ledger: Pick<Ledger, "readAll">,
  candidates: readonly { readonly slug: string; readonly version: string }[],
) {
  return inspectWordPressLedgerExclusions({
    ledger,
    candidates,
  });
}

describe("WordPress ledger exclusions", () => {
  it.each(["enumerate", "trace", "child"] as const)(
    "counts a partitioned enumerate Trial, without counting %s separately",
    (runKind) => {
      const events = trial("partitioned", "1.0.0").map((event) =>
        event.type === "discovery-run-started" ? { ...event, runKind } : event,
      );
      expect(
        inspect(reader(events), [{ slug: "partitioned", version: "1.0.0" }])[0]
          ?.reasons,
      ).toEqual(runKind === "enumerate" ? ["previously-selected"] : []);
      const bootstrap = events.map((event) =>
        event.type === "discovery-run-finished"
          ? {
              ...event,
              observed: {
                filesRead: 0,
                toolCalls: 0,
                uniqueFilesRead: 0,
                labRequests: 0,
                dbQueries: 0,
              },
              childThreadsObserved: 0,
              brokerMetrics: {
                forwardedRequests: 1,
                requestLimitExceeded: 0,
                unauthorizedRequests: 0,
              },
            }
          : event,
      );
      expect(
        inspect(reader(bootstrap), [
          { slug: "partitioned", version: "1.0.0" },
        ])[0]?.reasons,
      ).toEqual([]);
    },
  );

  it("keeps untouched candidates and excludes the same slug in later selections", () => {
    const ledger = reader(trial("seen", "1.2.0"));
    expect(
      inspect(ledger, [
        { slug: "seen", version: "1.2.0" },
        { slug: "new", version: "1.0.0" },
      ]),
    ).toEqual([
      {
        slug: "seen",
        version: "1.2.0",
        reasons: ["previously-selected"],
        reason: "version-increased",
      },
      { slug: "new", version: "1.0.0", reasons: [], reason: "initial" },
    ]);
  });

  it("revisits only a higher plugin version", () => {
    const ledger = reader([
      ...trial("seen", "1.9.0", "campaign-1", digest("a")),
      ...trial("seen", "1.10.0", "campaign-2", digest("b")),
    ]);
    expect(inspect(ledger, [{ slug: "seen", version: "1.11.0" }])).toEqual([
      {
        slug: "seen",
        version: "1.11.0",
        reasons: [],
        reason: "version-increased",
      },
    ]);
    expect(
      inspect(ledger, [{ slug: "seen", version: "1.10.0" }])[0]?.reasons,
    ).toEqual(["previously-selected"]);
    expect(
      inspect(ledger, [{ slug: "seen", version: "1.9.1" }])[0]?.reasons,
    ).toEqual(["previously-selected"]);
  });

  it("reads beyond the ledger's 1000-event page", () => {
    const earlier = Array.from({ length: 1000 }, (_, index) =>
      selected(`other-${index}`, "1.0.0", `campaign-${index}`, digest("a")),
    );
    const ledger = reader([
      ...earlier,
      ...trial("seen", "1.0.0", "last", digest("b")),
    ]);
    expect(
      inspect(ledger, [{ slug: "seen", version: "1.0.0" }])[0]?.reasons,
    ).toEqual(["previously-selected"]);
  });

  it("excludes a version whose discovery Lab failed to provision until the version changes", () => {
    const result = inspectWordPressLedgerExclusions({
      ledger: reader([
        selected("needs-elementor", "1.0.0"),
        labFailed(),
        selected("other", "1.0.0", "campaign-2", digest("b")),
        labFailed("campaign-2", digest("b")),
        started("wp2shell-bounty-v2", "campaign-2", digest("b")),
        finished("wp2shell-bounty-v2", "campaign-2", digest("b")),
      ]),
      candidates: [
        { slug: "needs-elementor", version: "1.0.0" },
        { slug: "needs-elementor", version: "1.0.1" },
        { slug: "other", version: "1.0.0" },
      ],
    });
    expect(
      result.map(({ slug, version, reasons }) => [slug, version, reasons]),
    ).toEqual([
      ["needs-elementor", "1.0.0", ["lab-provision-failed"]],
      ["needs-elementor", "1.0.1", []],
      ["other", "1.0.0", ["previously-selected"]],
    ]);
  });

  it("excludes a version whose source freeze was deferred until the version changes", () => {
    const skipped = (
      slug: string,
      version: string,
      campaignId: string,
      reason = "deferred",
    ) =>
      ledgerEventV1Schema.parse({
        ...base(campaignId, digest("f"), `skip-${campaignId}-${slug}`),
        type: "target-skipped",
        selectionId: `wporg:${slug}@${version}`,
        stage: "freeze",
        reason,
      });
    const result = inspectWordPressLedgerExclusions({
      ledger: reader([
        // The same selection attempt froze another target, so the deferral is the target's own.
        skipped("bad-header", "1.0.0", "selection-1"),
        skipped("timed-out", "1.0.0", "selection-1", "connect-timeout"),
        selected("fine", "1.0.0", "selection-1", digest("a")),
        // Nothing froze in this attempt: the host may have failed, not the target.
        skipped("host-down", "1.0.0", "selection-2"),
        // A rejected archive is the version's own failure even when nothing else froze (#623).
        skipped("bad-archive", "1.0.0", "selection-2", "invalid-archive"),
        // Deferred once, then frozen and explored: the Trial rule decides.
        skipped("recovered", "1.0.0", "selection-1"),
        ...trial("recovered", "1.0.0", "campaign-3", digest("c")),
      ]),
      candidates: [
        { slug: "bad-header", version: "1.0.0" },
        { slug: "bad-header", version: "1.0.1" },
        { slug: "timed-out", version: "1.0.0" },
        { slug: "host-down", version: "1.0.0" },
        { slug: "bad-archive", version: "1.0.0" },
        { slug: "bad-archive", version: "1.0.1" },
        { slug: "recovered", version: "1.0.0" },
      ],
    });
    expect(
      result.map(({ slug, version, reasons }) => [slug, version, reasons]),
    ).toEqual([
      ["bad-header", "1.0.0", ["freeze-deferred"]],
      ["bad-header", "1.0.1", []],
      ["timed-out", "1.0.0", []],
      ["host-down", "1.0.0", []],
      ["bad-archive", "1.0.0", ["freeze-deferred"]],
      ["bad-archive", "1.0.1", []],
      ["recovered", "1.0.0", ["previously-selected"]],
    ]);
  });

  it("excludes every slug a batch held by another runner selected, until that batch is no longer held (#604)", () => {
    const ledger = reader([
      // Another prefix's runner holds this batch; neither target has started.
      selected("held-a", "1.0.0", "selection-1", digest("a")),
      selected("held-b", "2.0.0", "selection-1", digest("b")),
      selected("free", "1.0.0", "selection-2", digest("c")),
    ]);
    const inspect = (reservedBatches?: ReadonlySet<string>) =>
      inspectWordPressLedgerExclusions({
        ledger,
        candidates: [
          { slug: "held-a", version: "1.0.0" },
          // A newer version of a held slug waits too: one runner per slug.
          { slug: "held-b", version: "2.0.1" },
          { slug: "free", version: "1.0.0" },
        ],
        ...(reservedBatches === undefined ? {} : { reservedBatches }),
      }).map(({ slug, reasons }) => [slug, reasons]);
    expect(inspect(new Set(["selection-1"]))).toEqual([
      ["held-a", ["reserved-by-runner"]],
      ["held-b", ["reserved-by-runner"]],
      ["free", []],
    ]);
    // Selected but never started is not a Trial: once released, all are eligible again.
    expect(inspect()).toEqual([
      ["held-a", []],
      ["held-b", []],
      ["free", []],
    ]);
  });

  it("reselects a fully observed non-Trial and a provider-limited run, and retains a partial Trial", () => {
    const finished = (
      runId: string,
      snapshotDigest: string,
      fields: Record<string, unknown>,
    ) =>
      ledgerEventV1Schema.parse({
        ...base("campaign-1", snapshotDigest, `finish-${runId}`),
        type: "discovery-run-finished",
        runId,
        costUsd: "unavailable",
        wallTimeMs: 1000,
        ...fields,
      });
    const observed = (filesRead: number) => ({
      toolCalls: 0,
      filesRead,
      uniqueFilesRead: filesRead,
      labRequests: 0,
      dbQueries: 0,
    });
    const ledger = reader([
      selected("refused", "1.0.0", "campaign-1", digest("a")),
      started("wp2shell-bounty-v2", "campaign-1", digest("a")),
      finished("run-campaign-1-wp2shell-bounty-v2", digest("a"), {
        outcome: "failed",
        reason: "provider",
        observed: observed(0),
        childThreadsObserved: 0,
        brokerMetrics: {
          forwardedRequests: 1,
          requestLimitExceeded: 0,
          unauthorizedRequests: 0,
        },
      }),
      // Ran partway into a quota: not a Trial (owner decision 2026-10-19).
      selected("limited", "1.0.0", "campaign-1", digest("b")),
      started("v3", "campaign-1", digest("b")),
      finished("run-campaign-1-v3", digest("b"), {
        outcome: "provider-limited",
        reason: "provider",
        providerLimit: "quota",
        observed: observed(12),
      }),
      // Read source, then failed for another reason: it is a Trial.
      selected("partial", "1.0.0", "campaign-1", digest("c")),
      started("v4", "campaign-1", digest("c")),
      finished("run-campaign-1-v4", digest("c"), {
        outcome: "failed",
        reason: "schema",
        observed: observed(12),
      }),
    ]);
    expect(
      inspect(ledger, [
        { slug: "refused", version: "1.0.0" },
        { slug: "limited", version: "1.0.0" },
        { slug: "partial", version: "1.0.0" },
      ]).map(({ reasons }) => reasons),
    ).toEqual([[], [], ["previously-selected"]]);
  });

  it("does not reselect a provider-limited Trial whose automatic resume was refused", () => {
    const events = [
      selected("limited", "1.0.0"),
      started("wp2shell-bounty-v2"),
      ledgerEventV1Schema.parse({
        ...base("campaign-1", digest("a"), "limited-finish"),
        type: "discovery-run-finished",
        runId: "run-campaign-1-wp2shell-bounty-v2",
        outcome: "provider-limited",
        reason: "provider",
        providerLimit: "rate-limit",
        costUsd: "unavailable",
        wallTimeMs: 41 * 60_000,
      }),
    ];
    const candidate = [{ slug: "limited", version: "1.0.0" }];
    expect(inspect(reader(events), candidate)[0]?.reasons).toEqual([]);
    const terminal = ledgerEventV1Schema.parse({
      ...base("campaign-1", digest("a"), "resume-refused"),
      type: "target-skipped",
      selectionId: "wporg:limited@1.0.0",
      stage: "discovery",
      reason: "run-failed",
      artifacts: [{ kind: "target-skip-diagnostic", digest: digest("b") }],
    });
    expect(
      inspect(reader([...events, terminal]), candidate)[0]?.reasons,
    ).toEqual(["previously-selected"]);
  });

  it("ignores child runs when counting exploration Trials", () => {
    const child = ledgerEventV1Schema.parse({
      ...started("wp2shell-bounty-v2"),
      runKind: "child",
      parentRunId: "root-run",
    });
    const ledger = reader([
      selected("child-only", "1.0.0"),
      child,
      finished("wp2shell-bounty-v2"),
    ]);
    expect(
      inspect(ledger, [{ slug: "child-only", version: "1.0.0" }])[0]?.reasons,
    ).toEqual([]);
  });
});
