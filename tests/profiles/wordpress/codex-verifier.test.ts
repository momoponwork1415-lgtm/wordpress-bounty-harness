import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  defineAgentRuntimeProfile,
  createNativeRunReceipt,
  ProviderAttachmentStore,
  type DiscoveryTransportRun,
} from "../../../src/discovery/index.js";
import { canonicalJson } from "../../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../../src/ledger/index.js";
import {
  admitWordPressFinding,
  type WordPressFinding,
} from "../../../src/profiles/wordpress/discovery/finding.js";
import type { WordPressLabHandle } from "../../../src/profiles/wordpress/lab/index.js";
import { CodexVerifier } from "../../../src/profiles/wordpress/verification/codex-verifier.js";

const digest = `sha256:${"a".repeat(64)}`;
const profile = defineAgentRuntimeProfile({
  id: "verification-test",
  transportKind: "codex-native/v1",
  sandboxImageDigest: digest,
  requestedModelId: "gpt-6-luna",
  requestedEffort: "low",
  codexCliVersion: "0.161.0",
  bundledCatalogDigest: digest,
  authenticationMethod: "host-private-bearer",
  cyberAccessProgram: "unavailable",
  serviceTier: "unavailable",
  subagent: { modelId: "unavailable", effort: "unavailable" },
});
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture(
  reports: readonly Record<string, unknown>[],
  failure?: "provider" | "sandbox",
  impact: WordPressFinding["impact"] = "sensitive-object-access",
  issueCanary = true,
) {
  const root = await mkdtemp(join(tmpdir(), "wbh-codex-verifier-"));
  roots.push(root);
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 12,
    maxBytes: 1024 * 1024,
  });
  const attachments = new ProviderAttachmentStore(join(root, "attachments"));
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: store,
  });
  const finding = admitWordPressFinding(
    {
      claim: "A synthetic access rule is missing",
      attackerPosition: "subscriber",
      impact,
      configurationPrecondition: "default",
      brokenProperty: "Only the owner may read it",
      sourceTrace: [{ file: "plugin.php", function: "view", line: 12 }],
      existingControls: "none",
      labObservations: "none",
    },
    {
      runId: "discovery-1",
      snapshotDigest: digest,
      reportArtifactDigest: digest,
    },
  );
  const findingDigest = await store.putFiles({
    "finding.json": canonicalJson(finding),
  });
  await ledger.append({
    schemaVersion: 1,
    identity: "finding-event",
    campaignId: "campaign-1",
    snapshotDigest: digest,
    occurredAt: "2026-10-08T00:00:00Z",
    type: "finding-recorded",
    findingId: finding.findingId,
    runId: "discovery-1",
    category: finding.impact,
    artifacts: [{ kind: "finding", digest: findingDigest }],
  });
  const runs: DiscoveryTransportRun[] = [];
  const runtime = {
    attachments,
    async execute(run: DiscoveryTransportRun) {
      runs.push(run);
      if (failure !== undefined)
        return {
          receipt: createNativeRunReceipt({
            ...run,
            terminal: "incomplete",
            reason: failure,
            startedAt: "2026-10-08T00:00:00Z",
            completedAt: "2026-10-08T00:01:00Z",
          }),
        };
      const report = reports[runs.length - 1]!;
      const attachment = await attachments.put(
        "verification",
        Buffer.from(JSON.stringify(report)),
      );
      return {
        attachment,
        receipt: createNativeRunReceipt({
          ...run,
          terminal: "completed",
          reason: "unavailable",
          startedAt: "2026-10-08T00:00:00Z",
          completedAt: "2026-10-08T00:01:00Z",
          reportArtifactDigest: attachment.digest,
          usage: {
            inputTokens: 10,
            cachedInputTokens: 0,
            outputTokens: 20,
            reasoningOutputTokens: 0,
          },
        }),
      };
    },
  };
  const verifier = new CodexVerifier({
    runtime,
    lab: {
      prepareExecutionCanary: () =>
        issueCanary
          ? { nonce: "fake-nonce", php: "synthetic-canary-php" }
          : null,
      prepareScriptCanary: () =>
        issueCanary
          ? { nonce: "fake-nonce", beaconUrl: "http://wordpress/fake-beacon" }
          : null,
    },
    store,
    ledger,
    profile,
    source: {
      directory: "/private/synthetic-source",
      tree: { digest, entries: 1, bytes: 10 },
    },
    clock: () => new Date("2026-10-08T00:00:00Z"),
  });
  const lab = {
    id: "lab-1",
    snapshotDigest: digest,
    setupDigest: digest,
    endpoint: "http://wordpress",
    networkName: "lab-internal",
    internalIp: "172.20.0.2",
    attackerAccounts: {
      subscriber: { username: "subscriber", password: "subscriber-secret" },
      customer: { username: "customer", password: "customer-secret" },
      administrator: { username: "administrator", password: "admin-secret" },
      contributor: { username: "contributor", password: "contributor-secret" },
    },
  };
  return { verifier, finding, lab, runs, store, ledger };
}

