#!/usr/bin/env node
// 検証ループ 1 周の「次にやること」を台帳から並べる、AI の道具（Issue #701）。
//
//   node scripts/verification-loop.ts [--state <dir>] [--units <path>]
//     [--lab-slots <n>] [--running-labs <id,...>] [--since <ISO>]
//     [--exclude-campaigns <regex>] [--mem-available-gib <n>] [--json]
//
// 手順は docs/agents/verification-loop.md。所有者決定 2026-10-27: scripts は AI の道具で、
// Harness の制御には入れない。台帳と Private Evidence は読み取り専用で開き、何も書かない。
// 段の判定はここでは行わない。各 Finding の最新の記録（判断の理由コード、検証の結果、
// 人間の観測）から、手順のどの節に回すかを機械的に振り分けるだけである。
// Lab の枠（--lab-slots、既定 8）はこの道具の既定値で、Harness は強制しない。
// 空きはさらに host の空きメモリで絞る（/proc/meminfo の MemAvailable、--mem-available-gib で上書き）。
// 予約を決め直すため、探索の sandbox と Lab の container の実使用（docker stats の合計）も出す。
//
// 入力:
//   台帳         <state>/ledger.sqlite の ledger_events
//   判断の理由   <state>/private-evidence/<digest>/content/record.json（review-decision）
//   報告単位     <state>/review-notes/report-units-*.json（既定は名前順で最後のもの、無くてもよい）
//   生きている Lab  docker ps の wbh-<labId>-wp。--running-labs で与えたらそれを使う。
//   検証中の Lab   <state>/handoff*/batch.json と <state>/handoff*/*/batch.json（verify next の一括）
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { DatabaseSync as Database } from "node:sqlite";

const USAGE =
  "usage: node scripts/verification-loop.ts [--state <dir>] [--units <path>] [--lab-slots <n>] [--running-labs <id,...>] [--since <ISO>] [--exclude-campaigns <regex>] [--mem-available-gib <n>] [--json]";

