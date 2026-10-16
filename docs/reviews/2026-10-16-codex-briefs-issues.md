# Codex への依頼文（Issue #275 / #276 / #278 / #279 / #277 / #281、2026-10-16）

所有者が Codex に貼って回す依頼文。PR 修正 3 本の依頼文は [2026-10-16-codex-briefs-262-265-268.md](2026-10-16-codex-briefs-262-265-268.md)。期限は 2026-10-20。順番のおすすめ: #281 → #284 → #276 → #275 → #278 → #279 → #277（matrix のみ）。1 run に 1 Issue。

共通の前置き（各依頼の先頭に付ける）:

```text
リポジトリ momoponwork1415-lgtm/wordpress-bounty-harness。origin/main から新しい branch を作る（命名 codex/issue-<番号>-<短い語>）。
規則: AGENTS.md、docs/DEVELOPMENT.md 第 3・5 節、docs/FACTORY.md、docs/reviews/2026-10-14-final-design.md 第 1・8・13 節を先に読む。
不変条件（SPEC §2）、判定器の成功条件、既定 prompt、台帳の event 型は変えない。新しい台帳 event 型・第 2 の journal・crash reconciliation は書かない。
先に公開 interface から失敗する受入試験を 1 つ書き、最小実装で通す（docs/TEST-STRATEGY.md）。
PR 本文は 5 項目（問い / 変えたこと / 変えなかったこと / 測った数字 / 消し方）を日本語で。pnpm check と pnpm build を通し、数字を貼る。追加差分は 500 行以内。
配線・runtime の変更は DEVELOPMENT §5 の初回 3 Trial の数字が別途必要なので、PR は Draft のままにし「数字待ち」と comment する。
open の PR が 3 本を超えている間は新しい実装 PR を出さない（DEVELOPMENT §5）。超えていたら Issue に進捗だけ comment して止まる。
```

## #281 campaign ID が長いと対象が freeze 段階で黙って skip される

```text
Issue #281 を解く。再現: campaign ID 42 文字で target-selected の identity（target-selected-<campaign>-<snapshot digest>）が Zod の 128 文字上限を超え、Ledger.append が throw、対象が target-skipped(stage: freeze, reason: other)、CLI は終了コード 0。

1. src/cli/index.ts の campaign run の入口で campaign ID の長さを検査し、identity が 128 文字に収まる上限（計算して定数にする）を超えたら UsageError で止める。メッセージに上限値と実際の長さを出す。continuous run が生成する campaign ID（prefix + 連番）も同じ検査を通す。
2. 既存 event の identity 形式は変えない。
3. 全対象が target-skipped(reason: other) で終わった campaign run は終了コード 0 にしない（既存の終了コードの意味は docs/OPERATIONS.md を読んで合わせる）。
4. テスト: (a) 長い ID で usage error、(b) 上限ちょうどの ID で通る、(c) 全対象 skip で非 0 終了。
追加 100 行以内。
```

## #276 子 agent の有効な最終報告を後続 prose と 3 件 cap で失わない

```text
Issue #276 を解く。対象は src/discovery/codex-native-agent-runtime.ts（406, 1415, 1368 行付近）と tests/discovery/codex-native-agent-runtime.test.ts:313。

1. 子 rollout の task_complete ごとに finalMessage を上書きするのをやめ、全 task_complete を raw で保存する（Private Evidence、既存の保存方針 #103 / #121 を守る）。
2. 各子について「最新の parse 可能な完全報告」を採用する。有効な JSON の後に説明文が来ても成果が消えない。
3. 3 件 cap は妥当性検査を通った報告に適用し、overflow は理由付きで保持する（candidate-held と同じく失わない。台帳には分類と理由だけ）。
4. 故障注入テスト 2 本: (a) 子が 有効 JSON → prose の順で返す、(b) 無効 ×3 → 有効 ×1 の順で返す。どちらも有効報告が保存される。
5. PR 本文の「測った数字」には、計測 Trial の子の報告数（raw / admitted / held）を書く欄を用意する（数字は後で AI が貼る）。
```

## #275 Root の正常完了に探索深度の typed record を要求する

