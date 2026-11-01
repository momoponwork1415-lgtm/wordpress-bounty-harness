import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, expect, test } from "vitest";

const script = fileURLToPath(
  new URL("../../scripts/submission-board.ts", import.meta.url),
);
const fixtures = fileURLToPath(
  new URL("../fixtures/submission-board/", import.meta.url),
);
let state: string;

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8")) as T;
}

beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), "wbh-submission-board-"));
  const ledger = new DatabaseSync(join(state, "ledger.sqlite"));
  ledger.exec(`CREATE TABLE ledger_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    event_json TEXT NOT NULL
  )`);
  const insert = ledger.prepare(
    "INSERT INTO ledger_events (event_type, event_json) VALUES (?, ?)",
  );
  for (const event of fixture<{ type: string }[]>("ledger-events.json"))
    insert.run(event.type, JSON.stringify(event));
  ledger.close();
  // review-decided が指す判断の記録（理由コード）を Private Evidence に置く。
  for (const [digest, reasonCode] of Object.entries(
    fixture<Record<string, string>>("decision-records.json"),
  )) {
    const directory = join(state, "private-evidence", digest, "content");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "record.json"),
      JSON.stringify({ reasonCode }),
    );
  }

  const mirror = new DatabaseSync(join(state, "history.sqlite"));
  mirror.exec(`CREATE TABLE vulnerabilities (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, published TEXT, record_json TEXT NOT NULL
    );
    CREATE TABLE software (
      vulnerability_id TEXT NOT NULL, slug TEXT NOT NULL,
      PRIMARY KEY (vulnerability_id, slug)
    )`);
  for (const record of fixture<
    {
      id: string;
      title: string;
      published: string;
      software: { slug: string }[];
    }[]
  >("mirror-records.json")) {
    mirror
      .prepare("INSERT INTO vulnerabilities VALUES (?, ?, ?, ?)")
      .run(record.id, record.title, record.published, JSON.stringify(record));
    for (const software of record.software)
      mirror
        .prepare("INSERT INTO software VALUES (?, ?)")
        .run(record.id, software.slug);
  }
  mirror.close();
});

afterEach(async () => {
  await rm(state, { recursive: true, force: true });
});

function render(extra: string[] = []) {
  const out = join(state, "board.html");
  const stdout = execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      script,
      "--state",
      state,
      "--units",
      join(fixtures, "units.json"),
      "--screen",
      join(fixtures, "screen.json"),
      "--mirror",
      join(state, "history.sqlite"),
      "--out",
      out,
      "--no-network",
      ...extra,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return {
    summary: JSON.parse(stdout) as Record<string, unknown>,
    html: readFileSync(out, "utf8"),
  };
}

function section(html: string, heading: string): string {
  const start = html.indexOf(`<h2>${heading}`);
  const end = html.indexOf("</table>", start);
  return html.slice(start, end);
}

test("renders report units with ledger, mirror and unfetched upstream without network", () => {
  const { summary, html } = render();
  expect(summary).toMatchObject({
    units: 2,
    excludedPlugins: 2,
    keep: 1,
    exclude: 3,
    unavailable: { mirror: 0, latest: 2, trunk: 2, ledger: 0 },
  });

  const units = section(html, "要検証");
  expect(units.match(/<tr><td>\d+<\/td>/g)).toHaveLength(2);
  expect(units).toContain("架空の画像集で題名欄が管理者画面に出る");
  // 固定版 2.1.0 を含む記録だけを数え、範囲外の記録は数えない。
  expect(units).toContain("固定版を含む公開記録 1 件");
  expect(units).toContain("Fixture Record In Range");
  expect(units).not.toContain("Fixture Record Out Of Range");
  expect(units).toContain("固定版を含む公開記録なし（slug の記録 0 件）");
  expect(units).toContain("最新版: 未取得");
  expect(units).toContain("trunk: 未取得");
  // 同じ Finding の review は最後のものを読む。
  expect(units).toContain("最新 review: <b>defer</b>（2026-01-03）");
  expect(units).toContain("観測 Lab 準備 1 回");
  expect(units).toContain("提出記録 1 件</b>（wordfence 2026-01-05）");
  expect(units).toContain("台帳の対象は wporg:sample-forms@1.0.1");
});

test("lists the ledger's stage 1 and 1b rejects per plugin, with the screen JSON as notes only", () => {
  const { html } = render();
  const excluded = section(html, "除外");
  const rows = excluded.match(/<tr><td><b>[^<]+<\/b>/g) ?? [];
  expect(rows).toEqual([
    "<tr><td><b>example-gallery</b>",
    "<tr><td><b>other-widgets</b>",
  ]);
  expect(excluded).toContain("オプション更新 1、格納型 XSS 1");
  expect(excluded).toContain("Wordfence 明示除外 1、本体依存 1");
  // 段 1b の不成立も台帳から出る。
  expect(excluded).toContain("sink に届かない（段 1b）");
  // JSON の注記は台帳にある除外にだけ付く。
  expect(excluded).toContain("本体の機能に依存する");
  expect(excluded).toContain("<details><summary>明細</summary>");
  // JSON だけの除外と、段 1・1b 以外の理由の reject は出さない。
  expect(excluded).not.toContain("99997777");
  expect(excluded).not.toContain("bbbb8888");
  expect(excluded).not.toContain("aaaa1111");
});

test("keeps going when the mirror is missing", () => {
  const { summary, html } = render(["--mirror", join(state, "absent.sqlite")]);
  expect(summary).toMatchObject({ unavailable: { mirror: 2 } });
  expect(section(html, "要検証")).toContain("ミラー: 未取得");
});
