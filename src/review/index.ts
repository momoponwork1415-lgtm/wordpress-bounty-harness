import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { measureCanonicalSourceTree } from "../infrastructure/canonical-source-tree.js";
import {
  canonicalDigest,
  canonicalJson,
} from "../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import type { Ledger, LedgerEventV1 } from "../ledger/index.js";

const id = z.string().min(1).max(128);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const refSchema = z.strictObject({
  campaignId: id,
  findingId: id,
  verificationId: id,
  snapshotDigest: digest,
});
const scopeStatus = z.enum([
  "in-scope",
  "out-of-scope",
  "ambiguous",
  "incomplete",
]);
const scopeResult = z.strictObject({
  programmeId: id,
  status: scopeStatus.exclude(["incomplete"]),
  destination: id,
  reason: z.string().min(1).max(2000),
});
const assessmentSchema = z.strictObject({
  id: digest,
  ref: refSchema,
  policyDigest: digest,
  programmeId: id,
  status: scopeStatus,
  destination: id,
  reason: z.string().min(1).max(2000),
  assessedAt: z.iso.datetime(),
});
const draftSchema = z.strictObject({
  assessmentId: digest,
  candidateId: digest,
  digest,
  revision: z.number().int().positive(),
  destination: id,
  content: z.string().min(1).max(100_000),
  preparedBy: z.enum(["ai", "human"]),
  createdAt: z.iso.datetime(),
});
const authorizationSchema = z.strictObject({
  candidateId: digest,
  draftDigest: digest,
  destination: id,
  authorizedBy: id,
  authorizedAt: z.iso.datetime(),
});

export type ReviewRef = z.infer<typeof refSchema>;
export type ScopeAssessment = z.infer<typeof assessmentSchema>;
export type SubmissionDraftRef = Omit<z.infer<typeof draftSchema>, "content">;
export type ReviewView = {
  readonly verificationStatus:
    "runtime-confirmed" | "contradicted" | "incomplete" | "missing";
  readonly scopeAssessments: readonly ScopeAssessment[];
  readonly drafts: readonly SubmissionDraftRef[];
  readonly privateEvidenceDigests: readonly string[];
};
export type ExternalActionAdmission =
  | { readonly status: "authorized"; readonly authorizationId: string }
  | {
      readonly status: "not-authorized";
      readonly reason:
        | "candidate-or-draft-not-found"
        | "exact-authorization-required"
        | "superseded-draft";
    };
export type DuplicateLookupResult =
  | { readonly status: "unavailable" | "no-match" }
  | { readonly status: "possible-match"; readonly reference: string };

export interface ProgrammeScopeEvaluator<TFacts = unknown> {
  readonly programmeIds: readonly string[];
  readonly policyDigest: string;
  assess(input: {
    readonly ref: ReviewRef;
    readonly facts: TFacts;
  }): Promise<readonly z.infer<typeof scopeResult>[]>;
}

/** Reads the judge-owned verification evidence; discovery claims are never scope facts. */
export interface ScopeFactsProvider<TFacts> {
  load(input: {
    readonly ref: ReviewRef;
    readonly verification: Extract<
      LedgerEventV1,
      { type: "verification-finished" }
    >;
  }): Promise<TFacts>;
}

/** The #12 Wordfence history DB plugs in here; review never imports its storage. */
export interface DuplicateLookup {
  inspect(input: {
    readonly findingId: string;
    readonly candidateId: string;
  }): Promise<DuplicateLookupResult>;
}

export class Review<TFacts = unknown> {
  readonly #ledger: Ledger;
  readonly #store: PrivateArtifactStore;
  readonly #scopeEvaluator: ProgrammeScopeEvaluator<TFacts>;
  readonly #factsProvider: ScopeFactsProvider<TFacts>;
  readonly #duplicateLookup: DuplicateLookup | undefined;
  readonly #clock: () => Date;

  constructor(options: {
    readonly ledger: Ledger;
    readonly artifactStore: PrivateArtifactStore;
    readonly scopeEvaluator: ProgrammeScopeEvaluator<TFacts>;
    readonly factsProvider: ScopeFactsProvider<TFacts>;
    readonly duplicateLookup?: DuplicateLookup;
    readonly clock?: () => Date;
  }) {
    this.#ledger = options.ledger;
    this.#store = options.artifactStore;
    this.#scopeEvaluator = options.scopeEvaluator;
    this.#factsProvider = options.factsProvider;
    this.#duplicateLookup = options.duplicateLookup;
    this.#clock = options.clock ?? (() => new Date());
    const identities = z
      .array(id)
      .min(1)
      .parse([...options.scopeEvaluator.programmeIds]);
    if (new Set(identities).size !== identities.length)
      throw new Error("Programme identities must be unique");
    digest.parse(options.scopeEvaluator.policyDigest);
  }

