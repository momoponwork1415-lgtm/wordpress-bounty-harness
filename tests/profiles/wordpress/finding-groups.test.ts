import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { verifyNextFinding } from "../../../src/cli/pipeline.js";
import { canonicalDigest } from "../../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import { Ledger, type LedgerEventV1 } from "../../../src/ledger/index.js";
import { exportReviewBundle, Review } from "../../../src/review/index.js";
import { recordWordPressReport } from "../../../src/profiles/wordpress/discovery/candidate-admission.js";

// #424: 同じ Snapshot で plugin 側の file:function が重なる Finding を受理時に群にし、
// 群の識別子を台帳に残す。review と verify next は群の代表を先に出す。捨てない。
// 判定と提出の単位は Finding のまま。

const digestOf = (c: string) => `sha256:${c.repeat(64)}`;
const campaignId = "campaign-groups";
const base = {
  schemaVersion: 1 as const,
  campaignId,
  snapshotDigest: digestOf("a"),
  occurredAt: "2026-10-21T08:00:00Z",
};
const CORE = "@wordpress/wp-includes/synthetic.php#core_sink";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function stores() {
  const root = await mkdtemp(join(tmpdir(), "wbh-groups-"));
  directories.push(root);
  const evidence = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 200,
    maxBytes: 10 * 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: evidence,
  });
  return { evidence, ledger };
}

/** `frames` lists `file#function` places separated by spaces. */
function finding(claim: string, frames: string) {
  return {
    claim,
    attackerPosition: "subscriber",
    impact: "stored-xss",
    configurationPrecondition: "default",
    brokenProperty: "Synthetic property",
    sourceTrace: frames.split(" ").map((frame, index) => {
      const [file, fn] = frame.split("#");
      return { file, function: fn, line: index + 1 };
    }),
    existingControls: "None",
    labObservations: "Synthetic observation",
  };
}

type Recorded = Extract<LedgerEventV1, { type: "finding-recorded" }>;
async function record(
  { ledger, evidence }: Awaited<ReturnType<typeof stores>>,
  findings: unknown[],
  runId: string,
  snapshotDigest = base.snapshotDigest,
): Promise<Recorded[]> {
  await recordWordPressReport(
    { findings, leads: [] },
    {
      ledger,
      evidence,
      base: { ...base, snapshotDigest },
      runId,
      trialId: runId,
      snapshotDigest,
      reportArtifactDigest: snapshotDigest,
    },
  );
  return ledger
    .readAll({ campaignId, type: "finding-recorded" })
    .map(({ event }) => event as Recorded)
    .filter((event) => event.runId === runId);
}

const group = (id: string, size: number, representative: boolean) => ({
  id: canonicalDigest([campaignId, id]),
  size,
  representative,
});

/** Two Findings sharing a plugin-side place, one sharing only a core frame, and one older event. */
async function seed() {
  const stored = await stores();
  const [first, overlapping, separate] = await record(
    stored,
    [
      finding("First effect", `includes/a.php#handle ${CORE}`),
      finding("Same handler", "includes/b.php#entry includes/a.php#handle"),
      // 重なるのは WordPress 本体の frame だけ: plugin 側の file:function ではないので別の群。
      finding("Unrelated effect", `includes/c.php#other ${CORE}`),
    ],
    "run-1",
  );
  // 受入条件 2: 群の識別子より前（2026-10-21 以前）の形の event。
  const legacy = "legacy-finding";
  await stored.ledger.append({
    ...base,
    identity: legacy,
    type: "finding-recorded",
    findingId: legacy,
    runId: "run-legacy",
    category: "sqli",
  });
  return {
    ...stored,
    first: first!,
    overlapping: overlapping!,
    separate: separate!,
    legacy,
  };
}

it("records overlapping plugin frames as one group and keeps the rest apart (#424)", async () => {
  const { ledger, evidence, first, overlapping, separate, legacy } =
    await seed();
  expect([first, overlapping, separate].map((e) => e.group?.id)).toEqual([
    first.findingId,
    first.findingId,
    separate.findingId,
  ]);
  // 台帳は digest だけを持つ（不変条件 8）。file 名と関数名は書かない。
  expect(JSON.stringify([first, overlapping])).not.toMatch(/handle|a\.php/);
  // 受入条件 4: review export に群の識別子と群内の件数が出る。旧形式の event は単独の群。
  const exported = async (findingId: string) =>
    (
      await exportReviewBundle({
        ledger,
        store: evidence,
        campaignId,
        findingId,
      })
    ).group;
  expect(await exported(overlapping.findingId)).toEqual(
    group(first.findingId, 2, false),
  );
  expect(await exported(separate.findingId)).toEqual(
    group(separate.findingId, 1, true),
  );
  expect(await exported(legacy)).toEqual(group(legacy, 1, true));
});

