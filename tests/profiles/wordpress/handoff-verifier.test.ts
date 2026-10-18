import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { admitWordPressFinding } from "../../../src/profiles/wordpress/discovery/finding.js";
import type { WordPressLabHandle } from "../../../src/profiles/wordpress/lab/index.js";
import {
  HandoffVerifier,
  WBH_VERIFY_SKILL_ID,
} from "../../../src/profiles/wordpress/verification/handoff-verifier.js";
import {
  WORDPRESS_VERIFIER_FILE_NAMES,
  type WordPressVerifierRun,
} from "../../../src/profiles/wordpress/verification/wordpress-verifier.js";

const digest = `sha256:${"a".repeat(64)}`;
const SKILL_PATH = new URL(
  "../../../.claude/skills/wbh-verify/SKILL.md",
  import.meta.url,
);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function until(condition: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition not met in time");
    await sleep(5);
  }
}

/** A fake Lab that records the host exposure calls; the directory is the real handoff. */
async function fixture(options: {
  readonly administrator?: null;
  readonly wallTimeMs?: number;
  readonly clock?: () => Date;
}) {
  const root = await mkdtemp(join(tmpdir(), "wbh-handoff-verifier-"));
  roots.push(root);
  const directory = join(root, "handoff");
  const finding = admitWordPressFinding(
    {
      claim: "A synthetic stored script reaches an administrator screen",
      attackerPosition: "unauthenticated",
      impact: "stored-xss",
      configurationPrecondition: "A form exists on a public page",
      brokenProperty: "Submitted text is rendered unescaped",
      sourceTrace: [{ file: "plugin.php", function: "render", line: 12 }],
      existingControls: "none",
      labObservations: "none",
    },
    {
      runId: "discovery-1",
      snapshotDigest: digest,
      reportArtifactDigest: digest,
    },
  );
  const handle: WordPressLabHandle = {
    id: "lab-1",
    snapshotDigest: digest,
    setupDigest: digest,
    endpoint: "http://wordpress.lab",
    networkName: "wbh-lab-1-net",
    internalIp: "172.20.0.2",
    recorderIp: "172.20.0.4",
    attackerAccounts: {
      subscriber: { username: "sub", password: "sub-pass" },
    },
  };
  const calls: unknown[] = [];
  let restarts = 0;
  const transport = new HandoffVerifier({
    directory,
    handle,
    lab: {
      async exposeToHost(_handle, input) {
        calls.push(["expose", input]);
        return {
          status: "exposed",
          container: "wbh-lab-1-host",
          httpPort: input.httpPort,
          databasePort: null,
        };
      },
      async withdrawFromHost() {
        calls.push(["withdraw"]);
        return true;
      },
      reviewAdministrator: () =>
        options.administrator === null
          ? null
          : { username: "harness-admin", password: "admin-pass" },
    },
    ports: { http: 8080, database: 3307 },
    reviewExport: async () => '{"schema":"review-export/v1"}',
    clock: options.clock ?? (() => new Date("2026-10-18T00:00:00Z")),
    wallTimeMs: options.wallTimeMs ?? 60_000,
    pollIntervalMs: 5,
  });
  const run: WordPressVerifierRun = {
    runId: "verify-1",
    finding,
    lab: {
      id: handle.id,
      snapshotDigest: digest,
      setupDigest: digest,
      endpoint: handle.endpoint,
      networkName: handle.networkName,
      internalIp: handle.internalIp,
      recorderIp: handle.recorderIp,
      attackerAccounts: handle.attackerAccounts,
    },
    canary: {
      kind: "script",
      beaconUrl: "http://canary/b/n",
      javascript: "fetch('http://canary/b/n')",
      loaderJavascript: "import('http://canary/l/n')",
    },
    restartObservation: async () => {
      restarts++;
    },
  };
  const place = (name: string, text = "") =>
    writeFile(join(directory, name), text);
  const exists = (name: string) =>
    readFile(join(directory, name), "utf8").then(
      () => true,
      () => false,
    );
  return {
    directory,
    transport,
    run,
    calls,
    restarts: () => restarts,
    place,
    exists,
  };
}