  async assessScope(input: {
    readonly ref: ReviewRef;
  }): Promise<readonly ScopeAssessment[]> {
    const ref = refSchema.parse(input.ref);
    const verification = this.#requireConfirmed(ref);
    const existing = (await this.#scopeAssessments(ref)).filter(
      (item) => item.policyDigest === this.#scopeEvaluator.policyDigest,
    );
    if (existing.length > 0) {
      const byProgramme = new Map(
        existing.map((item) => [item.programmeId, item]),
      );
      if (byProgramme.size !== existing.length)
        throw new Error("Duplicate programme assessment");
      for (const programmeId of this.#scopeEvaluator.programmeIds) {
        if (!byProgramme.has(programmeId)) {
          byProgramme.set(
            programmeId,
            await this.#persistAssessment(ref, {
              programmeId,
              status: "incomplete",
              destination: programmeId,
              reason: "scope-recording-interrupted",
            }),
          );
        }
      }
      return this.#scopeEvaluator.programmeIds.map((programmeId) =>
        byProgramme.get(programmeId)!,
      );
    }

    let results: readonly z.infer<typeof scopeResult>[];
    let failed = false;
    try {
      const facts = await this.#factsProvider.load({ ref, verification });
      results = z
        .array(scopeResult)
        .parse(await this.#scopeEvaluator.assess({ ref, facts }));
      const expected = new Set(this.#scopeEvaluator.programmeIds);
      const actual = new Set(results.map((item) => item.programmeId));
      if (
        results.length !== expected.size ||
        actual.size !== expected.size ||
        [...expected].some((name) => !actual.has(name))
      ) {
        throw new Error(
          "Every configured programme must be assessed exactly once",
        );
      }
    } catch {
      failed = true;
      results = this.#scopeEvaluator.programmeIds.map((programmeId) => ({
        programmeId,
        status: "ambiguous" as const,
        destination: programmeId,
        reason: "scope-evaluation-failed",
      }));
    }
    const assessments: ScopeAssessment[] = [];
    for (const item of results) {
      assessments.push(
        await this.#persistAssessment(ref, {
          programmeId: item.programmeId,
          status: failed ? "incomplete" : item.status,
          destination: item.destination,
          reason: item.reason,
        }),
      );
    }
    return assessments;
  }

  async #persistAssessment(
    ref: ReviewRef,
    item: {
      readonly programmeId: string;
      readonly status: ScopeAssessment["status"];
      readonly destination: string;
      readonly reason: string;
    },
  ): Promise<ScopeAssessment> {
    const record = assessmentSchema.parse({
      id: canonicalDigest({
        ref,
        policyDigest: this.#scopeEvaluator.policyDigest,
        ...item,
      }),
      ref,
      policyDigest: this.#scopeEvaluator.policyDigest,
      ...item,
      assessedAt: this.#clock().toISOString(),
    });
    const artifactDigest = await this.#storeRecord(record);
    const appended = await this.#ledger.append({
      schemaVersion: 1,
      identity: `scope:${record.id}`,
      campaignId: ref.campaignId,
      snapshotDigest: ref.snapshotDigest,
      occurredAt: record.assessedAt,
      type: "scope-assessed",
      findingId: ref.findingId,
      programmeId: record.programmeId,
      status: record.status,
      artifacts: [{ kind: "review-scope", digest: artifactDigest }],
    });
    if (appended.status === "conflict")
      throw new Error("Scope assessment ledger conflict");
    return record;
  }

  async saveDraft(input: {
    readonly assessmentId: string;
    readonly content: string;
    readonly preparedBy: "ai" | "human";
  }): Promise<SubmissionDraftRef> {
    const assessmentId = digest.parse(input.assessmentId);
    const assessment = (await this.#allAssessments()).find(
      (item) => item.id === assessmentId,
    );
    if (
      assessment?.status !== "in-scope" ||
      assessment.policyDigest !== this.#scopeEvaluator.policyDigest
    )
      throw new Error("An in-scope assessment is required");
    const prior = (await this.#allDrafts()).filter(
      (item) => item.assessmentId === assessmentId,
    );
    const revision = Math.max(0, ...prior.map((item) => item.revision)) + 1;
    const content = z.string().min(1).max(100_000).parse(input.content);
    const preparedBy = z.enum(["ai", "human"]).parse(input.preparedBy);
    const draftDigest = canonicalDigest({
      assessmentId,
      revision,
      content,
      preparedBy,
    });
    const candidateId = canonicalDigest({
      assessmentId,
      draftDigest,
      destination: assessment.destination,
    });
    const record = draftSchema.parse({
      assessmentId,
      candidateId,
      digest: draftDigest,
      revision,
      destination: assessment.destination,
      content,
      preparedBy,
      createdAt: this.#clock().toISOString(),
    });
    const artifactDigest = await this.#storeRecord(record);
    const appended = await this.#ledger.append({
      schemaVersion: 1,
      identity: `draft:${draftDigest}`,
      campaignId: assessment.ref.campaignId,
      snapshotDigest: assessment.ref.snapshotDigest,
      occurredAt: record.createdAt,
      type: "draft-saved",
      findingId: assessment.ref.findingId,
      candidateId,
      revisionDigest: draftDigest,
      artifacts: [{ kind: "review-draft", digest: artifactDigest }],
    });
    if (appended.status === "conflict")
      throw new Error("Submission Draft ledger conflict");
    const { content: _content, ...publicRef } = record;
    return publicRef;
  }

  async authorizeExternalAction(input: {
    readonly candidateId: string;
    readonly draftDigest: string;
    readonly destination: string;
    readonly authorizedBy: string;
  }): Promise<void> {
    const candidateId = digest.parse(input.candidateId);
    const draftDigest = digest.parse(input.draftDigest);
    const destination = id.parse(input.destination);
    const authorizedBy = id.parse(input.authorizedBy);
    const draft = (await this.#allDrafts()).find(
      (item) =>
        item.candidateId === candidateId &&
        item.digest === draftDigest &&
        item.destination === destination,
    );
    if (draft === undefined)
      throw new Error("An exact Submission Candidate and Draft are required");
    const assessment = (await this.#allAssessments()).find(
      (item) =>
        item.id === draft.assessmentId &&
        item.status === "in-scope" &&
        item.policyDigest === this.#scopeEvaluator.policyDigest,
    );
    if (assessment === undefined)
      throw new Error("An in-scope assessment is required");
    const record = authorizationSchema.parse({
      candidateId,
      draftDigest,
      destination,
      authorizedBy,
      authorizedAt: this.#clock().toISOString(),
    });
    const artifactDigest = await this.#storeRecord(record);
    const appended = await this.#ledger.append({
      schemaVersion: 1,
      identity: `authorization:${canonicalDigest(record)}`,
      campaignId: assessment.ref.campaignId,
      snapshotDigest: assessment.ref.snapshotDigest,
      occurredAt: record.authorizedAt,
      type: "external-action-authorized",
      candidateId,
      revisionDigest: draftDigest,
      destination,
      artifacts: [{ kind: "review-authorization", digest: artifactDigest }],
    });
    if (appended.status === "conflict")
      throw new Error("Authorization ledger conflict");
  }

  async admitExternalAction(input: {
    readonly candidateId: string;
    readonly draftDigest: string;
    readonly destination: string;
  }): Promise<ExternalActionAdmission> {
    const candidateId = digest.parse(input.candidateId);
    const draftDigest = digest.parse(input.draftDigest);
    const destination = id.parse(input.destination);
    const draft = (await this.#allDrafts()).find(
      (item) =>
        item.candidateId === candidateId &&
        item.digest === draftDigest &&
        item.destination === destination,
    );
    if (draft === undefined)
      return {
        status: "not-authorized",
        reason: "candidate-or-draft-not-found",
      };
    const assessment = (await this.#allAssessments()).find(
      (item) =>
        item.id === draft.assessmentId &&
        item.status === "in-scope" &&
        item.policyDigest === this.#scopeEvaluator.policyDigest,
    );
    if (assessment === undefined)
      return {
        status: "not-authorized",
        reason: "exact-authorization-required",
      };
    const latest = Math.max(
      ...(await this.#allDrafts())
        .filter((item) => item.assessmentId === draft.assessmentId)
        .map((item) => item.revision),
    );
    if (draft.revision !== latest)
      return { status: "not-authorized", reason: "superseded-draft" };
    const authorization = this.#readAll("external-action-authorized").find(
      ({ event }) =>
        event.type === "external-action-authorized" &&
        event.candidateId === candidateId &&
        event.revisionDigest === draftDigest &&
        event.destination === destination,
    );
    return authorization === undefined
      ? { status: "not-authorized", reason: "exact-authorization-required" }
      : { status: "authorized", authorizationId: authorization.event.identity };
  }

  async inspectDuplicate(input: {
    readonly findingId: string;
    readonly candidateId: string;
  }): Promise<DuplicateLookupResult> {
    const request = z
      .strictObject({ findingId: id, candidateId: id })
      .parse(input);
    return this.#duplicateLookup?.inspect(request) ?? { status: "unavailable" };
  }

  async inspect(input: {
    readonly campaignId: string;
    readonly findingId: string;
  }): Promise<ReviewView> {
    const query = z
      .strictObject({ campaignId: id, findingId: id })
      .parse(input);
    const verification = this.#readAll("verification-finished").find(
      ({ event }) =>
        event.type === "verification-finished" &&
        event.campaignId === query.campaignId &&
        event.findingId === query.findingId,
    );
    const assessments = (await this.#allAssessments()).filter(
      (item) =>
        item.ref.campaignId === query.campaignId &&
        item.ref.findingId === query.findingId,
    );
    const assessmentIds = new Set(assessments.map((item) => item.id));
    const drafts = (await this.#allDrafts())
      .filter((item) => assessmentIds.has(item.assessmentId))
      .map(({ content: _content, ...reference }) => reference);
    const candidateIds = new Set(drafts.map((draft) => draft.candidateId));
    const privateEvidenceDigests = [
      ...this.#readAll("verification-finished").filter(
        ({ event }) =>
          event.type === "verification-finished" &&
          event.campaignId === query.campaignId &&
          event.findingId === query.findingId,
      ),
      ...this.#readAll("scope-assessed").filter(
        ({ event }) =>
          event.type === "scope-assessed" &&
          event.campaignId === query.campaignId &&
          event.findingId === query.findingId,
      ),
      ...this.#readAll("draft-saved").filter(
        ({ event }) =>
          event.type === "draft-saved" &&
          event.campaignId === query.campaignId &&
          event.findingId === query.findingId,
      ),
      ...this.#readAll("external-action-authorized").filter(
        ({ event }) =>
          event.type === "external-action-authorized" &&
          event.campaignId === query.campaignId &&
          candidateIds.has(event.candidateId),
      ),
    ].flatMap(({ event }) =>
      event.artifacts.map((artifact) => artifact.digest),
    );
    return {
      verificationStatus:
        verification?.event.type === "verification-finished"
          ? verification.event.result.status
          : "missing",
      scopeAssessments: assessments,
      drafts,
      privateEvidenceDigests,
    };
  }

  #requireConfirmed(
    ref: ReviewRef,
  ): Extract<LedgerEventV1, { type: "verification-finished" }> {
    const verification = this.#readAll("verification-finished").find(
      ({ event }) =>
        event.type === "verification-finished" &&
        event.campaignId === ref.campaignId &&
        event.findingId === ref.findingId &&
        event.verificationId === ref.verificationId,
    );
    if (
      verification?.event.type !== "verification-finished" ||
      verification.event.snapshotDigest !== ref.snapshotDigest ||
      verification.event.result.status !== "runtime-confirmed"
    ) {
      throw new Error("A matching runtime-confirmed verification is required");
    }
    return verification.event;
  }

  #readAll(type: LedgerEventV1["type"]) {
    const records: ReturnType<Ledger["read"]>[number][] = [];
    let afterSequence = 0;
    for (;;) {
      const page = this.#ledger.read({ type, afterSequence, limit: 1000 });
      records.push(...page);
      if (page.length < 1000) return records;
      afterSequence = page[page.length - 1]!.sequence;
    }
  }

  async #storeRecord(record: object): Promise<string> {
    const staging = await this.#store.stage();
    const content = canonicalJson(record);
    await writeFile(join(staging.contentDirectory, "record.json"), content, {
      mode: 0o600,
    });
    const measured = await measureCanonicalSourceTree(
      staging.contentDirectory,
      { maxEntries: 1, maxBytes: 100_000 },
    );
    const committed = await this.#store.commit(measured.digest, staging);
    if (committed.status === "conflict")
      throw new Error("Private Evidence conflict");
    return committed.artifact.digest;
  }

  async #readRecord<T>(
    event: LedgerEventV1,
    kind: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const evidence = event.artifacts.find((item) => item.kind === kind);
    if (evidence === undefined)
      throw new Error("Private Evidence reference is missing");
    const resolved = await this.#store.readFile(
      evidence.digest,
      "record.json",
      100_000,
    );
    if (resolved.status !== "resolved")
      throw new Error("Private Evidence is unavailable");
    return schema.parse(JSON.parse(resolved.bytes.toString("utf8")) as unknown);
  }

  async #allAssessments(): Promise<ScopeAssessment[]> {
    return Promise.all(
      this.#readAll("scope-assessed").map(({ event }) =>
        this.#readRecord(event, "review-scope", assessmentSchema),
      ),
    );
  }

  async #scopeAssessments(ref: ReviewRef): Promise<ScopeAssessment[]> {
    return (await this.#allAssessments()).filter(
      (item) =>
        item.ref.findingId === ref.findingId &&
        item.ref.campaignId === ref.campaignId &&
        item.ref.snapshotDigest === ref.snapshotDigest &&
        item.ref.verificationId === ref.verificationId,
    );
  }

  async #allDrafts(): Promise<z.infer<typeof draftSchema>[]> {
    return Promise.all(
      this.#readAll("draft-saved").map(({ event }) =>
        this.#readRecord(event, "review-draft", draftSchema),
      ),
    );
  }
}