// node:sqlite は stderr に ExperimentalWarning を出す。その 1 種だけを落とす。
type Emit = (name: string | symbol, ...args: unknown[]) => boolean;
const processWithEmit = process as unknown as { emit: Emit };
const originalEmit: Emit = processWithEmit.emit.bind(process);
processWithEmit.emit = (name, ...args) => {
  const first = args[0] as { name?: unknown } | undefined;
  if (name === "warning" && first?.name === "ExperimentalWarning") return false;
  return originalEmit(name, ...args);
};
const { DatabaseSync } = await import("node:sqlite");
process.on("uncaughtException", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

const { values } = parseArgs({
  options: {
    state: { type: "string" },
    units: { type: "string" },
    "lab-slots": { type: "string", default: "8" },
    "mem-available-gib": { type: "string" },
    "running-labs": { type: "string" },
    since: { type: "string" },
    // 開発セットと配線確認の campaign。本番だけを回す（所有者 2026-10-26）。
    "exclude-campaigns": { type: "string", default: "^(tp326-|issue-?[0-9])" },
    json: { type: "boolean", default: false },
  },
  strict: true,
});

const stateDirectory = resolve(
  values.state ?? join(homedir(), ".local/state/wordpress-bounty-harness"),
);
const notesDirectory = join(stateDirectory, "review-notes");
const evidenceDirectory = join(stateDirectory, "private-evidence");
const labSlots = Number(values["lab-slots"]);
if (!Number.isInteger(labSlots) || labSlots < 0)
  throw new Error(`--lab-slots は 0 以上の整数。${USAGE}`);
const since =
  values.since ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
if (Number.isNaN(Date.parse(since)))
  throw new Error(`--since は ISO の時刻。${USAGE}`);
const excludedCampaign = new RegExp(values["exclude-campaigns"]);

// ---------------------------------------------------------------- 段の名前

/**
 * 手順書の節と 1 対 1 に対応する。理由コードは docs/agents/verification-loop.md の
 * 「段の印」の表と同じ。
 */
const SCREEN_PASS = "screen-v5-verify";
const SOURCE_CHECK_PASS = "source-check-pass";
const SOURCE_CHECK_UNKNOWN = "source-check-unknown";
const AWAITING_HUMAN = "awaiting-human-observation";
/** 止まった検証を 1 回やり直しても止まったとき、ループが打つ印。所有者の判断待ちになる。 */
const RETRY_EXHAUSTED = "loop-retry-exhausted";
/** Lab image の欠落で検証できない印。image が直ったら同じ Finding に lab-image-fixed を足して解く。 */
const LAB_IMAGE_BLOCKED = "lab-image-blocked";

type Stage =
  | "screen" // 段 1 がまだ
  | "source-check" // 段 1 の要検証。段 1b がまだ
  | "unit" // 段 1b の成立。報告単位がまだ
  | "lab" // 報告単位あり。Lab がまだ
  | "verifying" // verify next の一括に入り、Lab が生きていて、まだ結果が無い
  | "awaiting-human" // observation-ready の Lab が生きている
  | "awaiting-human-lab-gone" // 観測待ちだが Lab が消えた
  | "report" // 人間の観測が match。照合と報告書へ
  | "stalled" // 検証が観測待ち以外の incomplete などで止まった
  | "owner" // 段 1b の未決や人間の mismatch。所有者の判断待ち
  | "blocked" // Lab image の欠落待ち（lab-image-blocked）
  | "done"; // 除外、提出済み、parked

// ---------------------------------------------------------------- 台帳

interface FindingFacts {
  findingId: string;
  campaignId?: string | undefined;
  snapshotDigest?: string | undefined;
  category?: string | undefined;
  recordedAt?: string | undefined;
  parked: boolean;
  submitted: boolean;
  decision?: { decision: string; reasonCode: string; at: string };
  verification?: {
    status: string;
    reason?: string;
    verificationId?: string;
    at: string;
  };
  verificationAttempts: number;
  readyAt?: string;
  readyVerificationId?: string | undefined;
  observation?: { result: string; verificationId: string };
  /** 最新版の再検証（reverify）で派生した Finding があれば、元の Finding はそちらに任せる。 */
  derivedTo?: string;
}

const findings = new Map<string, FindingFacts>();
const slugBySnapshot = new Map<string, string>();
/** lab-provisioned の identity `verification-lab-<verificationId>` から labId を引く。 */
const labByVerification = new Map<string, string>();
/** verification-finished が出た verificationId。 */
const finishedVerifications = new Set<string>();

function facts(findingId: string): FindingFacts {
  let value = findings.get(findingId);
  if (value === undefined) {
    value = {
      findingId,
      parked: false,
      submitted: false,
      verificationAttempts: 0,
    };
    findings.set(findingId, value);
  }
  return value;
}

function reasonCodeOf(artifacts: unknown): string {
  const reference = Array.isArray(artifacts)
    ? (artifacts as { kind?: unknown; digest?: unknown }[]).find(
        (item) => item.kind === "review-decision",
      )
    : undefined;
  if (typeof reference?.digest !== "string") return "unreferenced";
  const path = join(
    evidenceDirectory,
    reference.digest,
    "content",
    "record.json",
  );
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as {
      reasonCode?: unknown;
    };
    return typeof record.reasonCode === "string"
      ? record.reasonCode
      : "unavailable";
  } catch {
    return "unavailable";
  }
}

const ledgerPath = join(stateDirectory, "ledger.sqlite");
if (!existsSync(ledgerPath))
  throw new Error(`台帳が ${ledgerPath} に無い。${USAGE}`);
const ledger: Database = new DatabaseSync(ledgerPath, { readOnly: true });
const rows = ledger
  .prepare(
    `SELECT event_json FROM ledger_events WHERE event_type IN (
      'target-selected', 'lab-provisioned', 'finding-recorded', 'finding-parked',
      'finding-park-restored', 'review-decided', 'verification-finished',
      'manual-observation-lab-ready', 'manual-observation-recorded',
      'submission-recorded', 'submission-recorded-externally'
    ) ORDER BY sequence`,
  )
  .all() as { event_json: string }[];
ledger.close();

