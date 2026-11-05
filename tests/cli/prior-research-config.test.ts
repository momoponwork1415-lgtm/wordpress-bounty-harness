import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { wordpressCampaignConfigSchema } from "../../src/cli/wordpress.js";
import {
  priorTrialInsideInvariantOne,
  rebuildWordPressPriorResearch,
  resolveWordPressPriorResearch,
} from "../../src/cli/wordpress-prior-research.js";
import {
  importWordPressResearch,
  researchImportIdentity,
} from "../../src/cli/wordpress-research-import.js";
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
        discovery: { lab: "attached" },
      }).discovery.priorResearch,
    ).toBe("none");
    expect(
      wordpressCampaignConfigSchema.parse({
        ...base,
        discovery: {
          lab: "attached",
          mode: "wide",
          priorResearch: "same-target",
        },
      }).discovery.priorResearch,
    ).toBe("same-target");
    expect(
      wordpressCampaignConfigSchema.safeParse({
        ...base,
        discovery: { lab: "attached", priorResearch: "all-targets" },
      }).success,
    ).toBe(false);
  });
});

async function fixture(
  options: { readonly attachmentsDirectory?: string } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "wbh-prior-research-"));
  directories.push(root);
  // The layout `openState` expects: the ledger beside `private-evidence/`.
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "private-evidence"),
    maxEntries: 8,
    maxBytes: 4 * 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: store,
  });
  const attachments = new ProviderAttachmentStore(
    options.attachmentsDirectory ?? join(root, "attachments"),
  );
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
    /** A sealed exploration Lab record with this `lookupLog` (ADR 0049). */
    readonly lookupLog?: readonly unknown[];
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
    const explorationLab =
      options.lookupLog === undefined
        ? undefined
        : await store.putFiles({
            "exploration-lab.json": JSON.stringify({
              schemaVersion: 1,
              labId: `lab-${options.runId}`,
              lookupLog: options.lookupLog,
            }),
          });
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
      artifacts:
        explorationLab === undefined
          ? []
          : [{ kind: "exploration-lab", digest: explorationLab }],
    });
    return {
      researchDigest: archive?.digest,
      explorationLabDigest: explorationLab,
    };
  };
  return {
    root,
    stateDirectory: root,
    store,
    ledger,
    attachments,
    trial,
    clock: () => new Date("2026-11-02T12:00:00.000Z"),
  };
}

const query = {
  targetId: "wporg:synthetic-plugin",
  snapshotDigest: sha("b"),
  currentVersion: "3.4.0",
};

describe("priorTrialInsideInvariantOne (ADR 0048)", () => {
  it("passes only v8-or-later wp2shell-bounty Trials without the ADR 0012 catalog", () => {
    const started = (promptVariant: string, catalog = false) => ({
      history: catalog
        ? {
            mode: "catalog" as const,
            digest: `sha256:${"c".repeat(64)}`,
            recordIds: [],
          }
        : { mode: "none" as const },
      configuration: { promptVariant },
    });
    expect(priorTrialInsideInvariantOne(started("wp2shell-bounty-v8"))).toBe(
      true,
    );
    expect(
      priorTrialInsideInvariantOne(started("wp2shell-bounty-v26-wide")),
    ).toBe(true);
    expect(priorTrialInsideInvariantOne(started("wp2shell-bounty-v7"))).toBe(
      false,
    );
    expect(
      priorTrialInsideInvariantOne(started("wp2shell-whitebox-v1.7")),
    ).toBe(false);
    expect(
      priorTrialInsideInvariantOne(started("wp2shell-bounty-v14-wide", true)),
    ).toBe(false);
  });
});

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

