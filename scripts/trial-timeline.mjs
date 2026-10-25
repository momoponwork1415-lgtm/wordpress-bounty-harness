#!/usr/bin/env node
// One Trial's delegation timeline, read from what the Harness already stores.
//
//   node scripts/trial-timeline.mjs --state <dir> --campaign <id> [--trial <trialId> | --run <runId>] [--work <dir>] [--json]
//
// Without --trial / --run it lists the campaign's Trials. Read-only: the ledger
// is opened read-only, Private Evidence and transcripts are only read. It prints
// times, counts and sha256 digests; it never prints delegation text, report
// text, candidate bodies, payloads or file contents (SPEC section 2, invariant 8).
//
// Sources (docs/reviews/2026-10-25-exploration-architecture-redesign.md section 8):
//   ledger        <state>/ledger.sqlite, table ledger_events
//   receipts      <state>/private-evidence/<digest>/content/receipt.json
//   transcripts   <work>/provider-attachments/diagnostic-<hex>/content/diagnostic.json
//                 (Claude: Root session transcript; Codex: Root and child rollouts)
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const USAGE =
  "usage: node scripts/trial-timeline.mjs --state <dir> --campaign <id> [--trial <trialId> | --run <runId>] [--work <dir>] [--json]";

// node:sqlite prints an ExperimentalWarning on stderr; drop only that one.
const emit = process.emit;
process.emit = function (name, ...args) {
  if (name === "warning" && args[0]?.name === "ExperimentalWarning")
    return false;
  return emit.call(this, name, ...args);
};
const { DatabaseSync } = await import("node:sqlite");
process.on("uncaughtException", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

const { values } = parseArgs({
  options: {
    state: { type: "string" },
    campaign: { type: "string" },
    trial: { type: "string" },
    run: { type: "string" },
    work: { type: "string" },
    json: { type: "boolean", default: false },
  },
  strict: true,
});
if (values.state === undefined || values.campaign === undefined)
  throw new Error(USAGE);
if (values.trial !== undefined && values.run !== undefined)
  throw new Error(`--trial and --run are exclusive. ${USAGE}`);

const stateDirectory = resolve(values.state);
const workDirectory = resolve(
  values.work ?? join(homedir(), ".local/share/wordpress-bounty-harness/work"),
);
const attachments = join(workDirectory, "provider-attachments");

// ---------------------------------------------------------------- helpers

const sha256 = (text) =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;
const ms = (iso) =>
  iso === undefined || iso === null ? null : Date.parse(iso);
const iso = (millis) =>
  millis === null || millis === undefined || Number.isNaN(millis)
    ? null
    : new Date(millis).toISOString();
const median = (numbers) => {
  const sorted = numbers.filter((n) => n !== null).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
// Only short identifier-like labels are printed; anything else becomes a digest.
const safeLabel = (text) =>
  typeof text === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(text)
    ? text
    : text === undefined || text === null
      ? null
      : sha256(String(text)).slice(0, 19);

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}
function readJsonLines(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A truncated line is skipped, like the Harness's own readers do.
    }
  }
  return out;
}
const receiptOf = (digest) =>
  digest === undefined
    ? undefined
    : readJsonFile(
        join(
          stateDirectory,
          "private-evidence",
          digest,
          "content",
          "receipt.json",
        ),
      );
// A diagnostic artifact digest names `diagnostic-<hex>` under provider-attachments.
const transcriptOf = (digest) =>
  digest === undefined
    ? undefined
    : readJsonLines(
        join(
          attachments,
          `diagnostic-${digest.replace(/^sha256:/, "")}`,
          "content",
          "diagnostic.json",
        ),
      );

// ----------------------------------------------------------------- ledger

const ledgerPath = join(stateDirectory, "ledger.sqlite");
if (!existsSync(ledgerPath)) throw new Error(`No ledger at ${ledgerPath}`);
const database = new DatabaseSync(ledgerPath, { readOnly: true });
const events = database
  .prepare(
    "select sequence, event_type, event_json from ledger_events where campaign_id = ? order by sequence",
  )
  .all(values.campaign)
  .map((row) => ({
    sequence: row.sequence,
    type: row.event_type,
    ...JSON.parse(row.event_json),
  }));
if (events.length === 0) throw new Error(`No events for ${values.campaign}`);

const startedEvents = events.filter((e) => e.type === "discovery-run-started");
const trialIds = [...new Set(startedEvents.map((e) => e.trialId))].filter(
  (t) => t !== undefined,
);

