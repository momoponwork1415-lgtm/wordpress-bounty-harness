import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/index.js";
import {
  createWordPressHostProfile,
  wordpressHostConfigSchema,
  type HostDockerRun,
} from "../../src/cli/wordpress-host.js";

const catalogHex = "c".repeat(64);
const image = (name: string, character: string) =>
  `${name}@sha256:${character.repeat(64)}`;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

type Docker = {
  readonly runsc?: boolean;
  readonly missingImage?: string;
  readonly cliVersion?: string;
};

const base64url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
/** A Codex CLI ChatGPT login file with synthetic values. */
const chatgptLogin = (exp: Date) =>
  JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: "synthetic",
      access_token: `${base64url({ alg: "none" })}.${base64url({
        exp: Math.floor(exp.getTime() / 1000),
      })}.c2ln`,
      refresh_token: "synthetic-refresh",
      account_id: "synthetic-account",
    },
  });

async function setup(
  docker: Docker = {},
  login?: { readonly expiresAt: Date },
) {
  const root = await mkdtemp(join(tmpdir(), "wbh-host-"));
  directories.push(root);
  const credentialFilePath = join(root, "provider-credential");
  await writeFile(
    credentialFilePath,
    login === undefined
      ? "synthetic-not-a-key\n"
      : chatgptLogin(login.expiresAt),
    { mode: 0o600 },
  );
  const proxyBundleDirectory = join(root, "bundle");
  await mkdir(proxyBundleDirectory);
  for (const file of [
    "provider-credential-proxy-cli.js",
    "provider-credential-proxy.js",
  ])
    await writeFile(join(proxyBundleDirectory, file), "// bundle\n");
  const configPath = join(root, "campaign.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      programmeBoundary: { version: "v1", text: "Synthetic boundary" },
      wordpressVersion: "6.8.3",
      lab: { siteTitle: "Lab", initialPosts: [], customerRole: false },
    }),
  );
  const host = wordpressHostConfigSchema.parse({
    schemaVersion: 1,
    dockerExecutablePath: "/usr/bin/docker",
    workDirectory: join(root, "work"),
    credentialFilePath,
    images: {
      database: image("mariadb", "1"),
      wordpress: image("wordpress", "2"),
      wordpressCli: image("wordpress-cli", "3"),
      browser: image("playwright", "4"),
      codex: image("codex", "5"),
      broker: image("node", "6"),
    },
    codex: {
      bundledCatalogPath: "/opt/codex/model-catalog.json",
      runtimeProfile: {
        id: "codex-sol-high",
        requestedModelId: "gpt-6.1-sol",
        requestedEffort: "high",
        codexCliVersion: "0.161.0",
        bundledCatalogDigest: `sha256:${catalogHex}`,
        authenticationMethod:
          login === undefined ? "host-private-bearer" : "chatgpt-oauth-host",
        cyberAccessProgram: "standard",
        serviceTier: "default",
        subagent: { modelId: "unavailable", effort: "unavailable" },
      },
    },
    wordfenceProgrammeTranscriptionPath: join(root, "absent.json"),
  });
  const calls: (readonly string[])[] = [];
  const runDocker: HostDockerRun = async (args) => {
    calls.push(args);
    const exited = (stdout: string, exitCode = 0) => ({
      kind: "exited" as const,
      exitCode,
      stdout,
      stderr: "",
    });
    if (args[0] === "version") return exited("29.0.0\n");
    if (args[0] === "info")
      return exited(
        JSON.stringify(
          docker.runsc === false ? { runc: {} } : { runc: {}, runsc: {} },
        ),
      );
    if (args[0] === "image")
      return args.at(-1) === docker.missingImage
        ? exited("", 1)
        : exited("sha256:id\n");
    if (args.includes("--entrypoint=codex"))
      return exited(`codex-cli ${docker.cliVersion ?? "0.161.0"}\n`);
    if (args.includes("--entrypoint=sha256sum"))
      return exited(`${catalogHex}  /opt/codex/model-catalog.json\n`);
    return exited("", 125);
  };
  const profile = await createWordPressHostProfile({
    host,
    runDocker,
    proxyBundleDirectory,
    fetch: () => Promise.reject(new Error("no network in tests")),
  });
  const run = async (
    argv: readonly string[] = ["runtime", "check", "--config", configPath],
  ) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(
      argv,
      { stateDirectory: join(root, "state"), profile },
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );
    return { code, stdout, stderr };
  };
  return { run, calls, credentialFilePath, configPath, root, profile };
}

