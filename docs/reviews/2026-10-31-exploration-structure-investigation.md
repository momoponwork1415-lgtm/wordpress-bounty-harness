# 探索の構造調査（2026-10-31、#714 の根拠）

所有者の問い「探索プロセスはちゃんと動いているか、手順がおかしくないか」に、本番台帳と実行記録だけで答えた記録。正本ではない。数字の出し方は末尾。

## 結論

探索は設計どおりに動いている。壊れている箇所は無い。ただし設計そのものに、発見が出にくい構造が 2 つある。

1. 終了条件が「sink の分類の消化」で、読んだ深さを見ていない。Root は中央値およそ 16 分で閉じ、制限時間 120 分のうち 100 分以上が毎回未使用になる。この構造は 10-26 の v14-wide から変わっていない。
2. Lead を Finding まで詰める段が無い。Lead は探索の中では「残りの隙間」として書かれて終わり、探索の外では人間が一覧を読むだけである（#715）。

## 1 Trial の実録（prod-v18-20261031-6、PHP 230 file / 約 7 万行の対象）

- Root は最初に wbh-recon の本文を読み、ツリーを見て、17 KB の構造地図（`recon-map.md`、104 行）を書いた。続けて wbh-tools の 2 本の列挙スクリプトを走らせ、hook 登録 169 行（`tools/hooks.tsv`）と効果呼び出しの一覧（`tools/sinks.tsv`）を研究ディレクトリに置いた。
- Root は子を sink の種類別（HTML / SQL / ファイル / 認証）に 4 体、続けて 3 体、2 体、1 体の計 10 体立てた。子はそれぞれ 102〜239 秒、tool 呼び出し 8〜20 回、固有 file 9〜31 を読み、ルートを sink 別の研究ファイルに書いて 1 通の報告で戻った。
- Root は登録簿（`REGISTRY.md`）に「供給された対象所有のエントリ群はすべて消化」と書き、開始から 17 分 50 秒で最終報告を出した。Root 自身が読んだ固有 file は 22。結果は Finding 0、Lead 1（子の報告の Lead を含めて 3）。
- 探索 sandbox、broker、provider の失敗は無い。

## 版をまたいだ構造の比較（Codex、Root 単位の Trial、台帳から）

| 日 / 版 | Trial | Root 分（平均） | 子 / Trial | 子 1 体の分 | 読んだ file / Trial | Finding / Trial | Lead / Trial |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10-26 v14-wide（子 4） | 21 | 15 | 7.8 | 3.0 | 387 | 3.62 | 3.71 |
| 10-27 v14-wide（子 8） | 48 | 10 | 7.2 | 2.4 | 358 | 0.75 | 3.17 |
| 10-27 v16-wide（子 8、契約 v5） | 42 | 9 | 8.1 | 2.2 | 414 | 0.33 | 3.55 |
| 10-28 v14-wide（子 8） | 54 | 8 | 5.7 | 2.3 | 235 | 0.93 | 2.59 |
| 10-28 v18-wide（子 8） | 30 | 9 | 6.9 | 2.2 | 306 | 0.20 | 4.17 |
| 10-31 v14-wide + skills | 15 | 12 | 7.0 | 2.2 | 281 | 1.00 | 4.53 |
| 10-31 v18-wide + skills | 30 | 16 | 9.5 | 2.7 | 425 | 0.13 | 4.47 |

「読んだ file」は重複を含む読取回数の合計である。時間、子の数、読んだ量は版を通じてほぼ同じで、スキル導入でむしろ増えている。違うのは Finding として出すか Lead として出すかの境目だけで、段 1b（固定ソースの読み直し）を通る率はどの版も Trial あたり 0.05〜0.07 で変わらない。

## 10-31 の v18-wide 30 Trial の分布

- Root 分: 5〜34、中央値およそ 16。
- 子: 4〜23 体。1 体あたり 2〜4 分、固有 file 12〜31。
- 読んだ file の合計: 80〜1,305 / Trial。対象の PHP file 数は 111〜731。
- Finding 4（段 1 通過 3、段 1b で 3 件とも到達性なしの不成立、段 1 除外 1）。Lead 134、腕を伏せた 5 項目判定で 84 / 97 が通過（#639）。

## 出し方

- 台帳 `ledger.sqlite` を `node:sqlite` で読み取り専用に開き、`discovery-run-started` の `configuration.promptVariant` / `runtime` / `skills` / `maxChildren` と、`discovery-run-finished` の `agentRole` / `wallTimeMs` / `observed.filesRead` / `observed.uniqueFilesRead`、`finding-recorded`、`lead-recorded` を Trial ごとに集計した。
- 1 Trial の実録は `scripts/trial-timeline.mjs --trial <id>` と、Private Evidence の `read-paths` と `native-run-receipt`、`work/provider-attachments/research-*`（研究ディレクトリの写し）と `diagnostic-*`（Codex の transcript）から読んだ。
- 対象の PHP file 数は `work/sources/<sourceDigest>` を数えた。
- Finding と Lead の本文はこの文書に書かない。
