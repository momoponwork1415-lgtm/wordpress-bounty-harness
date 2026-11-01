#!/usr/bin/env node
// 提出候補（報告単位）と除外の 1 画面 HTML を作り直す、AI の道具（Issue #696）。
//
//   node scripts/submission-board.ts [--state <dir>] [--units <path>] [--screen <path>]
//     [--mirror <path>] [--out <path>] [--no-network]
//
// 所有者決定 2026-10-27: scripts は AI の道具で、Harness の制御には入れない。
// 台帳とミラーは読み取り専用で開き、何も書かない。出力 HTML は Git 外に置く。
// 報告単位の分け方は入力 JSON の側で決まっている。除外は台帳の review-decided のうち、
// 最新が reject で理由コードが screen-v5-* か source-check-* のものを正にする（#701）。
// 除外判定の JSON は注記（noteJa）にだけ使う。ここでは並べるだけで、`summary` と
// `noteJa` は入力のまま出す。ペイロード、URL、関数名、再現手順は足さない。
//
// 入力:
//   台帳         <state>/ledger.sqlite の ledger_events（event_type, event_json）
//   報告単位     <state>/review-notes/report-units-*.json（既定は名前順で最後のもの）
//   判断の理由   <state>/private-evidence/<digest>/content/record.json（review-decision）
//   除外判定     <state>/review-notes/exclusion-screen-*.json（同上、注記だけ）
//   ミラー       ~/wp-bounty-workspace/intelligence/history.sqlite（software, vulnerabilities）
//   網           WordPress.org の plugin 情報 API と plugins.svn.wordpress.org の trunk。
//                --no-network のとき、または失敗したときは「未取得」と書いて続ける。
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { DatabaseSync as Database } from "node:sqlite";

const USAGE =
  "usage: node scripts/submission-board.ts [--state <dir>] [--units <path>] [--screen <path>] [--mirror <path>] [--out <path>] [--no-network]";

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
    screen: { type: "string" },
    mirror: { type: "string" },
    out: { type: "string" },
    "no-network": { type: "boolean", default: false },
  },
  strict: true,
});

const stateDirectory = resolve(
  values.state ?? join(homedir(), ".local/state/wordpress-bounty-harness"),
);
const notesDirectory = join(stateDirectory, "review-notes");
const unitsPath = resolve(values.units ?? latestNote("report-units-"));
const screenPath = resolve(values.screen ?? latestNote("exclusion-screen-"));
const mirrorPath = resolve(
  values.mirror ??
    join(homedir(), "wp-bounty-workspace/intelligence/history.sqlite"),
);
const today = new Date().toLocaleDateString("sv-SE");
const outPath = resolve(
  values.out ?? join(notesDirectory, `submission-board-${today}.html`),
);
const network = !values["no-network"];

function latestNote(prefix: string): string {
  const names = existsSync(notesDirectory)
    ? readdirSync(notesDirectory)
        .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
        .sort()
    : [];
  const last = names.at(-1);
  if (last === undefined)
    throw new Error(`${prefix}*.json が ${notesDirectory} に無い。${USAGE}`);
  return join(notesDirectory, last);
}

// ---------------------------------------------------------------- 入力の形

interface ReportUnit {
  groupId: string;
  slug: string;
  version: string;
  members: string[];
  representative: string;
  kind?: string;
  attacker?: string;
  title?: string;
  summary?: string;
  precondition?: string;
  victim?: string;
  publicNote?: string;
  nextStep?: string;
  notes?: string;
}

