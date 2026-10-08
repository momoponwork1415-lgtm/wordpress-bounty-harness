import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { persistImmutableFile } from "../../../infrastructure/immutable-file.js";
import { canonicalJson, sha256Digest } from "../acquisition/canonical-json.js";
import {
  normalizedProgrammePolicySchema,
  programmeEligibilityFreshnessPolicySchema,
  programmeEligibilityInspectionRequestSchema,
  programmeEligibilitySnapshotRefSchema,
  programmeEligibilitySnapshotSchema,
  programmeIntelligenceRefreshRequestSchema,
  programmePolicyConflictSignalSchema,
  programmePolicySourceDescriptorSchema,
  programmePolicySourceSnapshotSchema,
  type NormalizedProgrammePolicy,
  type OpenProgrammeIntelligenceOptions,
  type ProgrammeEligibilityInspectionRequest,
  type ProgrammeEligibilityResult,
  type ProgrammeEligibilitySnapshot,
  type ProgrammeEligibilitySnapshotRef,
  type ProgrammeIntelligence,
  type ProgrammeIntelligenceRefreshRequest,
  type ProgrammePolicySourceAdapter,
  type ProgrammePolicySourceSnapshot,
} from "./contracts.js";

interface RetrievedPolicy {
  readonly source: ProgrammePolicySourceSnapshot;
  readonly policy: NormalizedProgrammePolicy;
}

function rawDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function snapshotRef(snapshot: ProgrammeEligibilitySnapshot) {
  const digest = sha256Digest(snapshot);
  return programmeEligibilitySnapshotRefSchema.parse({
    kind: "programme-eligibility-snapshot-ref",
    schemaVersion: 1,
    id: `programme-snapshot:${digest.slice(7, 31)}`,
    digest,
  });
}

class FileProgrammeIntelligence implements ProgrammeIntelligence {
  readonly #storageDirectory: string;
  readonly #sourceAdapters: readonly ProgrammePolicySourceAdapter[];
  readonly #freshnessPolicy: OpenProgrammeIntelligenceOptions["freshnessPolicy"];
  readonly #clock: () => Date;