/** Only checks run before an adapter exists: no target container, no network. */
const startedContainers = (calls: readonly (readonly string[])[]) =>
  calls.filter((args) => args[0] === "run" && !args.includes("--network=none"));

describe("WordPress host entry", () => {
  it("rejects retired non-handoff reverification before initializing host boundaries", async () => {
    const { run, calls, configPath, root } = await setup({ runsc: false });
    const result = await run([
      "review",
      "reverify",
      "--campaign",
      "synthetic",
      "--finding",
      "synthetic",
      "--config",
      configPath,
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr.join("\n")).toContain(
      "The legacy Codex Verifier is retired",
    );
    expect(calls).toEqual([]);
    await expect(lstat(join(root, "work"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps the existing host preflight for explicitly requested handoff reverification", async () => {
    const { run, calls, configPath, root } = await setup({ runsc: false });
    const result = await run([
      "review",
      "reverify",
      "--campaign",
      "synthetic",
      "--finding",
      "synthetic",
      "--config",
      configPath,
      "--handoff",
      join(root, "handoff"),
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr.join("\n")).toContain(
      "Host preflight failed; nothing was started",
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(startedContainers(calls)).toEqual([]);
  });

  it.each([
    ["wide", "none", 3, 2, 3, 135],
    ["wide", "none", 3, 2, 10, 135],
    ["wide", "attached", 0, 2, 3, 135],
    ["wide", "attached", 2, 2, 3, 195],
    ["wide", "attached", 3, 2, 3, 225],
    ["partitioned", "none", 3, 2, 3, 255],
    ["partitioned", "none", 3, 4, 3, 165],
    ["partitioned", "none", 3, 8, 3, 120],
  ] as const)(
    "budgets %s/%s resets=%s parallel=%s targets=%s as %s login minutes",
    async (mode, lab, maxResets, maxParallel, maximumTargets, expected) => {
      const { root, configPath, profile } = await setup();
      await mkdir(join(root, "work"));
      await writeFile(
        join(root, "absent.json"),
        JSON.stringify({
          schemaVersion: 1,
          transcribedAt: "2026-10-28",
          pages: ["programme", "terms", "report-form"].map((sourceKind) => ({
            kind: "wordfence-programme-page",
            schemaVersion: 2,
            sourceKind,
            assertions: {},
          })),
        }),
      );
      const config = JSON.parse(await readFile(configPath, "utf8"));
      await writeFile(
        configPath,
        JSON.stringify({
          ...config,
          runWallTimeMinutes: 120,
          discovery: {
            mode,
            lab: { mode: lab, maxResets },
            ...(mode === "partitioned"
              ? {
                  enumerator: { runtime: "codex" },
                  tracer: { runtime: "codex", maxParallel },
                }
              : {}),
          },
          resources: { maxConcurrentTargets: 1, memoryBudgetMiB: 36864 },
        }),
      );
      const selection = JSON.parse(
        await readFile(
          new URL(
            "../../src/profiles/wordpress/policy/selection.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const selectionPath = join(root, "selection.json");
      await writeFile(
        selectionPath,
        JSON.stringify({ ...selection, maximumTargets }),
      );
      const status = await profile.hostStatus!(
        { stateDirectory: root } as never,
        { configPath, selectionPath },
      );
      expect(status.loginMarginMinutes).toBe(expected);
    },
  );

  it("opens Codex partitioned roles without a Claude host section", async () => {
    const { run, configPath } = await setup();
    const config = JSON.parse(await readFile(configPath, "utf8"));
    await writeFile(
      configPath,
      JSON.stringify({
        ...config,
        discovery: {
          mode: "partitioned",
          enumerator: { runtime: "codex" },
          tracer: { runtime: "codex" },
        },
      }),
    );
    expect((await run()).code).toBe(0);
  });

  it("checks the host, then compares the probed Codex image with the runtime profile", async () => {
    const { run, calls } = await setup();
    const result = await run();
    expect(result).toEqual({
      code: 0,
      stdout: [
        "codex-cli  profile 0.161.0  image 0.161.0  ok",
        `catalog  profile sha256:${catalogHex}  image sha256:${catalogHex}  ok`,
      ],
      stderr: [],
    });
    expect(calls.map((args) => args.slice(0, 2).join(" "))).toEqual(
      expect.arrayContaining(["version --format", "info --format"]),
    );
    expect(
      calls.filter((args) => args[0] === "image").map((args) => args.at(-1)),
    ).toEqual([
      image("mariadb", "1"),
      image("wordpress", "2"),
      image("wordpress-cli", "3"),
      image("playwright", "4"),
      image("codex", "5"),
      image("node", "6"),
    ]);
    expect(startedContainers(calls)).toEqual([]);
  });

  it.each([
    {
      name: "runsc is not registered",
      docker: { runsc: false },
      item: "runsc: gVisor (runsc) is not a registered Docker runtime",
    },
    {
      name: "a pinned image is not present",
      docker: { missingImage: image("playwright", "4") },
      item: "image browser:",
    },
    {
      name: "the Codex image ships another CLI version",
      docker: { cliVersion: "0.162.0" },
      item: "codex-runtime: image codex-cli 0.162.0",
    },
  ])("does not start when $name", async ({ docker, item }) => {
    const { run, calls } = await setup(docker);
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.stderr.join("\n")).toContain(
      "Host preflight failed; nothing was started",
    );
    expect(result.stderr.join("\n")).toContain(item);
    expect(startedContainers(calls)).toEqual([]);
  });

  it("does not start when the credential file is readable by others", async () => {
    const { run, credentialFilePath } = await setup();
    await chmod(credentialFilePath, 0o644);
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.stderr.join("\n")).toContain(
      "credential: readable by others",
    );
  });

  it("checks that a ChatGPT login outlives the 120-minute Trial plus startup margin without printing it", async () => {
    const valid = await setup(
      {},
      { expiresAt: new Date(Date.now() + 9 * 24 * 60 * 60_000) },
    );
    const ok = await valid.run();
    expect(ok.code).toBe(0);
    const expiring = await setup(
      {},
      { expiresAt: new Date(Date.now() + 30 * 60_000) },
    );
    const failed = await expiring.run();
    expect(failed.code).toBe(1);
    expect(failed.stderr.join("\n")).toContain(
      "credential: the ChatGPT login is unreadable or expires within 135 minutes",
    );
    expect(failed.stderr.join("\n")).not.toContain("synthetic-account");

    const tooShort = await setup(
      {},
      { expiresAt: new Date(Date.now() + 90 * 60_000) },
    );
    const blocked = await tooShort.run();
    expect(blocked.code).toBe(1);
    expect(blocked.stderr.join("\n")).toContain("expires within 135 minutes");

    const longEnough = await setup(
      {},
      { expiresAt: new Date(Date.now() + 140 * 60_000) },
    );
    expect((await longEnough.run()).code).toBe(0);
  });

  it("rejects a host image that is not pinned by digest", () => {
    expect(() =>
      wordpressHostConfigSchema.shape.images.parse({
        database: "mariadb:11",
        wordpress: image("wordpress", "2"),
        wordpressCli: image("wordpress-cli", "3"),
        browser: image("playwright", "4"),
        codex: image("codex", "5"),
        broker: image("node", "6"),
      }),
    ).toThrow();
  });
});