for (const row of rows) {
  const event = JSON.parse(row.event_json) as Record<string, unknown>;
  const text = (key: string) =>
    typeof event[key] === "string" ? (event[key] as string) : undefined;
  const type = text("type");
  if (type === "target-selected") {
    const snapshot = text("snapshotDigest");
    const selection = text("selectionId");
    if (snapshot !== undefined && selection !== undefined)
      slugBySnapshot.set(snapshot, selection.replace(/^wporg:/, ""));
    continue;
  }
  if (type === "lab-provisioned") {
    const identity = text("identity") ?? "";
    const labId = text("labId");
    if (identity.startsWith("verification-lab-") && labId !== undefined)
      labByVerification.set(identity.slice("verification-lab-".length), labId);
    continue;
  }
  const findingId = text("findingId");
  if (findingId === undefined) continue;
  const entry = facts(findingId);
  entry.campaignId ??= text("campaignId");
  entry.snapshotDigest ??= text("snapshotDigest");
  const at = text("occurredAt") ?? "";
  switch (type) {
    case "finding-recorded": {
      entry.category ??= text("category");
      entry.recordedAt ??= at;
      const origin = text("derivedFromFindingId");
      if (origin !== undefined) facts(origin).derivedTo = findingId;
      break;
    }
    case "finding-parked":
      entry.parked = true;
      break;
    case "finding-park-restored":
      entry.parked = false;
      break;
    case "review-decided":
      entry.decision = {
        decision: text("decision") ?? "?",
        reasonCode: reasonCodeOf(event.artifacts),
        at,
      };
      break;
    case "verification-finished": {
      const result = (event.result ?? {}) as Record<string, unknown>;
      const verificationId = text("verificationId");
      entry.verification = {
        status: typeof result.status === "string" ? result.status : "?",
        ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
        ...(verificationId === undefined ? {} : { verificationId }),
        at,
      };
      entry.verificationAttempts += 1;
      if (verificationId !== undefined)
        finishedVerifications.add(verificationId);
      break;
    }
    case "manual-observation-lab-ready":
      entry.readyAt ??= at;
      entry.readyVerificationId = text("verificationId");
      break;
    case "manual-observation-recorded":
      entry.observation = {
        result: text("result") ?? "?",
        verificationId: text("verificationId") ?? "",
      };
      break;
    case "submission-recorded":
    case "submission-recorded-externally":
      entry.submitted = true;
      break;
  }
}

// ---------------------------------------------------------------- 報告単位

interface ReportUnit {
  groupId: string;
  slug?: string;
  version?: string;
  members: string[];
  representative: string;
}

function latestUnitsPath(): string | undefined {
  if (!existsSync(notesDirectory)) return undefined;
  const names = readdirSync(notesDirectory)
    .filter(
      (name) => name.startsWith("report-units-") && name.endsWith(".json"),
    )
    .sort();
  const last = names.at(-1);
  return last === undefined ? undefined : join(notesDirectory, last);
}
const unitsPath =
  values.units === undefined ? latestUnitsPath() : resolve(values.units);
const units: ReportUnit[] = [];
if (unitsPath !== undefined) {
  const json = JSON.parse(readFileSync(unitsPath, "utf8")) as unknown;
  units.push(
    ...(Array.isArray(json)
      ? (json as ReportUnit[])
      : ((json as { groups?: ReportUnit[] }).groups ?? [])),
  );
}
// 報告単位の members は findingId の先頭 8 桁以上（sha256: の後）で書かれている。
const unitOf = new Map<string, ReportUnit>();
for (const unit of units)
  for (const member of new Set([...unit.members, unit.representative])) {
    const short = member.replace(/^sha256:/, "");
    for (const findingId of findings.keys())
      if (findingId.replace(/^sha256:/, "").startsWith(short))
        unitOf.set(findingId, unit);
  }
// 最新版の再検証で派生した Finding は、元の Finding の単位に入る。
for (const entry of findings.values()) {
  const unit = unitOf.get(entry.findingId);
  if (unit !== undefined && entry.derivedTo !== undefined)
    unitOf.set(entry.derivedTo, unit);
}

