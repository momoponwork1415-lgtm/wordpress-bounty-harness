import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";

import { canonicalDigest } from "../../src/infrastructure/canonical-json.js";
import { measureCanonicalSourceTree } from "../../src/infrastructure/canonical-source-tree.js";
import {
  CodexOneShotRuntime,
  GvisorCodexSandbox,
  ProviderAttachmentStore,
  defineAgentRuntimeProfile,
  providerCredentialEgressReceiptSchema,
  type OneShotRun,
  type ProviderCredentialEgressBroker,
} from "../../src/discovery/index.js";
import { wordPressLabCommandRule } from "../../src/profiles/wordpress/discovery/lab-commands.js";

const digest = `sha256:${"a".repeat(64)}`;
const image = `codex@${digest}`;
const profile = defineAgentRuntimeProfile({
  id: "codex",
  transportKind: "codex-native/v1",
  sandboxImageDigest: digest,
  requestedModelId: "gpt-6-sol",
  requestedEffort: "high",
  codexCliVersion: "0.161.0",
  bundledCatalogDigest: digest,
  authenticationMethod: "host-private-bearer",
  cyberAccessProgram: "unavailable",
  serviceTier: "unavailable",
  subagent: { modelId: "gpt-6-sol", effort: "high" },
});
const files = [
  "http.json",
  "steps.md",
  "route.json",
  "session.json",
  "refutation.md",
  "precondition",
];
const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});

