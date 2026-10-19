import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { formatResumeRow } from "../../src/cli/index.js";
import { CLAUDE_RUNNER_SOURCE } from "../../src/discovery/claude-runner.js";
import {
  ANTHROPIC_UPSTREAM_ORIGIN,
  assessTrialResume,
  ClaudeNativeAgentRuntime,
  createNativeRunReceipt,
  defineClaudeRuntimeProfile,
  GvisorClaudeSandbox,
  ProviderAttachmentStore,
  providerCredentialEgressReceiptSchema,
  sealNativeRunReceipt,
  type ClaudeSandbox,
  type ClaudeSandboxCommand,
  type ClaudeSandboxResult,
  type DiscoveryResumeInput,
  type DiscoveryTransportRun,
  type NativeRunSession,
  type ProviderCredentialEgressBroker,
} from "../../src/discovery/index.js";
import { canonicalDigest } from "../../src/infrastructure/canonical-json.js";
import { measureCanonicalSourceTree } from "../../src/infrastructure/canonical-source-tree.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";

const digest = `sha256:${"a".repeat(64)}`;
const promptDigest = `sha256:${"c".repeat(64)}`;
const image = `claude@${digest}`;
const start = "2026-10-20T00:00:00.000Z";
const end = "2026-10-20T00:20:00.000Z";
const definition = {
  id: "opus",
  requestedModelId: "claude-opus-5-5",
  requestedEffort: "high",
  claudeCliVersion: "2.1.296",
  authenticationMethod: "anthropic-oauth-host",
  subagent: { modelId: "claude-opus-5-5", effort: "high" },
} as const;
const profile = defineClaudeRuntimeProfile(definition, digest);
const otherProfile = defineClaudeRuntimeProfile(
  { ...definition, requestedEffort: "medium" },
  digest,
);
const resumePrompt = "Before giving up, keep exploring.";
const prompt = `Objective.\n\n${resumePrompt}`;
const SESSION = "0f1e2d3c-4b5a-4968-8776-655443322110";
const ROOT_PATH = `-workspace-main/${SESSION}.jsonl`;
const childPath = (id: string) =>
  `-workspace-main/${SESSION}/subagents/agent-${id}.jsonl`;

const lines = (...events: unknown[]) =>
  events.map((event) => JSON.stringify(event)).join("\n");
