import type { CampaignInputV1, PlannedTrial } from "../discovery/index.js";
import { runDiscoveryCampaign } from "../discovery/index.js";
import {
  canonicalDigest,
  canonicalJson,
} from "../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import type {
  LabHandle,
  LabProvisioner,
  LabReachability,
} from "../lab/index.js";
import type { Ledger } from "../ledger/index.js";
import type { TargetSelection } from "../selection/index.js";
import type { Snapshot } from "../snapshot/index.js";
import type {
  VerifiableFinding,
  Verification,
  VerificationResultV1,
} from "../verification/index.js";

type DiscoveryOptions = Parameters<typeof runDiscoveryCampaign>[0];

/** Everything a campaign needs, built by a profile composition from public interfaces. */
export interface CampaignPipeline<
  Target extends TargetSelection,
  Setup,
  Handle extends LabHandle,
  Finding extends VerifiableFinding,
  Reconstruction,
> {
  readonly select: () => Promise<readonly Target[]>;
  readonly freeze: (target: Target) => Promise<Snapshot>;
  readonly lab: LabProvisioner<Setup, Handle>;
  readonly setupFor: (snapshot: Snapshot) => Setup;
  readonly discovery: (input: {
    readonly target: Target;
    readonly snapshot: Snapshot;
    readonly lab: Handle;
  }) => Promise<{
    readonly input: CampaignInputV1;
    readonly plannedTrials: readonly PlannedTrial[];
    readonly historyFraction: number;
    readonly ablation?: NonNullable<DiscoveryOptions["ablation"]>;
    readonly concurrency?: number;
    readonly runWallTimeMs?: number;
    readonly executor: DiscoveryOptions["executor"];
    readonly attachments: DiscoveryOptions["attachments"];
    readonly admitFinding: DiscoveryOptions["admitFinding"];
    readonly admitLead?: NonNullable<DiscoveryOptions["admitLead"]>;
    readonly leadSignature?: NonNullable<DiscoveryOptions["leadSignature"]>;
  }>;
  readonly verification: Verification<Finding, Setup, Handle, Reconstruction>;
  readonly reconstructionFor: (snapshot: Snapshot) => Reconstruction;
}

type SkipStage = "freeze" | "discovery" | "verification";

export type CampaignSummary = {
  readonly campaignId: string;
  /** Targets left behind by an error; the next target still runs. */
  readonly skipped: readonly {
    readonly targetId: string;
    readonly version: string;
    readonly stage: SkipStage;
    readonly message: string;
  }[];
  /** Set when the campaign stopped early and can be resumed with the same id. */
  readonly stopped?: "provider-limit";
  readonly targets: readonly {
    readonly targetId: string;
    readonly version: string;
    readonly snapshotDigest: string;
    readonly lab: "ready" | "failed";
    readonly runCount: number;
    readonly stoppedBy: string;
    readonly verifications: readonly {
      readonly findingId: string;
      readonly status: VerificationResultV1["status"];
    }[];
  }[];
};

/** Wiring only: each step is a module's public interface; rules stay in the modules. */
export async function runCampaignPipeline<
  Target extends TargetSelection,
  Setup,
  Handle extends LabHandle,
  Finding extends VerifiableFinding,
  Reconstruction,