/** A `lookupLog` with one answered find, one answered trace and one refused find. */
const lookupLog = [
  {
    requestedAt: "2026-11-02T00:00:00.000Z",
    answeredAt: "2026-11-02T00:00:01.000Z",
    command: "find",
    status: "answered",
    request: "7391820465123",
    answer: {
      status: "answered",
      marker: "7391820465123",
      database: [
        { table: "wp_options", column: "option_value", keys: ["x_settings"] },
      ],
      files: [],
      truncated: false,
      lookupsUsed: 1,
      maxLookups: 60,
    },
  },
  {
    requestedAt: "2026-11-02T00:00:02.000Z",
    answeredAt: "2026-11-02T00:00:03.000Z",
    command: "trace",
    status: "answered",
    request: {
      method: "GET",
      path: "/?x=1",
      bodyLength: 0,
      cookieLength: 12,
    },
    answer: {
      status: "answered",
      httpStatus: 200,
      entries: [
        {
          depth: 2,
          function: "x_render",
          file: "wp-content/plugins/x/render.php",
          line: 5,
        },
      ],
      entryCount: 1,
      truncated: false,
      lookupsUsed: 2,
      maxLookups: 60,
    },
  },
  {
    requestedAt: "2026-11-02T00:00:04.000Z",
    answeredAt: "2026-11-02T00:00:04.000Z",
    command: "find",
    status: "refused",
    reason: "budget",
    request: "8391820465123",
    answer: {
      status: "refused",
      reason: "budget",
      lookupsUsed: 2,
      maxLookups: 60,
    },
  },
];

describe("resolveWordPressPriorResearch, wider hand-over (ADR 0049 D)", () => {
  it("passes assumptions, walks, REGISTRY.md and the store table beside the map, in the fixed order, and leaves the rest", async () => {
    const f = await fixture();
    await f.trial({
      campaignId: "c1",
      snapshotDigest: sha("c"),
      targetId: query.targetId,
      version: "3.3.1",
      runId: "run-wide",
      archive: {
        "recon-map.md": "# Map\n",
        "REGISTRY.md": "# Registry\n",
        "MERGED.md": "merged routes stay",
        "sql.md": "route file stays",
        "assumptions/rest.md": "| store | ... |\n",
        "assumptions/ajax.md": "| hook | ... |\n",
        "assumptions/nested/deep.md": "one level only",
        "walks/rest.md": "walk\n",
        "walks/cut.md": { truncated: true },
        "traces/rest-x.md": "traces stay",
        "tools/hooks.tsv": "hook\tfile\n",
      },
      lookupLog,
    });
    const resolved = await resolveWordPressPriorResearch(
      f,
      f.attachments,
      query,
    );
    expect(resolved.status).toBe("passed");
    if (resolved.status !== "passed") return;
    expect(resolved.files.map(({ path }) => path)).toEqual([
      "prior/recon-map.md",
      "prior/REGISTRY.md",
      "prior/stores.json",
      "prior/assumptions/ajax.md",
      "prior/assumptions/rest.md",
      "prior/walks/rest.md",
    ]);
    const stores = JSON.parse(
      Buffer.from(
        resolved.files.find(({ path }) => path === "prior/stores.json")!
          .contentBase64,
        "base64",
      ).toString("utf8"),
    ) as { finds: unknown[]; traces: unknown[] };
    expect(stores.finds).toEqual([
      {
        marker: "7391820465123",
        database: [{ table: "wp_options", column: "option_value" }],
        files: [],
      },
    ]);
    expect(stores.traces).toEqual([
      {
        method: "GET",
        path: "/?x=1",
        httpStatus: 200,
        entryCount: 1,
        files: ["wp-content/plugins/x/render.php"],
      },
    ]);
    expect(JSON.stringify(stores)).not.toContain("x_settings");
    expect(JSON.stringify(stores)).not.toContain("ookie");
    for (const absent of [
      "MERGED",
      "sql.md",
      "traces/",
      "tools/",
      "nested",
      "cut.md",
    ])
      expect(resolved.section).not.toContain(absent);
    expect(resolved.section).toContain(
      "- /workspace/research/prior/stores.json (",
    );
    expect(resolved.configuration.files.map(({ name }) => name)).toEqual([
      "recon-map.md",
      "REGISTRY.md",
      "stores.json",
      "assumptions/ajax.md",
      "assumptions/rest.md",
      "walks/rest.md",
    ]);
    expect(resolved.configuration.withheld).toBeUndefined();
    expect(resolved.configuration.sourceState).toBeUndefined();
    // The resumed segment rebuilds the same section, store table included.
    expect(
      await rebuildWordPressPriorResearch(
        f,
        f.attachments,
        resolved.configuration,
        "3.4.0",
      ),
    ).toBe(resolved.section);
  });

  it("withholds the largest files past 2 MiB, names them in the section and the record, and still passes the rest", async () => {
    const f = await fixture();
    const walks = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `walks/w${String(index).padStart(2, "0")}.md`,
        "w".repeat(60_000 - index),
      ]),
    );
    await f.trial({
      campaignId: "c1",
      snapshotDigest: sha("c"),
      targetId: query.targetId,
      version: "3.3.1",
      runId: "run-big",
      archive: { "recon-map.md": "# Map\n", ...walks },
    });
    const resolved = await resolveWordPressPriorResearch(
      f,
      f.attachments,
      query,
    );
    expect(resolved.status).toBe("passed");
    if (resolved.status !== "passed") return;
    const total = resolved.configuration.files.reduce(
      (sum, file) => sum + file.bytes,
      0,
    );
    expect(total).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(resolved.configuration.files[0]!.name).toBe("recon-map.md");
    const withheld = resolved.configuration.withheld!;
    expect(withheld.length).toBeGreaterThan(0);
    expect(withheld.length + resolved.configuration.files.length).toBe(41);
    // The withheld walks are the largest (lowest index) ones, named only.
    expect(withheld).toEqual(
      Array.from(
        { length: withheld.length },
        (_, index) => `walks/w${String(index).padStart(2, "0")}.md`,
      ),
    );
    expect(resolved.section).toContain(
      `- Withheld for size, not placed: ${withheld.join(", ")}.`,
    );
    for (const name of withheld)
      expect(resolved.files.some(({ path }) => path === `prior/${name}`)).toBe(
        false,
      );
    expect(
      await rebuildWordPressPriorResearch(
        f,
        f.attachments,
        resolved.configuration,
        "3.4.0",
      ),
    ).toBe(resolved.section);
  });
});

