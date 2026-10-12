import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { canonicalDigest } from "../../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import {
  loadWordPressAcceptanceCriteria,
  loadWordPressReproductionTemplate,
} from "../../../src/profiles/wordpress/acceptance/index.js";
import { wordpressReproductionRenderer } from "../../../src/profiles/wordpress/verification/reproduction-package.js";
import { STANDARD_REPRODUCER_SCRIPT } from "../../../src/profiles/wordpress/verification/standard-script.js";
import { openReproductionPackage } from "../../../src/review/reproduction-package.js";
import { publishReproductionPackage } from "../../../src/verification/reproduction-package.js";

const snapshotDigest = `sha256:${"a".repeat(64)}`;
const setupDigest = `sha256:${"b".repeat(64)}`;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

// These are synthetic format fixtures labelled with the two public benchmark cases.
// They do not assert that either path worked in a real Lab.
const cases = [
  {
    caseId: "TP-SX",
    version: "3.2.6",
    category: "stored-xss",
    judgeId: "wordpress-stored-script",
    conditions: {
      observedVia: "synthetic-canary",
      firedContexts: "synthetic-page",
    },
    browser: true,
  },
  {
    caseId: "TP-ATO",
    version: "3.3.1",
    category: "account-takeover",
    judgeId: "wordpress-administrator-principal",
    conditions: {
      observedVia: "synthetic-session",
      reachedRole: "administrator",
    },
    browser: false,
  },
] as const;

for (const testCase of cases) {
  it(`generates the ${testCase.caseId} ${testCase.version} package with the shared reading order`, async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wbh-reproduction-template-"),
    );
    directories.push(directory);
    const store = new PrivateArtifactStore({
      rootDirectory: join(directory, "private-evidence"),
      maxEntries: 10,
      maxBytes: 100_000,
    });
    const snapshotBody = {
      kind: "source-snapshot" as const,
      schemaVersion: 1 as const,
      target: {
        identity: "translatepress-multilingual",
        version: testCase.version,
        sourceDigest: snapshotDigest,
      },
      dependencies: [],
    };
    const snapshot = {
      ...snapshotBody,
      digest: canonicalDigest(snapshotBody),
    };
    const setup = {
      schemaVersion: 1 as const,
      snapshotDigest: snapshot.digest,
      siteTitle: "Synthetic package test",
      initialPosts: [],
      customerRole: false,
    };
    const caseSetupDigest = canonicalDigest(setup);
    const route = {
      schemaVersion: 1,
      snapshotDigest: snapshot.digest,
      labSetupDigest: caseSetupDigest,
      role: "unauthenticated",
      account: "none",
      defaultSettings: true,
      configurationChanges: [],
      steps: [
        {
          kind: "http",
          method: "GET",
          path: "/synthetic-fixture",
          expected: "synthetic observation",
        },
        ...(testCase.browser
          ? [
              {
                kind: "browser",
                path: "/synthetic-fixture",
                expected: "synthetic visual observation",
              },
            ]
          : []),
      ],
      evidence: [
        { kind: "http", path: "fixture.txt", capture: "agent-authored" },
        { kind: "canary", path: "canary.txt", capture: "harness-captured" },
        ...(testCase.browser
          ? [
              {
                kind: "screenshot",
                path: "screen.png",
                capture: "harness-captured",
              },
            ]
          : []),
      ],
    };
    const evidenceDigest = await store.putFiles({
      "confirmed-route.json": JSON.stringify(route),
      "fixture.txt": "synthetic format fixture, not an HTTP record",
      "canary.txt": "synthetic judge fixture, not a Lab observation",
      ...(testCase.browser ? { "screen.png": "synthetic image fixture" } : {}),
    });
    const result = await publishReproductionPackage({
      store,
      renderer: wordpressReproductionRenderer,
      category: testCase.category,
      findingSnapshotDigest: snapshot.digest,
      labSnapshotDigest: snapshot.digest,
      labSetupDigest: caseSetupDigest,
      judgeResult: {
        status: "runtime-confirmed",
        judgeId: testCase.judgeId,
        proofKind: "nonce-canary",
        conditions: testCase.conditions,
        evidenceDigest,
      },
      reconstruction: {
        wordpressVersion: "6.8",
        target: snapshotBody.target,
        enabledSettings: [],
        roles: ["unauthenticated"],
      },
      setup,
      snapshot,
    });
    expect(result.status).toBe("runtime-confirmed");
    if (result.status !== "runtime-confirmed") return;

    const criteria = await loadWordPressAcceptanceCriteria(testCase.category);
    const template = await loadWordPressReproductionTemplate();
    expect(criteria).not.toBeNull();
    expect(result.acceptanceCriteria).toEqual({
      id: criteria?.id,
      version: 1,
      digest: criteria?.digest,
    });
    expect(result.reproductionTemplate).toEqual({
      id: template.id,
      version: 1,
      digest: template.digest,
    });

    const opened = await openReproductionPackage(store, result);
    expect(opened.status).toBe("opened");
    if (opened.status !== "opened") return;
    const headings = template.sections.map(
      (section, index) => `## ${index + 1}. ${section.heading}`,
    );
    const positions = headings.map((heading) => opened.manual.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(
      [...positions].sort((left, right) => left - right),
    );
    expect(opened.manual).toContain(`${testCase.version}`);
    expect(opened.manual).toContain(`${testCase.judgeId}`);
    expect(opened.manual).toContain("not-assessed");
    expect(opened.manual).toContain("not-recorded-in-this-package");
    expect(opened.manual).not.toContain("GET /synthetic-fixture");
    expect(opened.script).not.toContain("/synthetic-fixture");
    expect(opened.agentAuthored).toMatchObject({
      provenance: "agent-authored",
      steps: expect.arrayContaining([
        {
          kind: "http",
          method: "GET",
          path: "/synthetic-fixture",
          expected: "synthetic observation",
        },
      ]),
    });
    expect(opened.evidence).toMatchObject({
      entries: expect.arrayContaining([
        { kind: "http", path: "fixture.txt", capture: "agent-authored" },
        { kind: "canary", path: "canary.txt", capture: "harness-captured" },
      ]),
    });
    const lab = await store.readFile(
      result.reproductionPackageDigest,
      "lab.json",
      100_000,
    );
    expect(lab.status).toBe("resolved");
    if (lab.status === "resolved") {
      expect(JSON.parse(lab.bytes.toString("utf8"))).toMatchObject({
        setup,
        snapshot,
      });
    }
    expect(directory).not.toContain("wordpress-bounty-harness-issue-140");
  });
}

