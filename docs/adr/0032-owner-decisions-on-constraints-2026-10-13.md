---
status: accepted (2026-10-14、所有者の決定で確定)
date: 2026-10-13
amends: 0030（タグ単位の履歴利用）, 0022（自動再試行の範囲）
amended-by: 0037（選定の Q4・Q5・Q6・Q9 と 2026-10-16「選定の帯」）
---

# 2026-10-13 のグリルで所有者が決めた制約と、出典不明の制約の扱い

## 背景

[docs/reviews/2026-10-13-design-features-constraints.md](../reviews/2026-10-13-design-features-constraints.md) で、制約のうち所有者の決定と文書で確認できるものは 5 群だけで、数値の大半は AI の既定値だと分かった。所有者は 2026-10-13 に 26 問のグリルに答え、「Q3 と Q4 は data で決める。他は推奨どおり」とした。この ADR はその答えの正本で、以後は変えた行だけ更新する。

## 決定

### 対象範囲と分類

| # | 項目 | 決定 |
| --- | --- | --- |
| Q1 | `content-deletion` | #185 の除外から外す。判定器は作らず `incomplete(no-judge)` で人間レビューへ |
| Q2 | Reflected XSS | Wordfence は対象外。Patchstack 向けにも出さない。半年後に見直す |
| Q13 | Trail of Bits の文言 | 採らない（CC BY-SA 4.0） |

### 選定

| # | 項目 | 決定 |
| --- | --- | --- |
| Q3 | 候補タグ | 所有者が列挙しない。Wordfence ミラーと WordPress.org のタグから「低権限・報奨対象の記録 / plugin」を機械的に出し、上位の族を既定にする（[2026-10-13-selection-data.md](../reviews/2026-10-13-selection-data.md) 第 3 節）。タグの出典を `target-selected` に残し、半年後に有償率で測る |
| Q4 | install 下限 | 100,000。公式の帯別平均と所有者の 2026-08 実績（Gate 1）による |
| Q5 | High Threat タグ 21 個と重み、攻撃面タグ重み | 削除。順位は installs と鮮度だけ |
| Q6 | runBudget 20 / 40 | 削除。#189 の自動 +2 Trial も削除。同じ plugin slug の 2 回目以降の独立 Trial は 1 Trial ごとに所有者が事前承認する。承認の形式は所有者が 2 回目を求めるときに決める（2026-10-14） |
| Q9 | 採点式 log10(1+installs)×10 + 鮮度×5 | 維持 |
| 確認 | 除外作者 5 社 | 維持（Wordfence 公式） |

### Lab と runtime

| # | 項目 | 決定 |
| --- | --- | --- |
| Q7 | 重大 option 7 個の固定監視 | #186 の実行前後の差分観測器で option 全体を見る。固定 7 個は「重大」ラベルだけ |
| 確認 | core 版 / sandbox CPU / 並列 | 7.1.3 / 6 / 3（Opus 併用時 2） |
| Q8 | 根拠の無い小さな数値（Verifier wall 30 分、Finding 文字数、Snapshot 取り込み上限、Lab timeout、broker 上限） | AI の既定値として維持。変えるときは計測を付ける。台帳 read 1,000 件だけは頁送りに直す |

### prompt

| # | 項目 | 決定 |
| --- | --- | --- |
| Q10 | 探索 v4 の骨格 | whitebox `bounded-wp2shell/v1.7` を骨格にし、class 列挙は Harness 生成の節へ移して本文 7,000 bytes 以内 |
| Q11 | class 列挙の内容 | v1.7 の 3 群（accepted / weaker / dropped） |
| Q12 | v3 固有の要素 | 「それ以外の具体的効果も記録」は外す。順位は v1.7 の 3 群。停止条件は「2 波連続で増分なし」。子は 3 |
| Q14 | Verifier v7 | 探索と別に対照表を作る（Anthropic の検証 4 手順、Visa の oracle 判定、現行 v6 の 6 field） |
| 確認 | Verifier の向き | 反証ではなく発火の確認 |

### 知識と運用

