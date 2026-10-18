# 2026-10-14 対象選定・並列実行・無人運転の照合

調べて報告する文書。正本ではない。事実、推論、提案を分ける。

## 調査範囲と限界

2026-10-14 13:04 JST 時点の GitHub main（d214de0）、v4 系の PR #217 / #219、Opus の Draft PR #225、SPEC、ADR 0029・0030・0031・0032、DEVELOPMENT、LESSONS、実装とテストを照合した。main はまだ v3 であり、実運転は v4 系の Git 外 state と別 worktree を使う。以下で「実装」は主に PR #219 head f85540a のコード、「運転事実」は同日監視チャットの台帳照合結果を指す。ローカル作業ツリーと Git 外 state はこの調査セッションの実行ツール障害で直接読めていない。pnpm check と実機 Trial は本調査では実行していない。

## 結論

| 問い | 確認結果 |
| --- | --- |
| 対象選定 | 同じ state の過去選定と未公開 Finding の除外、版・prompt変更による再候補化、選定内の次点補充は実装済み。別 state の既往は共有されない。既定の自動選定は3件未満で停止する。 |
| 並列実行 | 1 campaign 内の異なる対象を最大2本動かす worker は実装済み。Codex と Opus をまたぐ対象予約、総メモリ・provider枠の原子的な管理はない。 |
| 数時間〜1週間 | 固定済み1バッチの処理と、その未消費対象への再開はある。次バッチ補充、全体期限、異常と結果の照合、横断資源管理は Git 外 driver と監視セッションに依存し、Step 1 の「1週分を人手0」は未達。 |

## 1. 対象選定

### 事実