interface Verdict {
  fid: string;
  short: string;
  slug: string;
  version: string;
  verdict: "keep" | "exclude";
  codes: string[];
  noteJa?: string;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

const unitsJson = readJson(unitsPath);
const units: ReportUnit[] = Array.isArray(unitsJson)
  ? (unitsJson as ReportUnit[])
  : ((unitsJson as { groups?: ReportUnit[] }).groups ?? []);
const screenJson = readJson(screenPath) as {
  recordedAt?: string;
  verdicts?: Verdict[];
};
const verdicts = screenJson.verdicts ?? [];

// ---------------------------------------------------------------- 台帳

interface FindingFacts {
  category?: string;
  snapshotDigest?: string;
  review?: { decision: string; reasonCode: string; at: string };
  submissions: { destination: string; submittedOn: string }[];
  labReady: number;
}

const findings = new Map<string, FindingFacts>();
const selectionBySnapshot = new Map<string, string>();
let ledgerAvailable = false;

function facts(findingId: string): FindingFacts {
  let value = findings.get(findingId);
  if (value === undefined) {
    value = { submissions: [], labReady: 0 };
    findings.set(findingId, value);
  }
  return value;
}

/** review-decided が指す review-decision の記録から理由コードを読む。読めなければ "unavailable"。 */
function reasonCodeOf(artifacts: unknown): string {
  const reference = Array.isArray(artifacts)
    ? (artifacts as { kind?: unknown; digest?: unknown }[]).find(
        (item) => item.kind === "review-decision",
      )
    : undefined;
  if (typeof reference?.digest !== "string") return "unreferenced";
  try {
    const record = JSON.parse(
      readFileSync(
        join(
          stateDirectory,
          "private-evidence",
          reference.digest,
          "content",
          "record.json",
        ),
        "utf8",
      ),
    ) as { reasonCode?: unknown };
    return typeof record.reasonCode === "string"
      ? record.reasonCode
      : "unavailable";
  } catch {
    return "unavailable";
  }
}

const ledgerPath = join(stateDirectory, "ledger.sqlite");
if (existsSync(ledgerPath)) {
  const ledger: Database = new DatabaseSync(ledgerPath, { readOnly: true });
  const rows = ledger
    .prepare(
      `SELECT event_json FROM ledger_events WHERE event_type IN (
        'target-selected', 'finding-recorded', 'finding-parked', 'review-decided',
        'submission-recorded-externally', 'manual-observation-lab-ready'
      ) ORDER BY sequence`,
    )
    .all() as { event_json: string }[];
  for (const row of rows) {
    const event = JSON.parse(row.event_json) as Record<string, unknown>;
    const text = (key: string) =>
      typeof event[key] === "string" ? (event[key] as string) : undefined;
    const type = text("type");
    if (type === "target-selected") {
      const snapshot = text("snapshotDigest");
      const selection = text("selectionId");
      if (snapshot !== undefined && selection !== undefined)
        selectionBySnapshot.set(snapshot, selection);
      continue;
    }
    const findingId = text("findingId");
    if (findingId === undefined) continue;
    const entry = facts(findingId);
    const snapshot = text("snapshotDigest");
    if (snapshot !== undefined) entry.snapshotDigest ??= snapshot;
    const at = (text("occurredAt") ?? "").slice(0, 10);
    if (type === "finding-recorded" || type === "finding-parked") {
      const category = text("category");
      if (category !== undefined) entry.category ??= category;
    } else if (type === "review-decided") {
      entry.review = {
        decision: text("decision") ?? "?",
        reasonCode: reasonCodeOf(event.artifacts),
        at,
      };
    } else if (type === "submission-recorded-externally") {
      entry.submissions.push({
        destination: text("destination") ?? "?",
        submittedOn: text("submittedOn") ?? at,
      });
    } else if (type === "manual-observation-lab-ready") {
      entry.labReady += 1;
    }
  }
  ledger.close();
  ledgerAvailable = true;
}

// 報告単位の members は findingId の先頭 8 桁（sha256: の後）で書かれている。
const findingsByShort = new Map<string, string[]>();
for (const findingId of findings.keys()) {
  const short = findingId.replace(/^sha256:/, "").slice(0, 8);
  findingsByShort.set(short, [
    ...(findingsByShort.get(short) ?? []),
    findingId,
  ]);
}
function resolveShort(short: string): string | undefined {
  if (short.startsWith("sha256:"))
    return findings.has(short) ? short : undefined;
  const matches = findingsByShort.get(short.slice(0, 8)) ?? [];
  return matches.find((id) => id.replace(/^sha256:/, "").startsWith(short));
}

// ---------------------------------------------------------------- ミラー

type Range = {
  from_version?: string;
  from_inclusive?: boolean;
  to_version?: string;
  to_inclusive?: boolean;
};

function versionTuple(version: string): number[] {
  return version
    .replace(/-/g, ".")
    .split(".")
    .map((part) => (/^\d+$/.test(part) ? Number(part) : 0));
}
function compareVersions(left: string, right: string): number {
  const a = versionTuple(left);
  const b = versionTuple(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
function inRange(version: string, range: Range): boolean {
  const from = range.from_version ?? "*";
  const to = range.to_version ?? "*";
  if (from !== "*") {
    const order = compareVersions(version, from);
    if (order < 0 || (order === 0 && range.from_inclusive === false))
      return false;
  }
  if (to !== "*") {
    const order = compareVersions(version, to);
    if (order > 0 || (order === 0 && range.to_inclusive === false))
      return false;
  }
  return true;
}

interface MirrorHit {
  published: string;
  title: string;
}
const mirrorAvailable = existsSync(mirrorPath);
const mirror: Database | undefined = mirrorAvailable
  ? new DatabaseSync(mirrorPath, { readOnly: true })
  : undefined;

function mirrorRecords(
  slug: string,
  version: string,
): { total: number; hits: MirrorHit[] } | undefined {
  if (mirror === undefined) return undefined;
  const rows = mirror
    .prepare(
      `SELECT DISTINCT v.title AS title, v.published AS published, v.record_json AS record
       FROM software s JOIN vulnerabilities v ON v.id = s.vulnerability_id
       WHERE s.slug = ? ORDER BY v.published DESC`,
    )
    .all(slug) as { title: string; published: string | null; record: string }[];
  const hits: MirrorHit[] = [];
  for (const row of rows) {
    const record = JSON.parse(row.record) as {
      software?: { slug?: string; affected_versions?: Record<string, Range> }[];
    };
    const ranges = (record.software ?? [])
      .filter((software) => software.slug === slug)
      .flatMap((software) => Object.values(software.affected_versions ?? {}));
    if (ranges.some((range) => inRange(version, range)))
      hits.push({
        published: (row.published ?? "").slice(0, 10),
        title: row.title,
      });
  }
  return { total: rows.length, hits };
}

// ---------------------------------------------------------------- 網

interface Upstream {
  latest?: string;
  latestError?: string;
  trunkDate?: string;
  trunkError?: string;
}

async function fetchLatest(
  slug: string,
): Promise<Pick<Upstream, "latest" | "latestError">> {
  try {
    const url = `https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request[slug]=${encodeURIComponent(slug)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const body = (await response.json()) as {
      version?: unknown;
      error?: unknown;
    };
    if (typeof body.version === "string") return { latest: body.version };
    return {
      latestError:
        typeof body.error === "string" ? body.error : `HTTP ${response.status}`,
    };
  } catch (error) {
    return { latestError: error instanceof Error ? error.name : "error" };
  }
}

function fetchTrunk(
  slug: string,
): Promise<Pick<Upstream, "trunkDate" | "trunkError">> {
  return new Promise((done) => {
    execFile(
      "svn",
      [
        "log",
        "-l",
        "1",
        "--xml",
        "--non-interactive",
        `https://plugins.svn.wordpress.org/${slug}/trunk`,
      ],
      { timeout: 30_000 },
      (error, stdout) => {
        const date = /<date>([^<]+)<\/date>/.exec(stdout)?.[1];
        if (date !== undefined) done({ trunkDate: date.slice(0, 10) });
        else done({ trunkError: error === null ? "履歴なし" : "svn 失敗" });
      },
    );
  });
}

