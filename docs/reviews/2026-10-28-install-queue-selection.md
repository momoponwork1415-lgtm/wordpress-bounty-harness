# インストール数順の選定列の計測（#533）

## 決定との対応

[Issue #533 の所有者決定](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/533#issuecomment-6464992081)に従い、popular browse と設定済みの 8 タグから、install 10,000 以上・365 日以内更新・除外著者と除外 slug 以外の候補を取る。
インストール数の降順、同じ段では更新日の降順とし、同版で数えた Trial があれば除外し、版が上がれば直ちに戻す。
Programme 適格性、WordPress core 互換性、観測の鮮度、予約中の対象、版単位の凍結・Lab 供給失敗の扱いは維持する。

| Issue の要素 | 実装と受入 |
| --- | --- |
| 全候補をインストール数順に並べる | 固定の取得件数・ページ数上限を削除し、下限か API 終端まで取得し、同じ install 段は更新日順にする |
| 同版 1 Trial、新版で復帰 | `explore` と旧 `enumerate` を履歴に数え、再開 segment・bootstrap 失敗・provider 制限は既存の Trial 定義に従い、resubmit・trace・child は独立した Trial にしない |
| 待ち日数・未提出 Finding・legacy 除外を廃止 | 旧判定、legacy file 読取・exporter、host の `legacyHistory` 欄を削除する |
| mirror に依存しない選定 | 採点・鮮度 gate・loader を削除し、CLI の受入で未設定に加え設定先の欠落・破損を確認し、screen / dedupe の mirror を残す |
| 新方針で旧欄を拒否し、旧履歴を読む | strict な policy schema と旧 `target-selection.json` reader を分け、旧 score・advisoryHistory・cascadeStep の読取を維持する |
| 台帳の型を変えず理由を残す | `initial` / `version-increased` を既存の selection artifact に入れ、既存 event の digest 参照から読む |
| 旧決定を閉じる | ADR 0037 の追記で採点・90 日・legacy・旧帯を上書きし、ADR 0030 から追記を参照する |

汎用 `TargetSelection.score` は既存契約の数値欄として残し、新規記録にはインストール数を入れる。
順位はこの欄を使わず、インストール数と更新日で比較する。
探索 prompt、Finding / Lead 契約、Programme Boundary、役割の文章、台帳 event schema は変更していない。

## 計測方法と範囲

2026-10-28 19:56:28〜20:04:47 JST に、公開 `openWordPressSelection().decide()` を本番方針のコピーで 1 回実行した。
本番台帳と Private Evidence は read-only で開き、台帳 24,878 event（sequence 24,878 まで）を開始時点で固定して入力した。
WordPress.org の一覧・個別観測、Programme 写し、出力レポートは独立した Git 外の保存先へ置いた。
レポート digest は `sha256:feadd4daca57c638e9a45e9b99539f4d9be6adb5d73bddac502024894f9d8923` である。
凍結と探索を起動しない選定の計測なので、新規 Trial は 0 件であり、提出 / Trial・Finding / Trial の変化は測っていない。

取得は 50 件 / ページで、popular が 45 ページ、forms・contact-form・membership・page-builder・elementor-addons・multilingual・backup・booking の各タグが 2 ページとなり、計 61 一覧だった。
全 9 系統がページ内の全件 install 10,000 未満に達して終了し、一覧取得失敗は 0 件、status は `available` だった。
[WordPress.org の実装](https://github.com/WordPress/wordpress.org/blob/trunk/wordpress.org/public_html/wp-content/plugins/plugin-directory/class-plugin-directory.php)の archive は `active_installs` 順で、popular は上流に 99 ページ上限があるため、下限に達しないまま上限に当たったときは `pagination-limit` として部分的な母集団を採用しない。
一般のページ保護上限 999 でも同じ扱いとし、一覧取得の失敗・古い応答も選定可能な全件取得として扱わない。
今回これらの上限には達しておらず、取得時点の一覧に現れる 10k 以上の重複除去後 2,170 slug を個別観測した。
個別観測の取得不能 20 件は選定から除き、更新日・install 数は取得中に変わり得るため、WordPress.org 全体の同一時刻 snapshot の件数とは扱わない。

## 比較結果

旧値は 2026-10-28 08:45 の選定レポートを基準とする。
新値では旧 1,000 / 2,000 件上限を外して 10k 以上へ母集団を広げ、取得時点と台帳時点も異なるので、件数差を一つのルールだけの因果効果とは扱わない。
除外理由は重複し得るため、その合計は除外 slug 数と一致しない。

| 指標 | 旧基準 | 新計測 |
| --- | ---: | ---: |
| 個別観測した候補 | 1,270 | 2,170 |
| eligible | 647 | 1,369 |
| 同版履歴による除外 | 467 | 441 |
| legacy による除外 | 26 | 0（判定削除） |
| 未提出 Finding による除外 | 78 | 0（判定削除） |
| 版上昇で戻った eligible | 未集計 | 86 |
| 初回の eligible | 未集計 | 1,283 |
| 更新期限による除外 | 未集計 | 259 |
| 著者 / slug による除外 | 未集計 | 53 / 1 |
| 版の凍結 / Lab 供給失敗による除外 | 未集計 | 28 / 4 |
| 個別観測不能 | 未集計 | 20 |

eligible は 722 件、観測候補は 900 件増えた。
eligible の install 段別件数は次のとおりで、合計は 1,369 件である。
WordPress.org の `active_installs` は公表された段の値であり、正確な導入数の実測ではない。

| 公表 install 段 | eligible |
| ---: | ---: |
| 10,000,000 | 2 |
| 7,000,000 | 1 |
| 5,000,000 | 2 |
| 4,000,000 | 2 |
| 3,000,000 | 2 |
| 2,000,000 | 4 |
| 1,000,000 | 28 |
| 900,000 | 3 |
| 800,000 | 2 |
| 700,000 | 3 |
| 600,000 | 7 |
| 500,000 | 10 |
| 400,000 | 2 |
| 300,000 | 10 |
| 200,000 | 14 |
| 100,000 | 29 |
| 90,000 | 3 |
| 80,000 | 4 |
| 70,000 | 20 |
| 60,000 | 39 |
| 50,000 | 44 |
| 40,000 | 110 |
| 30,000 | 145 |
| 20,000 | 272 |
| 10,000 | 611 |

## 検証と差分の範囲

公開選定 API の受入を先に実行し、旧 scoreWeights 必須のため失敗する red から、install / 更新日順・新版復帰・同版除外の green にした。
列挙の受入も固定上限のため 21 ページ以降を取得しない red を確認してから、下限到達・上流打切り・部分取得失敗の処理を入れた。
旧 selection artifact、旧レポート、Trial に数えない run、partitioned の enumerate、再開 segment、凍結失敗、mirror の欠落・破損を含む `pnpm check` は 1,304 件成功・2 件 skip、`pnpm build` は成功した。

差分は旧採点・cascade・legacy の削除が主体で、この報告を除く差分は追加 821 行・削除 3,735 行である。
同じ差分を `git diff -w --numstat` で見ると追加 528 行・削除 3,442 行となり、差の各 293 行は主に旧 mirror / cascade の囲いを外したインデント変更で、file の移動はない。
残る追加行は新規コードだけの数ではなく、受入テスト・旧テストの置換・文書を含む。
所有者の「1 Issue 1 PR」を優先し、旧欄拒否・旧実装削除・旧 reader 維持・全件列挙を一つの変更として扱う。
これらを分けると、旧設定を受けるのに意味を失う期間や、広げた帯が取得上限で欠ける期間ができるためである。

## 起動時の引継ぎ

本計測では稼働中の設定・本番 state・runner を書き換えていない。
新選定方針は Git 外へ別 file として準備したが、読込先の切替・再起動は後続の運用で行う。
新 build は host の旧 `legacyHistory` 欄を拒否するため、現行 host を上書きせず、その欄を外した起動用コピーが必要となる。
旧 selection 方針も deprecated 欄と固定取得上限を除いたコピーを使い、旧方針 digest の予約 batch はそのまま新方針として再利用しない。
mirror の screen / dedupe 用設定は残し、既存の legacy file や mirror の記録を消さない。
