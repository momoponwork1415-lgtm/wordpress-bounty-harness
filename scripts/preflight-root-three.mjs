import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const workspace = resolve(fileURLToPath(new URL("../", import.meta.url)));
const { values } = parseArgs({
  options: { host: { type: "string" }, state: { type: "string" } },
  strict: true,
});
if (values.host === undefined || values.state === undefined)
  throw new Error(
    "usage: pnpm preflight:root-three --host <private host.json> --state <private directory>",
  );
const stateRoot = resolve(values.state);
if (stateRoot === workspace || stateRoot.startsWith(`${workspace}${sep}`))
  throw new Error("Preflight evidence must be outside the Git worktree");
const state = join(stateRoot, `preflight-${randomUUID()}`);
await mkdir(state, { recursive: true, mode: 0o700 });
try {
  const { loadWordPressHostConfig } =
    await import("../dist/cli/wordpress-host.js");
  const host = await loadWordPressHostConfig(resolve(values.host));
  const { canonicalDigest, canonicalJson } =
    await import("../dist/infrastructure/canonical-json.js");
  const { measureCanonicalSourceTree } =
    await import("../dist/infrastructure/canonical-source-tree.js");
  const {
    admitCooperativeRuntimeProfile,
    CODEX_COOPERATIVE_SANDBOX_MEMORY_MIB,
    defineAgentRuntimeProfile,
    GvisorCodexSandbox,
    CodexNativeAgentRuntime,
    createProviderCredentialEgressBroker,
    ProviderAttachmentStore,
  } = await import("../dist/discovery/index.js");
  const docker = (...args) =>
    execFileSync(host.dockerExecutablePath, args, {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const network = `wbh-preflight-${randomUUID().slice(0, 8)}`;
  const labName = `${network}-lab`;
  const sourceDirectory = join(state, "source");
  await mkdir(sourceDirectory, { mode: 0o700 });
  for (const [name, content] of Object.entries({
    "a.txt": "alpha red\n",
    "b.txt": "beta blue\n",
    "c.txt": "gamma green\n",
    "d.txt": "delta yellow\n",
  }))
    await writeFile(join(sourceDirectory, name), content, { mode: 0o600 });
  const sourceTree = await measureCanonicalSourceTree(sourceDirectory, {
    maxEntries: 10,
    maxBytes: 1024,
  });
  const imageDigest = host.images.codex.slice(
    host.images.codex.lastIndexOf("sha256:"),
  );
  const profile = defineAgentRuntimeProfile({
    ...host.codex.runtimeProfile,
    transportKind: "codex-native/v1",
    sandboxImageDigest: imageDigest,
  });
  const admitted = admitCooperativeRuntimeProfile(profile, host.images.codex);
  if (admitted.status !== "admitted")
    throw new Error(`Cooperative runtime profile rejected: ${admitted.status}`);
  const scratch = join(state, "scratch");
  const brokerScratch = join(state, "broker-scratch");
  const attachments = join(state, "attachments");
  await Promise.all(
    [scratch, brokerScratch, attachments].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );
  const sandbox = new GvisorCodexSandbox({
    dockerExecutablePath: host.dockerExecutablePath,
    image: host.images.codex,
    bundledCatalogPath: host.codex.bundledCatalogPath,
    scratchRootDirectory: scratch,
    maxOutputBytes: 16 * 1024 * 1024,
    timeoutMs: 5 * 60_000,
    memoryMiB: CODEX_COOPERATIVE_SANDBOX_MEMORY_MIB,
  });
  const runtime = new CodexNativeAgentRuntime(
    sandbox,
    createProviderCredentialEgressBroker({
      dockerExecutablePath: host.dockerExecutablePath,
      brokerImage: host.images.broker,
      credentialFilePath: host.credentialFilePath,
      credentialKind:
        profile.authenticationMethod === "chatgpt-oauth-host"
          ? "chatgpt-login"
          : "api-key",
      scratchRootDirectory: brokerScratch,
      proxyBundleDirectory: join(workspace, "dist", "discovery"),
    }),
    new ProviderAttachmentStore(attachments),
    host.images.codex,
  );
  const prompt = `Infrastructure preflight only. The source files are harmless text fixtures. Read /workspace/main/d.txt yourself and GET http://wordpress:8080/ with curl. Create exactly three subagents in parallel. Give each child one distinct file from /workspace/main/a.txt, b.txt, c.txt to read and ask it to GET http://wordpress:8080/ with curl. Each child must return only a JSON object with keys findings (empty array), leads (empty array), examined (short string), unexamined (short string). Wait for all three. Your final response must be the same JSON object shape, with findings and leads empty.`;
  let networkCreated = false;
  let labCreated = false;
  let receipt;
  let failure;
  const cleanupFailures = [];
  try {
    docker("network", "create", "--internal", network);
    networkCreated = true;
    docker(
      "run",
      "-d",
      "--pull=never",
      "--runtime=runsc",
      "--network",
      network,
      "--network-alias",
      "wordpress",
      "--name",
      labName,
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--entrypoint=node",
      host.images.broker,
      "-e",
      "require('http').createServer((_,r)=>{r.writeHead(200);r.end('preflight-ok')}).listen(8080,'0.0.0.0')",
    );
    labCreated = true;
    const labRuntime = docker(
      "inspect",
      "--format",
      "{{.HostConfig.Runtime}}",
      labName,
    );
    if (labRuntime !== "runsc")
      throw new Error("Lab did not start under runsc");
    const ip = docker(
      "inspect",
      "--format",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      labName,
    );
    const labProbe = docker(
      "run",
      "--rm",
      "--pull=never",
      "--runtime=runsc",
      "--network",
      network,
      `--add-host=wordpress:${ip}`,
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--entrypoint=node",
      host.images.broker,
      "-e",
      "require('http').get('http://wordpress:8080/',r=>{let s='';r.on('data',b=>s+=b);r.on('end',()=>process.stdout.write(s))}).on('error',e=>{console.error(e.message);process.exitCode=1})",
    );
    if (labProbe !== "preflight-ok")
      throw new Error("Lab internal HTTP probe failed");
    const run = {
      runId: randomUUID(),
      targetSnapshotDigest: sourceTree.digest,
      profile,
      prompt,
      lab: {
        endpoint: "http://wordpress:8080",
        networkName: network,
        internalIp: ip,
      },
      campaignInput: {
        schemaVersion: 1,
        snapshotDigest: sourceTree.digest,
        trustBoundary: {
          version: "preflight-v1",
          text: "Harmless text files and an isolated HTTP probe.",
        },
        programmeBoundary: {
          version: "preflight-v1",
          text: "No vulnerability testing.",
        },
        modelProfileDigest: profile.digest,
        promptDigest: canonicalDigest(prompt),
        stopRules: { maxRuns: 1, noFindingRuns: 1 },
        lab: { setupDigest: canonicalDigest({ network, labName }) },
        history: { mode: "none" },
      },
      sourceDirectory,
      sourceTree,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
    const result = await runtime.execute(run);
    const children = result.agentRuns ?? [];
    const ready =
      result.receipt.terminal === "completed" &&
      result.receipt.grantReceiptDigest !== "unavailable" &&
      result.receipt.diagnosticArtifactDigest !== undefined &&
      (result.receipt.observed?.filesRead ?? 0) > 0 &&
      (result.receipt.observed?.labRequests ?? 0) > 0 &&
      children.length === 3 &&
      children.every(
        ({ receipt: child }) =>
          child.terminal === "completed" &&
          child.diagnosticArtifactDigest !== undefined &&
          (child.observed?.filesRead ?? 0) > 0 &&
          (child.observed?.labRequests ?? 0) > 0,
      );
    receipt = {
      schemaVersion: 1,
      status: ready ? "ready" : "incomplete",
      reason: ready ? null : "agent-observation-incomplete",
      snapshotDigest: sourceTree.digest,
      profileDigest: profile.digest,
      root: result.receipt,
      children: children.map(({ agentPath, receipt: child }) => ({
        agentPath,
        receipt: child,
      })),
    };
  } catch (error) {
    failure = error;
    receipt = {
      schemaVersion: 1,
      status: "incomplete",
      reason: "environment-failure",
      snapshotDigest: sourceTree.digest,
      profileDigest: profile.digest,
      root: null,
      children: [],
    };
  } finally {
    if (labCreated) {
      try {
        docker("rm", "-f", labName);
      } catch {
        cleanupFailures.push("lab-remove");
      }
    }
    if (networkCreated) {
      try {
        docker("network", "rm", network);
      } catch {
        cleanupFailures.push("network-remove");
      }
    }
  }
  if (cleanupFailures.length > 0) {
    receipt = {
      ...receipt,
      status: "incomplete",
      reason: "cleanup-failure",
      cleanupFailures,
    };
  }
  if (failure !== undefined)
    await writeFile(
      join(state, "failure.txt"),
      String(failure.stack ?? failure),
      { mode: 0o600 },
    );
  const saved = canonicalJson(receipt);
  await writeFile(join(state, "preflight.json"), saved, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      status: receipt.status,
      reason: receipt.reason,
      receiptDigest: canonicalDigest(receipt),
      evidenceDirectory: state,
      root:
        receipt.root === null
          ? null
          : {
              terminal: receipt.root.terminal,
              observed: receipt.root.observed,
              usage: receipt.root.usage,
            },
      children: receipt.children.map(({ agentPath, receipt: child }) => ({
        agentPath,
        terminal: child.terminal,
        reason: child.reason,
        observed: child.observed,
        usage: child.usage,
      })),
    }),
  );
  if (receipt.status !== "ready") process.exitCode = 1;
} catch (error) {
  const fallback = {
    schemaVersion: 1,
    status: "incomplete",
    reason: "preflight-setup-failed",
    snapshotDigest: null,
    profileDigest: null,
    root: null,
    children: [],
  };
  try {
    await writeFile(join(state, "preflight.json"), JSON.stringify(fallback), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (writeError) {
    if (writeError?.code !== "EEXIST") throw writeError;
  }
  await writeFile(join(state, "failure.txt"), String(error?.stack ?? error), {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      status: "incomplete",
      reason: fallback.reason,
      evidenceDirectory: state,
    }),
  );
  process.exitCode = 1;
}