describe("CodexVerifier.attempt", () => {
  it.each([
    ["rce", "execution", "synthetic-canary-php"],
    ["stored-xss", "script", "http://wordpress/fake-beacon"],
  ] as const)(
    "issues the %s canary through the Lab",
    async (impact, kind, value) => {
      const f = await fixture(
        [
          {
            "http.json": JSON.stringify({
              exchanges: [{ request: {}, response: { body: "ordinary" } }],
            }),
            "steps.md": "Step",
          },
        ],
        undefined,
        impact,
      );
      const attempt = await f.verifier.attempt({
        finding: f.finding,
        lab: f.lab,
      });
      expect(attempt.status).toBe("attempted");
      expect(f.runs).toHaveLength(1);
      expect(f.runs[0]?.prompt).toContain(value);
      expect(
        f.ledger.read({ type: "verifier-run-finished" }).at(0)?.event,
      ).toMatchObject({ canaryIssued: kind });
    },
  );

  it("returns incomplete before starting a run when the Lab cannot issue a required canary", async () => {
    const f = await fixture([], undefined, "rce", false);
    expect(
      await f.verifier.attempt({ finding: f.finding, lab: f.lab }),
    ).toMatchObject({ status: "incomplete", reason: "precondition" });
    expect(f.runs).toHaveLength(0);
  });

  it("keeps a valid session in private evidence and rejects a malformed cookie", async () => {
    const report = (cookie: string) => ({
      "http.json": JSON.stringify({
        exchanges: [{ request: {}, response: { body: "ordinary" } }],
      }),
      "steps.md": "Step",
      "session.json": JSON.stringify({ cookie }),
    });
    const valid = await fixture([report("wordpress_logged_in%7Cfake")]);
    const attempted = await valid.verifier.attempt({
      finding: valid.finding,
      lab: valid.lab,
    });
    expect(attempted.status).toBe("attempted");
    if (attempted.status === "attempted") {
      const saved = await valid.store.readFile(
        attempted.recipeDigest,
        "session.json",
        1024,
      );
      expect(saved.status).toBe("resolved");
    }
    const invalid = await fixture([report("invalid cookie with spaces")]);
    expect(
      await invalid.verifier.attempt({
        finding: invalid.finding,
        lab: invalid.lab,
      }),
    ).toMatchObject({ status: "incomplete", reason: "recipe" });
  });
  it("returns a private HTTP recipe and records a fresh verifier receipt", async () => {
    const http = {
      exchanges: [
        {
          request: { path: "/synthetic" },
          response: { body: "ordinary response" },
        },
      ],
    };
    const f = await fixture([
      { "http.json": JSON.stringify(http), "steps.md": "Synthetic steps" },
    ]);
    const attempt = await f.verifier.attempt({
      finding: f.finding,
      lab: f.lab,
    });
    expect(attempt.status).toBe("attempted");
    if (attempt.status !== "attempted") return;
    expect(
      (await f.store.readFile(attempt.recipeDigest, "http.json", 1024)).status,
    ).toBe("resolved");
    expect(
      (await f.store.readFile(attempt.recipeDigest, "steps.md", 1024)).status,
    ).toBe("resolved");
    const event = f.ledger.read({ type: "verifier-run-finished" }).at(0)?.event;
    expect(event?.type).toBe("verifier-run-finished");
    if (event?.type !== "verifier-run-finished") return;
    expect(event.promptDigest).toBe(
      "sha256:a95b104f54d482095c766f91f91e8dd645f7f6c50c54aa11ccdc39d7c6a24161",
    );
    const storedReceipt = await f.store.readFile(
      event.receiptDigest,
      "receipt.json",
      1024 * 1024,
    );
    expect(storedReceipt.status).toBe("resolved");
    if (storedReceipt.status !== "resolved") return;
    expect(JSON.parse(storedReceipt.bytes.toString("utf8"))).toMatchObject({
      requestedModelId: "gpt-6-luna",
      requestedEffort: "low",
      codexCliVersion: "0.161.0",
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    expect(f.runs[0]?.campaignInput.history).toEqual({ mode: "none" });
  });

  it("preserves the route facts needed by the Harness judge", async () => {
    const route = { role: "subscriber", defaultSettings: true, steps: [] };
    const f = await fixture([
      {
        "http.json": JSON.stringify({
          exchanges: [{ request: {}, response: { body: "ordinary" } }],
        }),
        "steps.md": "Synthetic steps",
        "route.json": JSON.stringify(route),
      },
    ]);
    const attempt = await f.verifier.attempt({
      finding: f.finding,
      lab: f.lab,
    });
    expect(attempt.status).toBe("attempted");
    if (attempt.status !== "attempted") return;
    const stored = await f.store.readFile(
      attempt.recipeDigest,
      "route.json",
      1024,
    );
    expect(stored.status).toBe("resolved");
    if (stored.status === "resolved")
      expect(JSON.parse(stored.bytes.toString("utf8"))).toEqual(route);
  });

  it("keeps refutation separate from the recipe and ignores a claimed verdict", async () => {
    const f = await fixture([
      {
        "http.json": JSON.stringify({
          exchanges: [{ request: {}, response: { body: "ordinary" } }],
        }),
        "steps.md": "A synthetic step",
        "refutation.md": "The response does not contain the claimed object",
        status: "runtime-confirmed",
      },
    ]);
    const attempt = await f.verifier.attempt({
      finding: f.finding,
      lab: f.lab,
    });
    expect(attempt.status).toBe("attempted");
    if (attempt.status !== "attempted") return;
    expect(attempt.refutationDigest).toMatch(/^sha256:/);
    expect(
      (await f.store.readFile(attempt.refutationDigest!, "refutation.md", 1024))
        .status,
    ).toBe("resolved");
    expect(
      (await f.store.readFile(attempt.recipeDigest, "refutation.md", 1024))
        .status,
    ).toBe("missing");
  });

  it("returns an actionable prerequisite failure before recipe validation", async () => {
    const f = await fixture([
      {
        "http.json": null,
        "steps.md": null,
        precondition: "The synthetic setting is unavailable",
      },
    ]);
    expect(
      await f.verifier.attempt({ finding: f.finding, lab: f.lab }),
    ).toEqual({
      status: "incomplete",
      reason: "precondition",
      nextStep: "The synthetic setting is unavailable",
    });
  });

  it("reports a missing or malformed HTTP record as an incomplete recipe", async () => {
    for (const report of [
      { "steps.md": "Step" },
      { "http.json": "{}", "steps.md": "Step" },
    ]) {
      const f = await fixture([report]);
      const attempt = await f.verifier.attempt({
        finding: f.finding,
        lab: f.lab,
      });
      expect(attempt).toMatchObject({ status: "incomplete", reason: "recipe" });
    }
  });

  it("passes only low-privilege credentials and starts a fresh run each time", async () => {
    const report = {
      "http.json": JSON.stringify({
        exchanges: [{ request: {}, response: { body: "ordinary" } }],
      }),
      "steps.md": "Step",
    };
    const f = await fixture([report, report]);
    await f.verifier.attempt({ finding: f.finding, lab: f.lab });
    await f.verifier.attempt({ finding: f.finding, lab: f.lab });
    expect(f.runs).toHaveLength(2);
    expect(f.runs[0]?.runId).not.toBe(f.runs[1]?.runId);
    for (const run of f.runs) {
      expect(run.prompt).toContain("subscriber-secret");
      expect(run.prompt).toContain("sensitive-object-access");
      expect(run.prompt).toContain("labObservations");
      expect(run.prompt).toContain("existingControls");
      expect(run.prompt).toContain("customer-secret");
      expect(run.prompt).not.toContain("admin-secret");
      expect(run.prompt).not.toContain("contributor-secret");
      expect(run.prompt).not.toContain("A synthetic step");
      expect(run.campaignInput.history).toEqual({ mode: "none" });
      expect(run.sourceDirectory).toBe("/private/synthetic-source");
      expect(run.outputKind).toBe("verification");
    }
    const accounts: WordPressLabHandle["attackerAccounts"] = {
      subscriber: { username: "subscriber", password: "secret" },
      // @ts-expect-error Elevated account credentials are not part of the Lab handle contract.
      administrator: { username: "administrator", password: "secret" },
    };
    expect(accounts.subscriber.username).toBe("subscriber");
  });

  it("preserves a transport failure receipt and does not relabel it as a recipe error", async () => {
    const f = await fixture([], "sandbox");
    await expect(
      f.verifier.attempt({ finding: f.finding, lab: f.lab }),
    ).rejects.toMatchObject({ reason: "sandbox" });
    const event = f.ledger.read({ type: "verifier-run-finished" }).at(0)?.event;
    expect(event).toMatchObject({
      type: "verifier-run-finished",
      terminal: "incomplete",
    });
  });
});