if (values.trial === undefined && values.run === undefined) {
  const rows = trialIds.map((trialId) => {
    const runs = startedEvents.filter((e) => e.trialId === trialId);
    const root = runs.find((e) => e.parentRunId === undefined);
    const finished = events.filter(
      (e) =>
        e.type === "discovery-run-finished" &&
        runs.some((r) => r.runId === e.runId) &&
        e.runId !== undefined &&
        runs.find((r) => r.runId === e.runId)?.parentRunId === undefined,
    );
    const last = finished.at(-1);
    return {
      trialId,
      runtime: root?.configuration?.runtime ?? "unknown",
      promptVariant: root?.configuration?.promptVariant ?? "unknown",
      rootSegments: runs.filter((r) => r.parentRunId === undefined).length,
      children: runs.filter((r) => r.parentRunId !== undefined).length,
      end: last ? endLabel(last) : "no-finish-event",
    };
  });
  if (values.json) console.log(JSON.stringify(rows, null, 2));
  else
    for (const r of rows)
      console.log(
        `${r.trialId}  ${r.runtime}  ${r.promptVariant}  rootSegments=${r.rootSegments} children=${r.children}  end=${r.end}`,
      );
  process.exit(0);
}

function endLabel(finished) {
  return [finished.outcome, finished.reason, finished.reasonDetail]
    .filter((x) => x !== undefined)
    .join("/");
}

const trialId =
  values.trial ??
  startedEvents.find((e) => e.runId === values.run)?.trialId ??
  undefined;
if (trialId === undefined || !trialIds.includes(trialId))
  throw new Error(`Trial not found in ${values.campaign}`);

// ------------------------------------------------------- runs of the Trial

const runs = new Map();
for (const e of startedEvents.filter((x) => x.trialId === trialId)) {
  runs.set(e.runId, {
    runId: e.runId,
    kind: e.parentRunId === undefined ? "root" : "child",
    parentRunId: e.parentRunId ?? null,
    resumesRun: e.resumesRun ?? null,
    segment: e.resumeSegment ?? 0,
    agentPath: e.configuration?.agentPath ?? null,
    runtime: e.configuration?.runtime ?? null,
    promptVariant: e.configuration?.promptVariant ?? null,
    startedSequence: e.sequence,
    finished: null,
    receipt: undefined,
    counts: { findings: 0, parked: 0, leads: 0, held: 0, rejected: 0 },
    groups: new Set(),
  });
}
for (const e of events) {
  if (e.runId === undefined || !runs.has(e.runId)) continue;
  const run = runs.get(e.runId);
  if (e.type === "discovery-run-finished") run.finished = e;
  else if (e.type === "finding-recorded") {
    run.counts.findings += 1;
    if (e.group?.id !== undefined) run.groups.add(e.group.id);
  } else if (e.type === "finding-parked") run.counts.parked += 1;
  else if (e.type === "lead-recorded") run.counts.leads += 1;
  else if (e.type === "candidate-held") run.counts.held += 1;
  else if (e.type === "candidate-rejected") run.counts.rejected += 1;
}
for (const run of runs.values()) {
  const artifact = run.finished?.artifacts?.find(
    (a) => a.kind === "native-run-receipt",
  );
  run.receipt = receiptOf(artifact?.digest);
  run.receiptDigest = artifact?.digest ?? null;
}
const rootRuns = [...runs.values()]
  .filter((r) => r.kind === "root")
  .sort(
    (a, b) => a.segment - b.segment || a.startedSequence - b.startedSequence,
  );
const childRuns = [...runs.values()].filter((r) => r.kind === "child");
if (rootRuns.length === 0) throw new Error("Trial has no Root run");

const runtime =
  rootRuns.find((r) => r.runtime !== null)?.runtime ??
  (rootRuns.find((r) => r.receipt)?.receipt?.claudeCliVersion !== undefined
    ? "claude-code/v1"
    : "unknown");
const isClaude = runtime === "claude-code/v1";
const isCodex = runtime === "codex-native/v1";

// ------------------------------------------------------ transcript parsing

