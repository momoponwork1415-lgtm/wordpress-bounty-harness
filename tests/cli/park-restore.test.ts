import { z } from "zod";

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/index.js";
import { createWordPressCliProfile } from "../../src/cli/wordpress.js";
import { canonicalJson } from "../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";
import { admitWordPressFinding } from "../../src/profiles/wordpress/discovery/finding.js";
import { loadWordpressScopePolicy } from "../../src/profiles/wordpress/scope-policy.js";

const SNAPSHOT = `sha256:${"a".repeat(64)}`;
const NOW = "2026-10-26T12:00:00.000Z";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** One admission-parked synthetic Finding; no target, Lab or provider is run. */
async function fixture(
  input: {
    readonly impact?: string;
    readonly reason?:
      "admin-configuration-precondition" | "outside-programme-boundary";
    readonly parked?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "wbh-cli-restore-"));
  roots.push(root);
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory);
  const store = new PrivateArtifactStore({
    rootDirectory: join(stateDirectory, "private-evidence"),
    maxEntries: 64,
    maxBytes: 100_000,
  });
  const ledger = new Ledger({
    databasePath: join(stateDirectory, "ledger.sqlite"),
    artifactStore: store,
  });
  const impact = input.impact ?? "stored-xss";
  const finding = admitWordPressFinding(
    {
      claim: "Synthetic stored script effect",
      attackerPosition: "subscriber",
      impact,
      configurationPrecondition:
        "An administrator enables the synthetic gallery feature.",
      brokenProperty: "Stored script cannot execute in a privileged browser",
      sourceTrace: [{ file: "plugin.php", function: "render", line: 1 }],
      existingControls: "None",
      labObservations: "Synthetic evidence only",
    },
    {
      runId: "run-1",
      snapshotDigest: SNAPSHOT,
      reportArtifactDigest: SNAPSHOT,
    },
  );
  const digest = await store.putFiles({
    "finding.json": canonicalJson(finding),
  });
  if (input.parked !== false)
    await ledger.append({
      schemaVersion: 1,
      identity: `discovery-finding-parked-${finding.findingId}`,
      campaignId: "campaign-1",
      snapshotDigest: SNAPSHOT,
      occurredAt: "2026-10-21T00:00:00Z",
      type: "finding-parked",
      findingId: finding.findingId,
      runId: "run-1",
      category: impact,
      reason: input.reason ?? "admin-configuration-precondition",
      preconditionClass: "admin-configuration",
      artifacts: [{ kind: "finding", digest }],
    });
  const profile = createWordPressCliProfile({
    scopePolicy: await loadWordpressScopePolicy(),
    boundaries: () => {
      throw new Error("No campaign is opened by review restore");
    },
  });
  const run = async (args: readonly string[]) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(
      args,
      { stateDirectory, profile, clock: () => new Date(NOW) },
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );
    return { code, stdout, stderr };
  };
  const restore = (extra: readonly string[] = []) =>
    run([
      "review",
      "restore",
      "--campaign",
      "campaign-1",
      "--finding",
      finding.findingId,
      "--reason",
      "Parked by the retired admin-configuration gate (ADR 0038 追記 8)",
      ...extra,
    ]);
  return { ledger, store, finding, digest, run, restore };
}

describe("review restore (#529)", () => {
  it("returns a retired admission park to the queue and keeps the old park", async () => {
    const { ledger, store, finding, digest, run, restore } = await fixture();
    expect(
      (await run(["review", "parked", "--campaign", "campaign-1"])).stdout,
    ).toHaveLength(1);

    const result = await restore(["--by", "orchestrator"]);
    expect(result).toEqual({
      code: 0,
      stderr: [],
      stdout: [`restored finding ${finding.findingId} to the review queue`],
    });
    expect(ledger.read({ type: "finding-parked" })).toHaveLength(1);
    expect(
      ledger.read({ type: "finding-recorded" }).map(({ event }) => event),
    ).toMatchObject([
      {
        identity: `discovery-finding-${finding.findingId}`,
        category: "stored-xss",
        artifacts: [{ kind: "finding", digest }],
      },
    ]);
    const [marker] = ledger
      .read({ type: "finding-park-restored" })
      .map(({ event }) => event);
    expect(marker).toMatchObject({
      findingId: finding.findingId,
      parkedIdentity: `discovery-finding-parked-${finding.findingId}`,
      reason: "admission-correction",
      occurredAt: NOW,
    });
    const note = marker?.artifacts.find(({ kind }) => kind === "restore-note");
    expect(marker?.artifacts[0]).toEqual({ kind: "finding", digest });
    const stored = await store.readJson(
      note?.digest ?? "",
      "restore-note.json",
      z.unknown(),
      1024,
    );
    expect(stored).toMatchObject({
      status: "resolved",
      value: {
        findingId: finding.findingId,
        restoredBy: "orchestrator",
        reason:
          "Parked by the retired admin-configuration gate (ADR 0038 追記 8)",
        restoredAt: NOW,
      },
    });
    expect(ledger.activeParked({ campaignId: "campaign-1" })).toHaveLength(0);
    expect(
      (await run(["review", "parked", "--campaign", "campaign-1"])).stdout,
    ).toEqual(["no parked findings"]);
    expect(
      (await run(["review", "--campaign", "campaign-1"])).stdout.join("\n"),
    ).toContain(finding.findingId);
  });

  it("refuses a second restore without appending", async () => {
    const { ledger, finding, restore } = await fixture();
    expect((await restore()).code).toBe(0);
    const before = ledger.readAll();
    const again = await restore();
    expect(again.code).toBe(1);
    expect(again.stderr.join("\n")).toContain(
      `Finding ${finding.findingId} is already restored`,
    );
    expect(ledger.readAll()).toEqual(before);
  });

  it("refuses a Finding that was never parked", async () => {
    const { ledger, restore } = await fixture({ parked: false });
    const result = await restore();
    expect(result.code).toBe(1);
    expect(result.stderr.join("\n")).toContain("no admission park event");
    expect(ledger.readAll()).toEqual([]);
  });

  it("refuses a Programme Boundary park", async () => {
    const { ledger, restore } = await fixture({
      impact: "reflected-xss",
      reason: "outside-programme-boundary",
    });
    const before = ledger.readAll();
    const result = await restore();
    expect(result.code).toBe(1);
    expect(result.stderr.join("\n")).toContain(
      "Programme Boundary parks cannot be restored here",
    );
    expect(ledger.readAll()).toEqual(before);
  });

  it("refuses an old configuration park whose impact the current boundary still parks", async () => {
    const { ledger, restore } = await fixture({ impact: "options-update" });
    const before = ledger.readAll();
    const result = await restore();
    expect(result.code).toBe(1);
    expect(result.stderr.join("\n")).toContain(
      "Finding is outside the Programme Boundary",
    );
    expect(ledger.readAll()).toEqual(before);
    expect(ledger.activeParked({ campaignId: "campaign-1" })).toHaveLength(1);
  });

  it("needs a reason", async () => {
    const { ledger, run, finding } = await fixture();
    const before = ledger.readAll();
    const result = await run([
      "review",
      "restore",
      "--campaign",
      "campaign-1",
      "--finding",
      finding.findingId,
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr.join("\n")).toContain("--reason is required");
    expect(ledger.readAll()).toEqual(before);
  });
});