| # | 項目 | 決定 |
| --- | --- | --- |
| Q15 / Q20 / Q21 | 知識の集約 | `docs/knowledge/` に索引と provenance 付きの写し。案件固有の値と件別の成績は Git 外、集計と schema だけ入れる |
| Q16 | 実験の重複防止 | Issue と PR の template に「`docs/knowledge/experiments.md` を検索した」を 1 行 |
| Q17 | 記録の形 | この ADR 1 本。以後は変えた行だけ更新 |
| Q18 | cron 2 本 | 止める（whitebox の queue tick、wordpress-harness の quota tick） |
| Q19 | Wordfence ミラー | 本リポの `profiles/wordpress/wordfence-history` に移し、`wp-bounty-workspace` から独立させる |
| Q22 | 追跡性 | `review-decided` に所要時間、提出記録から run / prompt digest を辿れる参照を足す（#186） |
| Q23 | ディスク | 第 4 周の後に Docker を prune。ディレクトリは Q19 / Q20 の後に消す |
| Q24 | 未 push の worktree | 中身を確認し、要るものだけ push |
| Q25 | 提出パッケージ | 37 件で回った 4 ファイル構成と human_only 9 項目を #188 の契約にする。Fill-Only 拡張と guard-lock は skill の assets |
| Q26 | Patchstack の形式 | 保留 |
| Q27 | CLI の位置づけ | CLI は AI（skill と Harness の自動処理）が呼ぶ機械向けの interface とし、所有者は Claude Code の skill から操作する。CLI の機能は増やさず、人間向けの表示や対話は skill に置く。既存の多機能は削除せず拡張を止め、整理は Step 2（所有者 2026-10-13） |

## ADR 0030 への修正

0030 の「公開履歴の件数・内容は選定候補の列挙・除外・採点に使わない」は plugin 単位の規則として維持する。タグ単位の yield（タグに属する plugin 群の低権限・報奨対象の記録数 / plugin 数）は候補タグの列挙にだけ使い、個々の plugin の順位・除外・採点には使わない。

## ADR 0022 への修正

自動再試行は実装どおり recipe 2 回、observation 2 回、provision 1 回、precondition は scenario ID が変わったときだけ（2026-10-14、所有者が実装を正本と決めた。#107、#209）。Verifier の provider 上限は 1 回（ADR 0022 の 2026-10-14 追記）。

## 2026-10-16 追加判断: 既定 prompt を v5 にする

所有者は 2026-10-16 に、v4 索引あり 5 run と索引なし 8 run で本体のコメント本文経由の Stored XSS（公開記録 3 件）が一度も候補にならないこと（#291）を見て、探索 prompt を `wp2shell-bounty-v5` に改め、既定にすると決めた。v5 は所有者が日本語訳を全文読んで確認した本文で、digest は `sha256:59c6bd1bb5fd5ef7618ce180de7f2d90af68fa4bcba26f90aa31aa3679d80cda`。出典対照表は docs/reviews/2026-10-16-wp2shell-bounty-v5-draft.md。

v5 で変えたもの: 受け入れる種類の順位と「落とす種類」の一覧を prompt から外し、対象内かどうかは Harness が付ける Programme Boundary の節に任せる。false negative を false positive より嫌うと 1 文で書く。WordPress 本体が受け取って保存する内容（コメント、登録項目など）を攻撃者が制御するデータとして名指しし、書く側・保存・読む側の 3 点を検査させる。stop 条件を「source に根ざした frontier が残る限り続け、registry を見直してから止める」に強める（wordpress-harness v8 由来）。最低時間は置かない（ADR 0029 のまま）。

変えないもの: Root＋最大 3 子、wall 60 分、入口索引の既定、Finding / Lead 契約の Harness 生成（ADR 0019）、公開記録を渡さない（ADR 0012）、対象固有の名前を入れない。v4 本文と digest は履歴照合用に残す。

同日の運用判断（2026-10-16）: Lab で前提を満たせない対象（外部 API に依存する Smash Balloon 系など）も探索対象から外さず、Finding が出れば検証が `incomplete(precondition)` でも人間レビューに回してよい（#283 の「カタログから外す」を取り消す）。検証は最悪、人手か Claude Code との対話で行う。Lab scenario の拡充（#213、#244）は探索の後に置く。

