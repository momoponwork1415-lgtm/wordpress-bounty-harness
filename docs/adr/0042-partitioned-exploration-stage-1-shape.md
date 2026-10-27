---
status: accepted
date: 2026-10-28
amends: 0029（単一協調 Trial の主経路）と 0039（探索の mode）に、Root を置かない 3 つ目の mode を足す。0019（生成する契約）に solo の描画を足す
---

# 区画分配型の探索（段階 1、形）

## 背景

探索の内側は、Root と最大 4 子の協調 Trial だけだった（ADR 0029、0039）。2026-10-27 の設計の報告（[2026-10-27-partitioned-exploration-design.md](../reviews/2026-10-27-partitioned-exploration-design.md)）は、本番の台帳から次の 4 つを読んだ。同じ経路が Finding と Lead の両方で複数の体から出る。Finding と Lead の線が体ごとに違う。`preconditionClass` は 27/32 が unknown で、Harness が自由文を分類している。Claude runtime の Root は file を 0 件読む。

公開 harness の repo 3 本（Anthropic の defending-code-reference-harness、Google Mantis、Cloudflare の audit skill）と Shopify、Mandiant AVDH の記事を行で読んだ結果（[2026-10-27-public-harness-repos-responsibility-split.md](../reviews/2026-10-27-public-harness-repos-responsibility-split.md)）、共通の線は 1 つだった。**中身は AI、形は Harness。** Harness は決定論の処理（schema、重複のまとめ、上限、割り当て、記録）だけを持ち、AI が出すべき中身を先に作らず、自由文を分類しない。区画の案を AI に出させる形には 3 つの先例がある。

所有者は 2026-10-27 に、探索の内側を「列挙役 → Harness の検査と割り当て → 区画ごとの追跡役 → 段 1b → Lab」の直列にし、Root を無くす構造を承認した（Issue #629）。組合せ役は 24 時間の輪に入れず名指しで起動する。考え方は Cloudflare VDH / VVS、AVDH、Anthropic の harness に揃え、部分ごとに Shopify（区画の大きさ = context の 2〜3 割）と Mantis（索引は HINT、証拠の階層）を足す（設計 §0）。

段階 1 は 2 本の PR に分ける。本 ADR はその 1 本目、**形** だけを決める。runtime（one-shot の runner、sandbox の mount、役ごとの実行、Trial の集約）は 2 本目で足す。

## 決定

### 役と流れ

- `discovery.mode` に `partitioned` を足す。`deep` と `wide` は変えない。
- 1 対象の Trial は、列挙役の run 1 つと、区画ごとの追跡役の run からなる。Root は置かない。どの役も入力 1 つ・出力 1 つで、子を起こさない。
- 列挙役は、固定ソースと、読み取り専用で `/workspace/tools` に置いた道具（hook の登録を拾う script、出口の呼び出しを拾う script）を受け取る。script は列挙役が自分で走らせて点検する。Harness は先に走らせず、出力を床として渡さない（所有者の指摘 2026-10-27: 床があると列挙役は何も足さない）。列挙役は行 id と `origin`（`script` / `agent`）付きの inventory と、区画の案を返す。
- Harness は inventory と区画の案の形だけを検査する。schema、同じ内容の行のまとめ、未知の行 id、どの区画にも無い行、複数の区画にある行、1 区画の行数と区画数の上限。超えた案は切り分けずに、理由の一覧を添えて差し戻す。差し戻しは `maxResubmits` まで。尽きたら Trial は理由付きの `incomplete` で終わり、候補 0 件には数えない。
- 追跡役は自分の区画の JSON、目的文 `objective-partition-v1`、契約 v4 の solo 描画、trust 境界、Programme Boundary を受け取り、Finding / Lead を返す。出力は既存の受け口（正規化、保留、park、群）をそのまま通り、Finding / Lead に `partition` が付く。
- 組合せ役と Lead の群は段階 2 以降。

### 役の定義と道具

- 役の定義は Markdown（frontmatter: `role`、`version`、`output` ＋ 本文）。`src/profiles/wordpress/prompts/agents/enumerator-v1.md`、`tracer-v1.md`。汎用の parser は `src/discovery/role-definition.ts`。定義の digest は Trial ごとの割り当て（区画の JSON）の digest と別に記録する。
- 道具は `src/profiles/wordpress/discovery/tools/` に置き、`WORDPRESS_ENUMERATION_TOOLS` で id と digest を固定する。道具の組の digest が `toolsDigest`。
- 目的文 `objective-partition-v1` は、現行の目的文がすでに持つ段落だけで組む（task-v15、first-principles-v11、sources-v8）。strategy、coordination、persistence の段落は持たない。区画が strategy で、協調する相手がいないからである。
- 契約 v4 の solo 描画（`wordpress-discovery-contract-v4-solo`）は、v4 から Root 宛ての段落 1 つと、子の報告と Root の最終報告に触れる 2 文を抜いたもので、ほかは byte 単位で同じ（所有者決定 2026-10-28）。新しい契約の版とは数えない（契約 v5 の教訓: Harness が足した文は探索を縮める。ADR 0038 追記 15）。
- 役の本文、目的文、道具の文は agent に渡る文章なので、`owner-approved` の規則（DEVELOPMENT 第 5 節）に従う。型の一覧、判断の基準、対象固有の名前、攻撃の手順は書かない。

### 設定

```json
"discovery": {
  "mode": "partitioned",
  "enumerator": { "runtime": "claude", "model": "…", "effort": "high", "wallMinutes": 20,
                  "tools": ["enumerate-hooks-v1", "enumerate-sinks-v1"], "rowSource": "agent" },
  "partition":  { "maxEntriesPerPartition": 60, "maxPartitions": 8, "maxResubmits": 2 },
  "tracer":     { "runtime": "claude", "model": "…", "effort": "high", "wallMinutes": 45, "maxParallel": 2 }
}
```

