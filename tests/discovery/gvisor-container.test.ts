import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { measureCanonicalSourceTree } from "../../src/infrastructure/canonical-source-tree.js";
import {
  BROKER_TLS_HOSTNAME,
  GvisorClaudeSandbox,
  GvisorCodexSandbox,
} from "../../src/discovery/index.js";
import {
  admittedLabHosts,
  brokerGrantFault,
  gvisorRunArgs,
  isGvisorIsolation,
  type GvisorContainer,
  type LabHosts,
} from "../../src/discovery/gvisor-container.js";

const digest = `sha256:${"a".repeat(64)}`;
const user = `${process.getuid?.()}:${process.getgid?.()}`;
const token = "t".repeat(43);
const caPem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const hosts = {
  labHost: { name: "wordpress", ipv4: "172.20.0.2" },
  databaseHost: { name: "database", ipv4: "172.20.0.3" },
  controlHost: { name: "labctl", ipv4: "172.20.0.130" },
};

/** Every `docker` call a sandbox made, with scratch paths and random names made stable. */
type Calls = string[][];

async function trees(root: string) {
  const measure = async (name: string) => {
    const directory = join(root, name);
    await mkdir(directory);
    await writeFile(join(directory, "main.txt"), name);
    return {
      directory,
      expectedTree: await measureCanonicalSourceTree(directory, {
        maxEntries: 10,
        maxBytes: 1024,
      }),
    };
  };
  return {
    source: await measure("source"),
    core: await measure("core"),
    php: await measure("php"),
  };
}

function recorder(root: string, calls: Calls) {
  return async (args: readonly string[]) => {
    calls.push(
      args.map((arg) =>
        arg
          .split(root)
          .join("<root>")
          .replace(/((?:codex|claude)-(?:run|home|research)-)[^,/]{6}/g, "$1*")
          .replace(/-agent-[0-9a-f-]{36}/, "-agent-<uuid>"),
      ),
    );
    const stdout = args.includes("--version")
      ? args.includes("--entrypoint=claude")
        ? "2.1.296 (Claude Code)\n"
        : "codex-cli 0.161.0\n"
      : args.includes("--entrypoint=sha256sum")
        ? `${"b".repeat(64)}  /opt/codex/model-catalog.json\n`
        : "{}\n";
    return { kind: "exited" as const, exitCode: 0, stdout, stderr: "" };
  };
}

const runscBase = (memoryMiB: number, cpus: number) => [
  "run",
  "--rm",
  "--pull=never",
  "--runtime=runsc",
  `--user=${user}`,
  "--read-only",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  "--pids-limit=256",
  `--memory=${memoryMiB}m`,
  `--cpus=${cpus}`,
  "--tmpfs=/tmp:rw,nosuid,nodev,size=256m",
];

const codexProbe = (memoryMiB: number) => [
  [
    ...runscBase(memoryMiB, 1),
    "--network=none",
    "--entrypoint=codex",
    `node@${digest}`,
    "--version",
  ],
  [
    ...runscBase(memoryMiB, 1),
    "--network=none",
    "--entrypoint=sha256sum",
    `node@${digest}`,
    "/opt/codex/model-catalog.json",
  ],
];

const codexName = "codex-agent-<uuid>";

/**
 * The exact `docker` argument lists of both runtimes, pinned before the
 * admission moved into one module and unchanged after it (candidate 9).
 * Codex runs on one CPU and Claude on two: a per-runtime parameter, kept.
 */