async function fixture(mode = "complete") {
  const root = await mkdtemp(join(tmpdir(), "codex-one-shot-lab-"));
  directories.push(root);
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "main.txt"), "fixed source");
  const sourceTree = await measureCanonicalSourceTree(source, {
    maxEntries: 10,
    maxBytes: 1024,
  });
  let revoked = false;
  const trace: string[] = [];
  const controller = new AbortController();
  const broker: ProviderCredentialEgressBroker = {
    async withGrant(request, operation) {
      expect(request.agentNetworkName).toBe(
        mode === "none" ? undefined : "lab-internal",
      );
      const { agentNetworkName: _network, ...grantRequest } = request;
      const body = {
        ...grantRequest,
        grantId: "grant-1",
        brokerImage: `broker@${digest}`,
        upstreamOrigin: "https://api.openai.com/v1",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        setup: { status: "ready" },
        cleanup: { status: "completed" },
        isolation: {
          backend: "gvisor",
          runtime: "runsc",
          fallbackUsed: false,
          agentNetworkInternal: true,
        },
      };
      const value = await operation({
        baseUrl: "http://172.30.0.2:8080",
        authorization: `Bearer ${randomBytes(32).toString("hex")}`,
        dockerNetworkName: request.agentNetworkName ?? "provider-egress-1",
        model: request.model,
        protocol: request.protocol,
        expiresAt: request.expiresAt,
      });
      return {
        operation: { status: "completed", value },
        receipt: providerCredentialEgressReceiptSchema.parse({
          ...body,
          digest: canonicalDigest(body),
        }),
      };
    },
  };
  const sandbox = new GvisorCodexSandbox({
    dockerExecutablePath: "/usr/bin/docker",
    image,
    bundledCatalogPath: "/opt/codex/model-catalog.json",
    scratchRootDirectory: root,
    ownerDirectory: join(root, "owners"),
    maxOutputBytes: 1024 * 1024,
    timeoutMs: 5000,
    runDocker: async (args, _stdin, _timeout, signal) => {
      let stdout = args.includes("--version")
        ? "codex-cli 0.161.0\n"
        : args.includes("--entrypoint=sha256sum")
          ? `${digest.slice(7)}  catalog\n`
          : "";
      if (
        args.includes("--network=lab-internal") ||
        args.includes("--network=provider-egress-1")
      ) {
        expect(args).toContain("--runtime=runsc");
        if (mode === "none")
          expect(args.some((arg) => arg.startsWith("--add-host="))).toBe(false);
        else expect(args).toContain("--add-host=wordpress:172.20.0.2");
        const mount = (path: string, readonly: boolean) => {
          const value = args.find((arg) => arg.includes(`dst=${path}`))!;
          expect(value.endsWith(",readonly")).toBe(readonly);
          return /src=([^,]+)/.exec(value)![1]!;
        };
        const input = mount("/workspace/input", true),
          output = mount("/workspace/output", false);
        if (mode !== "none") {
          expect(
            JSON.parse(await readFile(join(input, "lab.json"), "utf8")),
          ).toEqual({ administrator: "synthetic-setup-only" });
          await expect(readFile(join(input, "attack.json"))).rejects.toThrow();
          const held = await open(join(input, "lab.json"), "r");
          try {
            trace.push("setup-done");
            if (mode === "expired") await sleep(250);
            else if (mode === "marker-link")
              await symlink(
                join(source, "main.txt"),
                join(output, "setup-done.json"),
              );
            else if (mode !== "early")
              await writeFile(
                join(output, "setup-done.json"),
                mode === "malformed" ? "not json" : "{}",
              );
            if (
              [
                "boundary",
                "expired",
                "early",
                "marker-link",
                "malformed",
                "hung",
                "wall",
                "operator",
              ].includes(mode)
            ) {
              if (mode === "operator") controller.abort("operator");
              if (mode === "wall")
                await new Promise<void>((resolve) => {
                  signal!.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
                  if (signal!.aborted) resolve();
                });
              await sleep(50);
              await expect(
                readFile(join(input, "attack.json")),
              ).rejects.toThrow();
              return {
                kind: "exited" as const,
                exitCode: 0,
                stdout: "",
                stderr: "",
              };
            }
            for (let attempts = 0; attempts < 100; attempts++) {
              if (
                await readFile(join(input, "attack.json"), "utf8").catch(
                  () => "",
                )
              )
                break;
              await sleep(5);
            }
            expect(revoked).toBe(true);
            expect(await held.readFile("utf8")).toBe("");
            await expect(readFile(join(input, "lab.json"))).rejects.toThrow();
            expect(
              JSON.parse(await readFile(join(input, "attack.json"), "utf8")),
            ).toEqual({ accounts: {} });
            trace.push("attack.json");
            await writeFile(join(output, "observation-ready.json"), "{}");
            for (const name of files)
              await writeFile(
                join(output, name),
                name.endsWith(".json") ? "{}" : "synthetic note",
              );
            trace.push("six-files");
          } finally {
            await held.close();
          }
        } else {
          await expect(readFile(join(input, "lab.json"))).rejects.toThrow();
          await writeFile(join(output, "ordinary.json"), "{}");
          await writeFile(join(output, "steps.md"), "ignored");
        }
        if (mode === "missing") await rm(join(output, "steps.md"));
        if (mode === "link") {
          await rm(join(output, "steps.md"));
          await symlink(join(source, "main.txt"), join(output, "steps.md"));
        }
        if (mode === "oversize")
          await truncate(join(output, "steps.md"), 8 * 1024 * 1024 + 1);
        if (mode === "count")
          for (let n = 0; n < 17; n++)
            await writeFile(join(output, `extra-${n}.json`), "{}");
        stdout = [
          { type: "thread.started", thread_id: "one-shot" },
          {
            type: "turn.completed",
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        ]
          .map((event) => JSON.stringify(event))
          .join("\n");
      }
      return { kind: "exited", exitCode: 0, stdout, stderr: "" };
    },
  });
  const attachments = new ProviderAttachmentStore(join(root, "evidence"));
  const run: OneShotRun = {
    runId: "one-shot-lab",
    targetSnapshotDigest: digest,
    profile,
    prompt: "Fixed role body.",
    inputFiles: [],
    toolFiles: [],
    output: "files",
    wallMs: mode === "wall" ? 100 : 5000,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    sourceDirectory: source,
    sourceTree,
    ...(mode === "none"
      ? {}
      : {
          lab: {
            endpoint: "http://wordpress",
            networkName: "lab-internal",
            internalIp: "172.20.0.2",
            labJson: JSON.stringify({ administrator: "synthetic-setup-only" }),
            administratorExpiresAt: new Date(
              Date.now() + (mode === "expired" ? 200 : 30_000),
            ).toISOString(),
            outputFileNames: files,
            async closeSetup() {
              revoked = true;
              trace.push("revoked");
              if (["hung", "wall", "operator"].includes(mode))
                return new Promise<string>(() => {});
              return mode === "boundary"
                ? undefined
                : JSON.stringify({ accounts: {} });
            },
          },
        }),
  };
  if (mode === "collision")
    (run.inputFiles as { name: string; content: string }[]).push({
      name: "lab.json",
      content: "{}",
    });
  const result = await new CodexOneShotRuntime(
    sandbox,
    broker,
    attachments,
    image,
    wordPressLabCommandRule,
  ).execute(run, controller.signal);
  return { result, trace, attachments, revoked };
}