/** Claude Root session transcript(s): Agent delegations, reports, Root's next action, final reports. */
function parseClaudeRoot(lines) {
  const out = {
    delegations: [], // {toolUseId, at, agentId, promptDigest, promptChars, labelDigest, labelChars}
    sendMessages: [], // {at, target}
    notifications: [], // {agentId, status, toolUses, durationMs, enqueuedAt, consumedAt}
    finalReports: [], // {at}
    actions: [], // {at, kind} Root's own tool calls / text, in order
  };
  const byToolUse = new Map();
  const open = new Map();
  for (const e of lines) {
    if (e.type === "assistant" && e.isSidechain !== true) {
      const content = Array.isArray(e.message?.content)
        ? e.message.content
        : [];
      for (const block of content) {
        if (block.type === "tool_use") {
          out.actions.push({ at: ms(e.timestamp), kind: block.name });
          if (block.name === "Agent") {
            const prompt =
              typeof block.input?.prompt === "string" ? block.input.prompt : "";
            const description =
              typeof block.input?.description === "string"
                ? block.input.description
                : "";
            const delegation = {
              toolUseId: block.id,
              at: ms(e.timestamp),
              agentId: null,
              promptDigest: prompt === "" ? null : sha256(prompt),
              promptChars: prompt.length,
              labelDigest:
                description === "" ? null : sha256(description).slice(0, 19),
              labelChars: description.length,
            };
            byToolUse.set(block.id, delegation);
            out.delegations.push(delegation);
          } else if (block.name === "StructuredOutput") {
            // The schema-bound final report (--json-schema) is a StructuredOutput tool call.
            out.finalReports.push({ at: ms(e.timestamp) });
          } else if (block.name === "SendMessage") {
            out.sendMessages.push({
              at: ms(e.timestamp),
              target: safeLabel(block.input?.to ?? block.input?.target),
            });
          }
        } else if (block.type === "text" && e.isApiErrorMessage !== true) {
          out.actions.push({ at: ms(e.timestamp), kind: "text" });
        }
      }
    } else if (e.type === "user" && e.isSidechain !== true) {
      const content = Array.isArray(e.message?.content)
        ? e.message.content
        : [];
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const delegation = byToolUse.get(block.tool_use_id);
        if (delegation && typeof e.toolUseResult?.agentId === "string")
          delegation.agentId = e.toolUseResult.agentId;
      }
    } else if (
      e.type === "queue-operation" &&
      typeof e.content === "string" &&
      e.content.startsWith("<task-notification")
    ) {
      const agentId = /<task-id>([^<]+)<\/task-id>/.exec(e.content)?.[1];
      if (agentId === undefined) continue;
      if (e.operation === "enqueue") {
        const note = {
          agentId,
          status: /<status>([^<]+)<\/status>/.exec(e.content)?.[1] ?? null,
          toolUses: Number(/<tool_uses>(\d+)</.exec(e.content)?.[1] ?? NaN),
          durationMs: Number(/<duration_ms>(\d+)</.exec(e.content)?.[1] ?? NaN),
          enqueuedAt: ms(e.timestamp),
          consumedAt: null,
        };
        if (Number.isNaN(note.toolUses)) note.toolUses = null;
        if (Number.isNaN(note.durationMs)) note.durationMs = null;
        out.notifications.push(note);
        open.set(agentId, note);
      } else if (e.operation === "remove" || e.operation === "dequeue") {
        const note = open.get(agentId);
        if (note && note.consumedAt === null) note.consumedAt = ms(e.timestamp);
      }
    }
  }
  return out;
}

/**
 * Fallback for receipts without a session file: the run's own stream-json.
 * It has no timestamps. Agent calls are paired with `harness.child-start`
 * hook events by order, and each `result` carries its turn's duration, so a
 * final report's time is the segment start plus the durations so far.
 */
function parseClaudeStream(lines, segmentStart) {
  const out = { delegations: [], finalReports: [], turns: 0 };
  const agentIds = lines
    .filter((e) => e.type === "harness.child-start")
    .map((e) => e.agentId);
  let elapsed = 0;
  for (const e of lines) {
    if (e.type === "assistant") {
      for (const block of Array.isArray(e.message?.content)
        ? e.message.content
        : []) {
        if (block.type !== "tool_use" || block.name !== "Agent") continue;
        const prompt =
          typeof block.input?.prompt === "string" ? block.input.prompt : "";
        const description =
          typeof block.input?.description === "string"
            ? block.input.description
            : "";
        out.delegations.push({
          toolUseId: `stream-${out.delegations.length}`,
          at: null,
          agentId: agentIds[out.delegations.length] ?? null,
          promptDigest: prompt === "" ? null : sha256(prompt),
          promptChars: prompt.length,
          labelDigest:
            description === "" ? null : sha256(description).slice(0, 19),
          labelChars: description.length,
        });
      }
    } else if (e.type === "result" && typeof e.duration_ms === "number") {
      elapsed += e.duration_ms;
      out.turns += 1;
      if (e.stop_reason !== "refusal" && e.is_error !== true)
        out.finalReports.push({
          at: segmentStart === null ? null : segmentStart + elapsed,
        });
    }
  }
  return out;
}

