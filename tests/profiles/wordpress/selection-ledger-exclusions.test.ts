import { describe, expect, it } from "vitest";

import {
  ledgerEventV1Schema,
  type Ledger,
  type LedgerReadAllQuery,
  type LedgerRecord,
} from "../../../src/ledger/index.js";
import {
  inspectWordPressLedgerExclusions,
  wordPressRevisitPolicySchema,
} from "../../../src/profiles/wordpress/selection/ledger-exclusions.js";

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

function finding(
  findingId: string,
  campaignId = "campaign-1",
  snapshotDigest = digest("a"),
) {
  return ledgerEventV1Schema.parse({
    ...base(campaignId, snapshotDigest, `finding-${campaignId}-${findingId}`),
    type: "finding-recorded",
    findingId,
    runId: "run-1",
    category: "stored-xss",
  });
}

function submitted(
  findingId: string,
  campaignId = "campaign-1",
  snapshotDigest = digest("a"),
) {
  return ledgerEventV1Schema.parse({
    ...base(
      campaignId,
      snapshotDigest,
      `submission-${campaignId}-${findingId}`,
    ),
    type: "submission-recorded",
    findingId,
    candidateId: "candidate-1",
  });
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
  kind:
    | "never"
    | "version-increased"
    | "prompt-version-changed"
    | "version-or-prompt-changed" = "never",
  currentPromptVariant = "wp2shell-bounty-v2",
) {
  return inspectWordPressLedgerExclusions({
    ledger,
    candidates,
    revisitPolicy: { kind },
    currentPromptVariant,
  });
}