const python3Available =
  spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;

it.skipIf(!python3Available)(
  "rejects a bodyless POST in the generated helper before any network request",
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "wbh-bodyless-reproduction-"),
    );
    directories.push(directory);
    const store = new PrivateArtifactStore({
      rootDirectory: join(directory, "private-evidence"),
      maxEntries: 10,
      maxBytes: 100_000,
    });
    const snapshotBody = {
      kind: "source-snapshot" as const,
      schemaVersion: 1 as const,
      target: {
        identity: "example",
        version: "1.0",
        sourceDigest: snapshotDigest,
      },
      dependencies: [],
    };
    const snapshot = {
      ...snapshotBody,
      digest: canonicalDigest(snapshotBody),
    };
    const setup = {
      schemaVersion: 1 as const,
      snapshotDigest: snapshot.digest,
      siteTitle: "Synthetic package test",
      initialPosts: [],
      customerRole: false,
    };
    const evidenceDigest = await store.putFiles({
      "fixture.txt": "synthetic format fixture",
      "canary.txt": "synthetic canary fixture",
    });
    const route = {
      schemaVersion: 1 as const,
      snapshotDigest: snapshot.digest,
      labSetupDigest: canonicalDigest(setup),
      role: "unauthenticated" as const,
      account: "none",
      defaultSettings: true,
      configurationChanges: [],
      steps: [
        {
          kind: "http" as const,
          method: "POST" as const,
          path: "/synthetic",
          expected: "Synthetic observation",
        },
      ],
      evidence: [
        {
          kind: "http" as const,
          path: "fixture.txt",
          capture: "agent-authored" as const,
        },
        {
          kind: "canary" as const,
          path: "canary.txt",
          capture: "harness-captured" as const,
        },
      ],
    };
    const rendered = await wordpressReproductionRenderer.render({
      category: "stored-xss",
      judgeId: "wordpress-stored-script",
      proofKind: "nonce-canary",
      conditions: {},
      route,
      snapshotDigest: snapshot.digest,
      reconstruction: {
        wordpressVersion: "6.8",
        target: snapshotBody.target,
        enabledSettings: [],
        roles: ["unauthenticated"],
      },
      labSetupDigest: route.labSetupDigest,
      evidenceDigest,
      store,
      setup,
      snapshot,
    });
    const scriptDirectory = join(directory, "script");
    await mkdir(scriptDirectory);
    const networkMarker = join(scriptDirectory, "network-called");
    await Promise.all([
      writeFile(join(scriptDirectory, "reproduce.py"), rendered.script),
      writeFile(
        join(scriptDirectory, "agent-authored.json"),
        rendered.auxiliaryFiles?.["agent-authored.json"] ?? "",
      ),
      writeFile(
        join(scriptDirectory, "requests.py"),
        [
          "from pathlib import Path",
          "class Session:",
          "    def request(self, *args, **kwargs):",
          "        Path(__file__).with_name('network-called').write_text('sent')",
          "        raise AssertionError('network request was attempted')",
        ].join("\n"),
      ),
    ]);
    const run = spawnSync("python3", [join(scriptDirectory, "reproduce.py")], {
      cwd: scriptDirectory,
      env: { ...process.env, WBH_BASE_URL: "http://127.0.0.1:9" },
      encoding: "utf8",
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("has no request body");
    expect(existsSync(networkMarker)).toBe(false);
  },
);

