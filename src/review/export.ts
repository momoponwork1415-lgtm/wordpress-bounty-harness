import { join } from "node:path";

import { z } from "zod";

import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import { readFindingGroups } from "../ledger/finding-groups.js";
import type { Ledger, LedgerEventV1 } from "../ledger/index.js";
import { readDecisionHistory } from "./decision-history.js";
import {
  DEDUPE_NOTE_FILE,
  readReviewRecord,
  type DuplicateCheck,
  type ReviewRecordByKind,
  type ReviewRecordKind,
} from "./records.js";

/**
 * `review export`: the one bundle the Claude Code skills read (ADR 0031). It
 * carries review material and Private Evidence paths. Candidate bodies,
 * payloads and HTTP bodies never appear as values; only their paths and digests.
 */
export const REVIEW_EXPORT_SCHEMA_ID = "review-export/v1";

const id = z.string().min(1).max(128);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const evidenceRefSchema = z.strictObject({
  kind: id,
  digest,
  /** Absolute directory holding the artifact's files on this host. */
  path: z.string().min(1),
});
const sourceTraceSchema = z.strictObject({
  file: z.string().max(512),
  function: z.string().max(256),
  line: z.number().int().positive(),
});
const httpRowSchema = z.strictObject({
  method: z.string().max(16),
  /** Path without its query string; parameter names are listed, values are not. */
  path: z.string().max(2048),
  queryKeys: z.array(z.string().max(128)).max(64),
  status: z.number().int().nullable(),
});
/** One file in Private Evidence: where it is on this host and the sha256 of its bytes. */
const fileRefSchema = z.strictObject({ path: z.string().min(1), digest });
const firingStatuses = [
  "observed",
  "not-observed",
  "visit-failed",
  "not-recorded",
] as const;

/** A profile summarizes its own state-diff file into this shape; values never appear. */
export const stateDiffSummarySchema = z.strictObject({
  settings: z.strictObject({
    added: z.array(z.string().max(191)),
    removed: z.array(z.string().max(191)),
    changed: z.array(
      z.strictObject({
        key: z.string().max(191),
        beforeDigest: z.string().max(64),
        afterDigest: z.string().max(64),
      }),
    ),
  }),
  principals: z.strictObject({
    added: z.array(
      z.strictObject({ name: z.string().max(60), roles: z.array(z.string()) }),
    ),
    removed: z.array(z.string().max(60)),
    changed: z.array(
      z.strictObject({
        name: z.string().max(60),
        rolesBefore: z.array(z.string()),
        rolesAfter: z.array(z.string()),
        credentialChanged: z.boolean(),
      }),
    ),
  }),
  tables: z.strictObject({
    added: z.array(z.string().max(64)),
    removed: z.array(z.string().max(64)),
    changed: z.array(
      z.strictObject({
        name: z.string().max(64),
        rowsBefore: z.number().int().nonnegative(),
        rowsAfter: z.number().int().nonnegative(),
        checksumChanged: z.boolean(),
      }),
    ),
  }),
});
export type StateDiffSummary = z.infer<typeof stateDiffSummarySchema>;