/** Codex Root rollout: spawn_agent / followup_task / send_message, child reports, final answers. */
function parseCodexRoot(lines) {
  const out = {
    turnsStarted: [],
    turnsCompleted: [],
    spawns: [], // {at, taskName, callId, cipherChars, threadId, agentPath}
    followups: [], // {at, target}
    sendMessages: [], // {at, target}
    reports: [], // {at, author}
    activity: [], // {at, kind, agentPath}
    finalReports: [], // {at}
    actions: [],
  };
  const spawnByCall = new Map();
  for (const e of lines) {
    const p = e.payload;
    if (p === undefined || p === null) continue;
    const at = ms(e.timestamp);
    if (e.type === "event_msg" && p.type === "task_started")
      out.turnsStarted.push(at);
    else if (e.type === "event_msg" && p.type === "task_complete")
      out.turnsCompleted.push(at);
    else if (e.type === "response_item" && p.type === "function_call") {
      let args;
      try {
        args = JSON.parse(p.arguments);
      } catch {
        args = {};
      }
      out.actions.push({
        at,
        kind: p.name,
        ...(p.name === "followup_task" || p.name === "send_message"
          ? { target: safeLabel(args.target) }
          : {}),
      });
      if (p.name === "spawn_agent") {
        const spawn = {
          at,
          taskName: safeLabel(args.task_name),
          callId: p.call_id,
          cipherChars:
            typeof args.message === "string" ? args.message.length : null,
          threadId: null,
          agentPath: null,
        };
        spawnByCall.set(p.call_id, spawn);
        out.spawns.push(spawn);
      } else if (p.name === "followup_task")
        out.followups.push({ at, target: safeLabel(args.target) });
      else if (p.name === "send_message")
        out.sendMessages.push({ at, target: safeLabel(args.target) });
    } else if (e.type === "response_item" && p.type === "custom_tool_call")
      out.actions.push({ at, kind: p.name ?? "tool" });
    else if (e.type === "event_msg" && p.type === "item_completed") {
      const item = p.item;
      if (item?.type === "SubAgentActivity") {
        out.activity.push({
          at: item.completed_at_ms ?? at,
          kind: item.kind,
          agentPath: item.agent_path ?? null,
        });
        const spawn = spawnByCall.get(item.id);
        if (item.kind === "started" && spawn) {
          spawn.threadId = item.agent_thread_id ?? null;
          spawn.agentPath = item.agent_path ?? null;
        }
      } else if (
        item?.type === "AgentMessage" &&
        item.phase === "final_answer"
      ) {
        out.finalReports.push({ at });
        out.actions.push({ at, kind: "text" });
      }
    } else if (e.type === "response_item" && p.type === "agent_message") {
      if (typeof p.author === "string" && p.recipient === "/root")
        out.reports.push({ at, author: p.author });
    }
  }
  return out;
}

/** Codex child rollout: turns (task_started) and first/last event times. */
function parseCodexChild(lines) {
  let turns = 0;
  let first = null;
  let last = null;
  for (const e of lines) {
    const at = ms(e.timestamp);
    if (at !== null) {
      first = first === null ? at : Math.min(first, at);
      last = last === null ? at : Math.max(last, at);
    }
    if (e.type === "event_msg" && e.payload?.type === "task_started")
      turns += 1;
  }
  return { turns, first, last };
}

// ---------------------------------------------------- Root-side gathering

const unavailable = [];
const segmentTranscripts = [];
for (const root of rootRuns) {
  const sessionFiles = root.receipt?.session?.files ?? [];
  const rootFile = sessionFiles.find((f) => f.kind === "root");
  const digest = rootFile?.diagnosticArtifactDigest;
  const lines = transcriptOf(digest);
  const streamLines =
    lines === undefined && isClaude
      ? transcriptOf(root.finished?.diagnosticArtifactDigest)
      : undefined;
  if (lines === undefined && streamLines === undefined)
    unavailable.push(
      `Root transcript of segment ${root.segment}: ${
        digest === undefined
          ? "no session file in the receipt"
          : "diagnostic not on disk"
      }`,
    );
  segmentTranscripts.push({ root, lines, streamLines, sessionFiles });
}

let claude = null;
let codex = null;
if (isClaude) {
  claude = {
    delegations: [],
    sendMessages: [],
    notifications: [],
    finalReports: [],
    actions: [],
  };
  const seenToolUse = new Set();
  const seenNotes = new Set();
  for (const { root, lines, streamLines } of segmentTranscripts) {
    if (lines === undefined && streamLines !== undefined) {
      const parsed = parseClaudeStream(
        streamLines,
        ms(root.receipt?.startedAt),
      );
      claude.delegations.push(...parsed.delegations);
      claude.finalReports.push(...parsed.finalReports);
      unavailable.push(
        `Segment ${root.segment}: no session transcript in the receipt; the run stream gave delegations (paired with child-start by order) and final reports (time = segment start + result.duration_ms, approximate). No report or consumption times, no Root next action.`,
      );
      continue;
    }
    if (lines === undefined) continue;
    const parsed = parseClaudeRoot(lines);
    for (const d of parsed.delegations) {
      // A resumed session carries its earlier turns; count each delegation once.
      if (seenToolUse.has(d.toolUseId)) continue;
      seenToolUse.add(d.toolUseId);
      claude.delegations.push(d);
    }
    for (const n of parsed.notifications) {
      const key = `${n.agentId}:${n.enqueuedAt}`;
      if (seenNotes.has(key)) continue;
      seenNotes.add(key);
      claude.notifications.push(n);
    }
    claude.sendMessages.push(...parsed.sendMessages);
    claude.finalReports.push(...parsed.finalReports);
    claude.actions.push(...parsed.actions);
  }
  claude.actions.sort((a, b) => a.at - b.at);
  claude.finalReports.sort((a, b) => a.at - b.at);
}
if (isCodex) {
  codex = {
    turnsStarted: [],
    turnsCompleted: [],
    spawns: [],
    followups: [],
    sendMessages: [],
    reports: [],
    activity: [],
    finalReports: [],
    actions: [],
  };
  const seenSpawns = new Set();
  const seenItems = new Set();
  for (const { lines } of segmentTranscripts) {
    if (lines === undefined) continue;
    const parsed = parseCodexRoot(lines);
    for (const spawn of parsed.spawns) {
      const key = spawn.callId;
      if (seenSpawns.has(key)) continue;
      seenSpawns.add(key);
      codex.spawns.push(spawn);
    }
    for (const field of [
      "turnsStarted",
      "turnsCompleted",
      "followups",
      "sendMessages",
      "reports",
      "activity",
      "finalReports",
      "actions",
    ])
      // A resumed rollout may repeat earlier events; an identical item is the same event.
      for (const item of parsed[field]) {
        const key = `${field}:${JSON.stringify(item)}`;
        if (seenItems.has(key)) continue;
        seenItems.add(key);
        codex[field].push(item);
      }
  }
  codex.finalReports.sort((a, b) => a.at - b.at);
  codex.actions.sort((a, b) => a.at - b.at);
  // Root's next action after each child message (Codex has no consumption event).
  codex.nextAfterMessage = codex.reports.map((report) => {
    const next = codex.actions.find((a) => a.at >= report.at);
    if (next === undefined) return "none";
    if (next.kind === "followup_task" || next.kind === "send_message")
      return next.target === safeLabel(report.author.split("/").at(-1))
        ? `${next.kind}-same-child`
        : `${next.kind}-other-child`;
    return next.kind;
  });
}