// ---------------------------------------------------------------- 生きている Lab

let runningLabs: Set<string> | undefined;
if (values["running-labs"] !== undefined)
  runningLabs = new Set(
    values["running-labs"].split(",").filter((id) => id !== ""),
  );
else
  try {
    const names = execFileSync(
      "docker",
      ["ps", "--format", "{{.Names}}", "--filter", "name=^wbh-"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    runningLabs = new Set(
      names
        .split("\n")
        .flatMap((name) => /^wbh-(.+)-wp$/.exec(name.trim())?.[1] ?? []),
    );
  } catch {
    runningLabs = undefined; // docker が読めない。Lab の生死は「不明」と書く。
  }

// ---------------------------------------------------------------- 検証中の一括

/**
 * verify next の一括（batch.json）は、Finding ごとの verificationId を先に決める。
 * Lab は一括で 1 台で、lab-provisioned は一括のどれかの verificationId に付く。
 * Lab が生きていて、まだ結果の無い構成員が残る一括は検証中である。観測待ちの準備
 * （manual-observation-lab-ready）は一括の最後にまとめて出るので、先に結果の出た
 * 構成員も一括が終わるまで検証中に数える。
 */
const inflight = new Map<string, string>(); // findingId → labId
function batchFiles(): string[] {
  const found: string[] = [];
  for (const name of readdirSync(stateDirectory)) {
    if (!name.startsWith("handoff")) continue;
    const directory = join(stateDirectory, name);
    const candidates = [join(directory, "batch.json")];
    try {
      for (const child of readdirSync(directory))
        candidates.push(join(directory, child, "batch.json"));
    } catch {
      continue; // ファイルだった
    }
    found.push(...candidates.filter((path) => existsSync(path)));
  }
  return found;
}
for (const path of batchFiles()) {
  let batch: { findings?: { findingId?: unknown; verificationId?: unknown }[] };
  try {
    batch = JSON.parse(readFileSync(path, "utf8")) as typeof batch;
  } catch {
    continue;
  }
  const members = (batch.findings ?? []).flatMap((item) =>
    typeof item.findingId === "string" &&
    typeof item.verificationId === "string"
      ? [{ findingId: item.findingId, verificationId: item.verificationId }]
      : [],
  );
  const labId = members
    .map((member) => labByVerification.get(member.verificationId))
    .find((id) => id !== undefined);
  if (labId === undefined || runningLabs?.has(labId) !== true) continue;
  if (
    members.every((member) => finishedVerifications.has(member.verificationId))
  )
    continue;
  for (const member of members) inflight.set(member.findingId, labId);
}

// ---------------------------------------------------------------- 振り分け

interface Item {
  stage: Stage;
  findingId: string;
  campaignId: string;
  slug: string;
  category: string;
  snapshotDigest: string;
  recordedAt: string;
  note: string;
  unit?: string;
  labId?: string;
}

function labOf(entry: FindingFacts): string | undefined {
  const verificationId =
    entry.readyVerificationId ?? entry.verification?.verificationId;
  return verificationId === undefined
    ? undefined
    : labByVerification.get(verificationId);
}

/**
 * 後の attempt に置き換えられたが、観測用に保持したまま生きている Lab。
 * review observe はこの Lab に記録できない（最新の attempt と照合するため）。
 */
function superseded(entry: FindingFacts): string | undefined {
  if (
    entry.readyVerificationId === undefined ||
    entry.observation !== undefined ||
    entry.readyVerificationId === entry.verification?.verificationId
  )
    return undefined;
  const labId = labByVerification.get(entry.readyVerificationId);
  return labId !== undefined && runningLabs?.has(labId) === true
    ? labId
    : undefined;
}

function classify(entry: FindingFacts): { stage: Stage; note: string } {
  if (entry.parked) return { stage: "done", note: "parked" };
  if (entry.submitted) return { stage: "done", note: "submitted" };
  if (entry.derivedTo !== undefined)
    return { stage: "done", note: `derived ${entry.derivedTo.slice(7, 19)}` };
  const reason = entry.decision?.reasonCode ?? "";
  if (entry.decision?.decision === "reject")
    return { stage: "done", note: `reject ${reason}` };
  if (entry.observation !== undefined)
    return entry.observation.result === "match"
      ? { stage: "report", note: "human match" }
      : { stage: "owner", note: `human ${entry.observation.result}` };
  if (inflight.has(entry.findingId))
    return { stage: "verifying", note: "verify next の一括で検証中" };
  const verification = entry.verification;
  if (verification !== undefined) {
    // 観測を記録できるのは、最新の attempt が観測待ちで、Lab の準備がその attempt のときだけ。
    if (
      verification.reason === AWAITING_HUMAN &&
      entry.readyVerificationId === verification.verificationId
    ) {
      const labId = labOf(entry);
      const alive =
        runningLabs === undefined || labId === undefined
          ? undefined
          : runningLabs.has(labId);
      return alive === false
        ? { stage: "awaiting-human-lab-gone", note: "Lab gone" }
        : {
            stage: "awaiting-human",
            note: alive === undefined ? "Lab unknown" : "Lab up",
          };
    }
    // 判定器の時期の runtime-confirmed は新しい流れで検証し直す（所有者 2026-10-26）。
    if (verification.status === "runtime-confirmed")
      return { stage: "lab", note: "judge-era runtime-confirmed" };
    if (
      reason === LAB_IMAGE_BLOCKED &&
      (entry.decision?.at ?? "") >= verification.at
    )
      return { stage: "blocked", note: LAB_IMAGE_BLOCKED };
    if (
      reason === RETRY_EXHAUSTED &&
      (entry.decision?.at ?? "") >= verification.at
    )
      return { stage: "owner", note: RETRY_EXHAUSTED };
    return {
      stage: "stalled",
      note: `${verification.status}(${verification.reason ?? ""}) attempts=${entry.verificationAttempts}${superseded(entry) === undefined ? "" : " 置き換えられた観測 Lab が生きている（目視だけ、記録不可）"}`,
    };
  }
  if (reason === SOURCE_CHECK_PASS)
    return unitOf.has(entry.findingId)
      ? { stage: "lab", note: "" }
      : { stage: "unit", note: "" };
  if (reason === SOURCE_CHECK_UNKNOWN)
    return { stage: "owner", note: SOURCE_CHECK_UNKNOWN };
  if (reason === SCREEN_PASS || reason === "screen-v5-reassessment")
    return { stage: "source-check", note: "" };
  return {
    stage: "screen",
    note:
      entry.decision === undefined
        ? ""
        : `${entry.decision.decision} ${reason}`,
  };
}

const items: Item[] = [];
for (const entry of findings.values()) {
  if (entry.recordedAt === undefined) continue; // finding-recorded の無い記録は扱わない
  if (excludedCampaign.test(entry.campaignId ?? "")) continue;
  const { stage, note } = classify(entry);
  const unit = unitOf.get(entry.findingId);
  const labId = inflight.get(entry.findingId) ?? labOf(entry);
  items.push({
    stage,
    findingId: entry.findingId,
    campaignId: entry.campaignId ?? "?",
    slug: slugBySnapshot.get(entry.snapshotDigest ?? "") ?? "?",
    category: entry.category ?? "?",
    snapshotDigest: entry.snapshotDigest ?? "?",
    recordedAt: entry.recordedAt,
    note,
    ...(unit === undefined ? {} : { unit: unit.groupId }),
    ...(labId === undefined ? {} : { labId }),
  });
}
items.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));

