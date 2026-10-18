import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { measureCanonicalSourceTree } from "../../src/infrastructure/canonical-source-tree.js";
import {
  BROKER_TLS_HOSTNAME,
  CHATGPT_PLACEHOLDER_ACCOUNT_ID,
  GvisorCodexSandbox,
} from "../../src/discovery/index.js";

const digest = `sha256:${"a".repeat(64)}`;
const sandboxUuid = "0f1e2d3c-4b5a-4987-a654-3210fedcba98";

describe("gVisor Codex sandbox", () => {
  it("ends a silent Docker client and stops its named container at the wall", async () => {
    const root = await mkdtemp(join(tmpdir(), "gvisor-wall-"));
    try {
      const source = join(root, "source");
      await mkdir(source);
      await writeFile(join(source, "main.txt"), "fixed source");
      const expectedTree = await measureCanonicalSourceTree(source, {
        maxEntries: 10,
        maxBytes: 1024,
      });
      const calls: string[][] = [];
      let clientStopped = false;
      let runStartedAt = 0;
      let agentStoppedAt = 0;
      const sandbox = new GvisorCodexSandbox({
        dockerExecutablePath: "/usr/bin/docker",
        image: `node@${digest}`,
        bundledCatalogPath: "/opt/codex/model-catalog.json",
        scratchRootDirectory: root,
        maxOutputBytes: 1024 * 1024,
        timeoutMs: 30,
        randomUuid: () => sandboxUuid,
        runDocker: async (...call) => {
          const [args] = call;
          calls.push([...args]);
          if (args[0] === "stop") agentStoppedAt = performance.now();
          if (args.includes("--network=internal-run")) {
            runStartedAt = performance.now();
            return new Promise((resolve) => {
              const signal = (
                call as unknown as [
                  readonly string[],
                  string | undefined,
                  number,
                  AbortSignal | undefined,
                ]
              )[3];
              signal?.addEventListener(
                "abort",
                () => {
                  clientStopped = true;
                  resolve({ kind: "timed-out", stdout: "", stderr: "" });
                },
                { once: true },
              );
            });
          }
          return {
            kind: "exited" as const,
            exitCode: 0,
            stdout: args.includes("--version")
              ? "codex-cli 0.161.0\n"
              : args.includes("--entrypoint=sha256sum")
                ? `${"b".repeat(64)}  /opt/codex/model-catalog.json\n`
                : "",
            stderr: "",
          };
        },
      });
      const result = await Promise.race([
        sandbox.execute({
          executable: "codex",
          args: ["exec", "--json"],
          stdin: "Inspect the source.",
          supportFiles: [
            { path: "/opt/codex-support/report-schema.json", content: "{}" },
          ],
          grant: {
            baseUrl: "http://172.28.0.2:8080",
            authorization: `Bearer ${randomBytes(32).toString("hex")}`,
            dockerNetworkName: "internal-run",
            model: "gpt-6.1-sol",
            protocol: "responses",
            expiresAt: "2026-10-08T07:30:00Z",
          },
          sourceMount: {
            directory: source,
            path: "/workspace/main",
            mode: "ro",
            expectedTree,
          },
          labHost: { name: "wordpress", ipv4: "172.20.0.2" },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("wall did not stop Docker")), 250),
        ),
      ]);
      expect(clientStopped).toBe(true);
      expect((agentStoppedAt - (runStartedAt + 30)) / 1000).toBeLessThan(1);
      expect(calls).toContainEqual([
        "stop",
        "-t",
        "10",
        `codex-agent-${sandboxUuid}`,
      ]);
      expect(calls.at(-1)).toEqual([
        "rm",
        "--force",
        `codex-agent-${sandboxUuid}`,
      ]);
      expect(result).toMatchObject({
        status: "failed",
        failureKind: "timed-out",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("names and explicitly removes a stopped agent container (#176)", async () => {
    const root = await mkdtemp(join(tmpdir(), "gvisor-codex-"));
    try {
      const source = join(root, "source");
      await mkdir(source);
      await writeFile(join(source, "main.txt"), "fixed source");
      const expectedTree = await measureCanonicalSourceTree(source, {
        maxEntries: 10,
        maxBytes: 1024,
      });
      const calls: (readonly string[])[] = [];
      const sandbox = new GvisorCodexSandbox({
        dockerExecutablePath: "/usr/bin/docker",
        image: `node@${digest}`,
        bundledCatalogPath: "/opt/codex/model-catalog.json",
        scratchRootDirectory: root,
        maxOutputBytes: 1024 * 1024,
        timeoutMs: 60_000,
        randomUuid: () => sandboxUuid,
        runDocker: async (args) => {
          calls.push(args);
          if (args.includes("--network=internal-run"))
            return {
              kind: "timed-out" as const,
              stdout: "",
              stderr: "synthetic timeout",
            };
          return {
            kind: "exited" as const,
            exitCode: 0,
            stdout: args.includes("--version")
              ? "codex-cli 0.161.0\n"
              : args.includes("--entrypoint=sha256sum")
                ? `${"b".repeat(64)}  /opt/codex/model-catalog.json\n`
                : "",
            stderr: "",
          };
        },
      });
      const result = await sandbox.execute({
        executable: "codex",
        args: ["exec", "--json"],
        stdin: "Inspect the source.",
        supportFiles: [
          { path: "/opt/codex-support/report-schema.json", content: "{}" },
        ],
        grant: {
          baseUrl: "http://172.28.0.2:8080",
          authorization: `Bearer ${randomBytes(32).toString("hex")}`,
          dockerNetworkName: "internal-run",
          model: "gpt-6.1-sol",
          protocol: "responses",
          expiresAt: "2026-10-08T07:30:00Z",
        },
        sourceMount: {
          directory: source,
          path: "/workspace/main",
          mode: "ro",
          expectedTree,
        },
        labHost: { name: "wordpress", ipv4: "172.20.0.2" },
      });
      expect(result).toMatchObject({
        status: "failed",
        failureKind: "timed-out",
      });
      expect(
        calls.find((args) => args.includes("--network=internal-run")),
      ).toContain(`--name=codex-agent-${sandboxUuid}`);
      expect(calls.at(-1)).toEqual([
        "rm",
        "--force",
        `codex-agent-${sandboxUuid}`,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("logs the CLI in with only the grant token and trusts only the grant's CA for a ChatGPT login grant", async () => {
    const root = await mkdtemp(join(tmpdir(), "gvisor-codex-"));
    try {
      const source = join(root, "source");
      await mkdir(source);
      await writeFile(join(source, "main.txt"), "fixed source");
      const expectedTree = await measureCanonicalSourceTree(source, {
        maxEntries: 10,
        maxBytes: 1024,
      });
      const caPem =
        "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
      let run: readonly string[] = [];
      let codexHome = "";
      let auth: unknown;
      let ca = "";
      const sandbox = new GvisorCodexSandbox({
        dockerExecutablePath: "/usr/bin/docker",
        image: `node@${digest}`,
        bundledCatalogPath: "/opt/codex/model-catalog.json",
        scratchRootDirectory: root,
        maxOutputBytes: 1024 * 1024,
        timeoutMs: 60_000,
        clock: () => new Date("2026-10-08T07:00:00Z"),
        runDocker: async (args) => {
          if (args.includes("--network=internal-run")) {
            run = args;
            for (const arg of args) {
              const home = /^--mount=type=bind,src=(.+),dst=\/tmp\/codex$/.exec(
                arg,
              );
              if (home?.[1] !== undefined) codexHome = home[1];
              const support =
                /^--mount=type=bind,src=(.+),dst=\/opt\/codex-support,readonly$/.exec(
                  arg,
                );
              if (support?.[1] !== undefined)
                ca = await readFile(join(support[1], "grant-ca.pem"), "utf8");
            }
            auth = JSON.parse(
              await readFile(join(codexHome, "auth.json"), "utf8"),
            );
            const sessionDirectory = join(
              codexHome,
              "sessions",
              "2026",
              "10",
              "08",
            );
            await mkdir(sessionDirectory, { recursive: true });
            await writeFile(
              join(sessionDirectory, "rollout-child.jsonl"),
              '{"type":"session_meta","payload":{"id":"child","source":"exec"}}\n',
            );
          }
          const output = args.includes("--version")
            ? "codex-cli 0.161.0\n"
            : args.includes("--entrypoint=sha256sum")
              ? `${"b".repeat(64)}  /opt/codex/model-catalog.json\n`
              : "{}\n";
          return { kind: "exited", exitCode: 0, stdout: output, stderr: "" };
        },
      });
      const grantToken = randomBytes(32).toString("hex");
      const command = {
        executable: "codex" as const,
        args: ["exec", "--json"],
        stdin: "Inspect the source.",
        supportFiles: [
          { path: "/opt/codex-support/report-schema.json", content: "{}" },
        ],
        grant: {
          baseUrl: `https://${BROKER_TLS_HOSTNAME}:8080`,
          tls: { hostname: BROKER_TLS_HOSTNAME, address: "172.28.0.2", caPem },
          authorization: `Bearer ${grantToken}`,
          dockerNetworkName: "internal-run",
          model: "gpt-6-luna",
          protocol: "responses" as const,
          expiresAt: "2026-10-08T07:30:00Z",
        },
        sourceMount: {
          directory: source,
          path: "/workspace/main" as const,
          mode: "ro" as const,
          expectedTree,
        },
        labHost: { name: "wordpress", ipv4: "172.20.0.2" },
      };
      const result = await sandbox.execute(command);
      expect(run).toContain(`--add-host=${BROKER_TLS_HOSTNAME}:172.28.0.2`);
      expect(run).toContain(
        "--env=CODEX_CA_CERTIFICATE=/opt/codex-support/grant-ca.pem",
      );
      expect(run.join(" ")).not.toContain("OPENAI_API_KEY");
      expect(ca).toBe(caPem);
      // The CLI holds a login made of the grant token and a placeholder account.
      expect(auth).toMatchObject({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          access_token: grantToken,
          refresh_token: "",
          account_id: CHATGPT_PLACEHOLDER_ACCOUNT_ID,
        },
      });
      const idToken = (auth as { tokens: { id_token: string } }).tokens
        .id_token;
      expect(
        JSON.parse(
          Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString(),
        ),
      ).toMatchObject({
        "https://api.openai.com/auth": {
          chatgpt_account_id: CHATGPT_PLACEHOLDER_ACCOUNT_ID,
        },
      });
      expect(result.rollouts).toEqual([
        '{"type":"session_meta","payload":{"id":"child","source":"exec"}}\n',
      ]);
      // The login lives only for the run.
      await expect(stat(codexHome)).rejects.toThrow();
      await expect(
        sandbox.execute({
          ...command,
          grant: { ...command.grant, baseUrl: "https://chatgpt.com:8080" },
        }),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("captures every direct child across later waves when more than sixteen sessions exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "gvisor-codex-"));
    try {
      const source = join(root, "source");
      await mkdir(source);
      await writeFile(join(source, "main.txt"), "fixed source");
      const expectedTree = await measureCanonicalSourceTree(source, {
        maxEntries: 10,
        maxBytes: 1024,
      });
      const sandbox = new GvisorCodexSandbox({
        dockerExecutablePath: "/usr/bin/docker",
        image: `node@${digest}`,
        bundledCatalogPath: "/opt/codex/model-catalog.json",
        scratchRootDirectory: root,
        maxOutputBytes: 1024 * 1024,
        timeoutMs: 60_000,
        runDocker: async (args) => {
          if (args.includes("--network=internal-run")) {
            const mount = args.find((arg) => arg.endsWith(",dst=/tmp/codex"));
            const codexHome =
              /^--mount=type=bind,src=(.+),dst=\/tmp\/codex$/.exec(
                mount ?? "",
              )?.[1];
            if (codexHome === undefined)
              throw new Error("Codex home is missing");
            const sessions = join(codexHome, "sessions", "2026", "10", "08");
            await mkdir(sessions, { recursive: true });
            await writeFile(
              join(sessions, "rollout-zz-root.jsonl"),
              `${JSON.stringify({
                timestamp: "2026-10-08T07:00:00Z",
                type: "session_meta",
                payload: { id: "root", source: "exec" },
              })}\nROOT_REPORT\n`,
            );
            for (let child = 0; child < 20; child++) {
              const minute = child === 0 ? 4 : child === 3 ? 1 : child;
              await writeFile(
                join(
                  sessions,
                  `rollout-${String(child).padStart(2, "0")}.jsonl`,
                ),
                `${JSON.stringify({
                  timestamp: `2026-10-08T07:${String(minute).padStart(2, "0")}:00Z`,
                  type: "session_meta",
                  payload: {
                    id: `child-${child}`,
                    source: {
                      subagent: {
                        thread_spawn: {
                          parent_thread_id: "root",
                          depth: 1,
                          agent_path: `/root/child_${child}`,
                        },
                      },
                    },
                  },
                })}\nCHILD_REPORT_${child}\n`,
              );
            }
          }
          return {
            kind: "exited" as const,
            exitCode: 0,
            stdout: args.includes("--version")
              ? "codex-cli 0.161.0\n"
              : args.includes("--entrypoint=sha256sum")
                ? `${"b".repeat(64)}  /opt/codex/model-catalog.json\n`
                : "{}\n",
            stderr: "",
          };
        },
      });
      const result = await sandbox.execute({
        executable: "codex",
        args: ["exec", "--json"],
        stdin: "Inspect the source.",
        supportFiles: [
          { path: "/opt/codex-support/report-schema.json", content: "{}" },
        ],
        grant: {
          baseUrl: "http://172.28.0.2:8080",
          authorization: `Bearer ${randomBytes(32).toString("hex")}`,
          dockerNetworkName: "internal-run",
          model: "gpt-6.1-sol",
          protocol: "responses",
          expiresAt: "2026-10-08T07:30:00Z",
        },
        sourceMount: {
          directory: source,
          path: "/workspace/main",
          mode: "ro",
          expectedTree,
        },
        labHost: { name: "wordpress", ipv4: "172.20.0.2" },
      });
      expect(result.rolloutFailure).toBeUndefined();
      expect(result.rollouts).toHaveLength(21);
      expect(result.rollouts?.some((raw) => raw.includes("ROOT_REPORT"))).toBe(
        true,
      );
      const completeChildren = result.rollouts
        ?.filter((raw) => raw.includes("CHILD_REPORT_"))
        .map((raw) => /CHILD_REPORT_(\d+)/.exec(raw)?.[1]);
      expect(completeChildren).toEqual(
        Array.from({ length: 20 }, (_, index) => String(index)),
      );
      const metadataOnly = result.rollouts?.filter(
        (raw) => !raw.includes("ROOT_REPORT") && !raw.includes("CHILD_REPORT_"),
      );
      expect(metadataOnly).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps bounded child evidence and marks capture incomplete above 256 session files", async () => {
    const root = await mkdtemp(join(tmpdir(), "gvisor-many-waves-"));
    try {
      const source = join(root, "source");
      await mkdir(source);
      await writeFile(join(source, "main.txt"), "fixed source");
      const expectedTree = await measureCanonicalSourceTree(source, {
        maxEntries: 10,
        maxBytes: 1024,
      });
      const sandbox = new GvisorCodexSandbox({
        dockerExecutablePath: "/usr/bin/docker",
        image: `node@${digest}`,
        bundledCatalogPath: "/opt/codex/model-catalog.json",
        scratchRootDirectory: root,
        maxOutputBytes: 1024 * 1024,
        timeoutMs: 60_000,
        runDocker: async (args) => {
          if (args.includes("--network=internal-run")) {
            const mount = args.find((arg) => arg.endsWith(",dst=/tmp/codex"));
            const codexHome =
              /^--mount=type=bind,src=(.+),dst=\/tmp\/codex$/.exec(
                mount ?? "",
              )?.[1];
            if (codexHome === undefined) throw new Error("Codex home missing");
            const sessions = join(codexHome, "sessions", "2026", "10", "08");
            await mkdir(sessions, { recursive: true });
            await writeFile(
              join(sessions, "rollout-000-root.jsonl"),
              `${JSON.stringify({
                timestamp: "2026-10-08T07:00:00Z",
                type: "session_meta",
                payload: { id: "root", source: "exec" },
              })}\nROOT_REPORT\n`,
            );
            for (let ordinal = 1; ordinal <= 258; ordinal++)
              await writeFile(
                join(
                  sessions,
                  `rollout-${String(ordinal).padStart(3, "0")}.jsonl`,
                ),
                `${JSON.stringify({
                  timestamp: "2026-10-08T07:01:00Z",
                  type: "session_meta",
                  payload: {
                    id: `child-${ordinal}`,
                    source: {
                      subagent: {
                        thread_spawn: {
                          parent_thread_id: "root",
                          depth: 1,
                          agent_path: `/root/child_${ordinal}`,
                        },
                      },
                    },
                  },
                })}\nCHILD_REPORT_${ordinal}\n`,
              );
          }
          return {
            kind: "exited" as const,
            exitCode: 0,
            stdout: args.includes("--version")
              ? "codex-cli 0.161.0\n"
              : args.includes("--entrypoint=sha256sum")
                ? `${"b".repeat(64)}  /opt/codex/model-catalog.json\n`
                : "{}\n",
            stderr: "",
          };
        },
      });
      const result = await sandbox.execute({
        executable: "codex",
        args: ["exec", "--json"],
        stdin: "Inspect the source.",
        supportFiles: [
          { path: "/opt/codex-support/report-schema.json", content: "{}" },
        ],
        grant: {
          baseUrl: "http://172.28.0.2:8080",
          authorization: `Bearer ${randomBytes(32).toString("hex")}`,
          dockerNetworkName: "internal-run",
          model: "gpt-6.1-sol",
          protocol: "responses",
          expiresAt: "2026-10-08T07:30:00Z",
        },
        sourceMount: {
          directory: source,
          path: "/workspace/main",
          mode: "ro",
          expectedTree,
        },
        labHost: { name: "wordpress", ipv4: "172.20.0.2" },
      });
      expect(result.rolloutFailure).toBe("capture-failed");
      expect(result.rollouts).toHaveLength(256);
      expect(result.rollouts?.[0]).toContain("ROOT_REPORT");
      expect(
        result.rollouts?.some((raw) => raw.includes("CHILD_REPORT_250")),
      ).toBe(true);
      expect(
        result.rollouts?.some((raw) => raw.includes("CHILD_REPORT_256")),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("measures the source and CLI before a pinned runsc execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "gvisor-codex-"));
    try {
      const source = join(root, "source");
      await mkdir(source);
      await writeFile(join(source, "main.txt"), "fixed source");
      const expectedTree = await measureCanonicalSourceTree(source, {
        maxEntries: 10,
        maxBytes: 1024,
      });
      const calls: { args: readonly string[]; stdin: string | undefined }[] =
        [];
      let researchContents: string | Buffer = "# Registry\n";
      let researchDirectory = "";
      const researchDirectories: string[] = [];
      const sandbox = new GvisorCodexSandbox({
        dockerExecutablePath: "/usr/bin/docker",
        image: `node@${digest}`,
        bundledCatalogPath: "/opt/codex/model-catalog.json",
        scratchRootDirectory: root,
        maxOutputBytes: 1024 * 1024,
        timeoutMs: 60_000,
        clock: () => new Date("2026-10-08T07:00:00Z"),
        runDocker: async (args, stdin) => {
          calls.push({ args, stdin });
          if (args.includes("--network=internal-run")) {
            const researchMount = args.find((arg) =>
              arg.endsWith(",dst=/workspace/research"),
            );
            researchDirectory =
              /^--mount=type=bind,src=(.+),dst=\/workspace\/research$/.exec(
                researchMount ?? "",
              )?.[1] ?? "";
            if (researchDirectory.length > 0) {
              researchDirectories.push(researchDirectory);
              await writeFile(
                join(researchDirectory, "REGISTRY.md"),
                researchContents,
              );
            }
          }
          const output = args.includes("--version")
            ? "codex-cli 0.161.0\n"
            : args.includes("--entrypoint=sha256sum")
              ? `${"b".repeat(64)}  /opt/codex/model-catalog.json\n`
              : "{}\n";
          return { kind: "exited", exitCode: 0, stdout: output, stderr: "" };
        },
      });
      const grantToken = randomBytes(32).toString("hex");
      const command = {
        executable: "codex" as const,
        args: ["exec", "--json"],
        stdin: "Inspect the source.",
        supportFiles: [
          { path: "/opt/codex-support/report-schema.json", content: "{}" },
        ],
        grant: {
          baseUrl: "http://172.28.0.2:8080",
          authorization: `Bearer ${grantToken}`,
          dockerNetworkName: "internal-run",
          model: "gpt-6.1-sol",
          protocol: "responses" as const,
          expiresAt: "2026-10-08T07:30:00Z",
        },
        sourceMount: {
          directory: source,
          path: "/workspace/main" as const,
          mode: "ro" as const,
          expectedTree,
        },
        researchMount: {
          path: "/workspace/research" as const,
          mode: "rw" as const,
        },
        labHost: { name: "wordpress", ipv4: "172.20.0.2" },
      };
      const result = await sandbox.execute(command);
      expect(result).toMatchObject({
        status: "exited",
        cliVersion: "0.161.0",
        bundledCatalogDigest: `sha256:${"b".repeat(64)}`,
        isolation: { backend: "gvisor", runtime: "runsc", fallbackUsed: false },
      });
      expect(calls).toHaveLength(4);
      const containerRuns = calls.filter(({ args }) => args[0] === "run");
      expect(containerRuns).toHaveLength(3);
      expect(
        containerRuns.every(({ args }) => args.includes("--runtime=runsc")),
      ).toBe(true);
      expect(
        containerRuns.every(({ args }) => args.includes("--pids-limit=256")),
      ).toBe(true);
      expect(calls[0]?.args).toContain("--network=none");
      expect(calls[1]?.args).toContain("--network=none");
      expect(calls[2]?.args).toContain("--network=internal-run");
      expect(calls[2]?.args).toContain("--add-host=wordpress:172.20.0.2");
      expect(calls[2]?.args).toContain(
        `--mount=type=bind,src=${source},dst=/workspace/main,readonly`,
      );
      expect(
        calls[2]?.args.some((arg) =>
          /^--mount=type=bind,src=.+,dst=\/workspace\/research$/.test(arg),
        ),
      ).toBe(true);
      expect(result.research?.truncated).toBe(false);
      expect(
        result.research && JSON.parse(result.research.archive.toString("utf8")),
      ).toMatchObject({
        kind: "research-directory-archive",
        truncated: false,
        collectedBytes: Buffer.byteLength("# Registry\n"),
        entries: [
          {
            path: "REGISTRY.md",
            type: "file",
            contentBase64: Buffer.from("# Registry\n").toString("base64"),
          },
        ],
      });
      await expect(stat(researchDirectory)).rejects.toThrow();
      expect(calls[2]?.stdin).toBe(command.stdin);
      // Without --interactive, docker run never hands stdin to the CLI.
      expect(calls[2]?.args).toContain("--interactive");
      // The CLI's own sandbox is off, so these outer controls are the boundary.
      for (const { args } of containerRuns) {
        expect(args).toEqual(
          expect.arrayContaining([
            "--runtime=runsc",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
          ]),
        );
        expect(
          args.filter(
            (arg) =>
              arg === "--privileged" ||
              arg.startsWith("--cap-add") ||
              arg === "--network=host" ||
              arg.startsWith("--pid=") ||
              arg.startsWith("--ipc=") ||
              arg.startsWith("--volume") ||
              arg.includes("docker.sock"),
          ),
        ).toEqual([]);
      }
      // Only the Trial notes and isolated CLI home are writable bind mounts.
      expect(
        calls[2]?.args.filter((arg) => arg.startsWith("--mount=")),
      ).toEqual([
        `--mount=type=bind,src=${source},dst=/workspace/main,readonly`,
        expect.stringMatching(
          /^--mount=type=bind,src=.+,dst=\/workspace\/research$/,
        ),
        expect.stringMatching(
          /^--mount=type=bind,src=.+,dst=\/opt\/codex-support,readonly$/,
        ),
        expect.stringMatching(/^--mount=type=bind,src=.+,dst=\/tmp\/codex$/),
      ]);
      expect(
        calls[2]?.args.filter((arg) => arg.startsWith("--network")),
      ).toEqual(["--network=internal-run"]);
      const core = join(root, "wordpress-core");
      await mkdir(core);
      await writeFile(join(core, "version.php"), "<?php // fixed core");
      const coreTree = await measureCanonicalSourceTree(core, {
        maxEntries: 10,
        maxBytes: 1024,
      });
      const dependencyMount = {
        directory: core,
        path: "/workspace/wordpress" as const,
        mode: "ro" as const,
        expectedTree: coreTree,
      };
      await sandbox.execute({ ...command, dependencyMount });
      expect(
        calls.filter(({ args }) => args[0] === "run").at(-1)?.args,
      ).toContain(
        `--mount=type=bind,src=${core},dst=/workspace/wordpress,readonly`,
      );
      await writeFile(join(core, "version.php"), "changed core");
      await expect(
        sandbox.execute({ ...command, dependencyMount }),
      ).rejects.toThrow("fixed snapshot tree");
      Object.assign(dependencyMount, { path: "/workspace/else" });
      await expect(
        sandbox.execute({ ...command, dependencyMount }),
      ).rejects.toThrow();
      await expect(
        sandbox.execute({
          ...command,
          sourceMount: {
            ...command.sourceMount,
            expectedTree: { ...expectedTree, digest },
          },
        }),
      ).rejects.toThrow();
      await sandbox.execute({
        ...command,
        databaseHost: { name: "database", ipv4: "172.20.0.3" },
      });
      expect(
        calls.filter(({ args }) => args[0] === "run").at(-1)?.args,
      ).toContain("--add-host=database:172.20.0.3");
      await expect(
        sandbox.execute({
          ...command,
          databaseHost: { name: "wordpress", ipv4: "172.20.0.3" },
        }),
      ).rejects.toThrow();
      researchContents = Buffer.alloc(8 * 1024 * 1024 + 1, 0x61);
      const truncated = await sandbox.execute(command);
      expect(truncated.research?.truncated).toBe(true);
      expect(
        truncated.research &&
          JSON.parse(truncated.research.archive.toString("utf8")),
      ).toMatchObject({
        truncated: true,
        collectedBytes: 8 * 1024 * 1024,
        entries: [{ path: "REGISTRY.md", truncated: true }],
      });
      expect(calls).toHaveLength(16);
      expect(new Set(researchDirectories).size).toBe(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("probes the image's CLI version and catalog digest without network or source", async () => {
    const root = await mkdtemp(join(tmpdir(), "gvisor-codex-"));
    try {
      const calls: (readonly string[])[] = [];
      const sandbox = new GvisorCodexSandbox({
        dockerExecutablePath: "/usr/bin/docker",
        image: `node@${digest}`,
        bundledCatalogPath: "/opt/codex/model-catalog.json",
        scratchRootDirectory: root,
        maxOutputBytes: 1024 * 1024,
        timeoutMs: 60_000,
        runDocker: async (args) => {
          calls.push(args);
          return {
            kind: "exited",
            exitCode: 0,
            stdout: args.includes("--version")
              ? "codex-cli 0.162.0\n"
              : `${"c".repeat(64)}  /opt/codex/model-catalog.json\n`,
            stderr: "",
          };
        },
      });
      expect(await sandbox.probe()).toEqual({
        cliVersion: "0.162.0",
        bundledCatalogDigest: `sha256:${"c".repeat(64)}`,
      });
      expect(calls).toHaveLength(2);
      for (const args of calls) {
        expect(args).toEqual(
          expect.arrayContaining(["--runtime=runsc", "--network=none"]),
        );
        expect(args.some((arg) => arg.startsWith("--mount="))).toBe(false);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
