import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import { httpCapture } from "../../../src/lab/capture.js";
import { Ledger } from "../../../src/ledger/index.js";
import {
  admitWordPressFinding,
  readWordPressFinding,
} from "../../../src/profiles/wordpress/discovery/finding.js";
import { createWordPressJudges } from "../../../src/profiles/wordpress/verification/judges.js";
import { wordpressReproductionRenderer } from "../../../src/profiles/wordpress/verification/reproduction-package.js";
import { createWordPressVerifierRecordReader } from "../../../src/profiles/wordpress/verification/verifier-record.js";
import { WordPressVerifier } from "../../../src/profiles/wordpress/verification/wordpress-verifier.js";
import { exportReviewBundle, Review } from "../../../src/review/index.js";
import { Verification } from "../../../src/verification/index.js";
import {
  handle,
  quietLab,
  setupDigest,
  snapshotDigest,
} from "./judge-fixture.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function evidenceStore() {
  const root = await mkdtemp(join(tmpdir(), "wbh-review-observations-"));
  directories.push(root);
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 20,
    maxBytes: 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: store,
  });
  return { store, ledger };
}

const QUERY_VALUE = "victim-query-sentinel";
const STEPS = "Steps sentinel: posted the canary, declared the victim page";
/** One attacker POST as the Lab recorder writes it. */
const CAPTURE = `{"request":{"method":"POST","path":"/synthetic","headers":{"cookie":"wordpress_logged_in_fixture=attacker-session"},"body":"v=1","bodyBase64":"dj0x","truncated":false},"response":{"statusCode":200,"headers":{},"body":"saved","bodyBase64":"c2F2ZWQ=","truncated":false}}\n`;
/** The six files a handoff skill leaves; the victim page carries a query value. */
const FILES = {
  "http.json": `{"exchanges":[{"request":{"method":"POST","path":"/synthetic"},"response":{"body":"saved"}}]}`,
  "steps.md": STEPS,
  "route.json": `{"role":"subscriber","defaultSettings":true,"steps":[{"kind":"http","method":"POST","path":"/synthetic","body":"v=1","expected":"saved"}],"victim":{"role":"administrator","paths":[{"path":"/wp-admin/admin.php?page=${QUERY_VALUE}","actions":[{"kind":"click","selector":"#open"}]}]}}`,
  "session.json": "",
  "refutation.md": "",
  precondition: "",
};

