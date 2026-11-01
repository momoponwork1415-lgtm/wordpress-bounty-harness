import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { wordpressCampaignConfigSchema } from "../../src/cli/wordpress.js";
import {
  rebuildWordPressPriorResearch,
  resolveWordPressPriorResearch,
} from "../../src/cli/wordpress-prior-research.js";
import { ProviderAttachmentStore } from "../../src/discovery/index.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger, type LedgerEventInput } from "../../src/ledger/index.js";

const sha = (value: string) => `sha256:${value.repeat(64)}`;
const base = {
  schemaVersion: 1 as const,
  programmeBoundary: { version: "v1", text: "Synthetic" },
  wordpressVersion: "6.8",
  lab: { siteTitle: "Synthetic", initialPosts: [], customerRole: false },
};

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("discovery.priorResearch configuration (ADR 0048)", () => {
  it("defaults to none and accepts same-target only", () => {
    expect(
      wordpressCampaignConfigSchema.parse({
        ...base,
        discovery: { lab: "none" },
      }).discovery.priorResearch,
    ).toBe("none");
    expect(
      wordpressCampaignConfigSchema.parse({
        ...base,
        discovery: { lab: "none", mode: "wide", priorResearch: "same-target" },
      }).discovery.priorResearch,
    ).toBe("same-target");
    expect(
      wordpressCampaignConfigSchema.safeParse({
        ...base,
        discovery: { lab: "none", priorResearch: "all-targets" },
      }).success,
    ).toBe(false);
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wbh-prior-research-"));
  directories.push(root);
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 8,
    maxBytes: 4 * 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: store,
  });
  const attachments = new ProviderAttachmentStore(join(root, "attachments"));
  let sequence = 0;
  const append = async (event: LedgerEventInput) => {
    const result = await ledger.append(event);
    if (result.status !== "appended") throw new Error(result.status);
  };
  const at = () =>
    `2026-10-${String(10 + Math.floor(sequence / 24)).padStart(2, "0")}T${String(sequence++ % 24).padStart(2, "0")}:00:00.000Z`;
  /** One earlier Trial on `version` of `targetId`, with the archive it sealed. */
  const trial = async (options: {
    readonly campaignId: string;
    readonly snapshotDigest: string;
    readonly targetId: string;
    readonly version: string;
    readonly runId: string;
    readonly promptVariant?: string;
    readonly catalog?: boolean;
    readonly archive?: Record<
      string,
      string | { truncated: true } | Buffer
    > | null;
  }) => {
    const slug = options.targetId.replace(/^wporg:/, "");
    const selection = await store.putFiles({
      "target-selection.json": JSON.stringify({
        targetId: options.targetId,
        slug,
        version: options.version,
        score: 4.5,
        selectedAt: "2026-10-08T00:00:00.000Z",
        policy: { id: "synthetic-pin", digest: sha("6") },
        activeInstallations: 5000,
        dependencyVersionPolicy: "pinned-only",
        scoreBreakdown: { installations: 3.7, recency: 0.8, history: 0 },
        observationRef: {
          kind: "wordpress-org-target-observation-ref",
          schemaVersion: 1,
          id: `observation-${slug}`,
          digest: sha("c"),
        },
        programmeRef: {
          kind: "programme-eligibility-snapshot-ref",
          schemaVersion: 1,
          id: "wordfence-policy",
          digest: sha("a"),
        },
      }),
    });
    const common = {
      schemaVersion: 1 as const,
      campaignId: options.campaignId,
      snapshotDigest: options.snapshotDigest,
    };
    await append({
      ...common,
      identity: `${options.runId}-selected`,
      occurredAt: at(),
      type: "target-selected",
      selectionId: `${options.targetId}@${options.version}`,
      artifacts: [{ kind: "target-selection", digest: selection }],
    });
    await append({
      ...common,
      identity: `${options.runId}-started`,
      occurredAt: at(),
      type: "discovery-run-started",
      runId: options.runId,
      trialId: options.runId,
      history: options.catalog
        ? { mode: "catalog", digest: sha("9"), recordIds: [] }
        : { mode: "none" },
      configuration: {
        promptVariant: options.promptVariant ?? "wp2shell-bounty-v20-wide",
      },
    });
    const archive =
      options.archive === null
        ? undefined
        : await attachments.put(
            "research",
            Buffer.from(
              JSON.stringify({
                kind: "research-directory-archive",
                schemaVersion: 1,
                truncated: false,
                collectedBytes: 1,
                entries: [
                  { path: "tools", type: "directory" },
                  ...Object.entries(
                    options.archive ?? { "recon-map.md": "# Map\n" },
                  ).map(([path, content]) =>
                    typeof content === "object" && !Buffer.isBuffer(content)
                      ? {
                          path,
                          type: "file",
                          contentBase64: Buffer.from("cut").toString("base64"),
                          truncated: true,
                        }
                      : {
                          path,
                          type: "file",
                          contentBase64:
                            Buffer.from(content).toString("base64"),
                        },
                  ),
                ],
              }),
            ),
          );
    await append({
      ...common,
      identity: `${options.runId}-finished`,
      occurredAt: at(),
      type: "discovery-run-finished",
      runId: options.runId,
      outcome: "completed",
      costUsd: "unavailable",
      wallTimeMs: 1,
      ...(archive === undefined
        ? {}
        : { researchArtifact: { digest: archive.digest, truncated: false } }),
    });
  };
  return { store, ledger, attachments, trial };
}

const query = {
  targetId: "wporg:synthetic-plugin",
  snapshotDigest: sha("b"),
  currentVersion: "3.4.0",
};

describe("resolveWordPressPriorResearch (ADR 0048)", () => {
  it("passes the latest earlier Trial's whole map and setup record from another Snapshot of the same target", async () => {
    const f = await fixture();
    await f.trial({
      campaignId: "c1",
      snapshotDigest: sha("a"),
      targetId: query.targetId,
      version: "3.3.0",
      runId: "run-old",
      archive: { "recon-map.md": "# Old map\n" },
    });
    await f.trial({
      campaignId: "c2",
      snapshotDigest: sha("c"),
      targetId: query.targetId,
      version: "3.3.1",
      runId: "run-new",
      archive: {
        "recon-map.md": "# New map\n",
        "lab-setup.md": "# Setup\n",
        "sql.md": "routes the section never names",
        "tools/hooks.tsv": "hook\tfile\n",
      },
    });
    // A Trial on this very Snapshot is not an earlier one.
    await f.trial({
      campaignId: "c3",
      snapshotDigest: query.snapshotDigest,
      targetId: query.targetId,
      version: "3.4.0",
      runId: "run-same",
      archive: { "recon-map.md": "# Same snapshot\n" },
    });
    // Another target's notes never cross over.
    await f.trial({
      campaignId: "c4",
      snapshotDigest: sha("d"),
      targetId: "wporg:other-plugin",
      version: "9.9",
      runId: "run-other",
      archive: { "recon-map.md": "# Other\n" },
    });
    const resolved = await resolveWordPressPriorResearch(
      f,
      f.attachments,
      query,
    );
    expect(resolved.status).toBe("passed");
    if (resolved.status !== "passed") return;
    expect(resolved.files).toEqual([
      {
        path: "prior/recon-map.md",
        contentBase64: Buffer.from("# New map\n").toString("base64"),
      },
      {
        path: "prior/lab-setup.md",
        contentBase64: Buffer.from("# Setup\n").toString("base64"),
      },
    ]);
    expect(resolved.section).toContain("version 3.3.1");
    expect(resolved.section).toContain("reads version 3.4.0");
    expect(resolved.section).not.toContain("sql.md");
    expect(resolved.configuration).toEqual({
      sourceRunId: "run-new",
      sourceSnapshotDigest: sha("c"),
      sourceVersion: "3.3.1",
      files: [
        {
          name: "recon-map.md",
          digest: `sha256:${createHash("sha256").update("# New map\n").digest("hex")}`,
          bytes: 10,
        },
        {
          name: "lab-setup.md",
          digest: `sha256:${createHash("sha256").update("# Setup\n").digest("hex")}`,
          bytes: 8,
        },
      ],
      sectionDigest: `sha256:${createHash("sha256").update(resolved.section).digest("hex")}`,
    });
    // A resumed segment rebuilds the same section from the recorded source run.
    expect(
      await rebuildWordPressPriorResearch(
        f,
        f.attachments,
        resolved.configuration,
        "3.4.0",
      ),
    ).toBe(resolved.section);
    expect(
      await rebuildWordPressPriorResearch(
        f,
        f.attachments,
        { ...resolved.configuration, sourceRunId: "run-missing" },
        "3.4.0",
      ),
    ).toBeUndefined();
  });

  it("records why nothing was passed: no earlier Trial, or an archive without the named files", async () => {
    const f = await fixture();
    expect(
      await resolveWordPressPriorResearch(f, f.attachments, query),
    ).toEqual({
      status: "none",
      configuration: { none: "no-earlier-trial" },
    });
    // Trials outside invariant 1 (catalog history, pre-v8 objective) and
    // Trials that sealed no notes are not earlier Trials for this purpose.
    await f.trial({
      campaignId: "c1",
      snapshotDigest: sha("a"),
      targetId: query.targetId,
      version: "3.2.0",
      runId: "run-catalog",
      catalog: true,
    });
    await f.trial({
      campaignId: "c2",
      snapshotDigest: sha("c"),
      targetId: query.targetId,
      version: "3.2.1",
      runId: "run-v7",
      promptVariant: "wp2shell-bounty-v7",
    });
    await f.trial({
      campaignId: "c3",
      snapshotDigest: sha("d"),
      targetId: query.targetId,
      version: "3.2.2",
      runId: "run-no-archive",
      archive: null,
    });
    expect(
      await resolveWordPressPriorResearch(f, f.attachments, query),
    ).toEqual({
      status: "none",
      configuration: { none: "no-earlier-trial" },
    });
    // The latest eligible Trial decides; a cut, oversize, empty or non-UTF-8
    // file is withheld whole, and an archive left with nothing passes nothing.
    await f.trial({
      campaignId: "c4",
      snapshotDigest: sha("e"),
      targetId: query.targetId,
      version: "3.3.0",
      runId: "run-unusable",
      archive: {
        "recon-map.md": { truncated: true },
        "lab-setup.md": Buffer.alloc(65_537, 0x61),
        "notes/recon-map.md": "# nested name does not count\n",
      },
    });
    expect(
      await resolveWordPressPriorResearch(f, f.attachments, query),
    ).toEqual({
      status: "none",
      configuration: { none: "no-files" },
    });
    await f.trial({
      campaignId: "c5",
      snapshotDigest: sha("f"),
      targetId: query.targetId,
      version: "3.3.1",
      runId: "run-binary",
      archive: {
        "recon-map.md": Buffer.from([0xff, 0xfe, 0x00]),
        "lab-setup.md": "# Setup only\n",
      },
    });
    const resolved = await resolveWordPressPriorResearch(
      f,
      f.attachments,
      query,
    );
    expect(resolved.status).toBe("passed");
    if (resolved.status !== "passed") return;
    expect(resolved.files.map(({ path }) => path)).toEqual([
      "prior/lab-setup.md",
    ]);
    expect(resolved.configuration.sourceRunId).toBe("run-binary");
  });
});