describe("WordPress ledger exclusions", () => {
  it("keeps untouched candidates and excludes the same slug in later selections", () => {
    const ledger = reader(trial("seen", "1.2.0"));
    expect(
      inspect(ledger, [
        { slug: "seen", version: "1.2.0" },
        { slug: "new", version: "1.0.0" },
      ]),
    ).toEqual([
      { slug: "seen", version: "1.2.0", reasons: ["previously-selected"] },
      { slug: "new", version: "1.0.0", reasons: [] },
    ]);
  });

  it("revisits only a genuinely higher plugin version when that policy is chosen", () => {
    const ledger = reader([
      ...trial("seen", "1.9.0", "campaign-1", digest("a")),
      ...trial("seen", "1.10.0", "campaign-2", digest("b")),
    ]);
    expect(
      inspect(
        ledger,
        [{ slug: "seen", version: "1.11.0" }],
        "version-increased",
      ),
    ).toEqual([{ slug: "seen", version: "1.11.0", reasons: [] }]);
    expect(
      inspect(
        ledger,
        [{ slug: "seen", version: "1.10.0" }],
        "version-increased",
      )[0]?.reasons,
    ).toEqual(["previously-selected"]);
    expect(
      inspect(
        ledger,
        [{ slug: "seen", version: "1.9.1" }],
        "version-increased",
      )[0]?.reasons,
    ).toEqual(["previously-selected"]);
  });

  it("re-admits a higher version only after minimumDaysSinceTrial have passed since the latest Trial (ADR 0037 addendum)", () => {
    // Trials started 2026-10-11T12:00Z (`occurredAt`).
    const ledger = reader([
      ...trial("seen", "1.9.0", "campaign-1", digest("a")),
      ...trial("seen", "1.10.0", "campaign-2", digest("b")),
    ]);
    const at = (days: number) =>
      new Date(Date.parse(occurredAt) + days * 86_400_000);
    const rule = (version: string, now: Date) =>
      inspectWordPressLedgerExclusions({
        ledger,
        candidates: [{ slug: "seen", version }],
        revisitPolicy: { kind: "version-increased", minimumDaysSinceTrial: 90 },
        currentPromptVariant: "wp2shell-bounty-v2",
        now,
      })[0]?.reasons;
    // Same version: excluded however long ago.
    expect(rule("1.10.0", at(400))).toEqual(["previously-selected"]);
    // Higher version but only 30 days: excluded.
    expect(rule("1.11.0", at(30))).toEqual(["previously-selected"]);
    // Higher version and 89.9 days: still excluded; 90 days: admitted.
    expect(rule("1.11.0", at(89.9))).toEqual(["previously-selected"]);
    expect(rule("1.11.0", at(90))).toEqual([]);
    expect(rule("1.11.0", at(400))).toEqual([]);
    // Without the day gap, the version increase alone re-admits (the pre-addendum rule).
    expect(
      inspectWordPressLedgerExclusions({
        ledger,
        candidates: [{ slug: "seen", version: "1.11.0" }],
        revisitPolicy: { kind: "version-increased" },
        currentPromptVariant: "wp2shell-bounty-v2",
        now: at(1),
      })[0]?.reasons,
    ).toEqual([]);
    // An unpublished Finding keeps the slug out regardless.
    expect(
      inspectWordPressLedgerExclusions({
        ledger: reader([
          ...trial("seen", "1.9.0", "campaign-1", digest("a")),
          finding("finding-1", "campaign-1", digest("a")),
        ]),
        candidates: [{ slug: "seen", version: "1.11.0" }],
        revisitPolicy: { kind: "version-increased", minimumDaysSinceTrial: 90 },
        currentPromptVariant: "wp2shell-bounty-v2",
        now: at(400),
      })[0]?.reasons,
    ).toEqual(["unpublished-finding"]);
    // Legacy-started slugs stay excluded; the rule reads only ledger Trials.
    expect(
      inspectWordPressLedgerExclusions({
        ledger: reader([]),
        candidates: [{ slug: "old", version: "9.0.0" }],
        revisitPolicy: { kind: "version-increased", minimumDaysSinceTrial: 90 },
        currentPromptVariant: "wp2shell-bounty-v2",
        now: at(400),
        legacyHistory: {
          started: new Set(["old"]),
          ambiguous: new Set<string>(),
          reconsider: new Set<string>(),
          exportedAt: "2026-10-12T00:00:00Z",
          digest: digest("f"),
        },
      })[0]?.reasons,
    ).toEqual(["legacy-started"]);
    expect(
      wordPressRevisitPolicySchema.safeParse({
        kind: "never",
        minimumDaysSinceTrial: 90,
      }).success,
    ).toBe(false);
  });

  it("keeps a Finding private even after a version increase", () => {
    const ledger = reader([...trial("seen", "1.2.0"), finding("finding-1")]);
    expect(
      inspect(
        ledger,
        [{ slug: "seen", version: "1.3.0" }],
        "version-increased",
      )[0]?.reasons,
    ).toEqual(["unpublished-finding"]);
    expect(
      inspect(ledger, [{ slug: "seen", version: "1.2.0" }])[0]?.reasons,
    ).toEqual(["unpublished-finding", "previously-selected"]);
  });

  it("does not mistake a human submission for public disclosure", () => {
    const ledger = reader([
      selected("seen", "1.2.0"),
      finding("finding-1"),
      submitted("finding-1"),
    ]);
    expect(
      inspect(
        ledger,
        [{ slug: "seen", version: "1.3.0" }],
        "version-increased",
      )[0]?.reasons,
    ).toEqual(["unpublished-finding"]);
  });

  it("stops selection when a Finding has no WordPress target selection", () => {
    const ledger = reader([finding("finding-without-selection")]);
    expect(() =>
      inspect(ledger, [{ slug: "unknown", version: "1.0.0" }]),
    ).toThrow("a Finding has no matching WordPress target selection");
  });

  it("requires a known and changed prompt version for every earlier selection", () => {
    const ledger = reader([
      ...trial("seen", "1.2.0"),
      ...trial(
        "seen",
        "1.3.0",
        "campaign-2",
        digest("b"),
        "wp2shell-bounty-v3",
      ),
    ]);
    expect(
      inspect(
        ledger,
        [{ slug: "seen", version: "1.3.0" }],
        "prompt-version-changed",
        "wp2shell-bounty-v4",
      )[0]?.reasons,
    ).toEqual([]);
    expect(
      inspect(
        ledger,
        [{ slug: "seen", version: "1.3.0" }],
        "prompt-version-changed",
        "wp2shell-bounty-v2",
      )[0]?.reasons,
    ).toEqual(["previously-selected"]);
  });

  it("does not exclude a selection whose Trial never started", () => {
    const reservation = ledgerEventV1Schema.parse({
      ...base("campaign-1", digest("c"), "selection-reservation"),
      type: "target-selected",
      selectionId: "wporg:reserved@1.0.0",
      promptVariant: "wp2shell-bounty-v2",
    });
    expect(
      inspect(reader([reservation]), [
        { slug: "reserved", version: "1.0.0" },
      ])[0]?.reasons,
    ).toEqual([]);
  });

  it("uses either configured change without accepting equal or older versions", () => {
    const ledger = reader([...trial("seen", "2.0.0")]);
    expect(
      inspect(
        ledger,
        [{ slug: "seen", version: "1.9.0" }],
        "version-or-prompt-changed",
        "wp2shell-bounty-v3",
      )[0]?.reasons,
    ).toEqual([]);
    expect(
      inspect(
        ledger,
        [{ slug: "seen", version: "2.0.0" }],
        "version-or-prompt-changed",
      )[0]?.reasons,
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

  it("lets owner reconsider override legacy and earlier Trial exclusions", () => {
    const legacyHistory = {
      started: new Set(["old-started", "back"]),
      ambiguous: new Set(["old-ambiguous", "held"]),
      reconsider: new Set(["back", "held", "retried"]),
      exportedAt: "2026-10-12T00:00:00Z",
      digest: digest("f"),
    };
    const result = inspectWordPressLedgerExclusions({
      ledger: reader(trial("retried", "1.0.0")),
      candidates: [
        "old-started",
        "old-ambiguous",
        "back",
        "held",
        "retried",
        "new",
      ].map((slug) => ({ slug, version: "1.0.0" })),
      revisitPolicy: { kind: "never" },
      currentPromptVariant: "wp2shell-bounty-v2",
      legacyHistory,
    });
    expect(result.map(({ slug, reasons }) => [slug, reasons])).toEqual([
      ["old-started", ["legacy-started"]],
      ["old-ambiguous", ["legacy-ambiguous"]],
      ["back", []],
      ["held", []],
      ["retried", []],
      ["new", []],
    ]);
  });

  it("counts a reconsidered slug's Trials that started after the legacy export", () => {
    const legacyHistory = {
      started: new Set(["retried"]),
      ambiguous: new Set<string>(),
      reconsider: new Set(["retried", "fresh"]),
      // The export predates the recorded Trial (2026-10-11T12:00Z).
      exportedAt: "2026-10-10T00:00:00Z",
      digest: digest("f"),
    };
    const result = inspectWordPressLedgerExclusions({
      ledger: reader(trial("retried", "1.0.0")),
      candidates: ["retried", "fresh"].map((slug) => ({
        slug,
        version: "1.0.0",
      })),
      revisitPolicy: { kind: "never" },
      currentPromptVariant: "wp2shell-bounty-v2",
      legacyHistory,
    });
    expect(result.map(({ slug, reasons }) => [slug, reasons])).toEqual([
      ["retried", ["previously-selected"]],
      ["fresh", []],
    ]);
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
      revisitPolicy: { kind: "never" },
      currentPromptVariant: "wp2shell-bounty-v2",
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
        // Deferred once, then frozen and explored: the Trial rule decides.
        skipped("recovered", "1.0.0", "selection-1"),
        ...trial("recovered", "1.0.0", "campaign-3", digest("c")),
      ]),
      candidates: [
        { slug: "bad-header", version: "1.0.0" },
        { slug: "bad-header", version: "1.0.1" },
        { slug: "timed-out", version: "1.0.0" },
        { slug: "host-down", version: "1.0.0" },
        { slug: "recovered", version: "1.0.0" },
      ],
      revisitPolicy: { kind: "never" },
      currentPromptVariant: "wp2shell-bounty-v2",
    });
    expect(
      result.map(({ slug, version, reasons }) => [slug, version, reasons]),
    ).toEqual([
      ["bad-header", "1.0.0", ["freeze-deferred"]],
      ["bad-header", "1.0.1", []],
      ["timed-out", "1.0.0", []],
      ["host-down", "1.0.0", []],
      ["recovered", "1.0.0", ["previously-selected"]],
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

  it("never revisits a started slug, even on a higher version", () => {
    expect(
      inspect(reader(trial("seen", "1.0.0")), [
        { slug: "seen", version: "9.0.0" },
      ])[0]?.reasons,
    ).toEqual(["previously-selected"]);
  });

  it("rejects invalid revisit policy combinations at the schema boundary", () => {
    expect(
      wordPressRevisitPolicySchema.safeParse({ kind: "never" }).success,
    ).toBe(true);
    expect(
      wordPressRevisitPolicySchema.safeParse({
        kind: "never",
        currentPromptVariant: "v3",
      }).success,
    ).toBe(false);
  });
});