// ----------------------------------------------------------- children rows

const trialStart =
  ms(rootRuns[0].receipt?.startedAt) ?? ms(claude?.delegations[0]?.at) ?? null;

const firstFinalReportAt =
  claude?.finalReports[0]?.at ?? codex?.finalReports[0]?.at ?? null;

const children = [];
for (const child of childRuns) {
  const parent = runs.get(child.parentRunId);
  const finished = child.finished;
  const receipt = child.receipt;
  const childKey = isClaude
    ? (child.agentPath?.split("/").at(-1) ??
      child.runId.slice((parent?.runId.length ?? 0) + 1))
    : child.runId; // Codex child run id is the thread id
  const row = {
    runId: child.runId,
    childKey,
    parentRunId: child.parentRunId,
    segment: parent?.segment ?? 0,
    label: null,
    delegation: { digest: "unavailable", chars: null },
    spawnedAt: null,
    startedAt: ms(receipt?.startedAt),
    finishedAt: ms(receipt?.completedAt),
    reportAt: null,
    consumedAt: null,
    nextRootAction: null,
    wallMs: finished?.wallTimeMs ?? null,
    outcome: finished ? endLabel(finished) : "no-finish-event",
    observed: finished?.observed ?? null,
    followups: 0,
    reports: 0,
    turns: null,
    candidates: { ...child.counts },
    groups: child.groups.size,
  };
  if (isClaude) {
    const delegation = claude.delegations.find((d) => d.agentId === childKey);
    if (delegation) {
      row.spawnedAt = delegation.at;
      row.delegation = {
        digest: delegation.promptDigest ?? "unavailable",
        chars: delegation.promptChars,
      };
      row.label = {
        digest: delegation.labelDigest,
        chars: delegation.labelChars,
      };
    }
    const note = claude.notifications.find((n) => n.agentId === childKey);
    if (note) {
      row.reportAt = note.enqueuedAt;
      row.consumedAt = note.consumedAt;
      row.reports = 1;
      const next = claude.actions.find(
        (a) => note.consumedAt !== null && a.at >= note.consumedAt,
      );
      row.nextRootAction = next
        ? { kind: next.kind, afterMs: next.at - note.consumedAt }
        : null;
    }
    row.followups = claude.sendMessages.filter(
      (m) => m.target === childKey,
    ).length;
  }
  if (isCodex) {
    const spawn = codex.spawns.find(
      (s) => s.threadId === childKey || s.agentPath === child.agentPath,
    );
    const taskName =
      child.agentPath?.split("/").at(-1) ?? spawn?.taskName ?? null;
    row.label = safeLabel(taskName);
    if (spawn) {
      row.spawnedAt = spawn.at;
      row.delegation = {
        digest: "unavailable",
        chars: null,
        encryptedChars: spawn.cipherChars,
      };
    }
    row.followups = codex.followups.filter((f) => f.target === taskName).length;
    row.followupsNote = "followup_task targeting the child's task name";
    const reports = codex.reports.filter((r) => r.author === child.agentPath);
    row.reports = reports.length;
    row.reportAt = reports[0]?.at ?? null;
    const sessionFile = segmentTranscripts
      .flatMap((s) => s.sessionFiles)
      .find((f) => f.kind === "child" && f.threadId === childKey);
    const childLines = transcriptOf(sessionFile?.diagnosticArtifactDigest);
    if (childLines !== undefined) row.turns = parseCodexChild(childLines).turns;
  }
  children.push(row);
}
children.sort(
  (a, b) =>
    (a.spawnedAt ?? a.startedAt ?? Infinity) -
    (b.spawnedAt ?? b.startedAt ?? Infinity),
);