export const reviewExportV1Schema = z.strictObject({
  schema: z.literal(REVIEW_EXPORT_SCHEMA_ID),
  generatedAt: z.iso.datetime(),
  campaignId: id,
  findingId: id,
  snapshotDigest: digest,
  target: z.strictObject({
    selectionId: z.string().nullable(),
    targetId: z.string().nullable(),
    activeInstallations: z.number().int().nonnegative().nullable(),
    versions: z.strictObject({
      explored: z.string().nullable(),
      /** The newest version any selection record in the ledger observed, if any. */
      latestKnown: z.string().nullable(),
      latestKnownAt: z.iso.datetime({ offset: true }).nullable(),
      sameAsExplored: z.boolean().nullable(),
      /** The public listing observed once at export time; null when it failed. */
      latestObserved: z
        .strictObject({
          version: z.string(),
          observedAt: z.iso.datetime({ offset: true }),
        })
        .nullable(),
    }),
  }),
  finding: z.strictObject({
    category: id,
    claim: z.string().max(4000),
    attackerPosition: z.string().max(64),
    impact: z.string().max(64),
    brokenProperty: z.string().max(1000),
    configurationPrecondition: z.string().max(1000).nullable(),
    sourceTrace: z.array(sourceTraceSchema),
    recordedAt: z.iso.datetime({ offset: true }),
    runId: id,
    promptVariant: z.string().nullable(),
    promptDigest: digest.nullable(),
    /** Full private record, including fields this bundle leaves out. */
    path: z.string().nullable(),
  }),
  /**
   * #424: Findings of the same Snapshot whose profile keys overlap. The group
   * orders review; the decision and the submission stay per Finding.
   */
  group: z.strictObject({
    id,
    size: z.number().int().positive(),
    representative: z.boolean(),
  }),
  verification: z
    .strictObject({
      verificationId: id,
      status: z.enum([
        "runtime-confirmed",
        "reproduced",
        "contradicted",
        "incomplete",
      ]),
      /** The deterministic judge, or the Harness reproducer for a `reproduced` result. */
      reason: z.string().nullable(),
      nextStep: z.string().nullable(),
      judgeId: z.string().nullable(),
      conditions: z.record(z.string(), z.string()).nullable(),
      evidenceCapture: z.string().nullable(),
      occurredAt: z.iso.datetime({ offset: true }),
      labSetupDigest: digest,
      scenario: z.strictObject({ id: z.string(), digest }).nullable(),
      attempts: z.number().int().positive(),
      verifierRuns: z.array(
        z.strictObject({
          runId: id,
          terminal: z.string(),
          promptDigest: digest,
          occurredAt: z.iso.datetime({ offset: true }),
        }),
      ),
    })
    .nullable(),
  http: z.strictObject({
    source: z.enum(["harness-captured", "agent-authored", "unavailable"]),
    path: z.string().nullable(),
    exchanges: z.array(httpRowSchema).max(500),
    truncated: z.boolean(),
  }),
  refutation: z
    .strictObject({
      digest,
      path: z.string(),
      text: z.string().max(16_384),
      truncated: z.boolean(),
    })
    .nullable(),
  labStateDiff: z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("captured"),
      path: z.string(),
      summary: stateDiffSummarySchema,
    }),
    z.strictObject({ status: z.literal("missing"), reason: z.string() }),
    /** The verification predates the observer, or the Finding is unverified. */
    z.strictObject({ status: z.literal("unavailable") }),
  ]),
  /**
   * #437: the Verifier's own record of the attempt and what the Harness-owned
   * observer saw on the victim side. Observations, not a verdict: the judge's
   * result stays in `verification`. Null when no recipe was recorded.
   */
  observations: z
    .strictObject({
      /** The Verifier's narrative; a record of what it did, never proof. */
      steps: fileRefSchema.nullable(),
      victim: z
        .strictObject({
          role: z.string().max(64),
          /** Pages the observer was asked to open; query values stay in the recipe. */
          pages: z
            .array(
              z.strictObject({
                path: z.string().max(2048),
                queryKeys: z.array(z.string().max(128)).max(64),
                actions: z.number().int().nonnegative(),
              }),
            )
            .max(5),
          /** What the observer recorded while it opened the pages. */
          firing: z.enum(firingStatuses),
          record: fileRefSchema.nullable(),
          screenshot: z.string().nullable(),
        })
        .nullable(),
    })
    .nullable(),
  review: z.strictObject({
    decisions: z.array(
      z.strictObject({
        decision: z.enum(["accept", "reject", "defer"]),
        occurredAt: z.iso.datetime({ offset: true }),
        humanElapsedSeconds: z.number().int().nonnegative().nullable(),
      }),
    ),
    scopeAssessments: z.array(
      z.strictObject({
        assessmentId: z.string(),
        programmeId: id,
        status: z.string(),
      }),
    ),
    /** The latest historical decision, even after a newer verification; null before any decision. */
    decision: z
      .strictObject({
        decision: z.enum(["accept", "reject", "defer"]),
        reasonCode: z.string().nullable(),
        duplicate: z.string().nullable(),
        decidedAt: z.iso.datetime({ offset: true }),
      })
      .nullable(),
    /**
     * #442 (ADR 0038 stage 4): the wbh-dedupe result the latest decision
     * carries, with what backs it. Only `no-match` goes on to stage 5;
     * `unavailable` waits for a re-check. `checkedAt` is null when no result
     * was recorded. Null before any decision.
     */
    duplicate: z
      .strictObject({
        status: z.enum(["possible-match", "no-match", "unavailable"]),
        /** `possible-match`: the CVE id or public record URL. */
        reference: z.string().nullable(),
        /** `unavailable`: why the check could not finish. */
        reason: z.string().nullable(),
        checkedAt: z.iso.datetime({ offset: true }).nullable(),
        /** The skill's note: databases, search terms, time, differences. */
        note: fileRefSchema.nullable(),
      })
      .nullable(),
    humanReproduction: z
      .strictObject({
        result: z.enum(["match", "mismatch", "unavailable"]),
        minutes: z.number().nullable(),
        recordedAt: z.iso.datetime({ offset: true }),
      })
      .nullable(),
    /** The newest verification of a Finding derived from this one (reverify). */
    latestReverification: z
      .strictObject({
        verificationId: id,
        findingId: id,
        status: z.string(),
        basis: z.string().nullable(),
        recordedAt: z.iso.datetime({ offset: true }),
      })
      .nullable(),
    latestDraft: z
      .strictObject({
        digest,
        revision: z.number().int().positive(),
        preparedBy: z.string(),
        programme: z.string(),
      })
      .nullable(),
    labSetup: z
      .strictObject({
        digest,
        ordinaryActivationDefaults: z.boolean().nullable(),
      })
      .nullable(),
  }),
  privateEvidence: z.strictObject({
    directory: z.string(),
    artifacts: z.array(evidenceRefSchema),
  }),
});
export type ReviewExportV1 = z.infer<typeof reviewExportV1Schema>;