  constructor(options: OpenProgrammeIntelligenceOptions) {
    this.#storageDirectory = options.storageDirectory;
    this.#sourceAdapters = [...options.sourceAdapters];
    this.#freshnessPolicy = programmeEligibilityFreshnessPolicySchema.parse(
      options.freshnessPolicy,
    );
    this.#clock = options.clock ?? (() => new Date());
  }

  async refresh(
    requestValue: ProgrammeIntelligenceRefreshRequest,
  ): Promise<ProgrammeEligibilityResult> {
    const request =
      programmeIntelligenceRefreshRequestSchema.parse(requestValue);
    const adapters = this.#sourceAdapters
      .filter(
        (adapter) => adapter.programmeIdentity === request.programmeIdentity,
      )
      .sort((left, right) =>
        left.sourceId < right.sourceId
          ? -1
          : left.sourceId > right.sourceId
            ? 1
            : 0,
      );
    if (adapters.length === 0) {
      throw new Error("Programme Intelligence has no required source Adapter");
    }

    const retrievedAt = this.#clock().toISOString();
    const requiredSources = adapters.map((adapter) =>
      programmePolicySourceDescriptorSchema.parse({
        sourceId: adapter.sourceId,
        sourceUrl: adapter.sourceUrl,
        parserVersion: adapter.parserVersion,
      }),
    );
    let sourceContents: readonly {
      readonly adapter: ProgrammePolicySourceAdapter;
      readonly bytes: Uint8Array;
    }[];
    try {
      sourceContents = await Promise.all(
        adapters.map(async (adapter) => ({
          adapter,
          bytes: await adapter.retrieve(),
        })),
      );
    } catch {
      return {
        status: "stale",
        programmeIdentity: request.programmeIdentity,
        reason: "refresh-failed",
        requiredSources,
      };
    }
    const retrieved: RetrievedPolicy[] = [];
    const parseContext = sourceContents.map(({ adapter, bytes }) => ({
      sourceId: adapter.sourceId,
      sourceUrl: adapter.sourceUrl,
      parserVersion: adapter.parserVersion,
      bytes,
    }));
    for (const { adapter, bytes } of sourceContents) {
      const source = programmePolicySourceSnapshotSchema.parse({
        sourceId: adapter.sourceId,
        sourceUrl: adapter.sourceUrl,
        retrievedAt,
        contentDigest: rawDigest(bytes),
        parserVersion: adapter.parserVersion,
      });
      let policy: NormalizedProgrammePolicy;
      try {
        const parsed = await adapter.parse(bytes, parseContext);
        if (programmePolicyConflictSignalSchema.safeParse(parsed).success) {
          return {
            status: "policy-conflict",
            programmeIdentity: request.programmeIdentity,
            sources: sourceContents.map(
              ({ adapter: sourceAdapter, bytes: sourceBytes }) =>
                programmePolicySourceSnapshotSchema.parse({
                  sourceId: sourceAdapter.sourceId,
                  sourceUrl: sourceAdapter.sourceUrl,
                  retrievedAt,
                  contentDigest: rawDigest(sourceBytes),
                  parserVersion: sourceAdapter.parserVersion,
                }),
            ),
          };
        }
        policy = normalizedProgrammePolicySchema.parse(parsed);
      } catch {
        return {
          status: "parse-failed",
          programmeIdentity: request.programmeIdentity,
          source,
        };
      }
      if (policy.programmeIdentity !== request.programmeIdentity) {
        return {
          status: "parse-failed",
          programmeIdentity: request.programmeIdentity,
          source,
        };
      }
      retrieved.push({ source, policy });
    }
    const first = retrieved[0];
    if (first === undefined) {
      throw new Error("Programme Intelligence lost its required source");
    }
    const sources = retrieved.map(({ source }) => source);
    const firstPolicy = canonicalJson(first.policy);
    if (retrieved.some(({ policy }) => canonicalJson(policy) !== firstPolicy)) {
      return {
        status: "policy-conflict",
        programmeIdentity: request.programmeIdentity,
        sources,
      };
    }
    const snapshot = programmeEligibilitySnapshotSchema.parse({
      kind: "programme-eligibility-snapshot",
      schemaVersion: 2,
      programmeIdentity: request.programmeIdentity,
      retrievedAt,
      sources,
      policy: {
        eligibility: first.policy.eligibility,
        programmeOpportunityBand: first.policy.programmeOpportunityBand,
      },
      freshnessPolicy: this.#freshnessPolicy,
    });
    const ref = await this.#persist(snapshot);
    return { status: "current", snapshot, snapshotRef: ref };
  }

  async inspect(
    requestValue: ProgrammeEligibilityInspectionRequest,
  ): Promise<ProgrammeEligibilityResult> {
    const request =
      programmeEligibilityInspectionRequestSchema.parse(requestValue);
    const snapshot = await this.#read(request.snapshotRef);
    const maximumAgeMs =
      request.requiredFor === "target-selection-batch"
        ? snapshot.freshnessPolicy.maximumAgeMs.targetSelectionBatch
        : snapshot.freshnessPolicy.maximumAgeMs.submissionStaging;
    const ageMs = this.#clock().getTime() - Date.parse(snapshot.retrievedAt);
    if (ageMs > maximumAgeMs) {
      return {
        status: "stale",
        programmeIdentity: snapshot.programmeIdentity,
        reason: "snapshot-expired",
        requiredFor: request.requiredFor,
        snapshotRef: request.snapshotRef,
        retrievedAt: snapshot.retrievedAt,
        maximumAgeMs,
        refreshRequired: true,
      };
    }
    return { status: "current", snapshot, snapshotRef: request.snapshotRef };
  }

  async #persist(
    snapshot: ProgrammeEligibilitySnapshot,
  ): Promise<ProgrammeEligibilitySnapshotRef> {
    const ref = snapshotRef(snapshot);
    const bytes = Buffer.from(canonicalJson(snapshot), "utf8");
    const directory = join(this.#storageDirectory, "programme-snapshots");
    const path = join(directory, `${ref.digest.slice(7)}.json`);
    if ((await persistImmutableFile(path, bytes)) === "conflict") {
      throw new Error("Programme Eligibility Snapshot artifact conflict");
    }
    return ref;
  }

  async #read(
    refValue: ProgrammeEligibilitySnapshotRef,
  ): Promise<ProgrammeEligibilitySnapshot> {
    const ref = programmeEligibilitySnapshotRefSchema.parse(refValue);
    const path = join(
      this.#storageDirectory,
      "programme-snapshots",
      `${ref.digest.slice(7)}.json`,
    );
    const bytes = await readFile(path);
    const snapshot = programmeEligibilitySnapshotSchema.parse(
      JSON.parse(bytes.toString("utf8")),
    );
    if (
      sha256Digest(snapshot) !== ref.digest ||
      snapshotRef(snapshot).id !== ref.id
    ) {
      throw new Error("Programme Eligibility Snapshot integrity mismatch");
    }
    return snapshot;
  }
}

export function openProgrammeIntelligence(
  options: OpenProgrammeIntelligenceOptions,
): ProgrammeIntelligence {
  return new FileProgrammeIntelligence(options);
}