```text
Issue #275 を解く。対象は src/discovery/codex-native-agent-runtime.ts（39, 1589 行付近）と src/discovery/campaign.ts:622。

1. Harness 所有の typed record を 1 つ定義し、読んだ source 数、approach family、admitted child 数、wave 数、反証・未解決点を runtime の観測から埋める（prompt の文言や agent の自己申告ではない）。
2. v4 が求める「3 子・最低 2 wave」を満たさない Root の終了は completed ではなく incomplete(no-work) とし、campaign は no-new-finding に数えない。最低実行時間は導入しない。
3. SPEC §6 の「source 0・子 0・broker 転送 1 以下は Trial に数えない」との境界を 1 か所（関数 1 つ）で定義し、その間（少し読んで空報告）は Trial に数えるが incomplete(no-work) になる、と docs/OPERATIONS.md に 1 段落で書く。SPEC は変えない。
4. 既存 event 型は足さない。discovery-run-finished の reason / reasonDetail で表す。ledger funnel で no-work の件数が読めるようにする。
5. テスト: 公開 interface（campaign run と台帳）から「空の最終報告で completed」を再現する失敗テストを先に置き、修正後 incomplete(no-work) になる。
```

## #278 review: 後発の incomplete が既存の positive evidence を隠さない

```text
Issue #278 を解く。対象は src/review/index.ts（172, 803 行付近）と tests/review/review.test.ts:153、src/review/export.ts。

1. 「最新 attempt」と「現在有効な positive evidence」を分ける。同じ Finding に runtime-confirmed の後 incomplete が付いても、reproduction package と positive の証拠 ref は export と inspect に残る。incomplete は併記する。
2. positive を失効できるのは、同一 route / Lab Setup の Harness 所有 negative control（contradicted）だけ。
3. テスト: review export から、positive → incomplete の順で検証した Finding で reproduction package が残る。
4. .claude/skills/ の 3 skill が読む対照表に verification.status の分岐を 1 行足す。skill 本文を変えるなら、変更後の全文と日本語訳を PR 本文に貼る（agent に渡る文章の規則、DEVELOPMENT §5）。
```

## #279 review / Private Evidence の record・history 契約を揃える

```text
Issue #279 を解く。#270 の作業ツリーにある修正案（対象テスト 118 件）を main に移す作業。

1. 共通の record / history 契約を 1 か所に置き、途中 bytes の公開を無くす（tmp に書いて rename）。文字数と byte 上限を一致させる。現在の verification と過去の decision / human result を混同しない。履歴読込は 1 ページで止まらない。writer と reader の schema を同じ定義から導く。
2. private record の形状、既存 digest、台帳の正本は維持する。
3. 探索ロジックと混ぜない独立 PR。lockfile と一致する依存版で pnpm check を通す。
4. 追加 500 行以内。超えるなら「契約」と「publication」の 2 PR に分ける。
```

## #277 judge coverage matrix（表だけ。判定器は変えない）

```text
Issue #277 の第 1 段だけを行う。判定器（src/profiles/wordpress/verification/judges.ts）は所有者本人の owner-approved path なので変更しない。

1. Programme 対象 impact（src/profiles/wordpress/discovery/programme-impacts.ts）× observer / judge（judges.ts、standard-reproducer.ts）の coverage matrix をテスト 1 本で固定する。各 impact について「judge あり / no-judge / 構造上 incomplete(observation) にしかならない」を出す。
2. その表を docs/reviews/2026-10-16-judge-coverage-matrix.md に書き、rfi、content-deletion、nonce 付き REST（judges.ts:911 の header 名による拒否）の 3 件がどこで止まるかを file:line で示す。
3. 判定器を足す・直す案は表の末尾に「所有者の判断」として列挙するだけで、実装しない。
PR は docs とテストだけ。
```

## #284 Lab provision 失敗の message と nextStep を残す（#281 の次、追加分）

```text
Issue #284 を解く。対象は src/cli/pipeline.ts（lab-provisioned の追記、455〜495 行付近）と src/profiles/wordpress/lab/index.ts（provision / seedCanaries の catch、820〜870 行付近）。

1. provision / seed / probe の失敗で、例外の class 名と message（先頭 500 文字）、nextStep を Private Evidence の lab-diagnostic artifact（既存の stderr.txt と同じ store.putFiles）に書き、台帳の lab-provisioned が digest で参照する。LabDockerFailure の diagnostic は従来どおり同じ artifact に含める。既存 event 型は足さない。
2. CLI の対象行（lab failed  runs 0  stopped by setup-failed）に failureStage、reason、artifact digest の先頭 12 文字を出す。
3. setup-failed の対象が 1 つ以上ある campaign run の終了コードは 0 にしない。#281 の受入 3 と同じ扱いにし、既存の終了コードの意味は docs/OPERATIONS.md を読んで合わせる（1 行足す）。
4. テスト: provision が一般の Error を throw する fake Lab で、(a) artifact に class 名と message が残る、(b) CLI 出力に stage が出る、(c) 終了コードが非 0。
provision の自動再試行は足さない。追加 120 行以内。
```