// Lab へ回す順: 報告単位ごとに 1 つ。同じ Snapshot の構成員は 1 Lab に 5 件まで（#704）。
interface LabPlan {
  unit: string;
  campaignId: string;
  slug: string;
  snapshotDigest: string;
  findingIds: string[];
}
// 構成員の誰かが検証中、観測待ち、報告に進んだ単位は、報告 1 件にまとめるので Lab を立てない。
const coveredUnits = new Set(
  items.flatMap((item) =>
    item.unit !== undefined &&
    (item.stage.startsWith("awaiting-human") ||
      item.stage === "report" ||
      item.stage === "verifying")
      ? [item.unit]
      : [],
  ),
);
const covered: Item[] = [];
const plans = new Map<string, LabPlan>();
for (const item of items) {
  // 止まった検証は、単位があればその単位の Lab でやり直す（手順書 7 節）。
  const retry = item.stage === "stalled" && item.unit !== undefined;
  if (item.stage !== "lab" && !retry) continue;
  if (item.unit !== undefined && coveredUnits.has(item.unit)) {
    if (item.stage === "lab") covered.push(item);
    continue;
  }
  const key = `${item.unit ?? item.findingId}|${item.campaignId}|${item.snapshotDigest}`;
  const plan = plans.get(key) ?? {
    unit: item.unit ?? "-",
    campaignId: item.campaignId,
    slug: item.slug,
    snapshotDigest: item.snapshotDigest,
    findingIds: [],
  };
  if (plan.findingIds.length < 5) plan.findingIds.push(item.findingId);
  plans.set(key, plan);
}
// 人間が観測を記録した Lab は、次の周で片付ける。生きている Lab だけを数える。
const heldLabs = new Set(
  items
    .filter(
      (item) => item.stage === "awaiting-human" && item.labId !== undefined,
    )
    .map((item) => item.labId as string),
);
// 置き換えられた観測 Lab も host の枠を使う。片付けは所有者が見終えてから（手順書 1 節）。
const viewOnlyLabs = [
  ...new Set(
    [...findings.values()].flatMap((entry) => superseded(entry) ?? []),
  ),
];
const teardown = [
  ...new Set(
    items
      .filter(
        (item) =>
          (item.stage === "report" || item.stage === "owner") &&
          item.labId !== undefined &&
          runningLabs?.has(item.labId) === true,
      )
      .map((item) => item.labId as string),
  ),
];
// 所有者 2026-10-31: 資源に余裕があれば Lab を絞らない。探索に 16 GiB を残す。2 周分の実測で
// 24 から戻した（「動作確認」2026-10-31）。gVisor の sandbox は docker stats に乗らないことが
// あるので、runsc の RSS（ps）も並べて出す。検証中の Lab 1 台（Lab browser を含む）を
// 1.5 GiB と見込む。保持中は 1 台約 0.5 GiB。今効いているのは枠（既定 8）で、メモリではない。
const MEMORY_RESERVE_GIB = 16;
const GIB_PER_ACTIVE_LAB = 1.5;
function memAvailableGib(): number | undefined {
  if (values["mem-available-gib"] !== undefined)
    return Number(values["mem-available-gib"]);
  try {
    const line = /^MemAvailable:\s+(\d+) kB$/m.exec(
      readFileSync("/proc/meminfo", "utf8"),
    );
    return line === null ? undefined : Number(line[1]) / 1024 / 1024;
  } catch {
    return undefined;
  }
}
const memoryGib = memAvailableGib();