it.skipIf(!python3Available)(
  "keeps generated helper requests on the Lab origin without following redirects",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "wbh-origin-reproduction-"));
    directories.push(directory);
    const store = new PrivateArtifactStore({
      rootDirectory: join(directory, "private-evidence"),
      maxEntries: 10,
      maxBytes: 100_000,
    });
    const snapshotBody = {
      kind: "source-snapshot" as const,
      schemaVersion: 1 as const,
      target: {
        identity: "example",
        version: "1.0",
        sourceDigest: snapshotDigest,
      },
      dependencies: [],
    };
    const snapshot = {
      ...snapshotBody,
      digest: canonicalDigest(snapshotBody),
    };
    const setup = {
      schemaVersion: 1 as const,
      snapshotDigest: snapshot.digest,
      siteTitle: "Synthetic package test",
      initialPosts: [],
      customerRole: false,
    };
    const evidenceDigest = await store.putFiles({
      "fixture.txt": "synthetic format fixture",
      "canary.txt": "synthetic canary fixture",
    });
    const route = {
      schemaVersion: 1 as const,
      snapshotDigest: snapshot.digest,
      labSetupDigest: canonicalDigest(setup),
      role: "subscriber" as const,
      account: "lab-subscriber",
      defaultSettings: true,
      configurationChanges: [],
      steps: [
        {
          kind: "http" as const,
          method: "GET" as const,
          path: "/https://example.invalid/",
          expected: "Synthetic observation",
        },
      ],
      evidence: [
        {
          kind: "http" as const,
          path: "fixture.txt",
          capture: "agent-authored" as const,
        },
        {
          kind: "canary" as const,
          path: "canary.txt",
          capture: "harness-captured" as const,
        },
      ],
    };
    const rendered = await wordpressReproductionRenderer.render({
      category: "stored-xss",
      judgeId: "wordpress-stored-script",
      proofKind: "nonce-canary",
      conditions: {},
      route,
      snapshotDigest: snapshot.digest,
      reconstruction: {
        wordpressVersion: "6.8",
        target: snapshotBody.target,
        enabledSettings: [],
        roles: ["subscriber"],
      },
      labSetupDigest: route.labSetupDigest,
      evidenceDigest,
      store,
      setup,
      snapshot,
    });
    const scriptDirectory = join(directory, "script");
    await mkdir(scriptDirectory);
    const agentAuthored = rendered.auxiliaryFiles?.["agent-authored.json"];
    expect(agentAuthored).toBeDefined();
    if (agentAuthored === undefined) return;
    await Promise.all([
      writeFile(join(scriptDirectory, "reproduce.py"), rendered.script),
      writeFile(join(scriptDirectory, "agent-authored.json"), agentAuthored),
      writeFile(
        join(scriptDirectory, "requests.py"),
        [
          "import json",
          "from pathlib import Path",
          "def record(kind, url, allow_redirects, trust_env):",
          "    with Path(__file__).with_name('requests.jsonl').open('a', encoding='utf-8') as log:",
          "        log.write(json.dumps({'kind': kind, 'url': url, 'allow_redirects': allow_redirects, 'trust_env': trust_env}) + '\\n')",
          "class Cookie:",
          "    name = 'wordpress_logged_in_synthetic'",
          "class Response:",
          "    status_code = 200",
          "    text = 'synthetic response'",
          "class Session:",
          "    def __init__(self):",
          "        self.cookies = []",
          "        self.trust_env = True",
          "    def post(self, url, **kwargs):",
          "        record('login', url, kwargs.get('allow_redirects'), self.trust_env)",
          "        self.cookies = [Cookie()]",
          "        return Response()",
          "    def request(self, method, url, **kwargs):",
          "        record(method, url, kwargs.get('allow_redirects'), self.trust_env)",
          "        return Response()",
        ].join("\n"),
      ),
    ]);
    const run = spawnSync("python3", [join(scriptDirectory, "reproduce.py")], {
      cwd: scriptDirectory,
      env: {
        ...process.env,
        WBH_BASE_URL: "http://127.0.0.1:9",
        WBH_USERNAME: "synthetic-user",
        WBH_PASSWORD: "synthetic-password",
      },
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    const requests = (
      await readFile(join(scriptDirectory, "requests.jsonl"), "utf8")
    )
      .trimEnd()
      .split("\n")
      .map((row) => JSON.parse(row));
    expect(requests).toEqual([
      {
        kind: "login",
        url: "http://127.0.0.1:9/wp-login.php",
        allow_redirects: false,
        trust_env: false,
      },
      {
        kind: "GET",
        url: "http://127.0.0.1:9/https://example.invalid/",
        allow_redirects: false,
        trust_env: false,
      },
    ]);
  },
);