// -------------------------------------------------------------- timeline

const rows = [];
const add = (at, segment, actor, kind, detail) =>
  rows.push({ at, segment, actor, kind, detail });
for (const root of rootRuns) {
  const r = root.receipt;
  add(ms(r?.startedAt), root.segment, "root", "root-start", {
    runId: root.runId,
    resumesRun: root.resumesRun,
    model: r?.requestedModelId ?? null,
    childModel: r?.subagent?.modelId ?? null,
  });
}
for (const c of children) {
  const spawnAt = c.spawnedAt ?? c.startedAt;
  add(spawnAt, c.segment, "root", "delegate", {
    child: c.childKey,
    label: c.label,
    delegationDigest: c.delegation.digest,
    delegationChars: c.delegation.chars,
    ...(c.delegation.encryptedChars !== undefined
      ? { encryptedChars: c.delegation.encryptedChars }
      : {}),
  });
  if (c.reportAt !== null)
    add(c.reportAt, c.segment, c.childKey, "report-delivered", {
      reports: c.reports,
    });
  if (c.consumedAt !== null)
    add(c.consumedAt, c.segment, "root", "report-read", {
      child: c.childKey,
      nextRootAction: c.nextRootAction,
    });
  add(c.finishedAt, c.segment, c.childKey, "child-finish", {
    outcome: c.outcome,
    wallMs: c.wallMs,
    observed: c.observed,
    candidates: c.candidates,
  });
}
// A Root event belongs to the last resume segment that had started by then.
const segmentAt = (at) =>
  rootRuns.filter((r) => at !== null && ms(r.receipt?.startedAt) <= at).at(-1)
    ?.segment ?? 0;
for (const f of codex?.followups ?? [])
  add(f.at, segmentAt(f.at), "root", "followup", { target: f.target });
for (const m of claude?.sendMessages ?? [])
  add(m.at, segmentAt(m.at), "root", "followup", { target: m.target });
for (const f of [
  ...(codex?.finalReports ?? []),
  ...(claude?.finalReports ?? []),
])
  add(f.at, segmentAt(f.at), "root", "final-report", {});
for (const root of rootRuns)
  add(ms(root.receipt?.completedAt), root.segment, "root", "root-end", {
    outcome: root.finished ? endLabel(root.finished) : "no-finish-event",
    wallMs: root.finished?.wallTimeMs ?? null,
    observed: root.finished?.observed ?? null,
    candidates: root.counts,
  });
rows.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
for (const row of rows) {
  row.offsetSec =
    row.at === null || trialStart === null
      ? null
      : Math.round((row.at - trialStart) / 100) / 10;
  row.at = iso(row.at);
}

// --------------------------------------------------------------- summary

const sum = (key) => [...runs.values()].reduce((n, r) => n + r.counts[key], 0);
const fromChildren = (key) => childRuns.reduce((n, r) => n + r.counts[key], 0);
const findingsTotal = sum("findings") + sum("parked");
const findingsFromChildren = fromChildren("findings") + fromChildren("parked");
const distinct = (items) =>
  new Set(items.filter((x) => x !== "unavailable")).size;
const delegationDigests = children
  .map((c) => c.delegation.digest)
  .filter((d) => d !== "unavailable");
const lastRoot = rootRuns.at(-1);
const childrenAfterFinal =
  firstFinalReportAt === null
    ? null
    : children.filter(
        (c) => c.finishedAt !== null && c.finishedAt > firstFinalReportAt,
      );
