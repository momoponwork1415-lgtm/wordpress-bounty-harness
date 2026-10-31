import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, expect, test } from "vitest";

// #701: 検証ループの道具が、台帳の最新の記録から各 Finding を手順の節に振り分ける。

const script = fileURLToPath(
  new URL("../../scripts/verification-loop.ts", import.meta.url),
);
const id = (digit: string) => `sha256:${digit.repeat(64)}`;
const snapshot = id("e");
let state: string;
let sequence = 0;
const events: Record<string, unknown>[] = [];

/** review-decision の記録を Private Evidence に置き、その digest を返す。 */
function decisionRecord(reasonCode: string): string {
  sequence += 1;
  const digest = `sha256:${sequence.toString(16).padStart(64, "0")}`;
  const directory = join(state, "private-evidence", digest, "content");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "record.json"), JSON.stringify({ reasonCode }));
  return digest;
}

const at = (minute: number) =>
  new Date(Date.UTC(2026, 9, 30, 0, minute)).toISOString();
function recorded(findingId: string, extra: Record<string, unknown> = {}) {
  events.push({
    type: "finding-recorded",
    campaignId: "prod-fixture-1",
    findingId,
    snapshotDigest: snapshot,
    category: "stored-xss",
    occurredAt: at(0),
    ...extra,
  });
}
function decided(
  findingId: string,
  decision: string,
  reason: string,
  minute = 1,
) {
  events.push({
    type: "review-decided",
    campaignId: "prod-fixture-1",
    findingId,
    decision,
    occurredAt: at(minute),
    artifacts: [{ kind: "review-decision", digest: decisionRecord(reason) }],
  });
}
function verified(
  findingId: string,
  verificationId: string,
  result: Record<string, unknown>,
  minute = 2,
) {
  events.push({
    type: "lab-provisioned",
    identity: `verification-lab-${verificationId}`,
    labId: `lab-${verificationId}`,
    occurredAt: at(minute),
  });
  events.push({
    type: "verification-finished",
    campaignId: "prod-fixture-1",
    findingId,
    verificationId,
    result,
    occurredAt: at(minute),
  });
}

beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), "wbh-verification-loop-"));
  events.length = 0;
  events.push({
    type: "target-selected",
    snapshotDigest: snapshot,
    selectionId: "wporg:sample-forms@1.0.1",
  });
});

afterEach(async () => {
  await rm(state, { recursive: true, force: true });
});

function run(extra: string[] = []) {
  const ledger = new DatabaseSync(join(state, "ledger.sqlite"));
  ledger.exec(`CREATE TABLE ledger_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    event_json TEXT NOT NULL
  )`);
  const insert = ledger.prepare(
    "INSERT INTO ledger_events (event_type, event_json) VALUES (?, ?)",
  );
  for (const event of events)
    insert.run(event.type as string, JSON.stringify(event));
  ledger.close();
  const stdout = execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      script,
      "--state",
      state,
      "--running-labs",
      "lab-v-held",
      "--since",
      "2026-10-29T00:00:00.000Z",
      "--json",
      ...extra,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(stdout) as {
    counts: Record<string, number>;
    labs: { slots: number; held: string[]; free: number; teardown: string[] };
    next: Record<string, { findingId?: string; findingIds?: string[] }[]>;
    metric: { findingsReady: number; medianHoursToObservationReady: number };
  };
}

const ids = (list: { findingId?: string }[] | undefined) =>
  (list ?? []).map((item) => item.findingId);