it("hands setup to the Lab, removes administrator credentials, and seals the six files in the receipt", async () => {
  const { result, trace, attachments } = await fixture();
  expect(result.receipt).toMatchObject({
    terminal: "completed",
    reason: "unavailable",
  });
  expect(trace).toEqual(["setup-done", "revoked", "attack.json", "six-files"]);
  expect(result.outputFiles?.map((file) => file.name)).toEqual(
    [...files, "setup-done.json", "observation-ready.json"].sort(),
  );
  const sealed = await attachments.readByDigest(
    "diagnostic",
    result.receipt.diagnosticArtifactDigest,
  );
  expect(sealed.status).toBe("resolved");
  if (sealed.status !== "resolved") throw new Error("missing evidence");
  const evidence = JSON.parse(sealed.bytes.toString());
  expect(evidence.outputFiles).toEqual(result.outputFiles);
  expect(
    evidence.labHandoff.events.map((event: { event: string }) => event.event),
  ).toEqual(["setup-done", "attack-published"]);
});

it("does not complete a Lab run whose six output files are missing", async () => {
  const { result } = await fixture("missing");
  expect(result.receipt).toMatchObject({
    terminal: "incomplete",
    reason: "evidence",
  });
});

it.each([
  ["boundary", "evidence"],
  ["expired", "wall"],
  ["early", "evidence"],
  ["marker-link", "evidence"],
  ["malformed", "evidence"],
  ["link", "evidence"],
  ["oversize", "evidence"],
  ["count", "evidence"],
  ["collision", "policy"],
])("closes %s as incomplete (%s)", async (mode, reason) => {
  const { result, revoked } = await fixture(mode);
  expect(result.receipt).toMatchObject({ terminal: "incomplete", reason });
  if (mode !== "collision") expect(revoked).toBe(true);
});

it("keeps a run without a Lab on the broker network and collects JSON only", async () => {
  const { result, revoked } = await fixture("none");
  expect(result.receipt.terminal).toBe("completed");
  expect(result.outputFiles).toEqual([
    { name: "ordinary.json", content: "{}" },
  ]);
  expect(revoked).toBe(false);
});

it("ends without publishing attack data when setup completion never answers", async () => {
  const { result } = await Promise.race([
    fixture("hung"),
    sleep(300).then(() => {
      throw new Error("setup boundary did not stop");
    }),
  ]);
  expect(result.receipt).toMatchObject({
    terminal: "incomplete",
    reason: "evidence",
  });
});

it.each(["wall", "operator"])(
  "preserves %s when the Lab setup is pending",
  async (reason) => {
    const { result } = await fixture(reason);
    expect(result.receipt).toMatchObject({ terminal: "incomplete", reason });
  },
);
