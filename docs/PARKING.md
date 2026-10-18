# PARKING（止めてある案）

Step 1（[DEVELOPMENT.md](DEVELOPMENT.md) 第 2 節）の完了まで着手しない案を 1 行ずつ置く。ADR にも Issue の milestone にもしない。再開の条件が書けるものは書く。

| 日付 | 案 | 再開の条件 |
| --- | --- | --- |
| 2026-10-13 | 探索 prompt の優先順位リストを所有者の有償実績順（ATO、Stored XSS、SQLi）に並べ直す | v4 の測定後、分類構成に偏りが見えたとき |
| 2026-10-13 | Verifier を「反証」から「発火の確認」へ向ける v7 の後、再試行回数で試行数が下がらなければ文言を再検討 | #107 の数字 |
| 2026-10-13 | PHP 本体の source を探索に渡す（元記事の third_party） | RCE 連鎖の候補が本番で出たとき |
| 2026-10-13 | WooCommerce を Lab の依存として常備する | 同じ前提不足が 3 回出たとき（Q47 の自動導出で足りない場合） |
| 2026-10-13 | LLM による候補の要約・順位付け skill | 週のレビュー batch が 6 時間を超えたとき |
| 2026-10-13 | 重複照合 skill を Harness から自動で呼ぶ | 人間が skill で 10 件回して出力が安定したとき |
| 2026-10-13 | Claude 系（Opus）探索 runtime の追加（`codex/opus-55-discovery`） | 無人運転の初回 Trial が 15 本以上あり、拒否率 30% 以上、または拒否 hold が週 2 回以上のとき。再開時は Claude 側の拒否分類を先に入れ、arm は campaign 設定で明示する（2026-10-14） |
| 2026-10-13 | Patchstack を第 2 の提出先にする（Programme Boundary を 2 本） | 提出候補が出た後、#175 の線で |
| 2026-10-13 | 検証 scenario を precondition 文の正規表現で選ぶ仕組みの置き換え | `incomplete(precondition)` の誤選択が 3 回出たとき |
| 2026-10-13 | 文書の整理（docs/reviews/2026-10-12-consolidation-and-production-first.md 第 4 節） | Step 1 完了後 |
| 2026-10-13 | 既知 7 件の再発見ベンチマークの残り（Smash Balloon、Unlimited Elements、TranslatePress 3.2.6） | Step 2 で判定器を触るとき |
| 2026-10-13 | 修正版の負の対照と `contradicted` の自動化 | Step 2 |
| 2026-10-13 | review CLI の多機能（decide / scope / draft / authorize / dedupe の人間向け表示）を skill 側へ寄せ、CLI を機械向けの最小集合に整理する | Step 2。skill 3 本が 10 件回って出力が安定したとき（ADR 0032 Q27） |
| 2026-10-14 | 継続運転の journal / owner lease / host 共通 claim / crash reconciliation / 既往 gate（`codex/issue-229-batch-pin`、`codex/issue-229-continuous-pr`、`codex/issue-227-inventory-slice`、`codex/issue-228-cross-campaign-claims`、`codex/repeat-trial-approval`）。branch は参照用に残し merge しない | 第 2 provider が実動したとき、または実機で連続運転が 2 回止まったとき |
| 2026-10-14 | 軽微な到達効果の事前保留（`codex/low-value-impact-gate`、#218） | review queue が週 15 件を超えたとき |
| 2026-10-14 | 週次 smoke の replay Verifier（#126）、`assignment` mode、旧 arm の examples、`eval score / keys / rubric / compare / prospective / case-blocked`、`review inspect`、`ledger coverage`、`review open`、archive prompt 10 版、plugin 固有 Lab adapter 8 本の削除 | Step 1 合格後の整理 PR（最終設計 P13）。週次 smoke の replay Verifier（#126）は 2026-10-18 所有者承認で削除（PR #342。`judges.ts` が読む `smoke-binding.json` の照合は凍結のため残し、`smoke-replay-recipe.ts` を読取専用の shim に縮めた）。`eval score / keys / rubric`・`review open`・`renderWordPressLeadNeighbourhood` は 2026-10-18 所有者承認で削除（PR #343。`eval compare` は保留のまま）。`eval compare / prospective / case-blocked`、`review inspect`、`ledger coverage` の 5 command は 2026-10-18 に所有者の指示で削除（運用・skill・runner のどれも呼んでいなかった。`evaluation-case-blocked` と `review-item-opened` の event 型は読み続ける）。plugin 固有 Lab adapter のうち Download Monitor / Download Manager の 2 本は 2026-10-18 所有者承認で削除（PR #344。Relevanssi / Simply Schedule / Brizy ×2 は `nextWordPressScenario` 経由で `verify next` の scenario 再試行が参照するため保留、User Registration ×2 / wpDiscuz / WP-Members は所有者実績 case との照合待ち）。旧 arm の examples（`translatepress-3.2.5/` 全部と `translatepress-3.2.6/` の managed-v1 / managed-v3 / wp2shell-bounty-v1 / short-objective-v2 の 4 file）は 2026-10-18 所有者承認で削除（PR #345。比較 arm v2 / v4 の file と `containers/development-set/` は残す） |
| 2026-10-14 | install 下限を方針版で変える仕組み（#230） | `--selection` で下限別の方針 file を選ぶ運用で代える。運用で足りなくなったとき |
| 2026-10-14 | 探索 prompt の A/B 事前登録（#201、再発見 case 5 × 2 arm） | Step 1 合格後 |
| 2026-10-14 | Wordfence mirror の日次更新（#231） | 提出候補が週 1 件を超えたとき |
| 2026-10-14 | WordPress プラグイン以外の対象を第 2 の Target Profile として追加する | WordPress 版の縦断ループが安定し、第 2 対象の固有要件が確認できたとき |
| 2026-10-14 | Google Mantis など探索手法の切り替えを比較可能な戦略として扱う | Step 1 の既定手法の実測分母ができ、比較する問いを 1 つ定めたとき |
| 2026-10-14 | 運転ログを AI が分析し、人間と協調して Harness を改善する | 継続運転の記録と人間レビューの転帰が十分に蓄積したとき |
| 2026-10-15 | 運転ログから週 1 件の変更案を数字付きで出す skill `wbh-tune`（提案のみ。Harness を変えない。meta-harness の人間ゲート版、[報告](reviews/2026-10-15-software-factory-and-meta-harness.md)） | `continuous run` が 1 週回り、Trial 開始 10 件以上と review batch 1 回の `decide --minutes` が台帳にあるとき。1 週に 1 変更 |
| 2026-10-16 | 探索入力を非信頼データと宣言する Harness 生成の固定節と、実際の stdin 全体の digest（full input digest）を run-started と receipt に結合する（#270 項目 7） | Step 1 判定後。または source / README 由来の指示に agent が従った実例が 1 件出たとき |
| 2026-10-16 | 入口索引の表示を `bounded text index` に変え、dynamic / unknown を区別する。PHP parser の導入（#270 項目 8）。**2026-10-18 ADR 0034 で索引自体を削除したので再開条件は消えた** | 空白形の回帰を 1 本足した後、実測で入口の取りこぼしが recall を下げたと分かったとき |
| 2026-10-16 | 提出操作全体の再送契約（提出記録・付随記録・再開位置を 1 つの操作 identity に結合、#270 項目 12） | 初提出の前。提出候補が 1 件出たとき |
| 2026-10-16 | 既知の修正履歴（同梱 release note）を除いた派生 source を provenance 付き Snapshot として固定する（#177） | 公開済み修正の記述を source から読んで候補を出した Trial が 1 件確認されたとき |