async function upstreamFor(slugs: string[]): Promise<Map<string, Upstream>> {
  const result = new Map<string, Upstream>();
  if (!network) return result;
  const queue = [...slugs];
  const worker = async () => {
    for (let slug = queue.shift(); slug !== undefined; slug = queue.shift()) {
      const [latest, trunk] = await Promise.all([
        fetchLatest(slug),
        fetchTrunk(slug),
      ]);
      result.set(slug, { ...latest, ...trunk });
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return result;
}

// ---------------------------------------------------------------- 表示語

const REASON_JA: Record<string, string> = {
  "same-root-submitted": "提出済みと同根",
  "heavy-admin-precondition": "管理者が作る重い前提",
  "cve-only-grade": "CVE 止まりの等級",
  "patched-in-latest": "最新版で修正済み",
  "core-dependency": "本体依存",
  "core-dependency-unclear": "本体依存の疑い",
  "public-duplicate": "公開済み重複",
  "public-similar": "近い公開記録あり",
  "park-impact": "park 対象の impact",
  "policy-out-of-scope": "Wordfence 明示除外",
  "admin-misconfig": "管理者の不適切設定",
  "admin-misconfig-unclear": "管理者の前提が重い",
  "pr-mid-or-high": "中〜高権限が必要",
  "external-not-writable": "外部サービス（書けない）",
  "external-writable": "外部サービス（誰でも書ける）",
  "external-unclear": "外部サービス（不明）",
  "chain-fragile": "多段連鎖で成立しにくい",
  "standard-feature": "標準機能の組合せ",
  "submitted-plugin": "提出済み plugin",
  "unverified-source": "依存ソース未確認",
  "reach-unclear": "到達条件が限定的",
  // wbh-screen v5 の理由コード（台帳では screen-v5- を前に付ける）。
  "contrived-usage": "通常利用の範囲外",
  "installer-transient": "導入時だけの一時スクリプト",
  "same-root-ticket": "同根の提出あり",
  // wbh-source-check の理由コード。
  "source-check-input": "入力を握れない（段 1b）",
  "source-check-reach": "sink に届かない（段 1b）",
};
// 理由の内訳に数えるのは除外の根拠になる符号だけ。残りは明細にだけ出す。
const IMPACT_JA: Record<string, string> = {
  "stored-xss": "格納型 XSS",
  "account-takeover": "アカウント乗っ取り",
  "arbitrary-file-download": "任意ファイルダウンロード",
  "arbitrary-file-read": "任意ファイル読み取り",
  "arbitrary-file-delete": "任意ファイル削除",
  lfi: "LFI",
  rce: "RCE",
  "php-file-write": "PHP ファイル書き込み",
  "privesc-to-admin": "管理者への権限昇格",
  sqli: "SQL インジェクション",
  "sensitive-object-access": "非公開オブジェクトの閲覧",
  "missing-authz": "認可欠落",
  "options-update": "オプション更新",
  "csrf-to-write": "CSRF による書き込み",
  other: "その他",
};

function escape(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function tally(items: string[]): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, count]) => `${name} ${count}`)
    .join("、");
}

