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
// Lab の枠（--lab-slots、既定 12）はこの道具の既定値で、Harness は強制しない。
// 空きはさらに host の空きメモリで絞る（/proc/meminfo の MemAvailable、--mem-available-gib で上書き）。
//
// 入力:
//   台帳         <state>/ledger.sqlite の ledger_events
//   判断の理由   <state>/private-evidence/<digest>/content/record.json（review-decision）
//   報告単位     <state>/review-notes/report-units-*.json（既定は名前順で最後のもの、無くてもよい）
//   生きている Lab  docker ps の wbh-<labId>-wp。--running-labs で与えたらそれを使う。
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
    "lab-slots": { type: "string", default: "12" },
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

type Stage =
  | "screen" // 段 1 がまだ
  | "source-check" // 段 1 の要検証。段 1b がまだ
  | "unit" // 段 1b の成立。報告単位がまだ
  | "lab" // 報告単位あり。Lab がまだ
  | "awaiting-human" // observation-ready の Lab が生きている
  | "awaiting-human-lab-gone" // 観測待ちだが Lab が消えた
  | "report" // 人間の観測が match。照合と報告書へ
  | "stalled" // 検証が観測待ち以外の incomplete などで止まった
  | "owner" // 段 1b の未決や人間の mismatch。所有者の判断待ち
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
  const labId = labOf(entry);
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
// 構成員の誰かが観測待ちか報告に進んだ単位は、報告 1 件にまとめるので Lab を立てない。
const coveredUnits = new Set(
  items.flatMap((item) =>
    item.unit !== undefined &&
    (item.stage.startsWith("awaiting-human") || item.stage === "report")
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
// 所有者 2026-10-31: 資源に余裕があれば Lab を絞らない。探索のために 16 GiB を残し、
// 検証中の Lab 1 台（Lab browser を含む）を 1.5 GiB と見込む。保持中は 1 台約 0.5 GiB。
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
const slotsByMemory =
  memoryGib === undefined
    ? Number.POSITIVE_INFINITY
    : Math.floor(
        Math.max(0, memoryGib - MEMORY_RESERVE_GIB) / GIB_PER_ACTIVE_LAB,
      );
const freeSlots = Math.min(
  slotsByMemory,
  Math.max(
    0,
    labSlots -
      heldLabs.size -
      viewOnlyLabs.filter((id) => !heldLabs.has(id)).length,
  ),
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
    free: freeSlots,
    memAvailableGib:
      memoryGib === undefined ? null : Math.round(memoryGib * 10) / 10,
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
    stalled: items.filter((item) => item.stage === "stalled"),
    report: items.filter((item) => item.stage === "report"),
    awaitingHuman: items.filter((item) =>
      item.stage.startsWith("awaiting-human"),
    ),
    owner: items.filter((item) => item.stage === "owner"),
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