const report = (claim: string) => ({
  findings: [JSON.stringify({ claim })],
  leads: [],
  examined: "source",
  unexamined: "none",
});
const init = { type: "system", subtype: "init", session_id: SESSION };
const success = {
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: SESSION,
  structured_output: report("root"),
};
const refusedTurn = {
  type: "assistant",
  message: {
    id: "refused",
    model: "claude-opus-5-5",
    stop_reason: "refusal",
    content: [],
  },
};
const childTranscript = (claim: string) =>
  lines({
    type: "assistant",
    timestamp: start,
    message: {
      id: `c-${claim}`,
      model: "claude-opus-5-5",
      content: [{ type: "text", text: JSON.stringify(report(claim)) }],
    },
  });

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function temporary(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

const run: DiscoveryTransportRun = {
  runId: "run-claude",
  targetSnapshotDigest: digest,
  profile,
  coordination: "cooperative",
  prompt,
  minimumActiveMs: 60_000,
  resumePrompt,
  sourceDirectory: "/private/source",
  sourceTree: { digest, entries: 1, bytes: 1 },
  campaignInput: {
    schemaVersion: 1,
    snapshotDigest: digest,
    trustBoundary: { version: "v1", text: "t" },
    programmeBoundary: { version: "v1", text: "p" },
    modelProfileDigest: profile.digest,
    promptDigest,
    stopRules: { maxRuns: 1, noFindingRuns: 1 },
    lab: { mode: "none" },
    history: { mode: "none" },
  },
  expiresAt: "2026-10-20T02:00:00.000Z",
};

const broker: ProviderCredentialEgressBroker = {
  async withGrant(request, operation) {
    const body = {
      schemaVersion: 1 as const,
      grantId: "grant-1",
      runtimeProfileDigest: request.runtimeProfileDigest,
      brokerImage: `broker@${digest}`,
      upstreamOrigin: ANTHROPIC_UPSTREAM_ORIGIN,
      model: request.model,
      protocol: request.protocol,
      maxRequests: request.maxRequests,
      maxRequestBytes: request.maxRequestBytes,
      maxResponseBytes: request.maxResponseBytes,
      expiresAt: request.expiresAt,
      startedAt: start,
      completedAt: end,
      setup: { status: "ready" as const },
      cleanup: { status: "completed" as const },
      metrics: {
        forwardedRequests: 4,
        requestLimitExceeded: 0,
        unauthorizedRequests: 0,
      },
      isolation: {
        backend: "gvisor" as const,
        runtime: "runsc" as const,
        fallbackUsed: false as const,
        agentNetworkInternal: true as const,
      },
    };
    const value = await operation({
      baseUrl: "http://172.30.0.2:8080",
      authorization: `Bearer ${randomBytes(32).toString("hex")}`,
      dockerNetworkName: "provider-egress-1",
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

async function claudeRuntime(
  result: Partial<ClaudeSandboxResult> & Pick<ClaudeSandboxResult, "stdout">,
) {
  const attachments = new ProviderAttachmentStore(
    await temporary("claude-resume-attachments-"),
  );
  const commands: ClaudeSandboxCommand[] = [];
  const sandbox: ClaudeSandbox = {
    async execute(command) {
      commands.push(command);
      return {
        status: "exited",
        exitCode: 0,
        startedAt: start,
        completedAt: end,
        image,
        cliVersion: "2.1.296",
        research: { archive: Buffer.from("{}"), truncated: false },
        isolation: { backend: "gvisor", runtime: "runsc", fallbackUsed: false },
        ...result,
      };
    },
  };
  return {
    runtime: new ClaudeNativeAgentRuntime(
      sandbox,
      broker,
      attachments,
      image,
      () => new Date(start),
    ),
    commands,
    attachments,
  };
}

function resumeOf(
  rootContent: string,
  childDigest = digest,
): DiscoveryResumeInput {
  return {
    threadId: SESSION,
    segment: 1,
    sessions: [
      {
        path: ROOT_PATH,
        threadId: SESSION,
        kind: "root",
        diagnosticArtifactDigest: digest,
        content: rootContent,
      },
      {
        path: childPath("old"),
        threadId: "old",
        kind: "child",
        diagnosticArtifactDigest: childDigest,
        content: childTranscript("old"),
      },
    ],
    research: [
      {
        path: "notes/plan.md",
        contentBase64: Buffer.from("plan\n").toString("base64"),
      },
    ],
  };
}

describe("Claude run session in the receipt (ADR 0036, 2026-10-20 addendum)", () => {
  it("records the Root session and every sealed transcript, Root and children", async () => {
    const { runtime, attachments } = await claudeRuntime({
      stdout: lines(init, success),
      transcripts: [
        { path: ROOT_PATH, content: lines({ type: "user" }) },
        { path: childPath("a1"), content: childTranscript("a1") },
      ],
    });
    const result = await runtime.execute({ ...run, minimumActiveMs: 1 });
    const session = result.receipt.session;
    expect(session).toMatchObject({
      rootThreadId: SESSION,
      rootTurns: 1,
      segment: 0,
    });
    expect(
      session?.files.map(({ path, kind, threadId }) => [path, kind, threadId]),
    ).toEqual([
      [ROOT_PATH, "root", SESSION],
      [childPath("a1"), "child", "a1"],
    ]);
    for (const file of session?.files ?? [])
      expect(
        (
          await attachments.readByDigest(
            "diagnostic",
            file.diagnosticArtifactDigest,
          )
        ).status,
      ).toBe("resolved");
  });

  it("records the session of a refused run too, so it can be resumed", async () => {
    const { runtime } = await claudeRuntime({
      stdout: lines(init, refusedTurn),
      exitCode: 3,
      transcripts: [{ path: ROOT_PATH, content: lines(refusedTurn) }],
    });
    const result = await runtime.execute(run);
    expect(result.receipt).toMatchObject({
      terminal: "incomplete",
      reason: "provider",
      reasonDetail: "provider-refusal",
      session: { rootThreadId: SESSION },
    });
  });
});

describe("Claude resume segment", () => {
  it("restores the transcripts and notes, starts from the session id, and records only new children", async () => {
    const restoredRoot = lines(init, refusedTurn);
    const { runtime, commands } = await claudeRuntime({
      // The resumed turn fails without a model answer; the old refusal is not this segment's stop.
      stdout: lines(init, {
        type: "harness.runner-error",
        message: "socket closed",
      }),
      exitCode: 1,
      transcripts: [
        {
          path: ROOT_PATH,
          content: `${restoredRoot}\n${lines({ type: "user" })}`,
        },
        { path: childPath("old"), content: childTranscript("old") },
        { path: childPath("new"), content: childTranscript("new") },
      ],
    });
    const result = await runtime.execute({
      ...run,
      resume: resumeOf(restoredRoot),
    });
    expect(commands).toHaveLength(1);
    const command = commands[0]!;
    expect(command.input).toMatchObject({
      prompt,
      resumePrompt,
      resumeSessionId: SESSION,
    });
    expect(command.resume?.sessionId).toBe(SESSION);
    expect(command.resume?.transcripts.map((file) => file.path)).toEqual([
      ROOT_PATH,
      childPath("old"),
    ]);
    expect(command.resume?.research).toEqual([
      { path: "notes/plan.md", content: Buffer.from("plan\n") },
    ]);
    expect(result.receipt).toMatchObject({
      terminal: "incomplete",
      reason: "provider",
      reasonDetail: "claude-exit:1",
      session: { rootThreadId: SESSION, segment: 1 },
    });
    expect(result.agentRuns?.map((child) => child.agentPath)).toEqual([
      "/root/new",
    ]);
    expect(result.receipt.session?.files.map((file) => file.threadId)).toEqual([
      SESSION,
      "old",
      "new",
    ]);
  });

  it("refuses a resume without the Root transcript or with Codex session files, before any grant", async () => {
    const { runtime, commands } = await claudeRuntime({ stdout: "" });
    const withoutRoot = resumeOf(lines(init));
    const codexPath = resumeOf(lines(init));
    for (const resume of [
      { ...withoutRoot, sessions: withoutRoot.sessions.slice(1) },
      {
        ...codexPath,
        sessions: codexPath.sessions.map((file) =>
          file.kind === "root"
            ? {
                ...file,
                path: "2026/10/20/rollout-2026-10-20T00-00-00-root.jsonl",
              }
            : file,
        ),
      },
    ]) {
      const result = await runtime.execute({ ...run, resume });
      expect(result.receipt).toMatchObject({
        terminal: "incomplete",
        reason: "policy",
        reasonDetail: "claude-run-not-admitted",
      });
    }
    expect(commands).toEqual([]);
  });
});

describe("Claude sandbox seed", () => {
  it("writes the restored transcripts and notes into the fresh directories before the container starts", async () => {
    const root = await temporary("claude-seed-");
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "fixed.php"), "<?php");
    const tree = await measureCanonicalSourceTree(source, {
      maxEntries: 10,
      maxBytes: 1024,
    });
    const seen: Record<string, string | undefined> = {};
    const sandbox = new GvisorClaudeSandbox({
      dockerExecutablePath: "/usr/bin/docker",
      image,
      scratchRootDirectory: root,
      maxOutputBytes: 1024 * 1024,
      timeoutMs: 60_000,
      runDocker: async (args, stdin) => {
        const mount = (target: string) =>
          args
            .find((arg) => arg.endsWith(`,dst=${target}`))
            ?.match(/src=([^,]+)/)?.[1];
        const home = mount("/tmp/claude");
        const notes = mount("/workspace/research");
        if (home !== undefined && notes !== undefined) {
          seen.transcript = await readFile(
            join(home, "projects", ROOT_PATH),
            "utf8",
          );
          seen.notes = await readFile(join(notes, "notes", "plan.md"), "utf8");
          seen.stdin = stdin;
        }
        return {
          kind: "exited",
          exitCode: 0,
          stdout: args.includes("--version") ? "2.1.296 (Claude Code)\n" : "",
          stderr: "",
        };
      },
    });
    const command = {
      grant: {
        baseUrl: "http://172.20.0.5:8080",
        authorization: `Bearer ${"t".repeat(43)}`,
        dockerNetworkName: "trial-internal",
        model: "claude-opus-5-5",
        protocol: "anthropic-messages" as const,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      input: {
        prompt,
        resumePrompt,
        minimumActiveMs: 1,
        model: "claude-opus-5-5",
        effort: "high",
        outputSchema: {},
        resumeSessionId: SESSION,
      },
      resume: {
        sessionId: SESSION,
        transcripts: [{ path: ROOT_PATH, content: "restored root\n" }],
        research: [{ path: "notes/plan.md", content: Buffer.from("plan\n") }],
      },
      sourceMount: { directory: source, expectedTree: tree },
      dependencyMounts: [],
    } satisfies ClaudeSandboxCommand;
    const result = await sandbox.execute(command);
    expect(seen).toEqual({
      transcript: "restored root\n",
      notes: "plan\n",
      stdin: expect.stringContaining(`"resumeSessionId":"${SESSION}"`),
    });
    // The restored transcript comes back with the segment's own capture.
    expect(result.transcripts?.map((file) => file.path)).toEqual([ROOT_PATH]);

    const { resume: seed, ...withoutSeed } = command;
    for (const refused of [
      // A session id without the files to resume it from.
      withoutSeed,
      {
        ...command,
        resume: { ...seed, sessionId: "another-session" },
      },
      {
        ...command,
        resume: {
          ...command.resume,
          transcripts: [{ path: "../escape.jsonl", content: "x" }],
        },
      },
      {
        ...command,
        resume: {
          ...command.resume,
          transcripts: [{ path: childPath("only"), content: "x" }],
        },
      },
    ])
      await expect(sandbox.execute(refused)).rejects.toThrow(
        "Claude sandbox command is not admitted",
      );
  });
});

describe("Claude runner resume", () => {
  it("starts on the restored session with the pinned directive, not the objective", async () => {
    const root = await temporary("claude-runner-resume-");
    const sdk = join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk");
    await mkdir(sdk, { recursive: true });
    await writeFile(
      join(sdk, "package.json"),
      JSON.stringify({
        name: "@anthropic-ai/claude-agent-sdk",
        type: "module",
        main: "index.js",
      }),
    );
    await writeFile(
      join(sdk, "index.js"),
      `export async function* query({ prompt, options }) {
  yield { type: "result", subtype: "success", is_error: false, session_id: options.resume ?? "new", prompt, resume: options.resume ?? null };
}`,
    );
    await writeFile(join(root, "runner.mjs"), CLAUDE_RUNNER_SOURCE);
    const child = promisify(execFile)(process.execPath, [
      join(root, "runner.mjs"),
    ]);
    child.child.stdin?.end(
      JSON.stringify({
        prompt: "objective",
        resumePrompt: "directive",
        minimumActiveMs: 1,
        model: "m",
        effort: "high",
        outputSchema: { type: "object" },
        resumeSessionId: "restored-session",
      }),
    );
    const { stdout } = await child;
    const first = stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((event) => event.type === "result");
    expect(first).toMatchObject({
      prompt: "directive",
      resume: "restored-session",
    });
  });
});

describe("assessTrialResume for a Claude run", () => {
  async function open() {
    const root = await temporary("claude-resume-ledger-");
    const attachments = new ProviderAttachmentStore(join(root, "attachments"));
    const evidence = new PrivateArtifactStore({
      rootDirectory: join(root, "evidence"),
      maxEntries: 20,
      maxBytes: 1024 * 1024,
    });
    const ledger = new Ledger({
      databasePath: join(root, "ledger.sqlite"),
      artifactStore: evidence,
    });
    return { attachments, evidence, ledger };
  }
  type Stores = Awaited<ReturnType<typeof open>>;

  /** A refused Claude run; `receiptSession` picks what its receipt holds. */
  async function record(
    stores: Stores,
    receiptSession:
      "recorded" | "diagnostic-only" | "none" | "evidence-missing",
  ) {
    const { attachments, evidence, ledger } = stores;
    const root = await attachments.put(
      "diagnostic",
      Buffer.from(lines(init, refusedTurn)),
    );
    const child = await attachments.put(
      "diagnostic",
      Buffer.from(childTranscript("a1")),
    );
    const rootDigest =
      receiptSession === "evidence-missing"
        ? `sha256:${"e".repeat(64)}`
        : root.digest;
    const diagnostic = await attachments.put(
      "diagnostic",
      Buffer.from(
        receiptSession === "none"
          ? lines(init, refusedTurn)
          : lines(init, refusedTurn, {
              type: "harness.transcripts",
              files: [
                { path: ROOT_PATH, digest: rootDigest },
                { path: childPath("a1"), digest: child.digest },
              ],
            }),
      ),
    );
    const session: NativeRunSession = {
      rootThreadId: SESSION,
      rootTurns: 1,
      segment: 0,
      files: [
        {
          path: ROOT_PATH,
          threadId: SESSION,
          kind: "root",
          diagnosticArtifactDigest: rootDigest,
        },
        {
          path: childPath("a1"),
          threadId: "a1",
          kind: "child",
          diagnosticArtifactDigest: child.digest,
        },
      ],
    };
    const receipt = createNativeRunReceipt({
      runId: "run-1",
      targetSnapshotDigest: digest,
      profile,
      terminal: "incomplete",
      reason: "provider",
      reasonDetail: "provider-refusal",
      startedAt: start,
      completedAt: end,
      diagnosticArtifactDigest: diagnostic.digest,
      ...(receiptSession === "recorded" || receiptSession === "evidence-missing"
        ? { session }
        : {}),
    });
    const base = {
      schemaVersion: 1 as const,
      campaignId: "campaign-1",
      snapshotDigest: digest,
      occurredAt: start,
    };
    await ledger.append({
      ...base,
      identity: "discovery-start-run-1",
      type: "discovery-run-started",
      runId: "run-1",
      trialId: "run-1",
      trialOrdinal: 0,
      runKind: "explore",
      labAttached: false,
      history: { mode: "none" },
      configuration: {
        promptVariant: "wp2shell-bounty-v8",
        promptDigest,
        runtime: "claude-code/v1",
      },
    });
    await ledger.append({
      ...base,
      identity: "discovery-finish-run-1",
      type: "discovery-run-finished",
      runId: "run-1",
      outcome: "failed",
      costUsd: "unavailable",
      wallTimeMs: 20 * 60_000,
      reason: "provider",
      reasonDetail: "provider-refusal",
      artifacts: [
        {
          kind: "native-run-receipt",
          digest: await sealNativeRunReceipt(evidence, receipt),
        },
      ],
    });
  }

  const assess = (stores: Stores, profileDigest = profile.digest) =>
    assessTrialResume({
      ledger: stores.ledger,
      evidence: stores.evidence,
      attachments: stores.attachments,
      campaignId: "campaign-1",
      runId: "run-1",
      snapshotDigest: digest,
      promptDigest,
      prompt,
      resumePrompt,
      profileDigest,
      wallTimeMs: 120 * 60_000,
      minimumActiveMs: 60 * 60_000,
    });

  it("admits a refused Claude run and gathers its transcripts under the same runtime", async () => {
    const stores = await open();
    await record(stores, "recorded");
    const assessment = await assess(stores);
    expect(assessment.status).toBe("resumable");
    if (assessment.status !== "resumable") return;
    expect(assessment.plan).toMatchObject({
      segment: 1,
      remainingWallMs: 100 * 60_000,
      minimumActiveMs: 40 * 60_000,
      configuration: { runtime: "claude-code/v1" },
      resume: { threadId: SESSION, segment: 1 },
    });
    expect(
      assessment.plan.resume.sessions.map(({ path, kind, content }) => [
        path,
        kind,
        content,
      ]),
    ).toEqual([
      [ROOT_PATH, "root", lines(init, refusedTurn)],
      [childPath("a1"), "child", childTranscript("a1")],
    ]);
  });

  it("reads the session of a receipt sealed before sessions were recorded from its sealed diagnostic", async () => {
    const stores = await open();
    await record(stores, "diagnostic-only");
    const assessment = await assess(stores);
    expect(assessment.status).toBe("resumable");
    if (assessment.status !== "resumable") return;
    expect(assessment.plan.resume.threadId).toBe(SESSION);
    expect(assessment.plan.resume.sessions.map((file) => file.kind)).toEqual([
      "root",
      "child",
    ]);
  });

  it("refuses a different runtime profile and missing session evidence, writing nothing", async () => {
    for (const [mode, profileDigest, reason] of [
      ["recorded", otherProfile.digest, "runtime-profile-differs"],
      ["none", profile.digest, "session-unrecorded"],
      ["evidence-missing", profile.digest, "session-evidence-missing"],
    ] as const) {
      const stores = await open();
      await record(stores, mode);
      const before = stores.ledger.readAll({ campaignId: "campaign-1" }).length;
      expect(await assess(stores, profileDigest)).toMatchObject({
        status: "refused",
        reason,
      });
      expect(stores.ledger.readAll({ campaignId: "campaign-1" })).toHaveLength(
        before,
      );
    }
  });

  it("shows a resumed segment, the stop it continued and how it ended in `ledger resumes`", async () => {
    const stores = await open();
    await record(stores, "recorded");
    const base = {
      schemaVersion: 1 as const,
      campaignId: "campaign-1",
      snapshotDigest: digest,
      occurredAt: end,
    };
    await stores.ledger.append({
      ...base,
      identity: "discovery-start-run-2",
      type: "discovery-run-started",
      runId: "run-2",
      trialId: "run-1",
      trialOrdinal: 0,
      runKind: "explore",
      resumesRun: "run-1",
      resumeSegment: 1,
      labAttached: false,
      history: { mode: "none" },
      configuration: {
        promptVariant: "wp2shell-bounty-v8",
        promptDigest,
        runtime: "claude-code/v1",
      },
    });
    expect(formatResumeRow(stores.ledger.resumes()[0]!)).toBe(
      "campaign-1  segment 1  run run-2  resumes run-1  after failed/provider/provider-refusal  runtime claude-code/v1  ended unfinished",
    );
    await stores.ledger.append({
      ...base,
      identity: "discovery-finish-run-2",
      type: "discovery-run-finished",
      runId: "run-2",
      outcome: "failed",
      costUsd: "unavailable",
      wallTimeMs: 12 * 60_000 + 30_000,
      reason: "provider",
      reasonDetail: "provider-refusal",
      artifacts: [],
    });
    const rows = stores.ledger.resumes({ campaignId: "campaign-1" });
    expect(rows.map(formatResumeRow)).toEqual([
      "campaign-1  segment 1  run run-2  resumes run-1  after failed/provider/provider-refusal  runtime claude-code/v1  ended failed/provider/provider-refusal  active 12.5 min",
    ]);
    expect(
      stores.ledger.resumes({ since: "2026-10-21T00:00:00.000Z" }),
    ).toEqual([]);
  });
});