// ---------------------------------------------------------------- 欄

const unavailable = { mirror: 0, latest: 0, trunk: 0, ledger: 0 };

function upstreamCell(
  unit: ReportUnit,
  upstream: Upstream | undefined,
): string {
  const lines: string[] = [];
  const records = mirrorRecords(unit.slug, unit.version);
  if (records === undefined) {
    unavailable.mirror += 1;
    lines.push("ミラー: 未取得");
  } else if (records.hits.length === 0) {
    lines.push(
      `ミラー: 固定版を含む公開記録なし（slug の記録 ${records.total} 件）`,
    );
  } else {
    const shown = records.hits
      .slice(0, 3)
      .map((hit) => `${escape(hit.published)} ${escape(hit.title)}`)
      .join("<br>");
    const more =
      records.hits.length > 3 ? `<br>ほか ${records.hits.length - 3} 件` : "";
    lines.push(
      `<b>ミラー: 固定版を含む公開記録 ${records.hits.length} 件</b><br><small>${shown}${more}</small>`,
    );
  }
  if (upstream?.latest !== undefined) {
    const order = compareVersions(upstream.latest, unit.version);
    lines.push(
      order > 0
        ? `<b>最新 ${escape(upstream.latest)}（要差分確認）</b>`
        : `最新 ${escape(upstream.latest)}（${order === 0 ? "Snapshot と同じ" : "Snapshot より古い"}）`,
    );
  } else {
    unavailable.latest += 1;
    lines.push(
      `最新版: 未取得${upstream?.latestError ? `（${escape(upstream.latestError)}）` : ""}`,
    );
  }
  if (upstream?.trunkDate !== undefined) {
    lines.push(`trunk 最終コミット ${escape(upstream.trunkDate)}`);
  } else {
    unavailable.trunk += 1;
    lines.push(
      `trunk: 未取得${upstream?.trunkError ? `（${escape(upstream.trunkError)}）` : ""}`,
    );
  }
  const note = unit.publicNote
    ? `<br><small>近い記録（入力）: ${escape(unit.publicNote)}</small>`
    : "";
  return lines.join("<br>") + note;
}