describe("HandoffVerifier (#352)", () => {
  it("writes lab.json, restarts observation after setup-done, returns the six files", async () => {
    const f = await fixture({});
    const pending = f.transport.run(f.run);
    await until(() => f.calls.length > 0);
    expect(f.calls[0]).toEqual(["expose", { httpPort: 8080, via: "recorder" }]);
    let labJson = "";
    await until(() => {
      void readFile(join(f.directory, "lab.json"), "utf8").then(
        (text) => {
          labJson = text;
        },
        () => undefined,
      );
      return labJson.length > 0;
    });
    const lab = JSON.parse(labJson) as Record<string, unknown>;
    expect(lab).toMatchObject({
      schema: "wbh-handoff-lab/v1",
      skill: WBH_VERIFY_SKILL_ID,
      runId: "verify-1",
      findingId: f.run.finding.findingId,
      endpoint: "http://wordpress.lab",
      host: { url: "http://127.0.0.1:8080", hostHeader: "wordpress.lab" },
      accounts: { subscriber: { username: "sub", password: "sub-pass" } },
      administrator: { username: "harness-admin", password: "admin-pass" },
      canary: f.run.canary,
      reviewExport: join(f.directory, "review-export.json"),
    });
    expect(lab).not.toHaveProperty("internalIp");
    expect(
      await readFile(join(f.directory, "review-export.json"), "utf8"),
    ).toBe('{"schema":"review-export/v1"}');

    // Setup is still running: nothing is observed yet.
    await sleep(30);
    expect(f.restarts()).toBe(0);
    await f.place("setup-done");
    await until(() => f.restarts() === 1);

    for (const name of WORDPRESS_VERIFIER_FILE_NAMES)
      await f.place(name, name === "precondition" ? "" : `${name} body`);
    const result = await pending;
    expect(result.outcome).toEqual({
      status: "files",
      files: {
        "http.json": "http.json body",
        "steps.md": "steps.md body",
        "route.json": "route.json body",
        "session.json": "session.json body",
        "refutation.md": "refutation.md body",
        precondition: "",
      },
    });
    const skill = await readFile(SKILL_PATH);
    expect(result.promptDigest).toBe(
      `sha256:${createHash("sha256").update(skill).digest("hex")}`,
    );
    expect(result.receipt).toMatchObject({
      runId: "verify-1",
      targetSnapshotDigest: digest,
      terminal: "completed",
      transport: "handoff/v1",
      skill: WBH_VERIFY_SKILL_ID,
    });
    expect(result.receipt.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(f.restarts()).toBe(1);
    expect(f.calls.at(-1)).toEqual(["withdraw"]);
  });

  it("does not read files placed before setup-done until setup-done arrives", async () => {
    const f = await fixture({});
    const pending = f.transport.run(f.run);
    await until(() => f.calls.length > 0);
    for (const name of WORDPRESS_VERIFIER_FILE_NAMES) await f.place(name, "x");
    await sleep(40);
    expect(f.restarts()).toBe(0);
    await f.place("setup-done");
    const result = await pending;
    expect(result.outcome.status).toBe("files");
    expect(f.restarts()).toBe(1);
  });

  it("records an abort before setup-done as incomplete with its reason", async () => {
    const f = await fixture({});
    const pending = f.transport.run(f.run);
    await until(() => f.calls.length > 0);
    await f.place("abort", "form editor unavailable\nmore detail");
    const result = await pending;
    expect(result.outcome).toEqual({
      status: "incomplete",
      nextStep: "handoff: Aborted before setup-done: form editor unavailable",
    });
    expect(result.receipt).toMatchObject({
      terminal: "incomplete",
      reason: "abort",
    });
    expect(f.restarts()).toBe(0);
    expect(f.calls.at(-1)).toEqual(["withdraw"]);
  });

  it("records an abort after setup-done as incomplete without reading partial files", async () => {
    const f = await fixture({});
    const pending = f.transport.run(f.run);
    await until(() => f.calls.length > 0);
    await f.place("setup-done");
    await until(() => f.restarts() === 1);
    await f.place("http.json", "{}");
    await f.place("abort");
    const result = await pending;
    expect(result.outcome).toEqual({
      status: "incomplete",
      nextStep: "handoff: Aborted after setup-done: no reason given",
    });
  });

  it("times out at the wall while waiting for setup-done", async () => {
    const f = await fixture({ wallTimeMs: 60, clock: () => new Date() });
    const result = await f.transport.run(f.run);
    expect(result.outcome).toEqual({
      status: "incomplete",
      nextStep: "handoff: setup-done was not placed within the wall",
    });
    expect(result.receipt).toMatchObject({
      terminal: "incomplete",
      reason: "timeout",
    });
    expect(f.restarts()).toBe(0);
    expect(f.calls.at(-1)).toEqual(["withdraw"]);
  });

  it("stops before exposing the Lab when no setup administrator exists", async () => {
    const f = await fixture({ administrator: null });
    const result = await f.transport.run(f.run);
    expect(result.outcome.status).toBe("incomplete");
    expect(f.calls).toEqual([]);
    expect(await f.exists("lab.json")).toBe(false);
  });
});