- 3 つの節は `partitioned` のときだけ書ける。省略した値は既定値になる。段階 1 の runtime は Claude だけ。
- 1 対象の最悪時間（列挙 × (1 + 差し戻し) + ceil(区画数 / 並列) × 追跡）は 240 分以内。並列の追跡役は memory 予算 ÷ (一発の sandbox 4,096 MiB + broker 512 MiB) 以内（所有者決定 2026-10-28、本番の予算 10,752 MiB なら 2）。
- `rowSource: "script-only"` は段階 3 の比較の腕で、Harness が script を先に走らせ、列挙役は区画の案だけ出す。測定にだけ使う。
- 例は `examples/campaign-partitioned.json`。

### 台帳

- `discovery-run-started.runKind` に `enumerate` / `trace`、`configuration.mode` に `partitioned`、`configuration.role {kind, definitionDigest, toolsDigest?, partitionId?, resubmit?}`。
- `enumeration-recorded`: Trial ごと 1 件。`accepted`、`resubmits`、`rejectedReasons`（enum の token だけ）、`inventoryDigest`、`partitionsDigest`、`scriptRan`、`scriptRowCount`、`agentRowCount`、`duplicateRowCount`、`partitionCount`、`definitionDigest`、`toolsDigest`、`rowSource`。行そのものは Private Evidence に置く（不変条件 8）。
- `partition-assigned`: 区画ごと 1 件。`partitionId`、`ordinal`、`of`、行数、`assignmentDigest`、担当の `runId`、`definitionDigest`。
- `finding-recorded.partition`、`lead-recorded.partition`。park には付けない。
- funnel は `enumerate` の run を Trial の試行として数え、`trace` の run は子と同じく数えない。

### 段階 1 の PR 1 で変えないこと

- runtime。`discovery.mode: "partitioned"` の設定は parse できるが、session は PR 2 まで `PARTITIONED_RUNTIME_PENDING` で拒む。
- `deep` と `wide` の Trial、prompt、契約、台帳の既存 event。
- SPEC 第 6 節。PR 2 で dev set 3 Trial が通った後に改訂する。

## 測り方

設計 §6 と `docs/agents/measurement.md` 5a 節。同じ 20 対象で v14-wide（契約 v4）と並べ、k=2。数えるのは群の数、段 1b を通った数、Lab で観測できた数、1 対象あたりの時間と token。列挙の品質は行 id を Finding / Lead の `sourceTrace` の先頭に突き合わせ、script の行と AI の行それぞれの使われた割合で出す。

## 採らなかった選択肢

- Harness が script を先に走らせて行を渡す: 列挙役が「もう揃っている」と読んで何も足さない。契約 v5 で Harness が足した文が探索を縮めたのと同じ現象。比較の腕としてだけ残す。
- 上限を超えた区画を Harness が切り分ける: 切り方は中身の判断で、線の外側。差し戻しにした。
- 組合せの候補を Harness が型合わせで作る: 語彙に乗らない組が落ち、当たらないたびに表が増える（消した「precondition の文からシナリオを選ぶ正規表現」と同じ種類）。一覧は形だけそろえて渡し、組は AI が選ぶ（段階 3、名指しのみ）。
- 契約の solo 版を v6 と数える: 文は v4 と同じで、抜いただけ。版を増やすと比較の分母が割れる。
- 新しい mode ではなく `wide` の中の切り替えにする: ADR 0039 の規則（mode は外側の設定値で決め、Trial の途中で変えない）に従い、mode にした。

## 追記 1（2026-10-28）: 本体の固定一覧

所有者決定（承認用の要約 §6 の Q6・Q11〜Q13、#632）。プラグインのソースだけでは見つからない「本体の機能の悪用」は、全プラグイン共通の固定知識として置く。

- 道具 `core-fixed-list-v1.md` を `/workspace/tools` に足す。中身は「プラグインが値を渡すと本体が効果に変える機能」と「本体が要求をプラグインのコードに解決する経路」の表で、機能の粒度で書き、Wordfence mirror の先例の件数（2025-01-01 以降、mirror 2026-10-27）を優先度の目安として添える。slug、個別の事例、手順、型の一覧は書かない。導出は [先例の集計](../reviews/2026-10-28-core-feature-abuse-precedents.md)。
- 渡す役は列挙役と追跡役。列挙役の本文に読む旨の 1 文を足した（digest を更新）。追跡役への mount は段階 1 の runtime PR で行う。⑤ の読み直し役には渡さない。
- 床ではない。一覧は本体側の機能の名前だけで、対象の行を含まない。列挙役が出す行の責任は変わらない。
- 更新は版と digest を固定し、mirror の月次の集計で新しい類が出たときだけ、数字付きの PR で版を上げる。自動では作り直さない。
- 消し方: file を消し、`WORDPRESS_ENUMERATION_TOOLS` の行と設定の `enumerator.tools` から外し、列挙役の 1 文を戻す。

## 消し方

`discovery.mode` を既定（`deep`）に戻すか `wide` にすれば、現行の協調 Trial のまま。役の Markdown、道具、`objective-partition-v1` の行、新しい event と `partition` 欄、設定の 3 節は残しても読まれない。消すときは、この ADR と GLOSSARY の 4 行、measurement.md の 5a 節、reviews/README の参照を revert し、`src/discovery/role-definition.ts`、`partition.ts`、`prompts/roles.ts`、`prompts/agents/`、`discovery/tools.ts`、`discovery/tools/`、`examples/campaign-partitioned.json` と test を消す。台帳の既存 event は消さない。