function ledgerCell(unit: ReportUnit): string {
  if (!ledgerAvailable) {
    unavailable.ledger += 1;
    return "台帳: 未取得";
  }
  const resolved = unit.members.map((short) => ({
    short,
    id: resolveShort(short),
  }));
  const known = resolved.flatMap((member) =>
    member.id === undefined
      ? []
      : [{ short: member.short, facts: facts(member.id) }],
  );
  const lines: string[] = [];
  const reviewed = known.filter((member) => member.facts.review !== undefined);
  if (reviewed.length === 0) {
    lines.push("review 判断なし");
  } else {
    const latest = reviewed
      .map((member) => member.facts.review!)
      .sort((a, b) => b.at.localeCompare(a.at))[0]!;
    lines.push(
      `最新 review: <b>${escape(latest.decision)}</b>（${escape(latest.at)}）`,
    );
    lines.push(
      `<small>Finding ごとの最新: ${escape(tally(reviewed.map((member) => member.facts.review!.decision)))}／未判断 ${known.length - reviewed.length}</small>`,
    );
  }
  const submissions = known.flatMap((member) => member.facts.submissions);
  lines.push(
    submissions.length === 0
      ? "提出記録なし"
      : `<b>提出記録 ${submissions.length} 件</b>（${escape(
          submissions
            .map((item) => `${item.destination} ${item.submittedOn}`)
            .join("、"),
        )}）`,
  );
  const labReady = known.reduce(
    (sum, member) => sum + member.facts.labReady,
    0,
  );
  if (labReady > 0) lines.push(`観測 Lab 準備 ${labReady} 回`);
  const missing = resolved.filter((member) => member.id === undefined).length;
  if (missing > 0) lines.push(`<small>台帳に無い short ${missing} 件</small>`);
  const representative = resolveShort(unit.representative);
  const snapshot =
    representative === undefined
      ? undefined
      : facts(representative).snapshotDigest;
  const selection =
    snapshot === undefined ? undefined : selectionBySnapshot.get(snapshot);
  if (
    selection !== undefined &&
    selection !== `wporg:${unit.slug}@${unit.version}`
  )
    lines.push(`<small>台帳の対象は ${escape(selection)}</small>`);
  return lines.join("<br>");
}

// ---------------------------------------------------------------- 組み立て

const sortedUnits = [...units].sort(
  (a, b) => a.slug.localeCompare(b.slug) || a.groupId.localeCompare(b.groupId),
);
const upstream = await upstreamFor([
  ...new Set(sortedUnits.map((unit) => unit.slug)),
]);

const unitRows = sortedUnits
  .map((unit, index) => {
    const notes = unit.notes ? `<br><small>${escape(unit.notes)}</small>` : "";
    return `<tr><td>${index + 1}</td><td><b>${escape(unit.slug)}</b> ${escape(unit.version)}<br><small>${escape(unit.kind)}／${escape(unit.attacker)}／被害者: ${escape(unit.victim)}</small></td><td><b>${escape(unit.title)}</b><br>${escape(unit.summary)}<br><small>前提: ${escape(unit.precondition)}</small></td><td>${unit.members.length} 件<br><small>代表 <code>${escape(unit.representative)}</code></small></td><td>${upstreamCell(unit, upstream.get(unit.slug))}</td><td>${escape(unit.nextStep)}${notes}</td><td>${ledgerCell(unit)}</td></tr>`;
  })
  .join("\n");

// 除外は台帳が正。最新の判断が reject で、段 1 か段 1b の理由コードのものだけを並べる。
const LEDGER_EXCLUDE = /^(screen-v5-|source-check-)/;
const noteByFinding = new Map(
  verdicts.map((verdict) => [verdict.fid, verdict]),
);
const excluded: Verdict[] = [];
for (const [findingId, entry] of findings) {
  const review = entry.review;
  if (review?.decision !== "reject" || !LEDGER_EXCLUDE.test(review.reasonCode))
    continue;
  const selection = selectionBySnapshot.get(entry.snapshotDigest ?? "") ?? "";
  const target = /^wporg:(.+)@([^@]+)$/.exec(selection);
  excluded.push({
    fid: findingId,
    short: findingId.replace(/^sha256:/, "").slice(0, 8),
    slug: target?.[1] ?? "台帳に対象なし",
    version: target?.[2] ?? "?",
    verdict: "exclude",
    codes: [review.reasonCode.replace(/^screen-v5-/, "")],
    ...(noteByFinding.get(findingId)?.noteJa === undefined
      ? {}
      : { noteJa: noteByFinding.get(findingId)!.noteJa! }),
  });
}
const excludedBySlug = new Map<string, Verdict[]>();
for (const verdict of excluded) {
  excludedBySlug.set(verdict.slug, [
    ...(excludedBySlug.get(verdict.slug) ?? []),
    verdict,
  ]);
}
function impactOf(verdict: Verdict): string {
  const category = findings.get(verdict.fid)?.category;
  return category === undefined
    ? "台帳に無い"
    : (IMPACT_JA[category] ?? category);
}
const excludedRows = [...excludedBySlug]
  .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  .map(([slug, items]) => {
    const versions = [...new Set(items.map((item) => item.version))].join("、");
    const reasons = items.flatMap((item) =>
      item.codes.map((code) => REASON_JA[code] ?? code),
    );
    const detail = items
      .map(
        (item) =>
          `<li><code>${escape(item.short)}</code> ${escape(impactOf(item))}／${escape(
            item.codes.map((code) => REASON_JA[code] ?? code).join("、"),
          )}${item.noteJa === undefined ? "" : ` — ${escape(item.noteJa)}`}</li>`,
      )
      .join("");
    return `<tr><td><b>${escape(slug)}</b> ${escape(versions)}</td><td>${items.length}</td><td>${escape(tally(items.map(impactOf)))}</td><td>${escape(tally(reasons))}</td><td><details><summary>明細</summary><ul>${detail}</ul></details></td></tr>`;
  })
  .join("\n");