test("routes each Finding by its latest decision, verification and observation", () => {
  recorded(id("1")); // 記録なし → 段 1
  recorded(id("2"));
  decided(id("2"), "defer", "screen-v5-verify"); // 段 1b へ
  recorded(id("3"));
  decided(id("3"), "defer", "screen-v5-verify");
  decided(id("3"), "defer", "source-check-pass", 2); // 単位が無い → 報告単位
  recorded(id("4"));
  decided(id("4"), "reject", "screen-v5-chain-fragile"); // 除外
  recorded(id("5"));
  decided(id("5"), "defer", "source-check-unknown"); // 所有者
  recorded(id("6"));
  verified(id("6"), "v-held", {
    status: "incomplete",
    reason: "awaiting-human-observation",
  });
  events.push({
    type: "manual-observation-lab-ready",
    findingId: id("6"),
    verificationId: "v-held",
    occurredAt: at(90),
  });
  recorded(id("7"));
  verified(id("7"), "v-stalled", {
    status: "incomplete",
    reason: "precondition",
  });
  recorded(id("8"));
  verified(id("8"), "v-done", { status: "incomplete", reason: "precondition" });
  decided(id("8"), "defer", "loop-retry-exhausted", 5); // やり直しも止まった → 所有者
  recorded(id("9"), { campaignId: "tp326-sv3-c1" }); // 開発セットは扱わない

  const result = run();
  expect(ids(result.next.screen)).toEqual([id("1")]);
  expect(ids(result.next.sourceCheck)).toEqual([id("2")]);
  expect(ids(result.next.unit)).toEqual([id("3")]);
  expect(ids(result.next.awaitingHuman)).toEqual([id("6")]);
  expect(ids(result.next.stalled)).toEqual([id("7")]);
  expect(ids(result.next.owner)).toEqual([id("5"), id("8")]);
  expect(result.counts.done).toBe(1);
  expect(Object.values(result.counts).reduce((a, b) => a + b)).toBe(8);
  // 生きている観測待ち Lab が 1 つ。既定の枠 4 から引いて空き 3。
  expect(result.labs).toMatchObject({
    slots: 4,
    held: ["lab-v-held"],
    free: 3,
  });
  // finding-recorded から observation-ready まで 1.5 時間。
  expect(result.metric).toMatchObject({
    findingsReady: 1,
    medianHoursToObservationReady: 1.5,
  });
});

test("plans one Lab per report unit, at most five Findings, within the free slots", () => {
  const unitFindings = ["a", "b", "c", "d", "f", "1"].map(id);
  for (const findingId of unitFindings) {
    recorded(findingId);
    decided(findingId, "defer", "source-check-pass");
  }
  recorded(id("2"));
  decided(id("2"), "defer", "source-check-pass");
  mkdirSync(join(state, "review-notes"));
  writeFileSync(
    join(state, "review-notes", "report-units-2026-10-30.json"),
    JSON.stringify([
      {
        groupId: "u1",
        representative: "aaaaaaaa",
        members: ["bbbbbbbb", "cccccccc", "dddddddd", "ffffffff", "11111111"],
      },
      { groupId: "u2", representative: "22222222", members: [] },
    ]),
  );
  const result = run(["--lab-slots", "1"]);
  expect(result.next.lab).toEqual([
    expect.objectContaining({
      unit: "u1",
      findingIds: unitFindings.slice(0, 5),
    }),
  ]);
  expect(result.next.labWaiting).toEqual([
    expect.objectContaining({ unit: "u2", findingIds: [id("2")] }),
  ]);
});

test("sends a human match to the report step and tears down its Lab; a derived Finding replaces its origin", () => {
  recorded(id("1"));
  verified(id("1"), "v-held", {
    status: "incomplete",
    reason: "awaiting-human-observation",
  });
  events.push({
    type: "manual-observation-lab-ready",
    findingId: id("1"),
    verificationId: "v-held",
    occurredAt: at(10),
  });
  events.push({
    type: "manual-observation-recorded",
    findingId: id("1"),
    verificationId: "v-held",
    result: "match",
    occurredAt: at(20),
  });
  recorded(id("2"));
  verified(id("2"), "v-old", { status: "incomplete", reason: "precondition" });
  recorded(id("3"), { derivedFromFindingId: id("2") });

  const result = run();
  expect(ids(result.next.report)).toEqual([id("1")]);
  expect(result.labs).toMatchObject({
    held: [],
    free: 4,
    teardown: ["lab-v-held"],
  });
  expect(ids(result.next.stalled)).toEqual([]);
  expect(ids(result.next.screen)).toEqual([id("3")]);
});
