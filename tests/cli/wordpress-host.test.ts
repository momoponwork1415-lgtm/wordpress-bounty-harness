import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function setup(docker: Docker = {}) {
  const root = await mkdtemp(join(tmpdir(), "wbh-host-"));
  directories.push(root);
  const credentialFilePath = join(root, "provider-credential");
  await writeFile(credentialFilePath, "synthetic-not-a-key\n", { mode: 0o600 });
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
        authenticationMethod: "host-private-bearer",
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
  const run = async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(
      ["runtime", "check", "--config", configPath],
      { stateDirectory: join(root, "state"), profile },
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );
    return { code, stdout, stderr };
  };
  return { run, calls, credentialFilePath };
}

/** Only checks run before an adapter exists: no target container, no network. */
const startedContainers = (calls: readonly (readonly string[])[]) =>
  calls.filter((args) => args[0] === "run" && !args.includes("--network=none"));

describe("WordPress host entry", () => {
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
