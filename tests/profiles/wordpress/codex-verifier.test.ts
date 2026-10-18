import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  defineAgentRuntimeProfile,
  createNativeRunReceipt,
  ProviderAttachmentStore,
  type DiscoveryTransportRun,
  type NativeRunReceipt,
} from "../../../src/discovery/index.js";
import { canonicalJson } from "../../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../../src/ledger/index.js";
import {
  admitWordPressFinding,
  type WordPressFinding,
} from "../../../src/profiles/wordpress/discovery/finding.js";
import type { WordPressLabHandle } from "../../../src/profiles/wordpress/lab/index.js";
import { loadWordPressVerifierPrompt } from "../../../src/profiles/wordpress/prompts/index.js";
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
  failure?:
    | "provider"
    | "sandbox"
    | {
        readonly reason: "schema";
        readonly reasonDetail: string;
        readonly brokerMetrics?: NativeRunReceipt["brokerMetrics"];
      },
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
            reason: typeof failure === "string" ? failure : failure.reason,
            ...(typeof failure === "string"
              ? {}
              : {
                  reasonDetail: failure.reasonDetail,
                  ...(failure.brokerMetrics === undefined
                    ? {}
                    : { brokerMetrics: failure.brokerMetrics }),
                }),
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
      markCapture: async () => "0",
      prepareExecutionCanary: () =>
        issueCanary
          ? { nonce: "fake-nonce", php: "synthetic-canary-php" }
          : null,
      prepareScriptCanary: () =>
        issueCanary
          ? {
              nonce: "fake-nonce",
              beaconUrl: "http://wordpress/fake-beacon",
              javascript:
                'fetch("http://wordpress/fake-beacon", { method: "POST", headers: { "X-WBH-Script-Canary": "fake-nonce" } });',
              loaderJavascript: 'import("//wordpress/fake-module")',
            }
          : null,
      canaryLedger: () =>
        issueCanary
          ? {
              nonce: "fake-nonce",
              adminUser: "wbh-canary-admin-fake-nonce",
              roleBaseline: {},
              sqlCanary: { table: "wbh_canary", value: "fake-value" },
              fileCanaries: [],
              sensitiveCanaries: [
                {
                  kind: "private-post",
                  objectId: "19",
                  value: "wbh-sensitive-secret-fixture",
                },
              ],
              option: "wbh_canary_fake-nonce",
              postId: "1",
              postMeta: "wbh_canary_fake-nonce",
              file: "/tmp/wbh-canary.txt",
              user: "wbh-canary-fake-nonce",
            }
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
    recorderIp: "172.20.0.4",
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
  it("records a replay in its own campaign when the same Finding exists in an earlier campaign", async () => {
    const f = await fixture([
      {
        "http.json": JSON.stringify({
          exchanges: [{ request: {}, response: { body: "ordinary" } }],
        }),
        "steps.md": "Step",
      },
    ]);
    const original = f.ledger.read({
      campaignId: "campaign-1",
      type: "finding-recorded",
      limit: 1,
    })[0]?.event;
    if (original?.type !== "finding-recorded")
      throw new Error("Synthetic Finding is missing");
    expect(
      await f.ledger.append({
        ...original,
        identity: "smoke-finding",
        campaignId: "smoke-campaign",
      }),
    ).toMatchObject({ status: "appended" });

    const attempt = await f.verifier.attempt({
      campaignId: "smoke-campaign",
      finding: f.finding,
      lab: f.lab,
    });
    expect(attempt.status).toBe("attempted");
    expect(
      f.ledger.read({
        campaignId: "campaign-1",
        type: "verifier-run-finished",
      }),
    ).toHaveLength(0);
    expect(
      f.ledger.read({
        campaignId: "smoke-campaign",
        type: "verifier-run-finished",
      }),
    ).toHaveLength(1);
  });

  it("passes the Lab's read-only database endpoint to the verifier transport", async () => {
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
      "sqli",
    );
    Object.assign(f.lab, {
      database: {
        host: "database",
        ipv4: "172.20.0.3",
        port: 3306,
        name: "wordpress",
        readOnlyAccount: {
          username: "fixture_reader",
          password: "fixture_only",
        },
      },
    });
    const attempt = await f.verifier.attempt({
      campaignId: "campaign-1",
      finding: f.finding,
      lab: f.lab,
    });
    expect(attempt.status).toBe("attempted");
    if (attempt.status !== "attempted") return;
    expect(
      (
        await f.store.readFile(
          attempt.recipeDigest,
          "capture-marker.json",
          1000,
        )
      ).status,
    ).toBe("resolved");
    expect(f.runs[0]?.lab?.database).toEqual({
      host: "database",
      ipv4: "172.20.0.3",
    });
    expect(f.runs[0]?.lab?.internalIp).toBe("172.20.0.4");
    expect(f.runs[0]?.prompt).toContain("fixture_reader");
    const run = f.runs[0];
    expect(run).toBeDefined();
    const labInput = JSON.parse(run!.prompt.split("\n\n## Lab\n")[1]!) as {
      canary: unknown;
    };
    expect(labInput.canary).toEqual({ kind: "sql", table: "wbh_canary" });
    expect(run!.prompt).toContain("## Harness SQL canary target");
    expect(JSON.stringify(run)).not.toContain("fake-value");
    const staticInstructions = run!.prompt.split("\n\n## Finding")[0]!;
    const expectedDigest = `sha256:${createHash("sha256").update(staticInstructions).digest("hex")}`;
    expect(run!.campaignInput.promptDigest).toBe(expectedDigest);
    expect(
      JSON.stringify(f.ledger.read({ type: "verifier-run-finished" })),
    ).not.toMatch(/fixture_only|fake-value/);
    expect(f.ledger.read({ type: "verifier-run-finished" })).toMatchObject([
      { event: { canaryIssued: "sql" } },
    ]);
    expect(f.ledger.read({ type: "verification-finished" })).toHaveLength(0);
  });

  it("withholds the database and protected canaries from a sensitive-object verifier", async () => {
    const f = await fixture(
      [{ precondition: "The synthetic route needs another step" }],
      undefined,
      "sensitive-object-access",
    );
    Object.assign(f.lab, {
      database: {
        host: "database",
        ipv4: "172.20.0.3",
        port: 3306,
        name: "wordpress",
        readOnlyAccount: {
          username: "fixture_reader",
          password: "fixture_only",
        },
      },
    });
    await f.verifier.attempt({
      campaignId: "campaign-1",
      finding: f.finding,
      lab: f.lab,
    });
    expect(f.runs[0]?.lab?.database).toBeUndefined();
    expect(f.runs[0]?.prompt).not.toContain("fixture_reader");
    expect(f.runs[0]?.prompt).not.toContain("wbh-sensitive-");
  });

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
        campaignId: "campaign-1",
        finding: f.finding,
        lab: f.lab,
      });
      expect(attempt.status).toBe("attempted");
      expect(f.runs).toHaveLength(1);
      expect(f.runs[0]?.prompt).toContain(value);
      if (impact === "stored-xss") {
        expect(f.runs[0]?.prompt).toContain('"javascript"');
        expect(f.runs[0]?.prompt).toContain('"loaderJavascript"');
        expect(f.runs[0]?.prompt).toContain("X-WBH-Script-Canary");
        expect(f.runs[0]?.prompt).toContain(
          "## Harness victim operation contract",
        );
        expect(f.runs[0]?.prompt).toContain('kind: "click-text"');
        const staticInstructions = f.runs[0]?.prompt.split("\n\n## Finding")[0];
        expect(staticInstructions).toBeDefined();
        const expectedDigest = `sha256:${createHash("sha256").update(staticInstructions!).digest("hex")}`;
        expect(f.runs[0]?.campaignInput.promptDigest).toBe(expectedDigest);
        expect(
          f.ledger.read({ type: "verifier-run-finished" }).at(0)?.event,
        ).toMatchObject({ promptDigest: expectedDigest });
      }
      expect(
        f.ledger.read({ type: "verifier-run-finished" }).at(0)?.event,
      ).toMatchObject({ canaryIssued: kind });
    },
  );

  it("passes the administrator principal canary to an account takeover verifier", async () => {
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
      "account-takeover",
    );
    expect(
      await f.verifier.attempt({
        campaignId: "campaign-1",
        finding: f.finding,
        lab: f.lab,
      }),
    ).toMatchObject({ status: "attempted" });
    expect(f.runs[0]?.prompt).toContain("wbh-canary-admin-fake-nonce");
    expect(
      f.ledger.read({ type: "verifier-run-finished" }).at(0)?.event,
    ).toMatchObject({ canaryIssued: "principal" });
  });

  it("passes a judge-owned earlier route only to the version-comparison Verifier", async () => {
    const f = await fixture([
      {
        "http.json": JSON.stringify({
          exchanges: [{ request: {}, response: { body: "ordinary" } }],
        }),
        "steps.md": "Step",
      },
    ]);
    const referenceRoute = {
      role: "subscriber",
      defaultSettings: false,
      steps: [
        {
          kind: "http",
          method: "POST",
          path: "/same-route",
          expected: "Earlier observed response",
        },
      ],
    };
    expect(
      await f.verifier.attempt({
        campaignId: "campaign-1",
        finding: f.finding,
        lab: f.lab,
        referenceRoute,
      }),
    ).toMatchObject({ status: "attempted" });
    expect(f.runs[0]?.prompt).toContain("## Earlier confirmed route");
    expect(f.runs[0]?.prompt).toContain("/same-route");
  });

  it.each(["rce", "sqli"] as const)(
    "returns incomplete before starting a %s run when the Lab cannot issue a required canary",
    async (impact) => {
      const f = await fixture([], undefined, impact, false);
      expect(
        await f.verifier.attempt({
          campaignId: "campaign-1",
          finding: f.finding,
          lab: f.lab,
        }),
      ).toMatchObject({ status: "incomplete", reason: "precondition" });
      expect(f.runs).toHaveLength(0);
    },
  );

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
      campaignId: "campaign-1",
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
        campaignId: "campaign-1",
        finding: invalid.finding,
        lab: invalid.lab,
      }),
    ).toMatchObject({ status: "incomplete", reason: "recipe" });
  });

  it("takes a missing session candidate from a reported login Set-Cookie header", async () => {
    const f = await fixture([
      {
        "http.json": JSON.stringify({
          exchanges: [
            {
              request: { method: "GET", url: "http://wordpress/" },
              response: {
                body: "ordinary",
                headers: {
                  "set-cookie": [
                    "wordpress_logged_in_fixture=example%7Ctoken; Path=/; HttpOnly",
                  ],
                },
              },
            },
          ],
        }),
        "steps.md": "Synthetic steps",
      },
    ]);
    const attempt = await f.verifier.attempt({
      campaignId: "campaign-1",
      finding: f.finding,
      lab: f.lab,
    });
    expect(attempt.status).toBe("attempted");
    if (attempt.status !== "attempted") return;
    const saved = await f.store.readFile(
      attempt.recipeDigest,
      "session.json",
      1024,
    );
    expect(saved.status).toBe("resolved");
    if (saved.status === "resolved")
      expect(JSON.parse(saved.bytes.toString("utf8"))).toEqual({
        cookie: "example%7Ctoken",
      });
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
      campaignId: "campaign-1",
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
      "sha256:df5ed497912146fd4ceaeacbf923d3cee3337c477afad8645044fca460bd3b18",
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
    const route = {
      role: "subscriber",
      defaultSettings: true,
      steps: ["GET /synthetic", "HEAD /synthetic"],
      victim: {
        role: "administrator",
        paths: ["/wp-admin/admin.php?page=fixture"],
      },
    };
    const f = await fixture([
      {
        "http.json": JSON.stringify({
          exchanges: [
            {
              request: { method: "GET", url: "http://wordpress/synthetic" },
              response: { body: "ordinary" },
            },
            {
              request: { method: "HEAD", url: "http://wordpress/synthetic" },
              response: { body: "" },
            },
          ],
        }),
        "steps.md": "Synthetic steps",
        "route.json": JSON.stringify(route),
      },
    ]);
    const attempt = await f.verifier.attempt({
      campaignId: "campaign-1",
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
      expect(JSON.parse(stored.bytes.toString("utf8"))).toEqual({
        role: "subscriber",
        account: "subscriber",
        defaultSettings: true,
        configurationChanges: [],
        victim: {
          role: "administrator",
          paths: ["/wp-admin/admin.php?page=fixture"],
        },
        steps: [
          {
            kind: "http",
            method: "GET",
            path: "/synthetic",
            expected: "Observe the response recorded in http.json",
          },
          {
            kind: "http",
            method: "HEAD",
            path: "/synthetic",
            expected: "Observe the response recorded in http.json",
          },
        ],
      });
  });

  it("rejects a route reconstructed from an off-Lab HTTP request", async () => {
    const f = await fixture([
      {
        "http.json": JSON.stringify({
          exchanges: [
            {
              request: { method: "GET", url: "http://outside.invalid/path" },
              response: { body: "ordinary" },
            },
          ],
        }),
        "steps.md": "Synthetic steps",
        "route.json": JSON.stringify({
          role: "subscriber",
          defaultSettings: true,
          steps: ["GET /path"],
        }),
      },
    ]);
    expect(
      await f.verifier.attempt({
        campaignId: "campaign-1",
        finding: f.finding,
        lab: f.lab,
      }),
    ).toMatchObject({ status: "incomplete", reason: "recipe" });
  });

  it("rejects a victim path that could leave the Lab origin", async () => {
    const f = await fixture([
      {
        "http.json": JSON.stringify({
          exchanges: [
            {
              request: { method: "GET", path: "/synthetic" },
              response: { body: "ordinary" },
            },
          ],
        }),
        "steps.md": "Synthetic steps",
        "route.json": JSON.stringify({
          role: "subscriber",
          defaultSettings: true,
          victim: { role: "administrator", paths: ["//outside.invalid/"] },
        }),
      },
    ]);
    expect(
      await f.verifier.attempt({
        campaignId: "campaign-1",
        finding: f.finding,
        lab: f.lab,
      }),
    ).toMatchObject({ status: "incomplete", reason: "recipe" });
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
      campaignId: "campaign-1",
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
      await f.verifier.attempt({
        campaignId: "campaign-1",
        finding: f.finding,
        lab: f.lab,
      }),
    ).toEqual({
      status: "incomplete",
      reason: "precondition",
      nextStep: "catalogue に無い前提",
    });
  });

  it("names the next catalogue scenario for a missing translation dictionary", async () => {
    const f = await fixture([
      { precondition: "Translation dictionary is empty" },
    ]);
    expect(
      await f.verifier.attempt({
        campaignId: "campaign-1",
        finding: f.finding,
        lab: f.lab,
      }),
    ).toEqual({
      status: "incomplete",
      reason: "precondition",
      nextStep:
        "translatepress-translation-data-v1: TranslatePress の二次言語・翻訳データ・承認済みコメント",
      nextScenarioId: "translatepress-translation-data-v1",
    });
  });

  it("reports a missing or malformed HTTP record as an incomplete recipe", async () => {
    for (const report of [
      { "steps.md": "Step" },
      { "http.json": "{}", "steps.md": "Step" },
    ]) {
      const f = await fixture([report]);
      const attempt = await f.verifier.attempt({
        campaignId: "campaign-1",
        finding: f.finding,
        lab: f.lab,
      });
      expect(attempt).toMatchObject({ status: "incomplete", reason: "recipe" });
    }
  });

  it("passes only low-privilege credentials and starts a fresh v7 run in each Lab", async () => {
    const report = {
      "http.json": JSON.stringify({
        exchanges: [{ request: {}, response: { body: "ordinary" } }],
      }),
      "steps.md": "Step",
    };
    const f = await fixture([report, report]);
    const retryLab = { ...f.lab, id: "lab-2" };
    await f.verifier.attempt({
      campaignId: "campaign-1",
      finding: f.finding,
      lab: f.lab,
    });
    await f.verifier.attempt({
      campaignId: "campaign-1",
      finding: f.finding,
      lab: retryLab,
    });
    expect(retryLab.id).not.toBe(f.lab.id);
    const fixed = await loadWordPressVerifierPrompt();
    expect(fixed.id).toBe("verifier-v7");
    expect(f.runs).toHaveLength(2);
    expect(f.runs[0]?.runId).not.toBe(f.runs[1]?.runId);
    for (const run of f.runs) {
      expect(run.campaignInput.promptDigest).toBe(fixed.digest);
      expect(run.prompt.startsWith(fixed.text.trim())).toBe(true);
      expect(run.targetSnapshotDigest).toBe(f.finding.snapshotDigest);
      expect(run.campaignInput.lab.setupDigest).toBe(f.lab.setupDigest);
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
    const receipts = f.ledger
      .read({ type: "verifier-run-finished" })
      .map(({ event }) => {
        if (event.type !== "verifier-run-finished")
          throw new Error("Missing receipt");
        expect(event.promptDigest).toBe(fixed.digest);
        return event.receiptDigest;
      });
    expect(receipts).toHaveLength(2);
    expect(new Set(receipts).size).toBe(2);
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
      f.verifier.attempt({
        campaignId: "campaign-1",
        finding: f.finding,
        lab: f.lab,
      }),
    ).rejects.toMatchObject({ reason: "sandbox" });
    const event = f.ledger.read({ type: "verifier-run-finished" }).at(0)?.event;
    expect(event).toMatchObject({
      type: "verifier-run-finished",
      terminal: "incomplete",
    });
  });

  it("attributes a CLI error with a failed broker relay to provider transport", async () => {
    const f = await fixture([], {
      reason: "schema",
      reasonDetail: "unadmitted-event-type:error",
      brokerMetrics: {
        forwardedRequests: 2,
        requestLimitExceeded: 0,
        unauthorizedRequests: 0,
        relayFailures: 1,
      },
    });
    await expect(
      f.verifier.attempt({
        campaignId: "campaign-1",
        finding: f.finding,
        lab: f.lab,
      }),
    ).rejects.toMatchObject({ reason: "provider" });
    const event = f.ledger.read({ type: "verifier-run-finished" }).at(0)?.event;
    expect(event).toMatchObject({
      type: "verifier-run-finished",
      terminal: "incomplete",
    });
    if (event?.type !== "verifier-run-finished") throw new Error("Missing run");
    const saved = await f.store.readFile(
      event.receiptDigest,
      "receipt.json",
      4096,
    );
    expect(saved.status).toBe("resolved");
    if (saved.status !== "resolved") throw new Error("Missing receipt");
    expect(JSON.parse(saved.bytes.toString("utf8"))).toMatchObject({
      reason: "schema",
      reasonDetail: "unadmitted-event-type:error",
      brokerMetrics: { relayFailures: 1 },
    });
  });

  it("keeps an unadmitted CLI error without broker relay evidence incomplete as recipe", async () => {
    const f = await fixture([], {
      reason: "schema",
      reasonDetail: "unadmitted-event-type:error",
    });
    await expect(
      f.verifier.attempt({
        campaignId: "campaign-1",
        finding: f.finding,
        lab: f.lab,
      }),
    ).resolves.toMatchObject({ status: "incomplete", reason: "recipe" });
  });
});
