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
import type { WordPressLabHandle } from "../../../src/profiles/wordpress/lab/index.js";
import { createWordPressAttemptObserver } from "../../../src/profiles/wordpress/verification/attempt-observer.js";
import { createWordPressVerifierRecordReader } from "../../../src/profiles/wordpress/verification/verifier-record.js";
import { WordPressVerifier } from "../../../src/profiles/wordpress/verification/wordpress-verifier.js";
import { exportReviewBundle, Review } from "../../../src/review/index.js";
import { Verification } from "../../../src/verification/index.js";

const snapshotDigest = `sha256:${"a".repeat(64)}`;
const setupDigest = `sha256:${"b".repeat(64)}`;
const handle: WordPressLabHandle = {
  id: "lab-1",
  snapshotDigest,
  setupDigest,
  endpoint: "http://wordpress",
  networkName: "wbh-lab-net",
  internalIp: "172.20.0.2",
  recorderIp: "172.20.0.4",
  attackerAccounts: {
    subscriber: { username: "lab-subscriber", password: "lab-only" },
  },
};

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
const STEPS = "Steps sentinel: posted the script, declared the victim page";
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

describe("a result awaiting a human observation keeps its records in review (#437, #525)", () => {
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
    // The Lab browser opened the declared page; no dialog was shown.
    const lab = {
      readCapture: async () => ({
        status: "captured" as const,
        ...httpCapture(Buffer.from(CAPTURE), 0),
      }),
      observeVictimPages: async () => ({
        status: "observed" as const,
        victimRole: "administrator" as const,
        screenshot: Buffer.from("synthetic screen"),
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
        teardown: async () => ({ status: "removed" }),
      },
      observer: createWordPressAttemptObserver({ store, lab }),
      readFinding: readWordPressFinding,
      verifier,
      clock,
    }).verify({
      campaignId: "campaign-1",
      findingId: finding.findingId,
      verificationId: "verification-1",
      snapshot: { digest: snapshotDigest },
      setup: {},
      campaignLabSetupDigest: setupDigest,
    });
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "awaiting-human-observation",
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
          path: expect.stringMatching(
            /\/content\/lab-browser-observation\.json$/,
          ),
          digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        screenshot: expect.stringMatching(/victim-screen\.png$/),
      },
    });
    const serialized = canonicalJson(bundle);
    expect(serialized).not.toContain(QUERY_VALUE);
    expect(serialized).not.toContain(STEPS);
  });
});

describe("WordPress verifier record reader (#437)", () => {
  it("reads the Lab browser's dialog record without a judge (#525)", async () => {
    const { store } = await evidenceStore();
    const reader = createWordPressVerifierRecordReader({ store });
    const recipeDigest = await store.putFiles({
      "route.json":
        '{"victim":{"role":"administrator","paths":["/wp-admin/"],"dialogMarker":"7381930362"}}',
    });
    const event = {
      type: "alert",
      message: "7381930362",
      topLevelPageUrlAtEvent: "http://wordpress/wp-admin/",
      topLevelPageOriginAtEvent: "http://wordpress",
      frameUrlsAtEvent: ["http://wordpress/wp-admin/"],
    };
    const evidenceDigest = await store.putFiles({
      "lab-browser-observation.json": canonicalJson({
        schemaVersion: 1,
        observerId: "wordpress-lab-browser",
        snapshotDigest,
        labSetupDigest: setupDigest,
        status: "visited",
        victimRole: "administrator",
        visits: 1,
        dialog: { marker: "7381930362", visitIndex: 0, event },
      }),
      "victim-page-after-dialog.png": "synthetic screenshot",
    });
    const result = await reader.read({ recipeDigest, evidenceDigest });
    expect(result.victim).toMatchObject({
      role: "administrator",
      firing: "observed",
      record: {
        path: expect.stringMatching(/lab-browser-observation\.json$/),
      },
      screenshot: expect.stringMatching(/victim-page-after-dialog\.png$/),
    });
    expect(result.victim).not.toHaveProperty("browserSignal");
  });

  const observer = (record: object) =>
    canonicalJson({ judgeId: "wordpress-stored-script", ...record });
  it("exports a browser dialog signal separately from canary firing", async () => {
    const { store } = await evidenceStore();
    const reader = createWordPressVerifierRecordReader({ store });
    const recipeDigest = await store.putFiles({
      "route.json":
        '{"victim":{"role":"administrator","paths":["/wp-admin/"],"dialogMarker":"7381930362"}}',
    });
    const evidenceDigest = await store.putFiles({
      "browser-dialog-observation.json": observer({
        kind: "numeric-dialog",
        status: "dialog-observed",
        marker: "7381930362",
        dialogEvent: {
          type: "alert",
          message: "7381930362",
          topLevelPageUrlAtEvent: "http://wordpress/wp-admin/",
          topLevelPageOriginAtEvent: "http://wordpress",
          frameUrlsAtEvent: ["http://wordpress/wp-admin/"],
        },
        capturedAttackerRequestMarkerMatch: true,
        verificationSequence: "post-setup-request-before-victim-visit",
        requiresHumanPreexistingContentCheck: true,
        victimRole: "administrator",
        victimPrincipal: "separate",
        snapshotDigest: `sha256:${"1".repeat(64)}`,
        labSetupDigest: `sha256:${"2".repeat(64)}`,
      }),
      "victim-page-after-dialog.png": "synthetic screenshot",
    });
    const result = await reader.read({ recipeDigest, evidenceDigest });
    expect(result.victim).toMatchObject({
      firing: "not-recorded",
      screenshot: null,
      browserSignal: {
        kind: "numeric-dialog",
        status: "dialog-observed",
        capturedAttackerRequestMarkerMatch: true,
        verificationSequence: "post-setup-request-before-victim-visit",
        victimPrincipal: "separate",
        record: {
          path: expect.stringMatching(/browser-dialog-observation\.json$/),
        },
        pageAfterDialogScreenshot: expect.stringMatching(
          /victim-page-after-dialog\.png$/,
        ),
      },
    });
  });
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