/** How a profile turns its own state-diff artifact into the generic summary. */
export interface StateDiffReader {
  read(digest: string): Promise<StateDiffSummary | null>;
}

/**
 * How a profile reads the HTTP record inside a judge's evidence artifact.
 * Only method, address and status cross this seam; Review drops query values
 * and never sees bodies. `null` means the artifact holds no HTTP record.
 */
export interface HttpEvidenceReader {
  read(evidenceDigest: string): Promise<HttpEvidenceRecord | null>;
}
export interface HttpEvidenceRecord {
  readonly source: "harness-captured" | "agent-authored";
  /** Absolute path of the record file on this host. */
  readonly path: string;
  readonly exchanges: readonly {
    readonly method: string;
    /** A path or URL; its query string is reduced to parameter names here. */
    readonly address: string;
    readonly status: number | null;
  }[];
}

/**
 * How a profile reads the Verifier's recipe and its own observer's record of
 * the victim side (#437). Paths, digests and the observer's status cross this
 * seam; bodies, payloads and query values do not.
 */
export interface VerifierRecordReader {
  read(input: {
    readonly recipeDigest: string;
    /** The judge's evidence artifact, where the observer's record lives. */
    readonly evidenceDigest: string | null;
  }): Promise<VerifierRecord>;
}
export interface VerifierRecord {
  readonly steps: z.infer<typeof fileRefSchema> | null;
  readonly victim: {
    readonly role: string;
    /** A path or URL per page; Review reduces its query string to names. */
    readonly pages: readonly {
      readonly address: string;
      readonly actions: number;
    }[];
    readonly firing: (typeof firingStatuses)[number];
    readonly record: z.infer<typeof fileRefSchema> | null;
    readonly screenshot: string | null;
  } | null;
}

const findingRecordSchema = z.looseObject({
  claim: z.string(),
  attackerPosition: z.string(),
  impact: z.string(),
  brokenProperty: z.string(),
  configurationPrecondition: z.string().optional(),
  sourceTrace: z.array(sourceTraceSchema).optional(),
});
const selectionRecordSchema = z.looseObject({
  activeInstallations: z.number().int().nonnegative().optional(),
});

const MAX_ROWS = 500;
const MAX_MEMO_CHARS = 16_384;