function activeSecondsAt(at) {
  if (at === null) return null;
  const index = rootRuns.reduce(
    (found, r, i) => (ms(r.receipt?.startedAt) <= at ? i : found),
    0,
  );
  const before = rootRuns
    .slice(0, index)
    .reduce((n, r) => n + (r.finished?.wallTimeMs ?? 0), 0);
  const startedAt = ms(rootRuns[index].receipt?.startedAt);
  return startedAt === null
    ? null
    : Math.round((before + (at - startedAt)) / 1000);
}
const summary = {
  campaignId: values.campaign,
  trialId,
  runtime,
  promptVariant: rootRuns[0].promptVariant,
  model: rootRuns[0].receipt?.requestedModelId ?? null,
  childModel: rootRuns[0].receipt?.subagent?.modelId ?? null,
  rootSegments: rootRuns.length,
  end: lastRoot.finished ? endLabel(lastRoot.finished) : "no-finish-event",
  trialWallMs: rootRuns.reduce((n, r) => n + (r.finished?.wallTimeMs ?? 0), 0),
  children: children.length,
  childrenWithDelegationDigest: delegationDigests.length,
  uniqueDelegationDigests: distinct(delegationDigests),
  // Codex: followup_task and send_message calls; Claude: SendMessage (none expected, children are one-shot).
  sameThreadFollowups:
    (codex?.followups.length ?? 0) +
    (codex?.sendMessages.length ?? 0) +
    (claude?.sendMessages.length ?? 0),
  followupTasks: codex?.followups.length ?? 0,
  childTurnsMedian: median(children.map((c) => c.turns)),
  childWallMsMedian: median(children.map((c) => c.wallMs)),
  childToolCallsMedian: median(
    children.map((c) => c.observed?.toolCalls ?? null),
  ),
  childFilesReadMedian: median(
    children.map((c) => c.observed?.filesRead ?? null),
  ),
  childUniqueFilesReadMedian: median(
    children.map((c) => c.observed?.uniqueFilesRead ?? null),
  ),
  findings: {
    recorded: sum("findings"),
    parked: sum("parked"),
    total: findingsTotal,
  },
  findingsFromChildren,
  findingShareFromChildren:
    findingsTotal === 0 ? null : findingsFromChildren / findingsTotal,
  leads: { total: sum("leads"), fromChildren: fromChildren("leads") },
  held: sum("held"),
  rootOwn: {
    findings: rootRuns.reduce(
      (n, r) => n + r.counts.findings + r.counts.parked,
      0,
    ),
    leads: rootRuns.reduce((n, r) => n + r.counts.leads, 0),
  },
  firstFinalReportAt: iso(firstFinalReportAt),
  firstFinalReportOffsetSec:
    firstFinalReportAt === null || trialStart === null
      ? null
      : Math.round((firstFinalReportAt - trialStart) / 1000),
  // Active time: earlier segments' wall plus the time inside the segment (resume gaps excluded).
  firstFinalReportActiveSec: activeSecondsAt(firstFinalReportAt),
  finalReports: (claude?.finalReports ?? codex?.finalReports ?? []).length,
  rootTurnsStarted: codex?.turnsStarted.length ?? null,
  childrenFinishedAfterFirstFinalReport: childrenAfterFinal?.length ?? null,
  candidatesOfChildrenFinishedAfterFirstFinalReport:
    childrenAfterFinal === null
      ? null
      : childrenAfterFinal.reduce(
          (n, c) =>
            n +
            c.candidates.findings +
            c.candidates.parked +
            c.candidates.leads,
          0,
        ),
  // Claude: Root's first action after it read a child report. Codex: after each child message.
  rootNextActionAfterReport: tally(
    codex
      ? codex.nextAfterMessage
      : children
          .map((c) => c.nextRootAction?.kind)
          .filter((k) => k !== undefined),
  ),
};
function tally(items) {
  const counts = {};
  for (const item of items) counts[item] = (counts[item] ?? 0) + 1;
  return counts;
}

const notDerivable = [
  "Event occurredAt in the ledger is the Trial start for every event of a segment (Issue 212); times here come from receipts and transcripts.",
  ...(isClaude
    ? [
        "Claude Root hook events (child-start/child-stop in the run stream) carry no time; delegation times come from the session transcript.",
        "Claude read-paths artifacts are empty; file counts come from observed.filesRead only.",
      ]
    : []),
  ...(isCodex
    ? ["Codex delegation text is encrypted: delegation digest is unavailable."]
    : []),
  "Candidates are attributed to the run that reported them, not to a time: candidates after the first final report cannot be counted for the Root's own runs.",
  ...unavailable,
];

const result = { summary, timeline: rows, children, notDerivable };

if (values.json) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

// ------------------------------------------------------------ text output