選定の帯（2026-10-16、ADR 0030 への修正）: 既定の母集団は 10 万以上 100 万未満のインストール帯とし、帯の中ではインストール数で順位を付けない。100 万以上は「直近 1 年に公開記録が一定件数以上」という根拠を満たすときだけ候補に残し、根拠を選定記録に書く。公開記録は slug 単位の件数だけを gate に使い、score と探索には渡さない（ADR 0012）。実装は #295。（2026-10-19: 「score に渡さない」は所有者決定で [ADR 0037](0037-selection-uses-advisory-history-counts.md) が上書きし、件数と公開日を score に入れる。探索に渡さない点は変わらない。100 万超の例外は未実装のまま #295。）

帯の上限の先行適用（2026-10-16、所有者）: 本番 2 batch 目から `maximumActiveInstallations: 1000000` を固定の filter として入れ、100 万以上は候補に残さない。帯の中の順位（インストール数に寄せない）と、公開記録の件数で 100 万以上を残す例外は #295 のまま未実装。

採らなかった選択肢: Harness 製の入口索引に出力側 sink を足す（索引あり・なしで差が出なかったので主因でない）。AI が前段で索引を作る（ADR 0029 で外した段付き構造の再導入）。wordpress-harness v8 全文への差し替え（v7 系で有償実績が無い）。

## 採らなかった選択肢

- 制約ごとに ADR を書く: 週 1 本の規則に収まらない。
- 所有者がタグを手で列挙する: 所有者が 2026-10-13 に退けた。

## 2026-10-14 の所有者決定（最終設計 docs/reviews/2026-10-14-final-design.md 第 14 節）

| # | 項目 | 決定 |
| --- | --- | --- |
| 1 | 最終設計の採用 | 採用。Step 1 の期日は「runner 起動＋8 日」 |
| 2 | Trial に数えない run | Root が source を 1 件も読まず、子を起動せず、broker 転送 1 以下で終わった run は Trial に数えない（SPEC §6、ADR 0029） |
| 3 | 旧世代の既往照合 | 旧研究 DB と旧 `--state` 台帳から Git 外 JSON（started / ambiguous / reconsider）を 1 回作る。AI が作る。無ければ runner は起動しない |
| 4 | ラベルと凍結 | P0 / P9 / P10 / P12 は所有者本人が `owner-approved`。DEVELOPMENT §2 の ADR 凍結を ADR 0016 / 0020 / 0022 / 0026 / 0029 / 0032 の該当行に限って解除 |
| 5 | 再試行回数 | 実装どおり（上記） |
| 6 | 手動再現 | 判定器が確認し最新版の reverify が緑の Finding は証拠を読むだけでよい。`no-judge` は手で再現する（2026-10-11 の「全件必須」を変更。SPEC §8 / §12、ADR 0016 は P12 で書き換え） |
| 7 | `no-judge` の提出 | 人間再現が `match` なら scope / draft が受理する口を作る（P12） |
| 8 | #220 の受入条件 2 | 「拒否は記録して次対象へ進む」に改定。拒否が続いた週の Step 1 判定は「拒否を除く対象で回り切った」と読む |
| 9 | A/B 事前登録（#201） | Step 1 の間は中止 |
| 10 | Q2（Reflected XSS） | 半年後の見直しのまま |

## 2026-10-17 の所有者決定（Claude の委任セッション）

本番 3 batch（20 対象）の review queue に出た対象内 Finding は `sensitive-object-access` 2 件だけで、どちらも Wordfence が明示的に対象外とする「非公開 / 下書き投稿の閲覧」に相当した。所有者は「脆弱性が出ない気がする。sensitive information exposure は外していい」「content-deletion と options-update も対象外かも。重大かどうかの判別が付きづらい」「privesc-to-contributor+ / auth-bypass-non-admin も対象外より」と判断した。