function httpRow(
  method: string,
  address: string,
  status: number | null,
): z.infer<typeof httpRowSchema> {
  let url: URL;
  try {
    url = new URL(address, "http://lab.invalid");
  } catch {
    return { method, path: address.split("?")[0] ?? "", queryKeys: [], status };
  }
  return {
    method,
    path: url.pathname,
    queryKeys: [...new Set(url.searchParams.keys())].slice(0, 64),
    status,
  };
}

/** Method, path and parameter names of each exchange; values and bodies stay behind `path`. */
async function httpSummary(
  reader: HttpEvidenceReader | undefined,
  evidenceDigest: string | undefined,
): Promise<ReviewExportV1["http"]> {
  const record =
    evidenceDigest === undefined
      ? null
      : ((await reader?.read(evidenceDigest)) ?? null);
  if (record === null)
    return {
      source: "unavailable",
      path: null,
      exchanges: [],
      truncated: false,
    };
  return {
    source: record.source,
    path: record.path,
    exchanges: record.exchanges
      .slice(0, MAX_ROWS)
      .map((exchange) =>
        httpRow(exchange.method, exchange.address, exchange.status),
      ),
    truncated: record.exchanges.length > MAX_ROWS,
  };
}

function duplicateView(
  check: DuplicateCheck,
  contentPath: (artifact: string) => string,
): ReviewExportV1["review"]["duplicate"] {
  return {
    status: check.status,
    reference: check.status === "possible-match" ? check.reference : null,
    reason: check.status === "unavailable" ? (check.reason ?? null) : null,
    checkedAt: check.checkedAt ?? null,
    note:
      check.note === undefined
        ? null
        : {
            path: join(contentPath(check.note), DEDUPE_NOTE_FILE),
            digest: check.note,
          },
  };
}

function versionOf(selectionId: string): {
  readonly targetId: string;
  readonly version: string;
} | null {
  const at = selectionId.lastIndexOf("@");
  if (at <= 0 || at === selectionId.length - 1) return null;
  return {
    targetId: selectionId.slice(0, at),
    version: selectionId.slice(at + 1),
  };
}