- 個別 plugin の公開脆弱性履歴の件数・内容は、候補の列挙、除外、採点に使わない。これは [ADR 0030](../../adr/0030-public-history-is-neutral-in-target-selection.md) と [選定実装](../../../src/profiles/wordpress/selection/wordpress-selection.ts) が一致する。ADR 0032 のタグ単位 yield は候補タグを選ぶための集計であり、個別 plugin の加点ではない。
- [ledger-exclusions.ts](../../../src/profiles/wordpress/selection/ledger-exclusions.ts) 101–158行は、同じ state の全 <code>target-selected</code> を slug の既往として扱い、<code>finding-recorded</code> がある slug を <code>unpublished-finding</code> として優先除外する。提出を記録しただけでは公開済みとみなさない。選定予約時に <code>target-selected</code> を書くため、Trial を始めていない対象も既往に入る。
- v4 系の [選定方針](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/84fc58639bc676ea8f3d496bb12abddd7de0d9f7/src/profiles/wordpress/policy/selection.json) は <code>version-or-prompt-changed</code>。候補版がすべての既往版より新しい、または現在の prompt がすべての既往の既知 prompt と異なると再候補になる。過去 prompt が不明なら prompt 変更だけでは許さない。未公開 Finding の除外はこの再候補化に優先する。現在の24時間 Codex 運転は Git 外方針で <code>revisitPolicy: never</code> としており、この既定より厳しい。
- 1回の選定では人気順と既定8タグから最大500候補を集め、適格候補を順位順に Snapshot 固定し、失敗時は次点で補う。[wordpress.ts](../../../src/cli/wordpress.ts) 1271–1320行。既定では固定済み3件未満なら選定レポートを Private Evidence に残してエラーにし、バッチの <code>target-selected</code> は書かない。候補源の自動拡張と閾値の自動緩和はない。
- Opus の [Draft PR #225](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/pull/225) の選定では、別 state に Codex 既往 slug 833件を Git 外方針で補完して除外しても、10万 install の既定コホートは500候補中、固定可能な新規1件だった。その後、同 PR の [選定契約](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/codex/opus-55-discovery/src/profiles/wordpress/selection/contracts.ts#L106-L122) と [CLI](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/codex/opus-55-discovery/src/cli/wordpress.ts#L1304-L1312) には、明示した <code>maximumTargets: 1</code> だけを許す変更が入った。既定の3件下限を変えるものではなく、PRは未統合。監視チャットでは、所有者が認めた別の3万 install コホートから3件を固定し、Opus 初回 Trial 1件が進行中と報告された。これは既定10万コホートの適格数が改善したことを意味しない。

### 評価

既往除外は「公開履歴を理由に避ける」規則ではなく、「同じ台帳で予約した対象と未公開 Finding を管理する」規則である。別 state の Codex と Opus には共通の予約台帳がないため、現在の非重複は Git 外リストの転記と人の照合で成り立つ。PR #216 の host 共通 Trial registry も Draft であり、全選定入口の原子的な slug 予約を保証したとはまだ言えない。

## 2. 並列実行

### 実装済み

- v4 系 [campaign.json](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/84fc58639bc676ea8f3d496bb12abddd7de0d9f7/src/profiles/wordpress/policy/campaign.json#L15-L20) は <code>maxRuns: 1</code>、<code>maxConcurrentRuns: 1</code>、<code>maxConcurrentTargets: 2</code>。 [pipeline.ts](../../../src/cli/pipeline.ts) 598–629行は固定バッチ内の対象 worker を2本まで起動する。2対象の同時進行・停止再開・対象別 cleanup は [CLIテスト](../../../tests/cli/cli.test.ts) 2157–2223行で確認される。
- 対象ごとの Lab、broker、sandbox は識別子で分離される。探索の provider limit を検知すると新規対象投入を止め、進行中対象の結果を待つ。これは単一 CLI / campaign 内の制御である。

### 未実装と測定上の限界

- <code>memoryBudgetMiB</code> は対象内の同時 discovery run 数の計算に使う値で、複数 campaign・別 state・別 provider の総予約ではない。[wordpress.ts](../../../src/cli/wordpress.ts) 960–968行。Codex の協調 sandbox 上限8 GiBと broker 512 MiBだけで2対象は最大約17 GiBを予約し得て、Labは別枠。ホストの空きメモリや provider 同時要求枠を Codex/Opus 横断で取得する semaphore は見当たらない。
- 別 state の slug 予約に原子的な共有 claim はない。現行の「Opus 2＋Codex 2、合計4」は外側の運用上限で、Harness が両 provider の起動時に守らせる上限ではない。[Opus事前確認レポート](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/codex/opus-55-discovery/docs/reviews/2026-10-14-claude-opus-55-subscription-preflight.md#L27-L30) も外側の監視を前提にする。
- #184 の「5対象82分」「ホスト24 CPU・約47 GiB」は2並列を試す根拠であり、2または4並列の実効短縮率とピーク資源の実証ではない。[Issue #184](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/184)。

文書上は [SPEC 第6節](../../SPEC.md) が「最初はTrialを1つずつ」と書く一方、既定設定は対象2並列である。[ADR 0032](../../adr/0032-owner-decisions-on-constraints-2026-10-13.md) 39行の「並列3、Opus併用時2、sandbox CPU 6」は proposed の決定で、現行 Codex sandbox の実装は CPU 1 のまま。設計意図、既定設定、実装値、実測値を同一視できない。

## 3. 数時間〜1週間の無人運転

### コードが行う範囲

<code>select</code> と <code>campaign run</code> は別コマンド。[OPERATIONS.md](../../OPERATIONS.md) 47–52行。初回の campaign run は最新の完全な選定バッチを <code>selection-batch-bound</code> で固定し、[pipeline.ts](../../../src/cli/pipeline.ts) 599–629行はその集合を処理する。次のバッチを選び直して連鎖するコードはない。60分は Trial の wall 上限であり、数時間・1週間の campaign 期限、週 quota、開始期限ではない。[SPEC](../../SPEC.md) 第6節、[DEVELOPMENT](../../DEVELOPMENT.md) 第2節の1週分無介入は完成条件であって達成記録ではない。

探索の provider limit 等なら新規対象開始を止めて終了コード3を返し、同じ command と campaign ID で未消費対象へ再開できる。一方、対象別の Snapshot・Lab・探索・検証エラーは <code>target-skipped</code> にして次へ進む経路があり、それだけなら CLI が0で終わり得る。[pipeline.ts](../../../src/cli/pipeline.ts) 241–267、374–389、579–596行。Verifier 結果が <code>incomplete(provider)</code> の場合も全体停止へ接続していないように読める。これはコードからの推論で、実機未確認。

Finding の独立 Verifier、理由別の再試行、台帳、review queue はある。[pipeline.ts](../../../src/cli/pipeline.ts) 462–559行、[review/index.ts](../../../src/review/index.ts) 216–327行。ただしバッチ全体の完了条件に「全 Finding に最終検証結果がある」「review export に届いた」を照合する処理と通知はない。AI監視が台帳を読む必要が残る。

「再開」は started 済み Trial の再試行を意味しない。[campaign.ts](../../../src/discovery/campaign.ts) 350–374、662–694行は、<code>discovery-run-started</code> がある時点で Trial 枠を消費する。対応する finished が欠けても同一 campaign ではその対象の Trial を置き換えない。失敗後に対象が完了扱いにならなければ、再実行で Lab 供給だけを繰り返し得る。[CLIテスト](../../../tests/cli/cli.test.ts) 2299–2349行も失敗 Trial の再実行が <code>runs 0</code> となることを固定している。

### 2026-10-14 13:04 JST の運転スナップショット

別の監視セッションの台帳照合によると、Codex 24時間運転は期限前の12:58 JSTに、Git 外 driver の <code>external-concurrency-cap</code> で停止した。driver が Opus の稼働を検知して進行中の Codex campaign を中断し、2対象の Root run に started はあるが finished がない。状態ファイルの「未完了0件」は台帳と不一致。選定20件、正常完了Trial12件、未完了2件、準備失敗4件、実行前skip2件、Finding2件、Lead10件。Opus 初回 Trial は継続中。期限は10月15日10:45:27 JSTで変更されていない。数値はこの時点のもの。対象名、未公開候補、payload、HTTP記録は本書に載せない。

この事故は「2並列 worker が動かない」証拠ではなく、横断ガードが稼働中 run を止めたことと、外側の status 集計が台帳の未終了 run を見落としたことを示す。同じ campaign IDを再実行しても、未終了2 Trial は自動でやり直されない。started/finished の照合と残存 Lab・broker の所有確認が先である。Opus が動いている間、全体の <code>lab cleanup --remove</code> は [OPERATIONS.md](../../OPERATIONS.md) 198–206行の条件に反する。

## 判断と次の問い

1. **最優先は運転状態の整合**。外側 driver が新規投入だけを止め、稼働中 Trial は完了または明示的な incomplete event まで待つこと。終了時は status.json でなく台帳の対象、started/finished、Finding/Lead、検証結果を突き合わせる。今回の2件を正常な0件や完了Trialに数えない。
2. **次に横断調停**。Codex と Opus の全起動経路で、slug と host 資源の共有 lease を原子的に取得する必要がある。現在の Git 外 excludedSlugs 転記と別々の memoryBudget は保証にならない。PR #216 の承認 registry と、同時実行の予約・重複防止を混同しない。
3. **週運転は1バッチの上に明示的な状態機械が必要**。期限前にだけ次の select を行い、候補不足・provider limit・対象別 skip・未検証・未終了 run を別の停止理由として残し、同じ state と方針 digest から再開する。候補不足時の条件変更は自動で行わず、方針改訂と新コホートとして記録する。

この順序は [LESSONS](../../LESSONS.md) の「判断の要らない処理はコード」「人間に見えない成果は無い」「量を増やす前に選定と検証を厚くする」と整合する。人間の提出前レビューと外部行動承認は [SPEC](../../SPEC.md) 第2節の判断点として残る。これ以外の機械的な監視を常時AIセッションに任せる状態を、1週無介入の完成とは扱わない。

## 未確認

- この調査セッションはローカル作業ツリーと Git 外の運転台帳を直接読めなかった。上の運転数字は監視セッションの読み取り報告に依存する。
- Opus 2＋Codex 2 の同時負荷、provider limit時の全体挙動、1週間の無人完走は未測定。
- PR #225 の実対象3 Trial品質ゲート、#216 の統合、停止した2 Trialの最終整理は未完了。