>(options: {
  readonly campaignId: string;
  readonly ledger: Ledger;
  readonly store: PrivateArtifactStore;
  readonly pipeline: CampaignPipeline<
    Target,
    Setup,
    Handle,
    Finding,
    Reconstruction
  >;
  readonly clock: () => Date;
  readonly newId: () => string;
}): Promise<CampaignSummary> {
  const { campaignId, ledger, pipeline, clock } = options;
  const at = () => clock().toISOString();
  const append = async (event: Parameters<Ledger["append"]>[0]) => {
    if ((await ledger.append(event)).status === "conflict")
      throw new Error(`Ledger conflict: ${event.identity}`);
  };
  // Selection and freeze records are keyed by campaign and snapshot; a resumed run keeps the first.
  const appendOnce = async (event: Parameters<Ledger["append"]>[0]) => {
    await ledger.append(event);
  };
  const targets: CampaignSummary["targets"][number][] = [];
  const skipped: CampaignSummary["skipped"][number][] = [];
  let stopped: CampaignSummary["stopped"];
  for (const target of await pipeline.select()) {
    const selectionId = `${target.targetId}@${target.version}`;
    let stage: SkipStage = "freeze";
    // Before a snapshot exists, the selection record stands in for its digest.
    let snapshotDigest = canonicalDigest(target);
    try {
      const snapshot = await pipeline.freeze(target);
      snapshotDigest = snapshot.digest;
      const base = {
        schemaVersion: 1 as const,
        campaignId,
        snapshotDigest: snapshot.digest,
      };
      await appendOnce({
        ...base,
        identity: `target-selected-${campaignId}-${snapshot.digest}`,
        occurredAt: target.selectedAt,
        type: "target-selected",
        selectionId,
        // The full selection record (install counts, score) stays in Private Evidence.
        artifacts: [
          {
            kind: "target-selection",
            digest: await options.store.putFiles({
              "target-selection.json": canonicalJson(target),
            }),
          },
        ],
      });
      await appendOnce({
        ...base,
        identity: `snapshot-frozen-${campaignId}-${snapshot.digest}`,
        occurredAt: at(),
        type: "snapshot-frozen",
        sourceDigest: snapshot.target.sourceDigest,
        dependencyDigests: snapshot.dependencies.map(
          (dependency) => dependency.sourceDigest,
        ),
      });

      stage = "discovery";
      const setup = pipeline.setupFor(snapshot);
      const provisioned = await pipeline.lab.provision(snapshot, setup);
      const seeded =
        provisioned.status === "ready"
          ? await pipeline.lab.seedCanaries(provisioned.handle)
          : null;
      const labId =
        provisioned.status === "ready"
          ? provisioned.handle.id
          : options.newId();
      const reachability =
        provisioned.status === "ready" &&
        seeded?.status === "seeded" &&
        pipeline.lab.probe !== undefined
          ? await pipeline.lab
              .probe(provisioned.handle)
              .catch((): LabReachability => ({
                http: "failed",
                database: "failed",
              }))
          : undefined;
      const ready =
        provisioned.status === "ready" &&
        seeded?.status === "seeded" &&
        reachability?.http !== "failed";
      const failure =
        provisioned.status === "incomplete"
          ? { failureStage: "provision" as const, reason: provisioned.reason }
          : seeded?.status === "incomplete"
            ? { failureStage: "seed" as const, reason: seeded.reason }
            : reachability?.http === "failed"
              ? {
                  failureStage: "probe" as const,
                  reason: "reachability" as const,
                }
              : undefined;
      const diagnostic =
        provisioned.status === "incomplete"
          ? provisioned.diagnostic
          : seeded?.status === "incomplete"
            ? seeded.diagnostic
            : undefined;
      await append({
        ...base,
        identity: `lab-provisioned-${labId}`,
        occurredAt: at(),
        type: "lab-provisioned",
        labId,
        status: ready ? "ready" : "failed",
        ...(reachability === undefined ? {} : { reachability }),
        ...(failure === undefined ? {} : failure),
        ...(diagnostic === undefined
          ? {}
          : {
              artifacts: [
                {
                  kind: "lab-diagnostic",
                  digest: await options.store.putFiles({
                    "stderr.txt": diagnostic,
                  }),
                },
              ],
            }),
      });
      if (!ready || provisioned.status !== "ready") {
        if (provisioned.status === "ready")
          await pipeline.lab.teardown(provisioned.handle);
        targets.push({
          targetId: target.targetId,
          version: target.version,
          snapshotDigest: snapshot.digest,
          lab: "failed",
          runCount: 0,
          stoppedBy: "setup-failed",
          verifications: [],
        });
        continue;
      }

      let discovered: Awaited<ReturnType<typeof runDiscoveryCampaign>>;
      let campaignInput: CampaignInputV1;
      try {
        const prepared = await pipeline.discovery({
          target,
          snapshot,
          lab: provisioned.handle,
        });
        campaignInput = prepared.input;
        discovered = await runDiscoveryCampaign({
          campaignId,
          labId,
          ledger,
          evidence: options.store,
          clock,
          ...prepared,
        });
      } finally {
        await pipeline.lab.teardown(provisioned.handle);
      }
      const summary = {
        targetId: target.targetId,
        version: target.version,
        snapshotDigest: snapshot.digest,
        lab: "ready" as const,
        runCount: discovered.runCount,
        stoppedBy: discovered.stoppedBy,
      };
      // The Verifier draws on the same subscription, so nothing else runs after a stop.
      if (discovered.stoppedBy === "provider-limit") {
        stopped = discovered.stoppedBy;
        await append({
          ...base,
          identity: `campaign-stopped-${options.newId()}`,
          occurredAt: at(),
          type: "campaign-stopped",
          reason: discovered.stoppedBy,
        });
        targets.push({ ...summary, verifications: [] });
        break;
      }

      stage = "verification";
      const verified = new Set(
        ledger
          .read({ campaignId, type: "verification-finished", limit: 1000 })
          .map(({ event }) =>
            event.type === "verification-finished" ? event.findingId : "",
          ),
      );
      const verifications: {
        findingId: string;
        status: VerificationResultV1["status"];
      }[] = [];
      const findings = ledger
        .read({ campaignId, type: "finding-recorded", limit: 1000 })
        .filter(({ event }) => event.snapshotDigest === snapshot.digest);
      for (const { event } of findings) {
        // A resumed campaign verifies only what an earlier pass left unverified.
        if (event.type !== "finding-recorded" || verified.has(event.findingId))
          continue;
        const result = await pipeline.verification.verify({
          campaignId,
          findingId: event.findingId,
          verificationId: options.newId(),
          snapshot,
          setup,
          campaignLabSetupDigest: campaignInput.lab.setupDigest,
          reconstruction: pipeline.reconstructionFor(snapshot),
        });
        verifications.push({
          findingId: event.findingId,
          status: result.status,
        });
      }
      targets.push({ ...summary, verifications });
    } catch (error: unknown) {
      // The failure text may hold paths; it goes to the operator, not the ledger.
      await append({
        schemaVersion: 1,
        campaignId,
        snapshotDigest,
        identity: `target-skipped-${options.newId()}`,
        occurredAt: at(),
        type: "target-skipped",
        selectionId,
        stage,
      });
      skipped.push({
        targetId: target.targetId,
        version: target.version,
        stage,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    campaignId,
    targets,
    skipped,
    ...(stopped === undefined ? {} : { stopped }),
  };
}

export type ReverificationSummary = {
  readonly targetId: string;
  readonly version: string;
  readonly snapshotDigest: string;
  readonly verificationId: string;
  readonly status: VerificationResultV1["status"];
};

/**
 * Freezes the target's latest version and verifies the same Finding against it
 * in a fresh Lab. Nothing from the earlier snapshot's verification is reused.
 */
export async function reverifyOnLatestVersion<
  Target extends TargetSelection,
  Setup,
  Handle extends LabHandle,
  Finding extends VerifiableFinding,
  Reconstruction,
>(options: {
  readonly campaignId: string;
  readonly findingId: string;
  readonly ledger: Ledger;
  readonly store: PrivateArtifactStore;
  readonly pipeline: Pick<
    CampaignPipeline<Target, Setup, Handle, Finding, Reconstruction>,
    "freeze" | "setupFor" | "verification" | "reconstructionFor"
  > & {
    /** The latest version of the target the Finding's snapshot was selected from. */
    readonly selectLatest: (input: {
      readonly selectionId: string;
    }) => Promise<Target | null>;
  };
  readonly clock: () => Date;
  readonly newId: () => string;
}): Promise<ReverificationSummary> {
  const { campaignId, findingId, ledger, pipeline } = options;
  const finding = ledger
    .read({ campaignId, findingId, type: "finding-recorded", limit: 1 })
    .at(0)?.event;
  if (finding?.type !== "finding-recorded")
    throw new Error("The finding is not recorded in this campaign");
  const selected = ledger
    .read({ campaignId, type: "target-selected", limit: 1000 })
    .map(({ event }) => event)
    .find(
      (event) =>
        event.type === "target-selected" &&
        event.snapshotDigest === finding.snapshotDigest,
    );
  if (selected?.type !== "target-selected")
    throw new Error("The finding's target selection is not recorded");
  const target = await pipeline.selectLatest({
    selectionId: selected.selectionId,
  });
  if (target === null)
    throw new Error("The target's latest version is not selectable now");
  const snapshot = await pipeline.freeze(target);
  const verificationId = options.newId();
  const base = {
    schemaVersion: 1 as const,
    campaignId,
    snapshotDigest: snapshot.digest,
  };
  for (const event of [
    {
      ...base,
      identity: `target-selected-${verificationId}`,
      occurredAt: target.selectedAt,
      type: "target-selected" as const,
      selectionId: `${target.targetId}@${target.version}`,
      artifacts: [
        {
          kind: "target-selection",
          digest: await options.store.putFiles({
            "target-selection.json": canonicalJson(target),
          }),
        },
      ],
    },
    {
      ...base,
      identity: `snapshot-frozen-${verificationId}`,
      occurredAt: options.clock().toISOString(),
      type: "snapshot-frozen" as const,
      sourceDigest: snapshot.target.sourceDigest,
      dependencyDigests: snapshot.dependencies.map(
        (dependency) => dependency.sourceDigest,
      ),
    },
  ])
    if ((await ledger.append(event)).status === "conflict")
      throw new Error(`Ledger conflict: ${event.identity}`);
  const setup = pipeline.setupFor(snapshot);
  const result = await pipeline.verification.verify({
    campaignId,
    findingId,
    verificationId,
    snapshot,
    basis: {
      kind: "latest-version",
      findingSnapshotDigest: finding.snapshotDigest,
    },
    setup,
    campaignLabSetupDigest: canonicalDigest(setup),
    reconstruction: pipeline.reconstructionFor(snapshot),
  });
  return {
    targetId: target.targetId,
    version: target.version,
    snapshotDigest: snapshot.digest,
    verificationId,
    status: result.status,
  };
}