const UNIT_GIB: Record<string, number> = {
  B: 1 / 1024 ** 3,
  KiB: 1 / 1024 ** 2,
  MiB: 1 / 1024,
  GiB: 1,
  kB: 1e3 / 1024 ** 3,
  MB: 1e6 / 1024 ** 3,
  GB: 1e9 / 1024 ** 3,
};
/** docker stats の使用量を、探索（codex-agent / provider-egress-broker）と Lab（wbh-）に分けて合計する。 */
function containerMemoryGib():
  { exploration: number; labs: number } | undefined {
  if (values["running-labs"] !== undefined) return undefined; // 試験では docker を読まない。
  try {
    const lines = execFileSync(
      "docker",
      ["stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 60_000,
      },
    ).split("\n");
    const total = { exploration: 0, labs: 0 };
    for (const line of lines) {
      const match = /^(\S+)\t([\d.]+)([A-Za-z]+)\s*\//.exec(line.trim());
      if (match === null) continue;
      const gib = Number(match[2]) * (UNIT_GIB[match[3] as string] ?? 0);
      if (
        /^(codex-agent|claude-agent|provider-egress-broker)-/.test(
          match[1] as string,
        )
      )
        total.exploration += gib;
      else if (/^wbh-[0-9a-f-]{36}-/.test(match[1] as string))
        total.labs += gib;
    }
    return total;
  } catch {
    return undefined;
  }
}
const containerGib = containerMemoryGib();

