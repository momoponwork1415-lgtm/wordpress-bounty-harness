import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import { httpCapture } from "../../../src/lab/capture.js";
import { admitWordPressFinding } from "../../../src/profiles/wordpress/discovery/finding.js";
import type {
  LabMailRead,
  WordPressLabHandle,
} from "../../../src/profiles/wordpress/lab/index.js";
import {
  createWordPressAttemptObserver,
  LAB_MAIL_FILE,
} from "../../../src/profiles/wordpress/verification/attempt-observer.js";

const digest = `sha256:${"a".repeat(64)}`;
const handle: WordPressLabHandle = {
  id: "lab-1",
  snapshotDigest: digest,
  setupDigest: digest,
  endpoint: "http://wordpress",
  networkName: "wbh-lab-net",
  internalIp: "172.20.0.2",
  recorderIp: "172.20.0.4",
  attackerAccounts: {
    subscriber: { username: "lab-subscriber", password: "fixture-placeholder" },
  },
};
const CAPTURE = `{"request":{"method":"GET","path":"/","headers":{},"body":"","bodyBase64":"","truncated":false},"response":{"statusCode":200,"headers":{},"body":"ok","bodyBase64":"b2s=","truncated":false}}\n`;
const finding = admitWordPressFinding(
  {
    claim: "A synthetic reset link reaches the attacker",
    attackerPosition: "unauthenticated",
    impact: "account-takeover",
    configurationPrecondition: "none",
    brokenProperty: "The reset key is sent to an attacker-chosen address",
    sourceTrace: [{ file: "plugin.php", function: "reset", line: 3 }],
    existingControls: "none",
    labObservations: "none",
  },
  {
    runId: "discovery-1",
    snapshotDigest: digest,
    reportArtifactDigest: digest,
  },
);

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function observe(mail: LabMailRead | undefined) {
  const root = await mkdtemp(join(tmpdir(), "wbh-observer-mail-"));
  directories.push(root);
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 20,
    maxBytes: 1024 * 1024,
  });
  const recipeDigest = await store.putFiles({
    "capture-marker.json": canonicalJson({ marker: "0" }),
  });
  const observer = createWordPressAttemptObserver({
    store,
    lab: {
      readCapture: async () => ({
        status: "captured" as const,
        ...httpCapture(Buffer.from(CAPTURE), 0),
      }),
      observeVictimPages: async () => ({
        status: "unavailable" as const,
        phase: "victim-page" as const,
      }),
      ...(mail === undefined ? {} : { readMail: async () => mail }),
    },
  });
  const result = await observer.observe({ finding, lab: handle, recipeDigest });
  if (result.status !== "recorded") throw new Error("not recorded");
  return { store, evidenceDigest: result.evidenceDigest };
}

describe("captured Lab mail in Private Evidence (#805)", () => {
  it("keeps every recipient's message beside the HTTP capture, under the evidence digest", async () => {
    const message = {
      id: "m1",
      receivedAt: "2026-11-03T00:00:00.000Z",
      from: { name: "WordPress", address: "wordpress@wordpress.invalid" },
      to: [{ name: "", address: "harness-admin@example.invalid" }],
      cc: [],
      bcc: [{ name: "", address: "me@attacker.invalid" }],
      replyTo: [],
      subject: "Password reset",
      text: "synthetic body",
      html: "",
    };
    const { store, evidenceDigest } = await observe({
      status: "captured",
      messages: [message],
    });
    const file = await store.readFile(evidenceDigest, LAB_MAIL_FILE, 65_536);
    expect(file.status).toBe("resolved");
    if (file.status !== "resolved") return;
    expect(JSON.parse(file.bytes.toString("utf8"))).toEqual({
      schemaVersion: 1,
      status: "captured",
      messages: [message],
    });
  });

  it("says the sink could not be read, and adds nothing when the Lab has none", async () => {
    const unread = await observe({ status: "unavailable" });
    const file = await unread.store.readFile(
      unread.evidenceDigest,
      LAB_MAIL_FILE,
      65_536,
    );
    expect(
      file.status === "resolved" && JSON.parse(file.bytes.toString("utf8")),
    ).toEqual({ schemaVersion: 1, status: "unavailable", messages: [] });

    for (const absent of [{ status: "absent" } as const, undefined]) {
      const none = await observe(absent);
      expect(
        (await none.store.readFile(none.evidenceDigest, LAB_MAIL_FILE, 65_536))
          .status,
      ).not.toBe("resolved");
    }
  });
});