const clock = (offset) => {
  if (offset === null) return "      ?";
  const total = Math.round(offset);
  const sign = total < 0 ? "-" : "+";
  const abs = Math.abs(total);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  return `${sign}${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};
const short = (text) =>
  text === null || text === undefined ? "-" : String(text);
const digest12 = (d) =>
  d === "unavailable" || d === null ? "unavailable" : d.slice(7, 19);
function describe(row) {
  const d = row.detail;
  switch (row.kind) {
    case "root-start":
      return `run=${d.runId.slice(0, 8)} model=${short(d.model)} child-model=${short(d.childModel)}${d.resumesRun ? " resumes=" + d.resumesRun.slice(0, 8) : ""}`;
    case "delegate":
      return `child=${d.child} label=${typeof d.label === "string" ? d.label : d.label ? `chars:${d.label.chars}` : "-"} delegation=${digest12(d.delegationDigest)} chars=${short(d.delegationChars)}${d.encryptedChars !== undefined ? ` encrypted-chars=${d.encryptedChars}` : ""}`;
    case "report-delivered":
      return `messages-to-root=${d.reports}`;
    case "report-read":
      return `child=${d.child} next-root-action=${d.nextRootAction ? `${d.nextRootAction.kind}(+${Math.round(d.nextRootAction.afterMs / 1000)}s)` : "-"}`;
    case "child-finish":
      return `${d.outcome} wall=${d.wallMs === null ? "-" : Math.round(d.wallMs / 1000) + "s"} toolCalls=${d.observed?.toolCalls ?? "-"} files=${d.observed?.filesRead ?? "-"}/${d.observed?.uniqueFilesRead ?? "-"} findings=${d.candidates.findings} parked=${d.candidates.parked} leads=${d.candidates.leads}`;
    case "followup":
      return `target=${short(d.target)}`;
    case "followups":
      return `count=${d.count} distinct-targets=${d.targets}`;
    case "root-end":
      return `${d.outcome} wall=${d.wallMs === null ? "-" : Math.round(d.wallMs / 1000) + "s"} toolCalls=${d.observed?.toolCalls ?? "-"} files=${d.observed?.filesRead ?? "-"}/${d.observed?.uniqueFilesRead ?? "-"} findings=${d.candidates.findings} parked=${d.candidates.parked} leads=${d.candidates.leads}`;
    default:
      return "";
  }
}
const pad = (text, width) => String(text).padEnd(width);
// Text output folds follow-ups issued within 30 s of the first of a burst into one row; --json keeps each call.
function condense(source) {
  const folded = [];
  for (const row of source) {
    const last = folded.at(-1);
    if (
      row.kind === "followup" &&
      last?.kind === "followups" &&
      row.offsetSec !== null &&
      row.offsetSec - last.offsetSec <= 30
    ) {
      last.detail.count += 1;
      last.targetSet.add(row.detail.target);
      last.detail.targets = last.targetSet.size;
    } else if (row.kind === "followup")
      folded.push({
        ...row,
        kind: "followups",
        detail: { count: 1, targets: 1 },
        targetSet: new Set([row.detail.target]),
      });
    else folded.push(row);
  }
  return folded;
}
const out = [];
out.push(
  `Trial ${trialId}  campaign=${values.campaign}  runtime=${runtime}  prompt=${short(summary.promptVariant)}  model=${short(summary.model)} child-model=${short(summary.childModel)}`,
);
out.push(
  `segments=${summary.rootSegments} end=${summary.end} children=${summary.children} trial-wall=${Math.round(summary.trialWallMs / 1000)}s`,
);
out.push("");
out.push(
  `${pad("t+", 9)}${pad("seg", 4)}${pad("actor", 22)}${pad("event", 17)}detail`,
);
for (const row of condense(rows))
  out.push(
    `${pad(clock(row.offsetSec), 9)}${pad(row.segment, 4)}${pad(row.actor.slice(0, 20), 22)}${pad(row.kind, 17)}${describe(row)}`,
  );
out.push("");
out.push("Children");
out.push(
  `${pad("child", 22)}${pad("seg", 4)}${pad("delegation", 14)}${pad("chars", 7)}${pad("wall(s)", 9)}${pad("tools", 7)}${pad("files", 7)}${pad("uniq", 6)}${pad("turns", 6)}${pad("follow", 7)}${pad("msgs", 6)}${pad("F", 3)}${pad("P", 3)}${pad("L", 3)}outcome`,
);
for (const c of children)
  out.push(
    `${pad(c.childKey.slice(0, 20), 22)}${pad(c.segment, 4)}${pad(digest12(c.delegation.digest), 14)}${pad(short(c.delegation.chars), 7)}${pad(c.wallMs === null ? "-" : Math.round(c.wallMs / 1000), 9)}${pad(short(c.observed?.toolCalls), 7)}${pad(short(c.observed?.filesRead), 7)}${pad(short(c.observed?.uniqueFilesRead), 6)}${pad(short(c.turns), 6)}${pad(c.followups, 7)}${pad(c.reports, 6)}${pad(c.candidates.findings, 3)}${pad(c.candidates.parked, 3)}${pad(c.candidates.leads, 3)}${c.outcome}`,
  );
out.push("");
out.push("Summary");
out.push(
  `  delegations: ${summary.childrenWithDelegationDigest}/${summary.children} with digest, ${summary.uniqueDelegationDigests} unique`,
);
out.push(
  `  same-thread follow-ups: ${summary.sameThreadFollowups} (followup_task ${summary.followupTasks})`,
);
out.push(
  `  findings: ${summary.findings.recorded} recorded + ${summary.findings.parked} parked, from children ${summary.findingsFromChildren} (share ${summary.findingShareFromChildren === null ? "-" : summary.findingShareFromChildren.toFixed(2)}); leads ${summary.leads.total} (children ${summary.leads.fromChildren})`,
);
out.push(
  `  Root first final report: ${summary.firstFinalReportOffsetSec === null ? "unavailable" : clock(summary.firstFinalReportOffsetSec)} since Trial start, ${summary.firstFinalReportActiveSec === null ? "unavailable" : clock(summary.firstFinalReportActiveSec)} active (final reports: ${summary.finalReports}); children finishing after it: ${short(summary.childrenFinishedAfterFirstFinalReport)}`,
);
out.push(
  `  Root next action after a child report/message: ${
    Object.entries(summary.rootNextActionAfterReport)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ") || "unavailable"
  }`,
);
out.push("");
out.push("Not derivable today");
for (const line of notDerivable) out.push(`  - ${line}`);
console.log(out.join("\n"));
