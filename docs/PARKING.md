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
| 2026-10-13 | Claude 系（Opus）探索 runtime の追加 | Step 1 完了後。5 時間窓の停止再開は provider 非依存に作っておく |
| 2026-10-13 | Patchstack を第 2 の提出先にする（Programme Boundary を 2 本） | 提出候補が出た後、#175 の線で |
| 2026-10-13 | 検証 scenario を precondition 文の正規表現で選ぶ仕組みの置き換え | `incomplete(precondition)` の誤選択が 3 回出たとき |
| 2026-10-13 | 文書の整理（docs/reviews/2026-10-12-consolidation-and-production-first.md 第 4 節） | Step 1 完了後 |
| 2026-10-13 | 既知 7 件の再発見ベンチマークの残り（Smash Balloon、Unlimited Elements、TranslatePress 3.2.6） | Step 2 で判定器を触るとき |
| 2026-10-13 | 修正版の負の対照と `contradicted` の自動化 | Step 2 |
| 2026-10-13 | review CLI の多機能（decide / scope / draft / authorize / dedupe の人間向け表示）を skill 側へ寄せ、CLI を機械向けの最小集合に整理する | Step 2。skill 3 本が 10 件回って出力が安定したとき（ADR 0032 Q27） |