/** runsc（gVisor）の process の RSS を、container 名で探索と Lab に分けて合計する（ps）。 */
function runscRssGib(): { exploration: number; labs: number } | undefined {
  if (values["running-labs"] !== undefined) return undefined; // 試験では読まない。
  try {
    const names = new Map(
      execFileSync(
        "docker",
        ["ps", "--no-trunc", "--format", "{{.ID}} {{.Names}}"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      )
        .split("\n")
        .flatMap((line) => {
          const [id, name] = line.trim().split(" ");
          return id === undefined || name === undefined ? [] : [[id, name]];
        }) as [string, string][],
    );
    const total = { exploration: 0, labs: 0 };
    for (const line of execFileSync("ps", ["-eo", "rss=,args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).split("\n")) {
      const match = /^\s*(\d+)\s+(.*runsc.*)$/.exec(line);
      if (match === null) continue;
      const id = /[0-9a-f]{64}/.exec(match[2] as string)?.[0];
      const name = id === undefined ? undefined : names.get(id);
      const gib = Number(match[1]) / 1024 ** 2;
      if (name === undefined) continue;
      if (/^(codex-agent|claude-agent|provider-egress-broker)-/.test(name))
        total.exploration += gib;
      else if (name.startsWith("wbh-")) total.labs += gib;
    }
    return total;
  } catch {
    return undefined;
  }
}
const runscGib = runscRssGib();
const slotsByMemory =
  memoryGib === undefined
    ? Number.POSITIVE_INFINITY
    : Math.floor(
        Math.max(0, memoryGib - MEMORY_RESERVE_GIB) / GIB_PER_ACTIVE_LAB,
      );
// 検証中の Lab も枠を使う。一括の途中で観測待ちになった Lab は 1 台として数える。
const activeLabs = [...new Set(inflight.values())].filter(
  (id) => !heldLabs.has(id),
);
// 提出済みの Finding の Lab など、どの列にも当たらないが生きている Lab も host の枠を使う。
// 片付けは所有者の了承の後（手順書 1 節）。この周で片付ける teardown だけは数えない。
const otherLabs = [...(runningLabs ?? [])].filter(
  (id) =>
    !heldLabs.has(id) &&
    !viewOnlyLabs.includes(id) &&
    !activeLabs.includes(id) &&
    !teardown.includes(id),
);
const usedLabs = new Set([
  ...heldLabs,
  ...viewOnlyLabs,
  ...activeLabs,
  ...otherLabs,
]);
const freeSlots = Math.min(
  slotsByMemory,
  Math.max(0, labSlots - usedLabs.size),
);

// 測る数字: finding-recorded から最初の observation-ready までの時間（--since 以降に記録した Finding）。
const hours = [...findings.values()]
  .filter(
    (entry) =>
      entry.recordedAt !== undefined &&
      entry.recordedAt >= since &&
      entry.readyAt !== undefined,
  )
  .map(
    (entry) =>
      (Date.parse(entry.readyAt as string) -
        Date.parse(entry.recordedAt as string)) /
      3_600_000,
  )
  .sort((a, b) => a - b);
const median =
  hours.length === 0
    ? null
    : hours.length % 2 === 1
      ? hours[(hours.length - 1) / 2]!
      : (hours[hours.length / 2 - 1]! + hours[hours.length / 2]!) / 2;

const counts: Record<string, number> = {};
for (const item of items) counts[item.stage] = (counts[item.stage] ?? 0) + 1;

const result = {
  schema: "wbh-verification-loop/v1",
  generatedAt: new Date().toISOString(),
  state: stateDirectory,
  unitsPath: unitsPath ?? null,
  counts,
  labs: {
    slots: labSlots,
    held: [...heldLabs],
    viewOnly: viewOnlyLabs,
    active: activeLabs,
    /** どの列にも当たらないが生きている Lab（提出済みの Finding の Lab など）。所有者の了承で片付ける。 */
    other: otherLabs,
    free: freeSlots,
    memAvailableGib:
      memoryGib === undefined ? null : Math.round(memoryGib * 10) / 10,
    reserveGib: MEMORY_RESERVE_GIB,
    /** 実測の docker stats 合計（GiB）。周の記録に残し、予約を決め直す材料にする。 */
    explorationUsedGib:
      containerGib === undefined
        ? null
        : Math.round(containerGib.exploration * 10) / 10,
    /** runsc の RSS（ps）。docker stats が gVisor を拾わないときの照合用。 */
    explorationRssGib:
      runscGib === undefined
        ? null
        : Math.round(runscGib.exploration * 10) / 10,
    labsRssGib:
      runscGib === undefined ? null : Math.round(runscGib.labs * 10) / 10,
    labsUsedGib:
      containerGib === undefined
        ? null
        : Math.round(containerGib.labs * 10) / 10,
    dockerReadable: runningLabs !== undefined,
    teardown,
  },
  next: {
    screen: items.filter((item) => item.stage === "screen"),
    sourceCheck: items.filter((item) => item.stage === "source-check"),
    unit: items.filter((item) => item.stage === "unit"),
    lab: [...plans.values()].slice(0, freeSlots),
    labWaiting: [...plans.values()].slice(freeSlots),
    /** 同じ単位の構成員がすでに観測待ちか報告にある。Lab を立てずに待つ。 */
    labCovered: covered,
    verifying: items.filter((item) => item.stage === "verifying"),
    stalled: items.filter((item) => item.stage === "stalled"),
    report: items.filter((item) => item.stage === "report"),
    awaitingHuman: items.filter((item) =>
      item.stage.startsWith("awaiting-human"),
    ),
    owner: items.filter((item) => item.stage === "owner"),
    blocked: items.filter((item) => item.stage === "blocked"),
  },
  metric: {
    since,
    findingsReady: hours.length,
    medianHoursToObservationReady:
      median === null ? null : Math.round(median * 10) / 10,
  },
};

if (values.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const short = (id: string) => id.replace(/^sha256:/, "").slice(0, 12);
  const line = (item: Item) =>
    `  ${short(item.findingId)}  ${item.campaignId}  ${item.slug}  ${item.category}${item.note === "" ? "" : `  ${item.note}`}`;
  console.log(`検証ループ ${result.generatedAt}  state ${stateDirectory}`);
  console.log(
    `段の件数: ${Object.entries(counts)
      .map(([stage, count]) => `${stage} ${count}`)
      .join(" / ")}`,
  );
  console.log(
    `Lab: 枠 ${labSlots}、観測待ちで保持 ${heldLabs.size}、空き ${freeSlots}${runningLabs === undefined ? "（docker が読めず、生死は不明）" : ""}、片付け ${teardown.length}`,
  );
  for (const [title, list] of [
    ["段 1 wbh-screen", result.next.screen],
    ["段 1b wbh-source-check", result.next.sourceCheck],
    ["報告単位を作る", result.next.unit],
    ["止まった検証", result.next.stalled],
    ["照合と報告書", result.next.report],
    ["観測待ち", result.next.awaitingHuman],
    ["所有者の判断待ち", result.next.owner],
  ] as const) {
    console.log(`${title}: ${list.length}`);
    for (const item of list) console.log(line(item));
  }
  console.log(`Lab に回す（この周）: ${result.next.lab.length}`);
  for (const plan of result.next.lab)
    console.log(
      `  ${plan.unit}  ${plan.campaignId}  ${plan.slug}  ${plan.findingIds.map(short).join(",")}`,
    );
  console.log(`Lab の順番待ち: ${result.next.labWaiting.length}`);
  console.log(
    `同じ単位が観測待ちのため Lab を立てない: ${result.next.labCovered.length}`,
  );
  for (const labId of teardown) console.log(`片付ける Lab: ${labId}`);
  console.log(
    `observation-ready までの中央値（${since} 以降に記録した Finding）: ${result.metric.medianHoursToObservationReady ?? "-"} 時間（${hours.length} 件）`,
  );
}