describe("an incomplete judge result keeps its observations in review (#437)", () => {
  it("queues the Finding and exports the Verifier's steps and the victim visit", async () => {
    const { store, ledger } = await evidenceStore();
    const finding = admitWordPressFinding(
      {
        claim: "A subscriber stores a script an administrator screen renders",
        attackerPosition: "subscriber",
        impact: "stored-xss",
        configurationPrecondition: "default",
        brokenProperty: "Stored text is rendered unescaped",
        sourceTrace: [{ file: "plugin.php", function: "render", line: 3 }],
        existingControls: "none",
        labObservations: "none",
      },
      { runId: "run-1", snapshotDigest, reportArtifactDigest: setupDigest },
    );
    const findingDigest = await store.putFiles({
      "finding.json": canonicalJson(finding),
    });
    await ledger.append({
      schemaVersion: 1,
      identity: "finding",
      campaignId: "campaign-1",
      snapshotDigest,
      occurredAt: "2026-10-21T00:00:00Z",
      type: "finding-recorded",
      findingId: finding.findingId,
      runId: "run-1",
      category: "stored-xss",
      artifacts: [{ kind: "finding", digest: findingDigest }],
    });
    // The Lab browser opened the declared page; no beacon reached the receiver.
    const lab = {
      ...quietLab({
        readCapture: async () => ({
          status: "captured" as const,
          ...httpCapture(Buffer.from(CAPTURE), 0),
        }),
        observeSessionUser: async () => ({
          status: "user",
          login: "lab-subscriber",
        }),
        observeStoredScript: async () => ({
          status: "observed",
          contexts: [],
          screenshot: Buffer.from("synthetic screen"),
        }),
      }),
      prepareExecutionCanary: () => null,
      prepareScriptCanary: () => ({
        nonce: "synthetic-nonce",
        beaconUrl: "http://receiver/beacon",
        javascript: "/* synthetic */",
        loaderJavascript: "/* synthetic */",
      }),
      markCapture: async () => "0",
      finishSetup: async () => true,
    };
    const clock = () => new Date("2026-10-21T01:00:00Z");
    const verifier = new WordPressVerifier({
      // The handoff's shape: setup closes, then the six files arrive.
      transport: {
        preconditionSetup: "transport",
        async run(input) {
          expect(await input.restartObservation()).toBe(true);
          const receipt = { digest: setupDigest, runId: input.runId };
          return {
            promptDigest: setupDigest,
            receipt: {
              ...receipt,
              targetSnapshotDigest: snapshotDigest,
              terminal: "completed",
            },
            outcome: { status: "files", files: FILES },
          };
        },
      },
      ...{ store, ledger, lab, clock },
    });
    const result = await new Verification({
      ledger,
      store,
      lab: {
        provision: async () => ({ status: "ready" as const, handle }),
        seedCanaries: async () => ({ status: "seeded", digest: setupDigest }),
        teardown: async () => ({ status: "removed" }),
      },
      judges: createWordPressJudges({ store, lab }),
      readFinding: readWordPressFinding,
      renderer: wordpressReproductionRenderer,
      verifier,
      clock,
    }).verify({
      campaignId: "campaign-1",
      findingId: finding.findingId,
      verificationId: "verification-1",
      snapshot: { digest: snapshotDigest },
      setup: {},
      campaignLabSetupDigest: setupDigest,
      reconstruction: {} as never,
    });
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "observation",
    });

    const queue = new Review({
      ledger,
      artifactStore: store,
      scopeEvaluator: {
        programmeIds: ["wordfence"],
        policyDigest: setupDigest,
        assess: async () => [],
      },
      factsProvider: { load: async () => ({}) },
      clock,
    }).queue({ campaignId: "campaign-1" });
    expect(queue.items).toMatchObject([
      { status: "incomplete", ref: { findingId: finding.findingId } },
    ]);

    const bundle = await exportReviewBundle({
      ...{ ledger, store, campaignId: "campaign-1" },
      findingId: finding.findingId,
      verifierRecord: createWordPressVerifierRecordReader({ store }),
    });
    expect(bundle.verification).toMatchObject({ status: "incomplete" });
    expect(bundle.observations).toEqual({
      steps: {
        path: expect.stringMatching(/\/content\/steps\.md$/),
        digest: `sha256:${createHash("sha256").update(STEPS).digest("hex")}`,
      },
      victim: {
        role: "administrator",
        pages: [
          { path: "/wp-admin/admin.php", queryKeys: ["page"], actions: 1 },
        ],
        firing: "not-observed",
        record: {
          path: expect.stringMatching(/\/content\/canary-observation\.json$/),
          digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        screenshot: expect.stringMatching(/victim-screen-diagnostic\.png$/),
      },
    });
    const serialized = canonicalJson(bundle);
    expect(serialized).not.toContain(QUERY_VALUE);
    expect(serialized).not.toContain(STEPS);
  });
});

describe("WordPress verifier record reader (#437)", () => {
  const observer = (record: object) =>
    canonicalJson({ judgeId: "wordpress-stored-script", ...record });
  it.each([
    [
      { "canary-observation.json": observer({ observedVia: "canary-beacon" }) },
      "observed",
    ],
    [{ "observer-diagnostic.json": observer({ phase: "x" }) }, "visit-failed"],
    [{ "canary-observation.json": '{"judgeId":"other"}' }, "not-recorded"],
  ] as const)(
    "copies the observer's record %j as %s",
    async (files, firing) => {
      const { store } = await evidenceStore();
      const reader = createWordPressVerifierRecordReader({ store });
      const recipeDigest = await store.putFiles({
        "route.json": '{"victim":{"role":"unauthenticated","paths":["/?p=7"]}}',
      });
      const evidenceDigest = await store.putFiles({
        ...files,
        "victim-screen.png": "screen",
      });
      const name = firing === "not-recorded" ? null : Object.keys(files)[0]!;
      const at = (file: string) =>
        join(store.contentPath(evidenceDigest), file);
      expect(await reader.read({ recipeDigest, evidenceDigest })).toMatchObject(
        {
          steps: null,
          victim: {
            role: "unauthenticated",
            pages: [{ address: "/?p=7", actions: 0 }],
            firing,
            record: name === null ? null : { path: at(name) },
            screenshot: firing === "observed" ? at("victim-screen.png") : null,
          },
        },
      );
      // A route without a victim has no victim side to report.
      const plain = await store.putFiles({
        "route.json": "{}",
        "steps.md": "x",
      });
      expect(
        await reader.read({ recipeDigest: plain, evidenceDigest }),
      ).toMatchObject({ steps: { path: expect.any(String) }, victim: null });
    },
  );
});