const cases: {
  readonly name: string;
  readonly run: (root: string, calls: Calls) => Promise<unknown>;
  readonly expected: Calls;
}[] = [
  {
    name: "Codex cooperative run over the plain broker with every Lab host and mount",
    run: async (root, calls) => {
      const { source, core, php } = await trees(root);
      return new GvisorCodexSandbox({
        dockerExecutablePath: "/usr/bin/docker",
        image: `node@${digest}`,
        bundledCatalogPath: "/opt/codex/model-catalog.json",
        scratchRootDirectory: root,
        ownerDirectory: join(root, "owners"),
        maxOutputBytes: 1024 * 1024,
        timeoutMs: 60_000,
        memoryMiB: 10240,
        randomUuid: () => "0f1e2d3c-4b5a-4987-a654-3210fedcba98",
        runDocker: recorder(root, calls),
      }).execute({
        executable: "codex",
        args: ["exec", "--json"],
        stdin: "Inspect the source.",
        minimumActiveMs: 1_000,
        resumeArgs: ["exec", "resume"],
        resumePrompt: "Continue.",
        supportFiles: [
          { path: "/opt/codex-support/report-schema.json", content: "{}" },
        ],
        grant: {
          baseUrl: "http://172.28.0.2:8080",
          authorization: `Bearer ${token}`,
          dockerNetworkName: "internal-run",
          model: "gpt-6.1-sol",
          protocol: "responses",
          expiresAt: "2026-10-08T07:30:00Z",
        },
        sourceMount: { ...source, path: "/workspace/main", mode: "ro" },
        dependencyMount: { ...core, path: "/workspace/wordpress", mode: "ro" },
        additionalDependencyMounts: [
          { ...php, path: "/workspace/php", mode: "ro" },
        ],
        researchMount: { path: "/workspace/research", mode: "rw" },
        ...hosts,
      });
    },
    expected: [
      ...codexProbe(10240),
      [
        ...runscBase(10240, 1),
        `--name=${codexName}`,
        "--interactive",
        "--network=internal-run",
        "--add-host=wordpress:172.20.0.2",
        "--add-host=database:172.20.0.3",
        "--add-host=labctl:172.20.0.130",
        "--mount=type=bind,src=<root>/source,dst=/workspace/main,readonly",
        "--mount=type=bind,src=<root>/core,dst=/workspace/wordpress,readonly",
        "--mount=type=bind,src=<root>/php,dst=/workspace/php,readonly",
        "--mount=type=bind,src=<root>/codex-research-*,dst=/workspace/research",
        "--mount=type=bind,src=<root>/codex-run-*,dst=/opt/codex-support,readonly",
        "--workdir=/workspace/main",
        "--env=HOME=/tmp",
        "--env=CODEX_HOME=/tmp/codex",
        "--mount=type=bind,src=<root>/codex-home-*,dst=/tmp/codex",
        `--env=OPENAI_API_KEY=${token}`,
        "--entrypoint=node",
        `node@${digest}`,
        "/opt/codex-support/minimum-active-runner.mjs",
        "1000",
        '["exec","--json"]',
        '["exec","resume"]',
        "Continue.",
      ],
      ["rm", "--force", codexName],
    ],
  },
  {
    name: "Codex one-shot run over the TLS broker with no Lab",
    run: async (root, calls) => {
      const { source } = await trees(root);
      return new GvisorCodexSandbox({
        dockerExecutablePath: "/usr/bin/docker",
        image: `node@${digest}`,
        bundledCatalogPath: "/opt/codex/model-catalog.json",
        scratchRootDirectory: root,
        ownerDirectory: join(root, "owners"),
        maxOutputBytes: 1024 * 1024,
        timeoutMs: 60_000,
        clock: () => new Date("2026-10-08T07:00:00Z"),
        randomUuid: () => "0f1e2d3c-4b5a-4987-a654-3210fedcba98",
        runDocker: recorder(root, calls),
      }).execute({
        executable: "codex",
        args: ["exec", "--json"],
        stdin: "Inspect the source.",
        supportFiles: [
          { path: "/opt/codex-support/report-schema.json", content: "{}" },
        ],
        grant: {
          baseUrl: `https://${BROKER_TLS_HOSTNAME}:8080`,
          tls: { hostname: BROKER_TLS_HOSTNAME, address: "172.28.0.2", caPem },
          authorization: `Bearer ${token}`,
          dockerNetworkName: "internal-run",
          model: "gpt-6-luna",
          protocol: "responses",
          expiresAt: "2026-10-08T07:30:00Z",
        },
        sourceMount: { ...source, path: "/workspace/main", mode: "ro" },
      });
    },
    expected: [
      ...codexProbe(2048),
      [
        ...runscBase(2048, 1),
        `--name=${codexName}`,
        "--interactive",
        "--network=internal-run",
        "--mount=type=bind,src=<root>/source,dst=/workspace/main,readonly",
        "--mount=type=bind,src=<root>/codex-run-*,dst=/opt/codex-support,readonly",
        "--workdir=/workspace/main",
        "--env=HOME=/tmp",
        "--env=CODEX_HOME=/tmp/codex",
        "--mount=type=bind,src=<root>/codex-home-*,dst=/tmp/codex",
        `--add-host=${BROKER_TLS_HOSTNAME}:172.28.0.2`,
        "--env=CODEX_CA_CERTIFICATE=/opt/codex-support/grant-ca.pem",
        "--entrypoint=codex",
        `node@${digest}`,
        "exec",
        "--json",
      ],
      ["rm", "--force", codexName],
    ],
  },
  {
    name: "Claude run with every Lab host and a dependency mount",
    run: async (root, calls) => {
      const { source, core } = await trees(root);
      return new GvisorClaudeSandbox({
        dockerExecutablePath: "/usr/bin/docker",
        image: `claude@${digest}`,
        scratchRootDirectory: root,
        ownerDirectory: join(root, "owners"),
        maxOutputBytes: 1024 * 1024,
        timeoutMs: 60_000,
        runDocker: recorder(root, calls),
      }).execute({
        grant: {
          baseUrl: "http://172.20.0.5:8080",
          authorization: `Bearer ${token}`,
          dockerNetworkName: "trial-internal",
          model: "claude-opus-5-5",
          subagentModel: "claude-sonnet-5-5",
          protocol: "anthropic-messages",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        input: {
          prompt: "Objective.",
          resumePrompt: "Before giving up.",
          minimumActiveMs: 1,
          maxChildren: 4,
          model: "claude-opus-5-5",
          effort: "high",
          outputSchema: {},
        },
        subagentModel: "claude-sonnet-5-5",
        sourceMount: source,
        dependencyMounts: [{ ...core, path: "/workspace/wordpress" }],
        ...hosts,
      });
    },
    expected: [
      [
        ...runscBase(10240, 2),
        "--network=none",
        "--entrypoint=claude",
        `claude@${digest}`,
        "--version",
      ],
      [
        ...runscBase(10240, 2),
        "--name=claude-agent-<uuid>",
        "--interactive",
        "--network=trial-internal",
        "--add-host=wordpress:172.20.0.2",
        "--add-host=database:172.20.0.3",
        "--add-host=labctl:172.20.0.130",
        "--mount=type=bind,src=<root>/source,dst=/workspace/main,readonly",
        "--mount=type=bind,src=<root>/core,dst=/workspace/wordpress,readonly",
        "--mount=type=bind,src=<root>/claude-research-*,dst=/workspace/research",
        "--mount=type=bind,src=<root>/claude-run-*,dst=/opt/claude-support,readonly",
        "--mount=type=bind,src=<root>/claude-home-*,dst=/tmp/claude",
        "--workdir=/workspace/main",
        "--env=HOME=/tmp",
        "--env=CLAUDE_CONFIG_DIR=/tmp/claude",
        "--env=ANTHROPIC_BASE_URL=http://172.20.0.5:8080",
        "--env=ANTHROPIC_AUTH_TOKEN",
        "--env=ANTHROPIC_MODEL=claude-opus-5-5",
        "--env=ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-opus-5-5",
        "--env=ANTHROPIC_SMALL_FAST_MODEL=claude-opus-5-5",
        "--env=CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-5-5",
        "--env=CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1",
        "--env=CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
        "--env=DISABLE_AUTOUPDATER=1",
        "--env=CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1",
        "--env=CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1",
        "--env=CLAUDE_CODE_NO_MODEL_FALLBACK=1",
        "--env=CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0",
        "--entrypoint=node",
        `claude@${digest}`,
        "/opt/claude-support/runner.mjs",
      ],
      ["rm", "--force", "claude-agent-<uuid>"],
    ],
  },
];

describe("gVisor container admission (invariant 2)", () => {
  it.each(cases)("pins the docker argument lists: $name", async (row) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "gvisor-pin-")));
    try {
      const calls: Calls = [];
      await row.run(root, calls);
      expect(calls).toEqual(row.expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  const lab = hosts.labHost;
  const database = hosts.databaseHost;
  const control = hosts.controlHost;
  it.each<[string, LabHosts, boolean]>([
    ["no Lab", {}, true],
    ["the Lab host alone", { labHost: lab }, true],
    ["all three hosts", hosts, true],
    ["a database without a Lab", { databaseHost: database }, false],
    ["a control host without a Lab", { controlHost: control }, false],
    [
      "a database named like the Lab host",
      { labHost: lab, databaseHost: { ...database, name: lab.name } },
      false,
    ],
    [
      "a control host named like the Lab host",
      { labHost: lab, controlHost: { ...control, name: lab.name } },
      false,
    ],
    [
      "a control host named like the database",
      { ...hosts, controlHost: { ...control, name: database.name } },
      false,
    ],
    ["an upper-case name", { labHost: { ...lab, name: "WordPress" } }, false],
    ["a dotted Lab name", { labHost: { ...lab, name: "wp.local" } }, false],
    ["an IPv6 address", { labHost: { ...lab, ipv4: "::1" } }, false],
  ])("admits Lab hosts: %s", (_name, value, admitted) => {
    expect(admittedLabHosts(value)).toBe(admitted);
  });

  it("refuses a Claude database host named like the Lab host before starting anything (stricter since candidate 9)", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "gvisor-pin-")));
    try {
      const calls: Calls = [];
      await expect(
        new GvisorClaudeSandbox({
          dockerExecutablePath: "/usr/bin/docker",
          image: `claude@${digest}`,
          scratchRootDirectory: root,
          maxOutputBytes: 1024,
          timeoutMs: 1000,
          runDocker: recorder(root, calls),
        }).execute({
          grant: {
            baseUrl: "http://172.20.0.5:8080",
            authorization: `Bearer ${token}`,
            dockerNetworkName: "trial-internal",
            model: "claude-opus-5-5",
            protocol: "anthropic-messages",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          input: {
            prompt: "p",
            resumePrompt: "r",
            minimumActiveMs: 1,
            maxChildren: 4,
            model: "claude-opus-5-5",
            effort: "high",
            outputSchema: {},
          },
          subagentModel: "claude-opus-5-5",
          sourceMount: {
            directory: root,
            expectedTree: { digest, entries: 1, bytes: 1 },
          },
          dependencyMounts: [],
          labHost: lab,
          databaseHost: { ...database, name: lab.name },
        }),
      ).rejects.toThrow("Claude sandbox command is not admitted");
      expect(calls).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  const container: GvisorContainer = {
    user,
    memoryMiB: 2048,
    cpus: 1,
    image: `node@${digest}`,
    entrypoint: "codex",
    command: ["--version"],
  };
  const agent = {
    name: "codex-agent-x",
    network: "internal-run",
    hosts: { labHost: lab },
    options: [],
  };
  it("identifies a refused mount path without emitting control characters (#588)", () => {
    for (const [source, target, message] of [
      ["/bad,source", "/workspace", 'source "/bad,source"'],
      ["/source", "/bad:target", 'target "/bad:target"'],
      ["/bad\nsource", "/workspace", 'source "/bad\\nsource"'],
      ["/source", "/bad\0target", 'target "/bad\\u0000target"'],
    ] as const) {
      expect(() =>
        gvisorRunArgs({
          ...container,
          agent: {
            ...agent,
            options: [{ mount: { source, target, readonly: true } }],
          },
        }),
      ).toThrow(message);
    }
  });

  it("refuses invalid Codex memory at construction before any execution (#588)", () => {
    for (const memoryMiB of [0, 2047, 2048.5, 10241, NaN, Infinity]) {
      expect(
        () =>
          new GvisorCodexSandbox({
            dockerExecutablePath: "/usr/bin/docker",
            image: `node@${digest}`,
            bundledCatalogPath: "/opt/codex/model-catalog.json",
            scratchRootDirectory: "/tmp/unused-codex-scratch",
            maxOutputBytes: 1024 * 1024,
            timeoutMs: 60_000,
            memoryMiB,
          }),
      ).toThrow("Codex sandbox options are invalid");
    }
  });

  it.each<[string, GvisorContainer]>([
    ["the root user", { ...container, user: "0:0" }],
    ["the root group", { ...container, user: "1000:0" }],
    ["no CPU", { ...container, cpus: 0 }],
    ["an unpinned image", { ...container, image: "node:latest" }],
    [
      "a network name with a space",
      { ...container, agent: { ...agent, network: "a b" } },
    ],
    [
      "unadmitted Lab hosts",
      { ...container, agent: { ...agent, hosts: { databaseHost: database } } },
    ],
    [
      "a mount source with a comma",
      {
        ...container,
        agent: {
          ...agent,
          options: [
            { mount: { source: "/a,b", target: "/x", readonly: true } },
          ],
        },
      },
    ],
    [
      "a relative mount source",
      {
        ...container,
        agent: {
          ...agent,
          options: [{ mount: { source: "a", target: "/x", readonly: true } }],
        },
      },
    ],
    [
      "a lower-case environment name",
      {
        ...container,
        agent: { ...agent, options: [{ env: "path", value: "/" }] },
      },
    ],
    [
      "an environment value with a newline",
      {
        ...container,
        agent: { ...agent, options: [{ env: "A", value: "a\nb" }] },
      },
    ],
    [
      "an extra host with a bad address",
      {
        ...container,
        agent: { ...agent, options: [{ host: { name: "a.b", ipv4: "x" } }] },
      },
    ],
  ])("refuses a container with %s", (_name, value) => {
    expect(() => gvisorRunArgs(value)).toThrow("not admitted");
  });

  it("probes with no network and nothing mounted", () => {
    const args = gvisorRunArgs(container);
    expect(args).toContain("--network=none");
    expect(args.some((arg) => arg.startsWith("--mount="))).toBe(false);
    expect(args.filter((arg) => arg.startsWith("--runtime="))).toEqual([
      "--runtime=runsc",
    ]);
  });

  it.each<[string, Parameters<typeof brokerGrantFault>[0], string | undefined]>(
    [
      [
        "plain HTTP on an IPv4 address",
        {
          baseUrl: "http://172.20.0.5:8080",
          authorization: `Bearer ${token}`,
          dockerNetworkName: "n",
          model: "m",
          protocol: "responses",
          expiresAt: "2026-10-08T07:30:00Z",
        },
        undefined,
      ],
      [
        "a host name over plain HTTP",
        {
          baseUrl: "http://broker:8080",
          authorization: `Bearer ${token}`,
          dockerNetworkName: "n",
          model: "m",
          protocol: "responses",
          expiresAt: "2026-10-08T07:30:00Z",
        },
        "address",
      ],
      [
        "the pinned TLS name with its CA",
        {
          baseUrl: `https://${BROKER_TLS_HOSTNAME}:8080`,
          tls: { hostname: BROKER_TLS_HOSTNAME, address: "172.28.0.2", caPem },
          authorization: `Bearer ${token}`,
          dockerNetworkName: "n",
          model: "m",
          protocol: "responses",
          expiresAt: "2026-10-08T07:30:00Z",
        },
        undefined,
      ],
      [
        "a short bearer token",
        {
          baseUrl: "http://172.20.0.5:8080",
          authorization: "Bearer short",
          dockerNetworkName: "n",
          model: "m",
          protocol: "responses",
          expiresAt: "2026-10-08T07:30:00Z",
        },
        "authorization",
      ],
    ],
  )("checks the broker grant: %s", (_name, grant, fault) => {
    expect(brokerGrantFault(grant)).toBe(fault);
  });

  it("accepts only the gVisor isolation without fallback", () => {
    expect(
      isGvisorIsolation({
        backend: "gvisor",
        runtime: "runsc",
        fallbackUsed: false,
      }),
    ).toBe(true);
    expect(
      isGvisorIsolation({
        backend: "gvisor",
        runtime: "runc",
        fallbackUsed: false,
      }),
    ).toBe(false);
    expect(
      isGvisorIsolation({
        backend: "gvisor",
        runtime: "runsc",
        fallbackUsed: true,
      }),
    ).toBe(false);
  });
});