| 項目 | 決定 |
| --- | --- |
| `sensitive-object-access` | `finding-parked` に回す。判定器が無く scope 評価が常に `ambiguous` で、人間の時間だけを使っていた |
| `content-deletion` | `finding-parked` に回す（Q1 を上書き）。重大な削除かどうかを機械で判別できない |
| `options-update` | `finding-parked` に回す。更新できる option が重大かどうかの判別が付きにくい。任意 option 更新から管理者登録に至る経路は `privesc-to-admin` として記録される |
| `privesc-to-contributor+` / `auth-bypass-non-admin` | `finding-parked` に回す。Wordfence の「その他」帯で、管理者未満の到達先は報奨の判別が付きにくい |
| 残す分類 | High Threat（`rce`、`php-file-write`、PHP ファイルに届く `arbitrary-file-read` / `delete`、`privesc-to-admin`、`auth-bypass-to-admin`、`account-takeover`）、Common（`sqli`、`stored-xss`）、その他のうち `arbitrary-file-read` / `delete` / `download`、`lfi` / `rfi` |
| 探索 prompt | 変えない。v5 の目的文は「重大なデータの読み取り・改変」「subscriber／customer からの権限昇格」を残し、出口の `WORDPRESS_PROGRAMME_EXCLUDED_IMPACTS` で振り分ける。prompt の版は上げない |
| 既存の Finding | 台帳は追記専用なので、review queue にある prod-20261016-3 の 2 件は所有者が `review decide` で処理する |

2026-10-13 の「`options-update` と `sensitive-object-access` は分類名だけで一律に除外しない」はこの決定で終わる。parked は `review parked` で見られ、半年後の見直し（Q2 と同じ時期）で復帰を再検討する。

## 2026-10-18 の所有者決定（Claude の委任セッション）

所有者は「owner-approved のラベルはいらないかも。結局、脆弱性を発見できるかどうかだからそっちで実験して結果がある程度わかるはず」と判断した。

| 項目 | 決定 |
| --- | --- |
| `owner-approved` の読了ゲート | 所有者本人の全文読了を merge の条件にしない。委任済みの AI が差分を確認し、委任を明記した PR comment を残してラベルを付ける。対象は P0 系の path（`docs/adr/`、`docs/SPEC.md`、trust 境界宣言、Programme Boundary、policy、判定器）と agent に渡る文章の両方 |
| 採否の基準 | 探索の結果（開発セットと本番の completed、Finding、Lead、runtime-confirmed）で判断する。agent に渡る文章の変更は数字を貼る規則（DEVELOPMENT §5）のまま |
| 変えないもの | 不変条件 1〜8。出典に無い要素を足さない規則。ラベルと adr-guard の仕組み自体（誰が付けるかだけが変わる）。外部送信の承認（不変条件 7）は所有者本人のまま |
| 所有者が読むもの | 読みたいときに読む。提出前 review と外部行動の承認は引き続き所有者 |

2026-10-13 の決定 4（P0 / P9 / P10 / P12 は所有者本人が `owner-approved`）はこの決定で終わる。所有者が読了ゲートを戻すときは、この表に 1 行足す。


## 2026-10-19 注記: 後の決定で終わった行（文書整理、所有者の委任で AI）

表は決定時の記録として残す。新しい決定は足さず、どの行がどこで終わったかだけを書く。

| 行 | 現行 |
| --- | --- |
| Q1 `content-deletion` | 本 ADR の 2026-10-17 節で `finding-parked`（Q1 を上書き） |
| Q4 install 下限 100,000 | 主帯の下限は 100,000 のまま。主帯が尽きたときだけ cascade 50k → 30k → ≥1M（paying class 記録 ≥2）を試す（[ADR 0037](0037-selection-uses-advisory-history-counts.md) の 2026-10-19 追記 4。2026-10-26 に 30k の段を外した、ADR 0037 追記） |
| Q5 / Q9 順位と採点式 | ADR 0037 の 2026-10-19 追記 2 の重み（`installations: 0.5`、`recency: 0`、`historyPayingClass: 1`、`recordRecency: 1`）。所有者は 2026-10-19 に重みの決定を AI に委任した |
| Q6 2 回目以降の独立 Trial | 選定による再訪は ADR 0037 追記 3（版上昇かつ最後の Trial から 90 日、`revisitPolicy: version-increased`）。「再訪は選定の結果であり、campaign 単位の承認ではない」。同じ版を手で再 Trial するときの扱いは Q6 のまま |
| 確認 除外作者 5 社 | `policy/selection.json` の `excludedAuthors` は 7 名。WooCommerce と MailPoet は Automattic 資産として 2026-10-17 に足した（`policy/selection.md`） |
| 確認 並列 3（Opus 併用時 2） | repo の既定は `resources.maxConcurrentRuns: 1`、`maxConcurrentTargets: 1`。2026-10-19 に所有者が「並列数は 10、選ぶ数も増やす」と指示し、schema 上限を `maxConcurrentTargets` 4 → 10、`maximumTargets` 5 → 10 に上げた（#347）。対象ごとの `maxConcurrentRuns` の上限 4 は変えない。本番は host の campaign 設定で同時対象 10、選定方針の写しで `maximumTargets` 10 |
| Q12 子は 3 | 子は最大 4（ADR 0029 の 2026-10-18 節、ADR 0033） |
| 2026-10-16「選定の帯」「帯の上限の先行適用」の 100 万超の例外 | ADR 0037 追記 4 の cascade 最後の段として実装（PR #382、#295 は close） |