/** Builds the bundle from the ledger and Private Evidence; nothing is written. */
export async function exportReviewBundle(options: {
  readonly ledger: Ledger;
  /** Private Evidence; the bundle's paths are the ones this store returns. */
  readonly store: PrivateArtifactStore;
  readonly campaignId: string;
  readonly findingId: string;
  readonly stateDiff?: StateDiffReader;
  readonly httpEvidence?: HttpEvidenceReader;
  readonly verifierRecord?: VerifierRecordReader;
  readonly clock?: () => Date;
  /** One public observation of the target's newest version; failures become null. */
  readonly observeLatestVersion?: (
    targetId: string,
  ) => Promise<{ version: string; observedAt: string } | null>;
}): Promise<ReviewExportV1> {
  const { ledger, store } = options;
  const campaignId = id.parse(options.campaignId);
  const findingId = id.parse(options.findingId);
  const contentPath = (artifact: string) => store.contentPath(artifact);
  const finding = ledger
    .read({ campaignId, findingId, type: "finding-recorded", limit: 1 })
    .at(0)?.event;
  if (finding?.type !== "finding-recorded")
    throw new Error("The finding is not recorded in this campaign");
  const artifacts: ReviewExportV1["privateEvidence"]["artifacts"] = [];
  const addArtifact = (kind: string, artifact: string | undefined) => {
    if (artifact === undefined) return;
    if (
      artifacts.some((item) => item.digest === artifact && item.kind === kind)
    )
      return;
    artifacts.push({ kind, digest: artifact, path: contentPath(artifact) });
  };
  for (const artifact of finding.artifacts)
    addArtifact(artifact.kind, artifact.digest);

  const findingRef = finding.artifacts.find((item) => item.kind === "finding");
  const findingFile =
    findingRef === undefined
      ? null
      : await store.readJson(
          findingRef.digest,
          "finding.json",
          findingRecordSchema,
          1024 * 1024,
        );
  const record = findingFile?.status === "resolved" ? findingFile.value : null;
  const run = ledger
    .readAll({ type: "discovery-run-started" })
    .find(
      ({ event }) =>
        event.type === "discovery-run-started" &&
        event.campaignId === campaignId &&
        event.runId === finding.runId,
    )?.event;

  const selections = ledger
    .readAll({ type: "target-selected" })
    .map(({ event }) => event)
    .filter((event) => event.type === "target-selected");
  const selected = selections.find(
    (event) =>
      event.campaignId === campaignId &&
      event.snapshotDigest === finding.snapshotDigest,
  );
  const explored =
    selected === undefined ? null : versionOf(selected.selectionId);
  let latest: { version: string; at: string } | null = null;
  if (explored !== null)
    for (const event of selections) {
      const parsed = versionOf(event.selectionId);
      if (parsed === null || parsed.targetId !== explored.targetId) continue;
      if (latest === null || event.occurredAt > latest.at)
        latest = { version: parsed.version, at: event.occurredAt };
    }
  const selectionRef = selected?.artifacts.find(
    (item) => item.kind === "target-selection",
  );
  addArtifact("target-selection", selectionRef?.digest);
  const selectionFile =
    selectionRef === undefined
      ? null
      : await store.readJson(
          selectionRef.digest,
          "target-selection.json",
          selectionRecordSchema,
          1024 * 1024,
        );
  const selectionRecord =
    selectionFile?.status === "resolved" ? selectionFile.value : null;

  const verifications = ledger
    .readAll({ campaignId, findingId, type: "verification-finished" })
    .map(({ event }) => event)
    .filter((event) => event.type === "verification-finished");
  const verification = verifications.at(-1);
  const verifierRuns = ledger
    .readAll({ campaignId, findingId, type: "verifier-run-finished" })
    .map(({ event }) => event)
    .filter((event) => event.type === "verifier-run-finished");
  for (const event of verifierRuns)
    addArtifact("verifier-receipt", event.receiptDigest);
  for (const event of verifications) {
    for (const artifact of event.artifacts)
      addArtifact(artifact.kind, artifact.digest);
    if ("evidenceDigest" in event.result)
      addArtifact("judge-evidence", event.result.evidenceDigest);
    if ("refutationDigest" in event.result)
      addArtifact("refutation", event.result.refutationDigest);
    if (event.result.status === "runtime-confirmed")
      addArtifact(
        "reproduction-package",
        event.result.reproductionPackageDigest,
      );
  }
  const labEvent =
    verification === undefined
      ? undefined
      : ledger
          .readAll({ type: "lab-provisioned" })
          .find(
            ({ event }) =>
              event.type === "lab-provisioned" &&
              event.identity ===
                `verification-lab-${verification.verificationId}`,
          )?.event;

  const evidenceDigest =
    verification !== undefined && "evidenceDigest" in verification.result
      ? verification.result.evidenceDigest
      : undefined;
  const http = await httpSummary(options.httpEvidence, evidenceDigest);
  const recipeRef = verification?.artifacts.find(
    (item) => item.kind === "recipe",
  );
  const verifierRecord =
    recipeRef === undefined || options.verifierRecord === undefined
      ? null
      : await options.verifierRecord.read({
          recipeDigest: recipeRef.digest,
          evidenceDigest: evidenceDigest ?? null,
        });
  const victim = verifierRecord?.victim ?? null;
  const observations: ReviewExportV1["observations"] =
    verifierRecord === null
      ? null
      : {
          steps: verifierRecord.steps,
          victim:
            victim === null
              ? null
              : {
                  ...victim,
                  pages: victim.pages.slice(0, 5).map((page) => {
                    const { path, queryKeys } = httpRow("", page.address, null);
                    return { path, queryKeys, actions: page.actions };
                  }),
                },
        };

  let refutation: ReviewExportV1["refutation"] = null;
  const refutationDigest =
    verification !== undefined && "refutationDigest" in verification.result
      ? verification.result.refutationDigest
      : undefined;
  if (refutationDigest !== undefined) {
    const memo = await store.readFile(
      refutationDigest,
      "refutation.md",
      1024 * 1024,
    );
    if (memo.status === "resolved") {
      const text = memo.bytes.toString("utf8");
      refutation = {
        digest: refutationDigest,
        path: join(contentPath(refutationDigest), "refutation.md"),
        text: text.slice(0, MAX_MEMO_CHARS),
        truncated: text.length > MAX_MEMO_CHARS,
      };
    }
  }

  let labStateDiff: ReviewExportV1["labStateDiff"] = { status: "unavailable" };
  if (verification?.labStateDiff?.status === "missing")
    labStateDiff = {
      status: "missing",
      reason: verification.labStateDiff.reason,
    };
  else if (verification?.labStateDiff?.status === "captured") {
    const diffRef = verification.artifacts.find(
      (item) => item.kind === "lab-state-diff",
    );
    const summary =
      diffRef === undefined
        ? null
        : ((await options.stateDiff?.read(diffRef.digest)) ?? null);
    labStateDiff =
      diffRef === undefined || summary === null
        ? { status: "missing", reason: "store" }
        : { status: "captured", path: contentPath(diffRef.digest), summary };
  }

  const decisions = readDecisionHistory(ledger, { campaignId, findingId }).map(
    ({ event }) => event,
  );
  for (const event of decisions)
    for (const artifact of event.artifacts)
      addArtifact(artifact.kind, artifact.digest);
  const scopes = ledger
    .readAll({ campaignId, findingId, type: "scope-assessed" })
    .map(({ event }) => event)
    .filter((event) => event.type === "scope-assessed");
  // Review's own records, read the way Review wrote them. An event without a
  // readable record (older events) keeps the derived fields null.
  const privateRecord = async <K extends ReviewRecordKind>(
    event: LedgerEventV1 | undefined,
    kind: K,
  ): Promise<ReviewRecordByKind[K] | null> => {
    if (event === undefined) return null;
    const read = await readReviewRecord(store, event, kind);
    return read.status === "read" ? read.record : null;
  };
  const latestHistoricalDecision = decisions.at(-1);
  const decisionRecord = await privateRecord(
    latestHistoricalDecision,
    "review-decision",
  );
  const ofFinding = (type: LedgerEventV1["type"], ids: readonly string[]) =>
    ids.flatMap((findingIdOf) =>
      ledger
        .readAll({ campaignId, findingId: findingIdOf, type })
        .map(({ event }) => event),
    );
  const reproduction = ofFinding("human-reproduction-recorded", [findingId]).at(
    -1,
  );
  const reproduceMinutes = ofFinding("human-effort-recorded", [findingId])
    .filter(
      (event) =>
        event.type === "human-effort-recorded" && event.action === "reproduce",
    )
    .at(-1);
  const derived = ledger
    .readAll({ type: "finding-recorded" })
    .map(({ event }) => event)
    .filter(
      (event) =>
        event.type === "finding-recorded" &&
        event.campaignId === campaignId &&
        event.derivedFromFindingId === findingId,
    )
    .map((event) => (event.type === "finding-recorded" ? event.findingId : ""));
  const reverification = ofFinding("verification-finished", derived)
    .filter((event) => event.type === "verification-finished")
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    .at(-1);
  const draft = ofFinding("draft-saved", [findingId]).at(-1);
  const draftRecord = await privateRecord(draft, "review-draft");
  const latestObserved =
    explored === null || options.observeLatestVersion === undefined
      ? null
      : await options.observeLatestVersion(explored.targetId).catch(() => null);

  return reviewExportV1Schema.parse({
    schema: REVIEW_EXPORT_SCHEMA_ID,
    generatedAt: (options.clock ?? (() => new Date()))().toISOString(),
    campaignId,
    findingId,
    snapshotDigest: finding.snapshotDigest,
    target: {
      selectionId: selected?.selectionId ?? null,
      targetId: explored?.targetId ?? null,
      activeInstallations: selectionRecord?.activeInstallations ?? null,
      versions: {
        explored: explored?.version ?? null,
        latestKnown: latest?.version ?? null,
        latestKnownAt: latest?.at ?? null,
        sameAsExplored:
          explored === null || latest === null
            ? null
            : explored.version === latest.version,
        latestObserved,
      },
    },
    finding: {
      category: finding.category,
      claim: record?.claim ?? "(finding.json unavailable)",
      attackerPosition: record?.attackerPosition ?? "unknown",
      impact: record?.impact ?? finding.category,
      brokenProperty: record?.brokenProperty ?? "(finding.json unavailable)",
      configurationPrecondition: record?.configurationPrecondition ?? null,
      sourceTrace: record?.sourceTrace ?? [],
      recordedAt: finding.occurredAt,
      runId: finding.runId,
      promptVariant:
        run?.type === "discovery-run-started"
          ? run.configuration.promptVariant
          : null,
      promptDigest:
        run?.type === "discovery-run-started"
          ? (run.configuration.promptDigest ?? null)
          : null,
      path:
        findingRef === undefined
          ? null
          : join(contentPath(findingRef.digest), "finding.json"),
    },
    group: readFindingGroups(ledger, { campaignId }).of(campaignId, findingId),
    verification:
      verification === undefined
        ? null
        : {
            verificationId: verification.verificationId,
            status: verification.result.status,
            reason:
              verification.result.status === "incomplete"
                ? verification.result.reason
                : null,
            nextStep:
              verification.result.status === "incomplete"
                ? verification.result.nextStep
                : null,
            judgeId:
              verification.result.status === "incomplete"
                ? null
                : verification.result.status === "reproduced"
                  ? verification.result.reproducerId
                  : verification.result.judgeId,
            conditions:
              verification.result.status === "runtime-confirmed" ||
              verification.result.status === "reproduced"
                ? verification.result.conditions
                : null,
            evidenceCapture: verification.evidenceCapture ?? null,
            occurredAt: verification.occurredAt,
            labSetupDigest: verification.labSetupDigest,
            scenario:
              labEvent?.type === "lab-provisioned" &&
              labEvent.scenario !== undefined
                ? labEvent.scenario
                : null,
            attempts: verifications.length,
            verifierRuns: verifierRuns.map((event) => ({
              runId: event.runId,
              terminal: event.terminal,
              promptDigest: event.promptDigest,
              occurredAt: event.occurredAt,
            })),
          },
    http,
    refutation,
    labStateDiff,
    observations,
    review: {
      decisions: decisions.map((event) => ({
        decision: event.decision,
        occurredAt: event.occurredAt,
        humanElapsedSeconds: event.humanElapsedSeconds ?? null,
      })),
      scopeAssessments: scopes.map((event) => ({
        assessmentId: event.identity,
        programmeId: event.programmeId,
        status: event.status,
      })),
      decision:
        latestHistoricalDecision === undefined
          ? null
          : {
              decision: latestHistoricalDecision.decision,
              reasonCode: decisionRecord?.reasonCode ?? null,
              duplicate:
                decisionRecord === null
                  ? null
                  : decisionRecord.duplicate.status === "possible-match"
                    ? `${decisionRecord.duplicate.status}:${decisionRecord.duplicate.reference}`
                    : decisionRecord.duplicate.status,
              decidedAt: latestHistoricalDecision.occurredAt,
            },
      duplicate:
        decisionRecord === null
          ? null
          : duplicateView(decisionRecord.duplicate, contentPath),
      humanReproduction:
        reproduction?.type !== "human-reproduction-recorded"
          ? null
          : {
              result: reproduction.result,
              minutes:
                reproduceMinutes?.type === "human-effort-recorded"
                  ? reproduceMinutes.minutes
                  : null,
              recordedAt: reproduction.occurredAt,
            },
      latestReverification:
        reverification?.type !== "verification-finished"
          ? null
          : {
              verificationId: reverification.verificationId,
              findingId: reverification.findingId,
              status: reverification.result.status,
              basis: reverification.basis?.kind ?? null,
              recordedAt: reverification.occurredAt,
            },
      latestDraft:
        draft?.type !== "draft-saved" || draftRecord === null
          ? null
          : {
              digest: draft.revisionDigest,
              revision: draftRecord.revision,
              preparedBy: draftRecord.preparedBy,
              programme: draftRecord.destination,
            },
      labSetup:
        verification === undefined
          ? null
          : {
              digest: verification.labSetupDigest,
              ordinaryActivationDefaults: null,
            },
    },
    privateEvidence: { directory: store.rootDirectory, artifacts },
  });
}