it("seals a reproduced package with the exact executed script and one-command Lab setup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wbh-reproduced-package-"));
  directories.push(directory);
  const store = new PrivateArtifactStore({
    rootDirectory: join(directory, "private-evidence"),
    maxEntries: 10,
    maxBytes: 100_000,
  });
  const snapshotBody = {
    kind: "source-snapshot" as const,
    schemaVersion: 1 as const,
    target: {
      identity: "example",
      version: "1.0",
      sourceDigest: snapshotDigest,
    },
    dependencies: [],
  };
  const sealedSnapshot = {
    ...snapshotBody,
    digest: canonicalDigest(snapshotBody),
  };
  const labSetup = {
    schemaVersion: 1 as const,
    snapshotDigest: sealedSnapshot.digest,
    siteTitle: "Synthetic test",
    initialPosts: [],
    customerRole: false,
  };
  const capture = `${JSON.stringify({
    request: { method: "GET", path: "/synthetic", truncated: false },
    response: { statusCode: 200, truncated: false },
  })}\n`;
  const evidenceDigest = await store.putFiles({
    "reproduced-route.json": JSON.stringify({
      schemaVersion: 1,
      snapshotDigest: sealedSnapshot.digest,
      labSetupDigest: setupDigest,
      role: "unauthenticated",
      account: "none",
      defaultSettings: true,
      configurationChanges: [],
      steps: [
        {
          kind: "http",
          method: "GET",
          path: "/synthetic",
          expected: "Synthetic canary",
        },
      ],
      evidence: [
        {
          kind: "http",
          path: "proxy-capture.jsonl",
          capture: "harness-captured",
        },
        {
          kind: "structured-output",
          path: "structured-output.json",
          capture: "harness-captured",
        },
      ],
    }),
    "proxy-capture.jsonl": capture,
    "structured-output.json": "{}",
    "standard-reproduce.py": STANDARD_REPRODUCER_SCRIPT,
  });
  const result = await publishReproductionPackage({
    store,
    renderer: wordpressReproductionRenderer,
    category: "sqli",
    findingSnapshotDigest: sealedSnapshot.digest,
    labSnapshotDigest: sealedSnapshot.digest,
    labSetupDigest: setupDigest,
    judgeResult: {
      status: "reproduced",
      reproducerId: "standard-python-v1",
      proofKind: "captured-script-observation",
      conditions: { observedVia: "canary-row-read" },
      evidenceDigest,
    },
    reconstruction: {
      wordpressVersion: "6.8",
      target: snapshotBody.target,
      enabledSettings: [],
      roles: ["unauthenticated"],
    },
    setup: labSetup,
    snapshot: sealedSnapshot,
    negativeControl: "pending-fixed-version",
  });
  expect(result.status).toBe("reproduced");
  if (result.status !== "reproduced") return;
  const opened = await openReproductionPackage(store, result);
  expect(opened).toMatchObject({
    status: "opened",
    script: STANDARD_REPRODUCER_SCRIPT,
  });
  const lab = await store.readFile(
    result.reproductionPackageDigest,
    "lab.json",
    100_000,
  );
  expect(lab.status).toBe("resolved");
  if (lab.status !== "resolved") return;
  expect(JSON.parse(lab.bytes.toString("utf8"))).toMatchObject({
    setup: labSetup,
    snapshot: sealedSnapshot,
  });
});