## 2026-10-19 追記: 同時対象数を runner の稼働中に変える（所有者の指示「並列数は可変にできるようにしよう」）

上の表の「確認 並列 3」の行にある `resources.maxConcurrentTargets` は、同時に走る対象の上限として残す。runner の稼働中は、操作者が `continuous concurrency <n>` で 1 から上限までの値を `<state>/continuous.concurrency` に書き、runner は新しい対象を始める直前にそれを読む。下げても走っている Trial は止めない。file が無ければ上限で走る。設定と選定方針の digest は変わらない。手で回す `campaign run` はこの値を読まない（OPERATIONS.md の継続運転の節）。

## 2026-10-19 追記 2: runtime ごとの同時対象数（所有者の指示「Opus 3 本、Codex 3 本」）

1 つの runner で Codex と Claude（Opus）を同時に走らせ、それぞれの本数に別の上限を置く。上限は campaign 設定の `resources.maxConcurrentTargetsByRuntime: { codex?, claude? }` に書く。書かなければ、今までどおり `maxConcurrentTargets` だけが効く。

- 各値は 0 から `maxConcurrentTargets` まで。`runtimeShare` の重みが正の runtime には 1 以上の値が要る（`runtimeShare` が無ければ全件 Codex なので、Codex に要る）。重みが 0 の runtime には要らない。
- 対象の runtime は、探索と同じく対象 ID と `runtimeShare` だけで決まる。枠が空いたら、選定順で最初の「runtime に空きがある対象」を始める。どの runtime も埋まっていれば、解放か 30 秒ごとの見直しまで待つ。合計の上限と `continuous concurrency` の値は今までどおり効く。
- runner の稼働中は、`continuous concurrency <n> --runtime <name>` で 0 からその runtime の上限までの値を `<state>/continuous.concurrency.<name>` に書ける。0 にすると、その runtime の新しい対象は始まらない。下げても走っている Trial は止めない。設定と選定方針の digest は変わらない。手で回す `campaign run` は設定の上限を使い、この file は読まない。
- batch の偏りは残る。1 batch の対象は hash で runtime に分かれるので、片方の runtime の対象が先に尽きると、その枠は batch が終わるまで空く。選定は凍結中なので、選定で runtime を釣り合わせることはしない。当面は選定方針の `maximumTargets` を上限の 10 にして空きを減らし、batch をまたいで補充する案は数字を見てから決める（OPERATIONS.md の継続運転の節）。
- provider 上限で campaign が止まる動きは変えていない。Claude の quota で止まると、同じ batch の Codex の新しい対象も backoff の間は始まらない。

## 2026-10-20 追記 3: provider 上限で止めるのは、上限に当たった runtime の対象だけにする（所有者の指示「探索はずっと動かしておいてほしい」）

出典は所有者の 2026-10-19 21:31 JST の指示「探索はずっと動かしておいてほしい」（設計課題報告 docs/reviews/2026-10-20-design-issues-from-production-results.md の §3.6）。追記 2 の最後の項目を、次の campaign に限って上書きする。`discovery.runtimeShare` が Codex と Claude の両方に正の重みを付け、`discovery.lab` が `none` の campaign である。

- 探索 run が provider 上限で終わったら、その runtime の未起動の対象だけを止める。もう一方の runtime の対象は起動と完了を続ける。`campaign-stopped` に `runtime` を付ける。両方の runtime が上限に当たれば、campaign 全体が止まる。
- runner の backoff は runtime ごとに段階を数える。待ち時間が最も早く終わる runtime に合わせて同じ campaign ID で再開し、待ち時間の残る runtime の対象は、その終わりまで起動しない。
- 上の条件に当たらない campaign と、Verifier の上限は、今までどおり campaign 全体を止める。