it("puts each group's representative first in verify next and review, and drops none (#424)", async () => {
  const { ledger, evidence, first, overlapping, separate, legacy } =
    await seed();
  // verify next（handoff の列）: 各群の代表が先、群の残りはその後。全件を検証する。
  const picked: string[] = [];
  const verification = {
    promptVersion: "stub/v1",
    async verify(input: { findingId: string; verificationId: string }) {
      picked.push(input.findingId);
      // 自動再試行しない incomplete を残し、次の呼び出しは別の Finding へ進む。
      const result = {
        status: "incomplete" as const,
        reason: "evidence" as const,
        nextStep: "Synthetic next step",
      };
      await ledger.append({
        ...base,
        identity: input.verificationId,
        type: "verification-finished",
        verificationId: input.verificationId,
        findingId: input.findingId,
        labSetupDigest: digestOf("b"),
        promptVersion: "stub/v1",
        result,
      });
      return result;
    },
  };
  for (let index = 0; index < 5; index++)
    await verifyNextFinding({
      campaignId,
      ledger,
      newId: () => `verification-${index}`,
      loadSnapshot: async () => ({}) as never,
      setupFor: () => ({}),
      verification: verification as never,
    });
  const order = [first.findingId, separate.findingId, legacy];
  expect(picked).toEqual([...order, overlapping.findingId]);
  // review: 同じ順で、各項目に群の識別子と群内の件数が付く。
  const queue = new Review({
    ledger,
    artifactStore: evidence,
    scopeEvaluator: {
      programmeIds: ["wordfence"],
      policyDigest: digestOf("d"),
      assess: async () => [],
    },
    factsProvider: { load: async () => ({}) },
  }).queue({ campaignId });
  expect(queue.items.map((item) => [item.ref.findingId, item.group])).toEqual([
    [first.findingId, group(first.findingId, 2, true)],
    [separate.findingId, group(separate.findingId, 1, true)],
    [legacy, group(legacy, 1, true)],
    [overlapping.findingId, group(first.findingId, 2, false)],
  ]);
});

// 受入条件 3: 本番の振り分け（#424 の comment）のうち acf-extended・wp-seopress・pods と
// 同じ形を、対象固有の名前を使わずに再現する。Snapshot と sourceTrace の file / function だけを使う。
it("bundles production-shaped Findings into the groups the triage counted", async () => {
  const stored = await stores();
  const shapes = [
    {
      // acf-extended 形の 14 件: 7 件（鎖で連結）+ 5 件（同じ関数を共有）+ 単独 2 件。
      findings: [
        "a/form.php#render a/field.php#save",
        "a/field.php#save a/meta.php#update",
        "a/meta.php#update a/meta.php#sanitize",
        `a/meta.php#sanitize ${CORE}`,
        "a/meta.php#sanitize a/list.php#print",
        "a/list.php#print",
        `a/form.php#render ${CORE}`,
        "b/ajax.php#dispatch b/ajax.php#query",
        `b/ajax.php#query ${CORE}`,
        "b/ajax.php#query",
        "b/rest.php#route b/ajax.php#query",
        "b/ajax.php#query b/export.php#write",
        `c/upload.php#store ${CORE}`,
        // plugin 側の場所が無い Finding は単独の群。
        CORE,
      ],
      groups: [7, 5, 1, 1],
    },
    {
      // wp-seopress 形の 6 件: 5 件 + 単独 1 件。
      findings: [
        "s/meta.php#save s/meta.php#field",
        "s/meta.php#field",
        "s/bulk.php#run s/meta.php#save",
        `s/meta.php#field ${CORE}`,
        "s/redirect.php#add s/meta.php#field",
        `s/sitemap.php#render ${CORE}`,
      ],
      groups: [5, 1],
    },
    {
      // pods 形の 2 件: 同じ本体の出口に出るが、plugin 側の関数が別なので 2 群。
      findings: [`p/item.php#save ${CORE}`, `p/item.php#load ${CORE}`],
      groups: [1, 1],
    },
  ];
  for (const [index, shape] of shapes.entries()) {
    const recorded = await record(
      stored,
      shape.findings.map((frames, n) =>
        finding(`Effect ${index}.${n}`, frames),
      ),
      `run-shape-${index}`,
      digestOf(String(index + 1)),
    );
    const sizes = new Map<string, number>();
    for (const { group } of recorded)
      sizes.set(group!.id, (sizes.get(group!.id) ?? 0) + 1);
    expect([...sizes.values()]).toEqual(shape.groups);
  }
  // 別の Snapshot の同じ file:function は束ねない。
  const [again] = await record(
    stored,
    [finding("Same frame, other snapshot", "a/form.php#render")],
    "run-other-snapshot",
    digestOf("c"),
  );
  expect(again!.group?.id).toBe(again!.findingId);
});