// 要検証は、最新の判断が段 1 の要検証か段 1b の成立・未決の印のもの（docs/agents/verification-loop.md）。
const KEEP_MARKS = new Set([
  "screen-v5-verify",
  "screen-v5-reassessment",
  "source-check-pass",
  "source-check-unknown",
]);
const keepCount = [...findings.values()].filter(
  (entry) =>
    entry.review?.decision === "defer" &&
    KEEP_MARKS.has(entry.review.reasonCode),
).length;
const excludeCount = excluded.length;
const sources = [
  `報告単位 ${escape(unitsPath.split("/").at(-1))}`,
  `除外の注記 ${escape(screenPath.split("/").at(-1))}${screenJson.recordedAt ? `（${escape(screenJson.recordedAt)}）` : ""}`,
  `台帳 ${ledgerAvailable ? "読込" : "未取得"}`,
  `ミラー ${mirrorAvailable ? "読込" : "未取得"}`,
  `網 ${network ? "使用" : "未使用（--no-network）"}`,
].join("／");

const page = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>提出候補と除外 ${escape(today)}</title>
<style>
:root{--fg:#1f2320;--bg:#f7f6f2;--line:#d8d6cd;--head:#e9eef7;--muted:#5d645e}
@media (prefers-color-scheme: dark){:root{--fg:#e6e4dc;--bg:#1b1d1c;--line:#3a3d3a;--head:#263040;--muted:#a3aaa4}}
body{font-family:system-ui,sans-serif;margin:16px;color:var(--fg);background:var(--bg);font-size:13px}
table{border-collapse:collapse;width:100%;margin-bottom:28px}
td,th{border-bottom:1px solid var(--line);padding:6px 8px;vertical-align:top;text-align:left}
th{background:var(--head);font-size:12px}
h2{margin-top:28px}code{font-size:12px}p{max-width:84ch}
details ul{margin:4px 0;padding-left:1.2em}details li{margin:2px 0}small{color:var(--muted)}
.wrap{overflow-x:auto}
</style></head><body>
<h1>提出候補（報告単位）と除外（${escape(today)}）</h1>
<p>台帳で段 1・1b を通った（要検証・成立・未決の印）Finding ${keepCount} 件 → <b>報告単位 ${units.length} 件</b>。段 1・1b の除外 ${excludeCount} 件（${excludedBySlug.size} plugin）。同じ根本原因の Finding は 1 行にまとめてある。印と除外は AI の中間判断で、台帳に <code>review decide --by ai</code> として記録してある。Private Evidence なので Git と Issue には貼らない。</p>
<p><small>${sources}。scripts/submission-board.ts が生成。</small></p>
<h2>要検証（報告単位）</h2>
<div class="wrap"><table><thead><tr><th>#</th><th>plugin／種類／攻撃者／被害者</th><th>何が起きるか</th><th>Finding 数と代表</th><th>公開記録と最新版・trunk</th><th>次の一手</th><th>台帳（review 判断と提出記録）</th></tr></thead><tbody>
${unitRows}
</tbody></table></div>
<h2>除外（plugin 単位）</h2>
<div class="wrap"><table><thead><tr><th>plugin</th><th>件数</th><th>種類</th><th>除外理由</th><th>明細</th></tr></thead><tbody>
${excludedRows}
</tbody></table></div>
</body></html>
`;

mirror?.close();
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, page, { mode: 0o600 });
console.log(
  JSON.stringify({
    out: outPath,
    units: units.length,
    excludedPlugins: excludedBySlug.size,
    keep: keepCount,
    exclude: excludeCount,
    unavailable,
  }),
);
