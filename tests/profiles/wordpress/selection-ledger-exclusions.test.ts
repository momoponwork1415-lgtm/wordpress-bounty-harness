import { describe, expect, it } from "vitest";

import {
  ledgerEventV1Schema,
  type Ledger,
  type LedgerReadQuery,
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
): Pick<Ledger, "read"> {
  const records: readonly LedgerRecord[] = events.map((event, index) => ({
    sequence: index + 1,
    event,
  }));
  return {
    read(query: LedgerReadQuery = {}) {
      return records
        .filter(
          ({ sequence, event }) =>
            sequence > (query.afterSequence ?? 0) &&
            (query.type === undefined || event.type === query.type) &&
            (query.campaignId === undefined ||
              event.campaignId === query.campaignId),
        )
        .slice(0, query.limit ?? 100);
    },
  };
}

function inspect(
  ledger: Pick<Ledger, "read">,
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

  it("reselects a fully observed non-Trial and retains a partial Trial", () => {
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
      // Ran partway into a quota: it is a Trial.
      selected("limited", "1.0.0", "campaign-1", digest("b")),
      started("v3", "campaign-1", digest("b")),
      finished("run-campaign-1-v3", digest("b"), {
        outcome: "provider-limited",
        reason: "provider",
        providerLimit: "quota",
        observed: observed(12),
      }),
    ]);
    expect(
      inspect(ledger, [
        { slug: "refused", version: "1.0.0" },
        { slug: "limited", version: "1.0.0" },
      ]).map(({ reasons }) => reasons),
    ).toEqual([[], ["previously-selected"]]);
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
