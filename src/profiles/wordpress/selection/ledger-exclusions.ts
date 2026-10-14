import { z } from "zod";

import type {
  Ledger,
  LedgerEventV1,
  LedgerRecord,
} from "../../../ledger/index.js";
import { compareVersions } from "../plugin-version.js";

/** Revisit is an explicit policy choice; the default policy uses `never`. */
export const wordPressRevisitPolicySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("never") }),
  z.strictObject({ kind: z.literal("version-increased") }),
  z.strictObject({ kind: z.literal("prompt-version-changed") }),
  z.strictObject({ kind: z.literal("version-or-prompt-changed") }),
]);

export type WordPressRevisitPolicy = z.infer<
  typeof wordPressRevisitPolicySchema
>;

export type WordPressLedgerExclusionReason =
  | "previously-selected"
  | "unpublished-finding"
  | "legacy-started"
  | "legacy-ambiguous";

/** Earlier generations' history, exported once outside Git (D2). */
export type WordPressLegacyHistory =
  | {
      readonly started: ReadonlySet<string>;
      readonly ambiguous: ReadonlySet<string>;
      /** Ambiguous slugs confirmed as first Trials; never bypasses started runs. */
      readonly reconsider: ReadonlySet<string>;
      readonly digest: string;
    }
  | "unavailable";

export interface WordPressLedgerExclusion {
  readonly slug: string;
  readonly version: string;
  readonly reasons: readonly WordPressLedgerExclusionReason[];
}

interface EarlierSelection {
  readonly version: string;
  readonly snapshotKey: string;
}

const pageSize = 1000;

function ledgerEvents(
  ledger: Pick<Ledger, "read">,
  type: LedgerEventV1["type"],
): readonly LedgerEventV1[] {
  const events: LedgerEventV1[] = [];
  let afterSequence = 0;
  for (;;) {
    const page: readonly LedgerRecord[] = ledger.read({
      type,
      afterSequence,
      limit: pageSize,
    });
    if (page.length === 0) return events;
    events.push(...page.map(({ event }) => event));
    const lastSequence = page.at(-1)?.sequence;
    if (lastSequence === undefined || lastSequence <= afterSequence)
      throw new Error("Ledger pagination did not advance");
    afterSequence = lastSequence;
    if (page.length < pageSize) return events;
  }
}

function snapshotKey(
  event: Pick<LedgerEventV1, "campaignId" | "snapshotDigest">,
): string {
  return `${event.campaignId}\0${event.snapshotDigest}`;
}

function selectionIdentity(selectionId: string): {
  readonly slug: string;
  readonly version: string;
} | null {
  const matched = /^wporg:([a-z0-9][a-z0-9-]*)@(.+)$/u.exec(selectionId);
  return matched?.[1] && matched[2]
    ? { slug: matched[1], version: matched[2] }
    : null;
}

function promptChanged(
  earlier: readonly EarlierSelection[],
  promptVersions: ReadonlyMap<string, ReadonlySet<string>>,
  currentPromptVariant: string,
): boolean {
  return earlier.every(({ snapshotKey: key }) => {
    const used = promptVersions.get(key);
    return (
      used !== undefined && used.size > 0 && !used.has(currentPromptVariant)
    );
  });
}

/**
 * Inspect the entire append-only ledger, including older campaigns. A target
 * with a recorded run start remains excluded. Observed zero activity is only
 * a lower bound and does not prove that an earlier run was not a Trial.
 */
export function inspectWordPressLedgerExclusions(input: {
  readonly ledger: Pick<Ledger, "read">;
  readonly candidates: readonly {
    readonly slug: string;
    readonly version: string;
  }[];
  readonly currentPromptVariant: string;
  readonly revisitPolicy: WordPressRevisitPolicy;
  readonly legacyHistory?: WordPressLegacyHistory;
}): readonly WordPressLedgerExclusion[] {
  const revisitPolicy = wordPressRevisitPolicySchema.parse(input.revisitPolicy);
  const promptVersions = new Map<string, Set<string>>();
  const selectedBySlug = new Map<string, EarlierSelection[]>();
  const selectedBySnapshot = new Map<string, string>();
  const versionBySnapshot = new Map<string, string>();
  const recordPrompt = (key: string, promptVariant: string): void => {
    const versions = promptVersions.get(key) ?? new Set<string>();
    versions.add(promptVariant);
    promptVersions.set(key, versions);
  };

  for (const event of ledgerEvents(input.ledger, "target-selected")) {
    if (event.type !== "target-selected") continue;
    const identity = selectionIdentity(event.selectionId);
    if (identity === null) continue;
    const key = snapshotKey(event);
    const priorSlug = selectedBySnapshot.get(key);
    const priorVersion = versionBySnapshot.get(key);
    if (
      priorSlug !== undefined &&
      (priorSlug !== identity.slug || priorVersion !== identity.version)
    )
      throw new Error(
        "Cannot select: conflicting target selections for a Snapshot",
      );
    selectedBySnapshot.set(key, identity.slug);
    versionBySnapshot.set(key, identity.version);
    if ("promptVariant" in event && typeof event.promptVariant === "string")
      recordPrompt(key, event.promptVariant);
  }

  for (const event of ledgerEvents(input.ledger, "discovery-run-started")) {
    if (event.type !== "discovery-run-started") continue;
    const key = snapshotKey(event);
    recordPrompt(key, event.configuration.promptVariant);
    const slug = selectedBySnapshot.get(key);
    const version = versionBySnapshot.get(key);
    if (slug === undefined || version === undefined)
      throw new Error(
        "Cannot select: a started run has no matching WordPress target selection",
      );
    const earlier = selectedBySlug.get(slug) ?? [];
    if (!earlier.some((item) => item.snapshotKey === key))
      earlier.push({ version, snapshotKey: key });
    selectedBySlug.set(slug, earlier);
  }

  // A submission receipt records a human action, not public disclosure.
  // Until the ledger records publication, every Finding remains private here.
  const unpublishedFindingSlugs = new Set<string>();
  for (const event of ledgerEvents(input.ledger, "finding-recorded")) {
    if (event.type !== "finding-recorded") continue;
    const slug = selectedBySnapshot.get(snapshotKey(event));
    if (slug === undefined)
      throw new Error(
        "Cannot select: a Finding has no matching WordPress target selection",
      );
    unpublishedFindingSlugs.add(slug);
  }

  const legacy = input.legacyHistory ?? "unavailable";
  return input.candidates.map(({ slug, version }) => {
    const reasons: WordPressLedgerExclusionReason[] = [];
    if (unpublishedFindingSlugs.has(slug)) reasons.push("unpublished-finding");
    if (legacy !== "unavailable") {
      if (legacy.started.has(slug)) reasons.push("legacy-started");
      else if (legacy.ambiguous.has(slug) && !legacy.reconsider.has(slug))
        reasons.push("legacy-ambiguous");
    }
    const earlier = selectedBySlug.get(slug) ?? [];
    if (earlier.length > 0) {
      const versionIncreased = earlier.every(
        (selected) => compareVersions(version, selected.version) > 0,
      );
      const changedPrompt = promptChanged(
        earlier,
        promptVersions,
        input.currentPromptVariant,
      );
      const revisit =
        revisitPolicy.kind === "version-increased"
          ? versionIncreased
          : revisitPolicy.kind === "prompt-version-changed"
            ? changedPrompt
            : revisitPolicy.kind === "version-or-prompt-changed"
              ? versionIncreased || changedPrompt
              : false;
      if (!revisit) reasons.push("previously-selected");
    }
    return { slug, version, reasons };
  });
}
