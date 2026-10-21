import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function until(
  condition: () => boolean | Promise<boolean>,
  ms = 2_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Condition not met in time");
    await sleep(5);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A fake Lab that records the host exposure calls; the directory is the real handoff. */
async function fixture(options: {
  readonly administrator?: null;
  readonly attackerPosition?: "unauthenticated" | "subscriber" | "customer";
  readonly customerAccount?: false;
  readonly wallTimeMs?: number;
  readonly clock?: () => Date;
  readonly restartObservation?: () => Promise<void>;
}) {
  const root = await mkdtemp(join(tmpdir(), "wbh-handoff-verifier-"));
  roots.push(root);
  const directory = join(root, "handoff");
  const finding = admitWordPressFinding(
    {
      claim: "A synthetic stored script reaches an administrator screen",
      attackerPosition: options.attackerPosition ?? "unauthenticated",
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
      ...(options.customerAccount === false
        ? {}
        : { customer: { username: "customer", password: "customer-pass" } }),
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
      await options.restartObservation?.();
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
  it.each([
    "setup-done",
    "observation-ready",
    "abort",
    "lab.json",
    ".lab.json.tmp",
    "attack.json",
    ".attack.json.tmp",
    "review-export.json",
    ...WORDPRESS_VERIFIER_FILE_NAMES,
  ])(
    "refuses a stale %s without exposing the Lab or overwriting it",
    async (name) => {
      const f = await fixture({ clock: () => new Date(), wallTimeMs: 60 });
      await mkdir(f.directory);
      await f.place(name, "previous-attempt");

      const result = await f.transport.run(f.run);

      expect(result.outcome).toEqual({
        status: "incomplete",
        nextStep:
          "handoff: The directory contains files from another attempt; use a fresh handoff directory",
      });
      expect(result.receipt).toMatchObject({
        terminal: "incomplete",
        reason: "stale-directory",
      });
      expect(f.calls).toEqual([]);
      expect(f.restarts()).toBe(0);
      expect(await f.exists(".wbh-handoff-active")).toBe(false);
      expect(await readFile(join(f.directory, name), "utf8")).toBe(
        "previous-attempt",
      );
    },
  );

  it("refuses a second run in the same active handoff directory", async () => {
    const f = await fixture({ clock: () => new Date(), wallTimeMs: 1_000 });
    const pending = f.transport.run(f.run);
    await until(() => f.calls.length > 0);

    const second = await f.transport.run({ ...f.run, runId: "verify-2" });
    expect(second.outcome).toEqual({
      status: "incomplete",
      nextStep:
        "handoff: Another attempt is using the handoff directory; use a fresh handoff directory",
    });
    expect(second.receipt).toMatchObject({ reason: "directory-in-use" });
    expect(f.calls).toEqual([["expose", { httpPort: 8080, via: "recorder" }]]);

    await f.place("abort", "test complete");
    expect((await pending).outcome.status).toBe("incomplete");
    expect(f.calls.at(-1)).toEqual(["withdraw"]);
    expect(await f.exists(".wbh-handoff-active")).toBe(false);
  });

  it("releases attacker data only after setup baseline and returns the six files", async () => {
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
      schema: "wbh-handoff-lab/v2",
      skill: WBH_VERIFY_SKILL_ID,
      runId: "verify-1",
      findingId: f.run.finding.findingId,
      endpoint: "http://wordpress.lab",
      host: { url: "http://127.0.0.1:8080", hostHeader: "wordpress.lab" },
      administrator: { username: "harness-admin", password: "admin-pass" },
      reviewExport: join(f.directory, "review-export.json"),
      files: { attack: join(f.directory, "attack.json") },
    });
    expect(lab).not.toHaveProperty("internalIp");
    expect(lab).not.toHaveProperty("accounts");
    expect(lab).not.toHaveProperty("canary");
    expect(lab).not.toHaveProperty("database");
    expect(lab).not.toHaveProperty("referenceRoute");
    expect(await f.exists(".lab.json.tmp")).toBe(false);
    expect(await f.exists("attack.json")).toBe(false);
    expect(labJson).not.toContain("sub-pass");
    expect(labJson).not.toContain("customer-pass");
    expect(
      await readFile(join(f.directory, "review-export.json"), "utf8"),
    ).toBe('{"schema":"review-export/v1"}');

    // Setup is still running: nothing is observed yet.
    await sleep(30);
    expect(f.restarts()).toBe(0);
    expect(await f.exists("observation-ready")).toBe(false);
    expect(await f.exists("attack.json")).toBe(false);
    await f.place("setup-done");
    await until(() => f.exists("attack.json"));
    expect(await f.exists("observation-ready")).toBe(true);
    expect(f.restarts()).toBe(1);
    const attack = JSON.parse(
      await readFile(join(f.directory, "attack.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(attack).toMatchObject({
      schema: "wbh-handoff-attack/v1",
      runId: "verify-1",
      findingId: f.run.finding.findingId,
      snapshotDigest: digest,
      accounts: {},
      canary: f.run.canary,
    });
    expect(attack).not.toHaveProperty("administrator");
    expect(await f.exists(".attack.json.tmp")).toBe(false);

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

  it.each(["subscriber", "customer"] as const)(
    "hands only the %s attacker account after setup",
    async (attackerPosition) => {
      const f = await fixture({ attackerPosition });
      const pending = f.transport.run(f.run);
      await until(() => f.exists("lab.json"));
      const lab = JSON.parse(
        await readFile(join(f.directory, "lab.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(lab).not.toHaveProperty("accounts");
      expect(await f.exists("attack.json")).toBe(false);
      await f.place("setup-done");
      await until(() => f.exists("attack.json"));
      const attack = JSON.parse(
        await readFile(join(f.directory, "attack.json"), "utf8"),
      ) as { accounts: unknown };
      expect(attack.accounts).toEqual({
        [attackerPosition]: f.run.lab.attackerAccounts[attackerPosition],
      });
      await f.place("abort", "handoff-interrupted");
      await pending;
    },
  );

  it("stops before exposing the Lab when the Finding's attacker account is unavailable", async () => {
    const f = await fixture({
      attackerPosition: "customer",
      customerAccount: false,
    });
    const result = await f.transport.run(f.run);
    expect(result.outcome).toMatchObject({ status: "incomplete" });
    expect(f.calls).toEqual([]);
    expect(await f.exists("lab.json")).toBe(false);
  });

  it("acknowledges observation only after the Harness baseline has restarted", async () => {
    const entered = deferred();
    const release = deferred();
    const f = await fixture({
      restartObservation: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const pending = f.transport.run(f.run);
    try {
      await until(() => f.exists("lab.json"));
      expect(await f.exists("observation-ready")).toBe(false);
      await f.place("setup-done");
      await entered.promise;
      expect(await f.exists("observation-ready")).toBe(false);
      expect(await f.exists("attack.json")).toBe(false);
      release.resolve();
      await until(() => f.exists("attack.json"));
      const lab = JSON.parse(
        await readFile(join(f.directory, "lab.json"), "utf8"),
      ) as { files: { observationReady: string; attack: string } };
      expect(lab.files.observationReady).toBe(
        join(f.directory, "observation-ready"),
      );
      expect(lab.files.attack).toBe(join(f.directory, "attack.json"));
    } finally {
      release.resolve();
      await f.place("abort", "test complete");
      await pending;
    }
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
    await f.place("precondition", "The ordinary setup could not be completed.");
    await f.place("abort", "precondition-unavailable\nprivate detail");
    const result = await pending;
    expect(result.outcome).toEqual({
      status: "incomplete",
      nextStep: "handoff:precondition-unavailable",
      precondition: "The ordinary setup could not be completed.",
    });
    expect(JSON.stringify(result)).not.toContain("private detail");
    expect(result.receipt).toMatchObject({
      terminal: "incomplete",
      reason: "abort",
    });
    expect(f.restarts()).toBe(0);
    expect(f.calls.at(-1)).toEqual(["withdraw"]);
  });

  it("normalizes arbitrary abort text before writing an incomplete result", async () => {
    const f = await fixture({});
    const pending = f.transport.run(f.run);
    await until(() => f.exists("lab.json"));
    await f.place("abort", "sensitive free text");
    const result = await pending;
    expect(result.outcome).toEqual({
      status: "incomplete",
      nextStep: "handoff:unspecified",
    });
    expect(JSON.stringify(result)).not.toContain("sensitive free text");
  });

  it("honors abort even when setup-done is present", async () => {
    const f = await fixture({});
    const pending = f.transport.run(f.run);
    await until(() => f.exists("lab.json"));
    await f.place("abort", "precondition-unavailable");
    await f.place("setup-done");
    const result = await pending;
    expect(result.outcome).toMatchObject({ status: "incomplete" });
    expect(result.receipt).toMatchObject({ reason: "abort" });
    expect(f.restarts()).toBe(0);
  });

  it("honors abort even when all six recipe files are present", async () => {
    const f = await fixture({});
    const pending = f.transport.run(f.run);
    await until(() => f.exists("lab.json"));
    await f.place("setup-done");
    await until(() => f.exists("observation-ready"));
    await f.place("abort", "route-unavailable");
    for (const name of WORDPRESS_VERIFIER_FILE_NAMES)
      await f.place(name, name === "precondition" ? "" : "complete-looking");
    const result = await pending;
    expect(result.outcome).toEqual({
      status: "incomplete",
      nextStep: "handoff:route-unavailable",
    });
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
      nextStep: "handoff:unspecified",
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
