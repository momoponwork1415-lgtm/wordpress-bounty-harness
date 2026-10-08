import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { measureCanonicalSourceTree } from "../../../src/infrastructure/canonical-source-tree.js";
import { canonicalDigest } from "../../../src/infrastructure/canonical-json.js";
import {
  openWordPressLab,
  type DockerRequest,
} from "../../../src/profiles/wordpress/lab/index.js";
import type { Snapshot } from "../../../src/snapshot/index.js";

const directories: string[] = [];
const sha = (value: string) => `sha256:${value.repeat(64)}`;

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(
  preflight: "ready" | "no-runsc" | "missing-image" = "ready",
) {
  const root = await mkdtemp(join(tmpdir(), "wbh-lab-"));
  directories.push(root);
  const sourceDirectory = join(root, "source");
  await mkdir(sourceDirectory);
  await writeFile(
    join(sourceDirectory, "example.php"),
    "<?php // harmless fixture\n",
  );
  const sourceTree = await measureCanonicalSourceTree(sourceDirectory, {
    maxEntries: 10,
    maxBytes: 1000,
  });
  const snapshotBody = {
    kind: "source-snapshot" as const,
    schemaVersion: 1 as const,
    target: {
      identity: "example",
      version: "1.0",
      sourceDigest: sourceTree.digest,
    },
    dependencies: [],
  };
  const snapshot: Snapshot = {
    ...snapshotBody,
    digest: canonicalDigest(snapshotBody),
  };
  const commands: DockerRequest[] = [];
  const lab = openWordPressLab({
    dockerExecutablePath: "/usr/bin/docker",
    images: {
      database: `mariadb@${sha("1")}`,
      wordpress: `wordpress@${sha("2")}`,
      wordpressCli: `wordpress-cli@${sha("3")}`,
    },
    source: {
      resolve: async () => ({
        target: { pluginSlug: "example", sourceDirectory, sourceTree },
        dependencies: [],
      }),
    },
    runner: {
      async run(request) {
        commands.push(request);
        if (request.args[0] === "info")
          return {
            exitCode: 0,
            stdout: preflight === "no-runsc" ? "{}" : '{"runsc":{}}',
            stderr: "",
          };
        if (request.args[0] === "image" && preflight === "missing-image")
          return { exitCode: 1, stdout: "", stderr: "unavailable" };
        if (request.args[0] === "inspect")
          return { exitCode: 0, stdout: "172.20.0.2", stderr: "" };
        if (request.args[0] === "exec" && request.args[2] === "cat")
          return { exitCode: 0, stdout: "fixed-nonce", stderr: "" };
        if (request.args.includes("eval"))
          return {
            exitCode: 0,
            stdout: "wbh-canary-fixed-nonce\n",
            stderr: "",
          };
        if (request.args.includes("--porcelain"))
          return { exitCode: 0, stdout: "7", stderr: "" };
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    },
    nonce: () => "fixed-nonce",
    healthAttempts: 1,
  });
  const setup = {
    schemaVersion: 1 as const,
    snapshotDigest: snapshot.digest,
    siteTitle: "Fixture",
    initialPosts: ["Welcome"],
    customerRole: false,
  };
  return { lab, snapshot, setup, commands, sourceDirectory };
}

describe("WordPress gVisor Lab", () => {
  it("provisions two independent internal labs, seeds canaries, and removes resources", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const first = await lab.provision(snapshot, setup);
    const second = await lab.provision(snapshot, setup);
    expect(first.status, JSON.stringify(commands)).toBe("ready");
    expect(second.status).toBe("ready");
    if (first.status !== "ready" || second.status !== "ready") return;
    expect(first.handle.id).not.toBe(second.handle.id);
    expect(first.handle.setupDigest).toMatch(/^sha256:/);
    expect(first.handle.internalIp).toBe("172.20.0.2");
    expect(first.handle.networkName).toMatch(/^wbh-.+-net$/);
    expect(
      commands.some(
        (command) =>
          command.args[0] === "inspect" && command.args.includes("--format"),
      ),
    ).toBe(true);
    expect(Object.keys(first.handle.attackerAccounts)).toEqual(["subscriber"]);
    expect(JSON.stringify(first.handle)).not.toContain("harness-admin");
    const canaries = await lab.seedCanaries(first.handle);
    expect(canaries.status).toBe("seeded");
    expect(lab.canaryLedger(first.handle)).toMatchObject({
      nonce: "fixed-nonce",
      postId: "7",
    });
    const execution = lab.prepareExecutionCanary(first.handle);
    expect(execution?.php).toContain("file_put_contents");
    if (execution !== null)
      expect(await lab.observeExecutionCanary(first.handle, execution)).toBe(
        "observed",
      );
    expect(
      commands
        .filter(
          (command) =>
            command.args[0] === "network" && command.args[1] === "create",
        )
        .every((command) => command.args.includes("--internal")),
    ).toBe(true);
    expect(
      commands
        .filter((command) => command.args[0] === "run")
        .every((command) => command.args.includes("--runtime=runsc")),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.args.includes("wp_magic_quotes") ||
          command.args.includes("WP_DEBUG") ||
          command.args.includes("allow_url_fopen"),
      ),
    ).toBe(false);
    expect(await lab.teardown(first.handle)).toEqual({ status: "removed" });
    expect(lab.canaryLedger(first.handle)).toBeNull();
    expect(await lab.teardown(second.handle)).toEqual({ status: "removed" });
  });

  it("resolves a presented session inside the Lab without placing it in PHP source", async () => {
    const { lab, snapshot, setup, commands } = await fixture();
    const provisioned = await lab.provision(snapshot, setup);
    if (provisioned.status !== "ready") throw new Error("not ready");
    expect(
      await lab.observeSessionUser(provisioned.handle, "synthetic%7C1%7Cvalue"),
    ).toEqual({ status: "user", login: "wbh-canary-fixed-nonce" });
    const evaluation = commands.find((command) =>
      command.args.includes("eval"),
    );
    expect(evaluation?.args).toContain(
      "WBH_SESSION_COOKIE=synthetic%7C1%7Cvalue",
    );
    expect(evaluation?.args).toContain("--runtime=runsc");
    expect(
      evaluation?.args.some(
        (arg) => arg.includes("synthetic") && arg.includes("wp_validate"),
      ),
    ).toBe(false);
    const before = commands.length;
    expect(
      await lab.observeSessionUser(provisioned.handle, "bad value'"),
    ).toEqual({ status: "none" });
    expect(commands.length).toBe(before);
  });

  it("does not start target containers when source differs from its snapshot", async () => {
    const { lab, snapshot, setup, commands, sourceDirectory } = await fixture();
    await writeFile(join(sourceDirectory, "example.php"), "changed");
    expect(await lab.provision(snapshot, setup)).toMatchObject({
      status: "incomplete",
      reason: "provision",
    });
    expect(commands.some((command) => command.args[0] === "run")).toBe(false);
  });

  it.each(["no-runsc", "missing-image"] as const)(
    "does not start target containers when %s preflight fails",
    async (failure) => {
      const { lab, snapshot, setup, commands } = await fixture(failure);
      expect(await lab.provision(snapshot, setup)).toMatchObject({
        status: "incomplete",
        reason: "provision",
      });
      expect(commands.some((command) => command.args[0] === "run")).toBe(false);
    },
  );
});
