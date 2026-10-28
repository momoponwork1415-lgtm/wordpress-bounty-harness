import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  createNativeRunReceipt,
  defineAgentRuntimeProfile,
  type OneShotRun,
} from "../../../src/discovery/index.js";
import { measureCanonicalSourceTree } from "../../../src/infrastructure/canonical-source-tree.js";
import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import { admitWordPressFinding } from "../../../src/profiles/wordpress/discovery/finding.js";
import { OneShotWordPressVerifier } from "../../../src/profiles/wordpress/verification/one-shot-verifier.js";
import type { WordPressVerifierRun } from "../../../src/profiles/wordpress/verification/wordpress-verifier.js";

const digest = `sha256:${"a".repeat(64)}`;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it("runs the fixed skill in a one-shot Lab and seals all six files through its receipt (#651)", async () => {
  const root = await mkdtemp(join(tmpdir(), "wbh-auto-verifier-"));
  roots.push(root);
  const sourceDirectory = join(root, "source");
  await mkdir(sourceDirectory);
  await writeFile(join(sourceDirectory, "plugin.php"), "<?php // synthetic\n");
  const tree = await measureCanonicalSourceTree(sourceDirectory, {
    maxEntries: 10,
    maxBytes: 1000,
  });
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "private"),
    maxEntries: 32,
    maxBytes: 1024 * 1024,
  });
  const profile = defineAgentRuntimeProfile({
    id: "synthetic",
    transportKind: "codex-native/v1",
    sandboxImageDigest: digest,
    requestedModelId: "gpt-6.1-sol",
    requestedEffort: "high",
    codexCliVersion: "0.161.0",
    bundledCatalogDigest: digest,
    authenticationMethod: "host-private-bearer",
    cyberAccessProgram: "standard",
    serviceTier: "priority",
    subagent: { modelId: "unavailable", effort: "unavailable" },
  });
  const finding = admitWordPressFinding(
    {
      claim: "synthetic claim",
      attackerPosition: "subscriber",
      impact: "stored-xss",
      configurationPrecondition: "default",
      brokenProperty: "synthetic",
      sourceTrace: [{ file: "plugin.php", function: "synthetic", line: 1 }],
      existingControls: "none",
      labObservations: "none",
    },
    {
      runId: "discovery-1",
      snapshotDigest: digest,
      reportArtifactDigest: digest,
    },
  );
  const lab = {
    id: "lab-1",
    snapshotDigest: digest,
    setupDigest: digest,
    endpoint: "http://wordpress",
    networkName: "wbh-lab-1-net",
    internalIp: "172.20.0.2",
    recorderIp: "172.20.0.4",
    attackerAccounts: { subscriber: { username: "sub", password: "sub-pass" } },
  };
  const input: WordPressVerifierRun = {
    runId: "verify-1",
    finding,
    lab,
    restartObservation: async () => {
      restartCount++;
      return true;
    },
  };
  let restartCount = 0;
  let captured: OneShotRun | undefined;
  const files = {
    "http.json":
      '{"exchanges":[{"request":{"method":"GET","path":"/synthetic"},"response":{"body":"ok"}}]}',
    "steps.md": "synthetic observation",
    "route.json": '{"role":"subscriber","defaultSettings":true,"steps":[]}',
    "session.json": "",
    "refutation.md": "",
    precondition: "",
  };
  const transport = new OneShotWordPressVerifier({
    oneShot: {
      async execute(run) {
        captured = run;
        const attack = await run.lab?.closeSetup(new AbortController().signal);
        expect(JSON.parse(attack ?? "{}")).toMatchObject({
          runId: "verify-1",
          findingId: finding.findingId,
          snapshotDigest: digest,
          accounts: { subscriber: { username: "sub" } },
        });
        expect(attack).not.toContain("setup-pass");
        return {
          receipt: createNativeRunReceipt({
            runId: run.runId,
            targetSnapshotDigest: digest,
            profile,
            terminal: "completed",
            reason: "unavailable",
            startedAt: "2026-10-28T00:00:00Z",
            completedAt: "2026-10-28T00:00:01Z",
          }),
          scriptRan: false,
          outputFiles: [
            ...Object.entries(files).map(([name, content]) => ({
              name,
              content,
            })),
            { name: "observation-ready.json", content: "{}" },
          ],
        };
      },
    },
    profile,
    handle: lab,
    lab: {
      reviewAdministrator: () => ({
        username: "harness-admin",
        password: "setup-pass",
      }),
    },
    sourceFor: async () => ({ directory: sourceDirectory, tree }),
    reviewExport: async () => '{"schema":"synthetic"}',
    store,
    clock: () => new Date("2026-10-28T00:00:00Z"),
  });

  const result = await transport.run(input);
  expect(result.outcome).toEqual({ status: "files", files });
  expect(result.receipt).toMatchObject({
    terminal: "completed",
    skill: "wbh-verify/v11",
    nativeReceipt: { terminal: "completed", reason: "unavailable" },
  });
  expect(captured?.lab).toMatchObject({
    internalIp: lab.recorderIp,
    networkName: lab.networkName,
  });
  expect(JSON.parse(captured!.lab!.labJson)).toMatchObject({
    administrator: { username: "harness-admin" },
  });
  expect(captured!.lab!.labJson).not.toContain("sub-pass");
  expect(restartCount).toBe(1);
  expect(captured?.inputFiles.map((file) => file.name)).toEqual([
    "review-export.json",
    "binding.json",
  ]);
  const raw = result.receipt as typeof result.receipt & {
    filesArtifactDigest: string;
  };
  expect(
    (await store.readFile(raw.filesArtifactDigest, "steps.md", 1000)).status,
  ).toBe("resolved");

  for (const reason of ["wall", "provider", "policy", "evidence"] as const) {
    const failed = new OneShotWordPressVerifier({
      ...transport.options,
      oneShot: {
        execute: async (run) => ({
          receipt: createNativeRunReceipt({
            runId: run.runId,
            targetSnapshotDigest: digest,
            profile,
            terminal: "incomplete",
            reason,
            startedAt: "2026-10-28T00:00:00Z",
            completedAt: "2026-10-28T00:00:01Z",
          }),
          scriptRan: false,
        }),
      },
    });
    const result = await failed.run({ ...input, runId: `verify-${reason}` });
    expect(result.outcome).toEqual({
      status: "incomplete",
      nextStep: `auto:${reason}`,
    });
    expect(result.receipt).toMatchObject({
      terminal: "incomplete",
      reason,
      nativeReceipt: { terminal: "incomplete", reason },
    });
  }

  const withoutAck = new OneShotWordPressVerifier({
    ...transport.options,
    oneShot: {
      execute: async (run) => {
        await run.lab?.closeSetup(new AbortController().signal);
        return {
          receipt: createNativeRunReceipt({
            runId: run.runId,
            targetSnapshotDigest: digest,
            profile,
            terminal: "completed",
            reason: "unavailable",
            startedAt: "2026-10-28T00:00:00Z",
            completedAt: "2026-10-28T00:00:01Z",
          }),
          scriptRan: false,
          outputFiles: Object.entries(files).map(([name, content]) => ({
            name,
            content,
          })),
        };
      },
    },
  });
  const missing = await withoutAck.run({ ...input, runId: "verify-no-ack" });
  expect(missing.outcome).toEqual({
    status: "incomplete",
    nextStep: "auto:evidence",
  });
  expect(missing.receipt).toMatchObject({
    terminal: "incomplete",
    reason: "evidence",
  });
});
