import type {
  CampaignInputV1,
  PlannedDiscoveryRun,
} from "../discovery/index.js";
import { runDiscoveryCampaign } from "../discovery/index.js";
import { canonicalJson } from "../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import type { LabHandle, LabProvisioner } from "../lab/index.js";
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
    readonly plannedRuns: readonly PlannedDiscoveryRun[];
    readonly historyFraction: number;
    readonly executor: DiscoveryOptions["executor"];
    readonly attachments: DiscoveryOptions["attachments"];
    readonly admitFinding: DiscoveryOptions["admitFinding"];
  }>;
  readonly verification: Verification<Finding, Setup, Handle, Reconstruction>;
  readonly reconstructionFor: (snapshot: Snapshot) => Reconstruction;
}

export type CampaignSummary = {
  readonly campaignId: string;
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
  const targets: CampaignSummary["targets"][number][] = [];
  for (const target of await pipeline.select()) {
    const snapshot = await pipeline.freeze(target);
    const base = {
      schemaVersion: 1 as const,
      campaignId,
      snapshotDigest: snapshot.digest,
    };
    await append({
      ...base,
      identity: `target-selected-${campaignId}-${snapshot.digest}`,
      occurredAt: target.selectedAt,
      type: "target-selected",
      selectionId: `${target.targetId}@${target.version}`,
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
    await append({
      ...base,
      identity: `snapshot-frozen-${campaignId}-${snapshot.digest}`,
      occurredAt: at(),
      type: "snapshot-frozen",
      sourceDigest: snapshot.target.sourceDigest,
    });

    const setup = pipeline.setupFor(snapshot);
    const provisioned = await pipeline.lab.provision(snapshot, setup);
    const seeded =
      provisioned.status === "ready"
        ? await pipeline.lab.seedCanaries(provisioned.handle)
        : null;
    const labId =
      provisioned.status === "ready" ? provisioned.handle.id : options.newId();
    const ready = provisioned.status === "ready" && seeded?.status === "seeded";
    await append({
      ...base,
      identity: `lab-provisioned-${labId}`,
      occurredAt: at(),
      type: "lab-provisioned",
      labId,
      status: ready ? "ready" : "failed",
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

    const verifications: {
      findingId: string;
      status: VerificationResultV1["status"];
    }[] = [];
    const findings = ledger
      .read({ campaignId, type: "finding-recorded", limit: 1000 })
      .filter(({ event }) => event.snapshotDigest === snapshot.digest);
    for (const { event } of findings) {
      if (event.type !== "finding-recorded") continue;
      const result = await pipeline.verification.verify({
        campaignId,
        findingId: event.findingId,
        verificationId: options.newId(),
        snapshot,
        setup,
        campaignLabSetupDigest: campaignInput.lab.setupDigest,
        reconstruction: pipeline.reconstructionFor(snapshot),
      });
      verifications.push({ findingId: event.findingId, status: result.status });
    }
    targets.push({
      targetId: target.targetId,
      version: target.version,
      snapshotDigest: snapshot.digest,
      lab: "ready",
      runCount: discovered.runCount,
      stoppedBy: discovered.stoppedBy,
      verifications,
    });
  }
  return { campaignId, targets };
}
