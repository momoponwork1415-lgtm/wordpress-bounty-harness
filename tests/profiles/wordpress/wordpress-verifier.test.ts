import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../../src/ledger/index.js";
import {
  admitWordPressFinding,
  type WordPressFinding,
} from "../../../src/profiles/wordpress/discovery/finding.js";
import type { WordPressLabHandle } from "../../../src/profiles/wordpress/lab/index.js";
import {
  WordPressVerifier,
  type WordPressVerifierRun,
  type WordPressVerifierTransportResult,
} from "../../../src/profiles/wordpress/verification/wordpress-verifier.js";
import type { RecordedFinding } from "../../../src/verification/index.js";

const digest = `sha256:${"a".repeat(64)}`;
const receiptDigest = `sha256:${"b".repeat(64)}`;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

type Outcome = WordPressVerifierTransportResult["outcome"];

/**
 * A transport that only returns what it is told: the shape a handoff adapter
 * (#352) or any other non-Codex transport would take.
 */
async function fixture(options: {
  readonly impact?: WordPressFinding["impact"];
  readonly attackerPosition?: WordPressFinding["attackerPosition"];
  readonly configurationPrecondition?: string;
  readonly setupPreconditions?: boolean;
  readonly outcome?: Outcome;
  readonly receiptRunId?: string;
  readonly captureMarker?: string | null;
  readonly setupCloses?: boolean;
}) {
  const root = await mkdtemp(join(tmpdir(), "wbh-wordpress-verifier-"));
  roots.push(root);
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 12,
    maxBytes: 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: store,
  });
  const finding = admitWordPressFinding(
    {
      claim: "A synthetic access rule is missing",
      attackerPosition: options.attackerPosition ?? "subscriber",
      impact: options.impact ?? "account-takeover",
      configurationPrecondition: options.configurationPrecondition ?? "default",
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
  const record = ledger
    .read({ campaignId: "campaign-1", type: "finding-recorded", limit: 1 })
    .at(0)?.event as RecordedFinding;
  const runs: WordPressVerifierRun[] = [];
  const verifier = new WordPressVerifier({
    transport: {
      ...(options.setupPreconditions
        ? { preconditionSetup: "transport" as const }
        : {}),
      async run(input) {
        runs.push(input);
        if (options.setupPreconditions) await input.restartObservation();
        return {
          promptDigest: digest,
          receipt: {
            digest: receiptDigest,
            runId: options.receiptRunId ?? input.runId,
            targetSnapshotDigest: input.finding.snapshotDigest,
            terminal:
              options.outcome?.status === "transport-failed"
                ? "incomplete"
                : "completed",
          },
          outcome: options.outcome ?? {
            status: "files",
            files: {
              "http.json": JSON.stringify({
                exchanges: [{ request: {}, response: { body: "ordinary" } }],
              }),
              "steps.md": "Step",
            },
          },
        };
      },
    },
    lab: {
      markCapture: async () => options.captureMarker ?? "7",
      finishSetup: async () => options.setupCloses ?? true,
    },
    store,
    ledger,
    clock: () => new Date("2026-10-08T00:00:00Z"),
  });
  const lab: WordPressLabHandle = {
    id: "lab-1",
    snapshotDigest: digest,
    setupDigest: digest,
    endpoint: "http://wordpress",
    networkName: "lab-internal",
    internalIp: "172.20.0.2",
    recorderIp: "172.20.0.4",
    database: {
      host: "database",
      ipv4: "172.20.0.3",
      port: 3306,
      name: "wordpress",
      readOnlyAccount: { username: "wbh_reader", password: "fixture_only" },
    },
    attackerAccounts: {
      subscriber: { username: "subscriber", password: "subscriber-secret" },
      customer: { username: "customer", password: "customer-secret" },
      // An untyped handle may carry more; the transport must never see it.
      ...({
        administrator: { username: "administrator", password: "admin-secret" },
      } as object),
    },
  };
  const attempt = (overrides: Partial<{ lab: WordPressLabHandle }> = {}) =>
    verifier.attempt({
      campaignId: "campaign-1",
      finding,
      lab: overrides.lab ?? lab,
      record,
    });
  return { verifier, finding, lab, record, runs, store, ledger, attempt };
}

describe("WordPressVerifier.attempt with a non-Codex transport", () => {
  it("gives the transport a named-field Lab view with low-privilege accounts and no canary (#525)", async () => {
    const f = await fixture({ impact: "stored-xss" });
    const attempt = await f.attempt();
    expect(attempt.status).toBe("attempted");
    expect(f.runs).toHaveLength(1);
    const run = f.runs[0]!;
    expect(run.runId).toMatch(new RegExp(`^verify-${f.finding.findingId}-`));
    expect(run.finding).toEqual(f.finding);
    expect(Object.keys(run.lab).sort()).toEqual([
      "attackerAccounts",
      "database",
      "endpoint",
      "id",
      "internalIp",
      "networkName",
      "recorderIp",
      "setupDigest",
      "snapshotDigest",
    ]);
    expect(run.lab.attackerAccounts).toEqual({
      subscriber: { username: "subscriber", password: "subscriber-secret" },
      customer: { username: "customer", password: "customer-secret" },
    });
    expect(JSON.stringify(run)).not.toContain("admin-secret");
    expect(run).not.toHaveProperty("canary");
    expect(run.referenceRoute).toBeUndefined();
    expect(
      f.ledger.read({ type: "verifier-run-finished" }).at(0)?.event,
    ).toMatchObject({
      findingId: f.finding.findingId,
      runId: run.runId,
      promptDigest: digest,
      terminal: "completed",
    });
    expect(
      f.ledger.read({ type: "verifier-run-finished" }).at(0)?.event,
    ).not.toHaveProperty("canaryIssued");
  });

  it("withholds the database from a sensitive-object transport only", async () => {
    const sensitive = await fixture({ impact: "sensitive-object-access" });
    await sensitive.attempt();
    expect(sensitive.runs[0]?.lab.database).toBeUndefined();
    const sqli = await fixture({ impact: "sqli" });
    await sqli.attempt();
    expect(sqli.runs[0]?.lab.database).toMatchObject({ host: "database" });
  });

  it.each(["rce", "account-takeover"] as const)(
    "runs a %s transport without waiting for a canary (#525)",
    async (impact) => {
      const f = await fixture({ impact });
      expect(await f.attempt()).toMatchObject({ status: "attempted" });
      expect(f.runs).toHaveLength(1);
      expect(f.runs[0]).not.toHaveProperty("canary");
    },
  );

  it("lets a setup-capable transport handle an ordinary missing Lab scenario", async () => {
    const f = await fixture({
      impact: "stored-xss",
      setupPreconditions: true,
      configurationPrecondition:
        "A public form is placed on a published page with default settings.",
    });
    expect(await f.attempt()).toMatchObject({ status: "attempted" });
    expect(f.runs).toHaveLength(1);
    expect(f.ledger.read({ type: "verifier-run-finished" })).toHaveLength(1);
    expect(f.ledger.read({ type: "finding-parked" })).toHaveLength(0);
  });

  it("marks a closed setup in the recipe and refuses files from an unclosed one (#430)", async () => {
    const closed = await fixture({
      impact: "stored-xss",
      setupPreconditions: true,
    });
    const attempt = await closed.attempt();
    if (attempt.status !== "attempted") throw new Error("not attempted");
    expect(
      await closed.store.readFile(
        attempt.recipeDigest,
        "setup-boundary.json",
        4096,
      ),
    ).toMatchObject({ status: "resolved" });
    const unclosed = await fixture({
      impact: "stored-xss",
      setupPreconditions: true,
      setupCloses: false,
    });
    expect(await unclosed.attempt()).toEqual({
      status: "incomplete",
      reason: "recipe",
      nextStep: "setup-not-closed",
    });
  });

  it("keeps the missing-scenario gate for a transport without setup capability", async () => {
    const f = await fixture({
      impact: "stored-xss",
      configurationPrecondition:
        "A public form is placed on a published page with default settings.",
    });
    expect(await f.attempt()).toMatchObject({
      status: "incomplete",
      reason: "precondition",
    });
    expect(f.runs).toHaveLength(0);
  });

  it("lets a setup-capable transport resolve an unclassified precondition", async () => {
    const f = await fixture({
      setupPreconditions: true,
      configurationPrecondition: "Ordinary setup described by the Finding.",
    });
    expect(await f.attempt()).toMatchObject({ status: "attempted" });
    expect(f.runs).toHaveLength(1);
  });

  it.each([false, true])(
    "passes an admin-configuration precondition to a setup-capable=%s transport",
    async (setupPreconditions) => {
      const f = await fixture({
        impact: "stored-xss",
        setupPreconditions,
        configurationPrecondition:
          "An administrator selects Password protected visibility for a published block.",
      });
      expect(await f.attempt()).toMatchObject({ status: "attempted" });
      expect(f.runs).toHaveLength(1);
      expect(f.ledger.read({ type: "finding-parked" })).toHaveLength(0);
      expect(
        f.ledger.read({ type: "finding-precondition-classified" })[0]?.event,
      ).toMatchObject({ preconditionClass: "admin-configuration" });
    },
  );

  it("records a precondition the transport's files disclose without parking the Finding", async () => {
    const privateDetail = "The ordinary setup is unavailable in this Lab.";
    const f = await fixture({
      setupPreconditions: true,
      outcome: {
        status: "files",
        files: {
          precondition: `The slider button Link is set to {author_name}. ${privateDetail}`,
        },
      },
    });
    const attempt = await f.attempt();
    expect(attempt).toMatchObject({
      status: "incomplete",
      reason: "precondition",
    });
    if (attempt.status !== "incomplete") return;
    expect(attempt.nextStep).toMatch(
      /^admin-configuration-precondition:sha256:[a-f0-9]{64}$/,
    );
    const evidenceDigest = attempt.nextStep.slice(
      "admin-configuration-precondition:".length,
    );
    const privateEvidence = await f.store.readFile(
      evidenceDigest,
      "precondition",
      4096,
    );
    expect(privateEvidence.status).toBe("resolved");
    if (privateEvidence.status === "resolved")
      expect(privateEvidence.bytes.toString("utf8")).toContain(privateDetail);
    expect(JSON.stringify(attempt)).not.toContain(privateDetail);
    expect(JSON.stringify(f.ledger.read({}))).not.toContain(privateDetail);
    expect(f.runs).toHaveLength(1);
    expect(f.ledger.read({ type: "verifier-run-finished" })).toHaveLength(1);
    expect(f.ledger.read({ type: "finding-parked" })).toHaveLength(0);
  });

  it("retains a handoff abort precondition privately and returns a whitelisted code with its digest", async () => {
    const privateDetail = "Private setup failure detail for this attempt";
    const f = await fixture({
      setupPreconditions: true,
      outcome: {
        status: "incomplete",
        nextStep: "handoff:precondition-unavailable",
        precondition: privateDetail,
      },
    });
    const attempt = await f.attempt();
    expect(attempt).toMatchObject({
      status: "incomplete",
      reason: "precondition",
    });
    if (attempt.status !== "incomplete") return;
    expect(attempt.nextStep).toMatch(
      /^abort-precondition-unavailable:sha256:[a-f0-9]{64}$/,
    );
    const evidenceDigest = attempt.nextStep.slice(
      "abort-precondition-unavailable:".length,
    );
    const privateEvidence = await f.store.readFile(
      evidenceDigest,
      "precondition",
      4096,
    );
    expect(privateEvidence.status).toBe("resolved");
    if (privateEvidence.status === "resolved")
      expect(privateEvidence.bytes.toString("utf8")).toBe(privateDetail);
    expect(JSON.stringify(attempt)).not.toContain(privateDetail);
    expect(JSON.stringify(f.ledger.read({}))).not.toContain(privateDetail);
  });

  it("keeps an unknown handoff diagnostic private", async () => {
    const privateDetail = "Private transport diagnostic for this attempt";
    const f = await fixture({
      setupPreconditions: true,
      outcome: { status: "incomplete", nextStep: privateDetail },
    });
    const attempt = await f.attempt();
    expect(attempt).toMatchObject({ status: "incomplete", reason: "recipe" });
    if (attempt.status !== "incomplete") return;
    expect(attempt.nextStep).toMatch(
      /^handoff-incomplete:sha256:[a-f0-9]{64}$/,
    );
    const evidenceDigest = attempt.nextStep.slice("handoff-incomplete:".length);
    const privateEvidence = await f.store.readFile(
      evidenceDigest,
      "transport-detail.txt",
      4096,
    );
    expect(privateEvidence.status).toBe("resolved");
    if (privateEvidence.status === "resolved")
      expect(privateEvidence.bytes.toString("utf8")).toBe(privateDetail);
    expect(JSON.stringify(attempt)).not.toContain(privateDetail);
    expect(JSON.stringify(f.ledger.read({}))).not.toContain(privateDetail);
  });

  it("records the run, then raises a transport failure with the transport's own reason", async () => {
    const f = await fixture({
      outcome: { status: "transport-failed", reason: "sandbox" },
    });
    await expect(f.attempt()).rejects.toMatchObject({ reason: "sandbox" });
    expect(
      f.ledger.read({ type: "verifier-run-finished" }).at(0)?.event,
    ).toMatchObject({ terminal: "incomplete" });
  });

  it("passes a transport's incomplete step through as a recipe failure", async () => {
    const f = await fixture({
      outcome: { status: "incomplete", nextStep: "Recover the files" },
    });
    expect(await f.attempt()).toEqual({
      status: "incomplete",
      reason: "recipe",
      nextStep: "Recover the files",
    });
    expect(f.ledger.read({ type: "verifier-run-finished" })).toHaveLength(1);
  });

  it("refuses a receipt that names another run", async () => {
    const f = await fixture({ receiptRunId: "verify-other" });
    await expect(f.attempt()).rejects.toThrow(
      "Verifier receipt does not match its run",
    );
    expect(f.ledger.read({ type: "verifier-run-finished" })).toHaveLength(0);
  });

  it("assembles the private recipe from the transport's files", async () => {
    const f = await fixture({
      outcome: {
        status: "files",
        files: {
          "http.json": JSON.stringify({
            exchanges: [
              {
                request: { method: "GET", url: "http://wordpress/synthetic" },
                response: {
                  body: "ordinary",
                  headers: {
                    "set-cookie":
                      "wordpress_logged_in_x=example%7Ctoken; Path=/",
                  },
                },
              },
            ],
          }),
          "steps.md": "Synthetic steps",
          "route.json": JSON.stringify({
            role: "subscriber",
            defaultSettings: true,
          }),
          "refutation.md": "The claimed object is absent",
        },
      },
    });
    const attempt = await f.attempt();
    expect(attempt.status).toBe("attempted");
    if (attempt.status !== "attempted") return;
    const read = async (name: string) =>
      f.store.readFile(attempt.recipeDigest, name, 4096);
    expect((await read("http.json")).status).toBe("resolved");
    expect((await read("steps.md")).status).toBe("resolved");
    const marker = await read("capture-marker.json");
    if (marker.status !== "resolved") throw new Error("marker missing");
    expect(JSON.parse(marker.bytes.toString("utf8"))).toEqual({ marker: "7" });
    const route = await read("route.json");
    if (route.status !== "resolved") throw new Error("route missing");
    expect(JSON.parse(route.bytes.toString("utf8"))).toEqual({
      role: "subscriber",
      account: "subscriber",
      defaultSettings: true,
      configurationChanges: [],
      steps: [
        {
          kind: "http",
          method: "GET",
          path: "/synthetic",
          expected: "Observe the response recorded in http.json",
        },
      ],
    });
    const session = await read("session.json");
    if (session.status !== "resolved") throw new Error("session missing");
    expect(JSON.parse(session.bytes.toString("utf8"))).toEqual({
      cookie: "example%7Ctoken",
    });
    expect((await read("refutation.md")).status).toBe("missing");
    expect(attempt.refutationDigest).toMatch(/^sha256:/);
  });

  it.each(["unauthenticated", "subscriber", "customer"] as const)(
    "accepts an empty session file for a %s route without inferring a cookie",
    async (attackerPosition) => {
      const f = await fixture({
        impact: "stored-xss",
        attackerPosition,
        outcome: {
          status: "files",
          files: {
            "http.json": JSON.stringify({
              exchanges: [
                {
                  request: { method: "GET", path: "/" },
                  response: {
                    body: "ordinary",
                    headers: {
                      "set-cookie": "wordpress_logged_in_x=unrelated; Path=/",
                    },
                  },
                },
              ],
            }),
            "steps.md": "Visit the page",
            "route.json": JSON.stringify({
              role: attackerPosition,
              defaultSettings: true,
            }),
            "session.json": "",
            "refutation.md": "",
            precondition: "",
          },
        },
      });
      const attempt = await f.attempt();
      expect(attempt.status).toBe("attempted");
      if (attempt.status !== "attempted") return;
      expect(
        await f.store.readFile(attempt.recipeDigest, "session.json", 4096),
      ).toMatchObject({ status: "missing" });
    },
  );

  it("rejects a malformed nonempty session file for an authenticated route", async () => {
    const f = await fixture({
      outcome: {
        status: "files",
        files: {
          "http.json": JSON.stringify({
            exchanges: [
              {
                request: { method: "GET", path: "/" },
                response: { body: "ordinary" },
              },
            ],
          }),
          "steps.md": "Visit the page",
          "route.json": JSON.stringify({
            role: "subscriber",
            defaultSettings: true,
          }),
          "session.json": "not-json",
          "refutation.md": "",
          precondition: "",
        },
      },
    });
    expect(await f.attempt()).toMatchObject({
      status: "incomplete",
      reason: "recipe",
      nextStep: "Repair the session.json cookie record, then repeat",
    });
  });

  it("keeps a route whose role differs from the Finding incomplete as recipe", async () => {
    const f = await fixture({
      outcome: {
        status: "files",
        files: {
          "http.json": JSON.stringify({
            exchanges: [{ request: {}, response: { body: "ordinary" } }],
          }),
          "steps.md": "Step",
          "route.json": JSON.stringify({
            role: "unauthenticated",
            defaultSettings: true,
          }),
        },
      },
    });
    expect(await f.attempt()).toMatchObject({
      status: "incomplete",
      reason: "recipe",
    });
  });

  it("does not run a transport for a Lab from another snapshot", async () => {
    const f = await fixture({});
    expect(
      await f.attempt({
        lab: { ...f.lab, snapshotDigest: `sha256:${"c".repeat(64)}` },
      }),
    ).toMatchObject({ status: "incomplete", reason: "precondition" });
    expect(f.runs).toHaveLength(0);
  });
});