describe("research import (ADR 0049 D)", () => {
  it("writes one event per ended Trial with sealed notes, skips notes missing from the shared store, writes nothing twice, and the resolver picks imported research like local", async () => {
    const bench = await fixture();
    const production = await fixture({
      attachmentsDirectory: join(bench.root, "attachments"),
    });
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    // Three bench Trials: one with a Lab record, one without, one outside
    // invariant 1 (catalog history) that is never a candidate.
    const withLab = await bench.trial({
      campaignId: "bench-1",
      snapshotDigest: sha("c"),
      targetId: query.targetId,
      version: "3.3.1",
      runId: "bench-run-lab",
      archive: {
        "recon-map.md": "# Bench map\n",
        "assumptions/rest.md": "| a |\n",
      },
      lookupLog,
    });
    await bench.trial({
      campaignId: "bench-2",
      snapshotDigest: sha("d"),
      targetId: "wporg:other-plugin",
      version: "1.0",
      runId: "bench-run-other",
      archive: { "recon-map.md": "# Other\n" },
    });
    await bench.trial({
      campaignId: "bench-3",
      snapshotDigest: sha("e"),
      targetId: query.targetId,
      version: "3.0.0",
      runId: "bench-run-catalog",
      catalog: true,
    });
    // A Trial whose notes are not in the shared store (sealed into another
    // attachment store) is skipped with a line, never recorded.
    const elsewhere = await fixture();
    await bench.trial({
      campaignId: "bench-4",
      snapshotDigest: sha("f"),
      targetId: query.targetId,
      version: "3.3.2",
      runId: "bench-run-missing",
      archive: null,
    });
    await bench.ledger.append({
      schemaVersion: 1,
      campaignId: "bench-4",
      snapshotDigest: sha("f"),
      identity: "bench-run-missing-finished-2",
      occurredAt: "2026-10-20T00:00:00.000Z",
      type: "discovery-run-finished",
      runId: "bench-run-missing",
      outcome: "completed",
      costUsd: "unavailable",
      wallTimeMs: 1,
      researchArtifact: {
        digest: (
          await elsewhere.attachments.put(
            "research",
            Buffer.from(
              JSON.stringify({
                kind: "research-directory-archive",
                schemaVersion: 1,
                truncated: false,
                collectedBytes: 1,
                entries: [
                  {
                    path: "recon-map.md",
                    type: "file",
                    contentBase64:
                      Buffer.from("# Elsewhere\n").toString("base64"),
                  },
                ],
              }),
            ),
          )
        ).digest,
        truncated: false,
      },
    });

    const first = await importWordPressResearch(
      production,
      production.attachments,
      {
        fromStateDirectory: bench.root,
        log,
      },
    );
    expect(first).toEqual({ imported: 2, existing: 0, skipped: 1 });
    expect(lines.filter((line) => line.startsWith("skipped"))).toEqual([
      expect.stringContaining("bench-run-missing"),
    ]);
    const events = production.ledger
      .readAll({ type: "research-imported" })
      .map(({ event }) => event);
    expect(
      events.map(
        (event) => event.type === "research-imported" && event.fromRunId,
      ),
    ).toEqual(["bench-run-lab", "bench-run-other"]);
    const imported = events[0]!;
    if (imported.type !== "research-imported") throw new Error("type");
    const fromState = bench.root.split("/").pop()!;
    expect(imported).toMatchObject({
      identity: researchImportIdentity(fromState, "bench-run-lab"),
      campaignId: `research-import:${fromState}`,
      snapshotDigest: sha("c"),
      fromState,
      fromCampaignId: "bench-1",
      fromRunId: "bench-run-lab",
      targetId: query.targetId,
      targetVersion: "3.3.1",
      researchDigest: withLab.researchDigest,
      explorationLabDigest: withLab.explorationLabDigest,
    });
    expect(imported.artifacts.map(({ kind }) => kind)).toEqual([
      "research-stores",
    ]);
    // Only the basename of the other state is recorded; never its path.
    expect(JSON.stringify(imported)).not.toContain(bench.root);
    // The store table in this state's Private Evidence carries no keys.
    const stores = await production.store.readFile(
      imported.artifacts[0]!.digest,
      "stores.json",
      1024 * 1024,
    );
    expect(stores.status).toBe("resolved");
    if (stores.status === "resolved") {
      const text = stores.bytes.toString("utf8");
      expect(text).toContain("wp_options");
      expect(text).not.toContain("x_settings");
    }

    // A second import writes nothing.
    const second = await importWordPressResearch(
      production,
      production.attachments,
      {
        fromStateDirectory: bench.root,
        log,
      },
    );
    expect(second).toEqual({ imported: 0, existing: 2, skipped: 1 });
    expect(
      production.ledger.readAll({ type: "research-imported" }).length,
    ).toBe(2);
    // `--slug` narrows to one plugin and finds the same, already imported, Trial.
    expect(
      await importWordPressResearch(production, production.attachments, {
        fromStateDirectory: bench.root,
        slug: "synthetic-plugin",
        log,
      }),
    ).toEqual({ imported: 0, existing: 1, skipped: 1 });
    await expect(
      importWordPressResearch(production, production.attachments, {
        fromStateDirectory: production.root,
        log,
      }),
    ).rejects.toThrow(/its own/);

    // The production ledger has no Trial of this target; the imported one is passed.
    const resolved = await resolveWordPressPriorResearch(
      production,
      production.attachments,
      query,
    );
    expect(resolved.status).toBe("passed");
    if (resolved.status !== "passed") return;
    expect(resolved.files.map(({ path }) => path)).toEqual([
      "prior/recon-map.md",
      "prior/stores.json",
      "prior/assumptions/rest.md",
    ]);
    expect(resolved.configuration).toMatchObject({
      sourceRunId: "bench-run-lab",
      sourceState: fromState,
      sourceSnapshotDigest: sha("c"),
      sourceVersion: "3.3.1",
    });
    expect(resolved.section).toContain("version 3.3.1");
    expect(
      await rebuildWordPressPriorResearch(
        production,
        production.attachments,
        resolved.configuration,
        "3.4.0",
      ),
    ).toBe(resolved.section);
    // An imported Trial on this very Snapshot is not an earlier Trial.
    expect(
      await resolveWordPressPriorResearch(production, production.attachments, {
        ...query,
        snapshotDigest: sha("c"),
      }),
    ).toEqual({ status: "none", configuration: { none: "no-earlier-trial" } });

    // A local Trial of the target that finished later wins over the
    // imported one (the fixture clocks advance per event; the first local
    // Trial here only moves the clock past the bench finish).
    await production.trial({
      campaignId: "prod-0",
      snapshotDigest: sha("0"),
      targetId: "wporg:other-plugin",
      version: "1.1",
      runId: "prod-run-other",
      archive: { "recon-map.md": "# Other\n" },
    });
    await production.trial({
      campaignId: "prod-1",
      snapshotDigest: sha("1"),
      targetId: query.targetId,
      version: "3.3.9",
      runId: "prod-run-later",
      archive: { "recon-map.md": "# Prod map\n" },
    });
    const later = await resolveWordPressPriorResearch(
      production,
      production.attachments,
      query,
    );
    expect(later.status === "passed" && later.configuration.sourceRunId).toBe(
      "prod-run-later",
    );
  });
});
