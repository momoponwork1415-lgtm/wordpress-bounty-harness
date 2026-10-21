# AGENTS.md

いまは Step 1（無人運転の 1 週）の段階で、本番ランナーが動いている（[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 第 2 節）。正本は [docs/SPEC.md](docs/SPEC.md) と [docs/adr/](docs/adr/) である。この文書はその要約で、食い違えば正本が勝つ。

## 読む順

1. [docs/SPEC.md](docs/SPEC.md) — 目的、不変条件、モジュール境界、受け渡し契約、単一協調 Trial の主経路と最初の縦断スライス。
2. [docs/adr/](docs/adr/) — 番号順に読む。設計の理由と、採らなかった選択肢。
3. 全体を掴みたいときだけ読む。これらは規則を増やさない。
   - 流れ: [docs/DESIGN-WALKTHROUGH.md](docs/DESIGN-WALKTHROUGH.md)
   - 動きとデータの図: [docs/SYSTEM-DIAGRAMS.md](docs/SYSTEM-DIAGRAMS.md)
   - 開発の流れ: [docs/FACTORY.md](docs/FACTORY.md)
   - 当時の図: [docs/DESIGN-DIAGRAMS.md](docs/DESIGN-DIAGRAMS.md)（2026-10-13）と [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。現状との差は各文書の冒頭にある。
4. [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 第 2 節 — 今の Step、完了条件、凍結しているもの。[docs/LESSONS.md](docs/LESSONS.md) — 過去 4 世代の教訓。新しい設計案は、この 2 つに反していないかを先に見る。止めてある案は [docs/PARKING.md](docs/PARKING.md) にある。過去 4 世代の実験記録と取り込んだ原本は [docs/knowledge/](docs/knowledge/) にある。新しい問いを立てる前に、同じ問いが無いかを見る。

## 不変条件（SPEC.md 第 2 節）

設計・実装・レビューのすべてで守る。

1. 探索エージェントへ渡すのは、固定したソース、人間が書いた trust 境界宣言、Programme Boundary、Lab、時点で切った対象の公開履歴だけである。公開履歴はカタログ情報に限る（ADR 0012）。評価対象の答え、held-out 公開日以降の記録、PoC、ペイロード、再現手順は渡さない。
2. 対象は gVisor（`runsc`）の使い捨て環境の中でだけ実行する。ホストでは実行せず、弱い隔離へ暗黙に切り替えない。外向き通信は、認証ブローカー経由の provider API に限る。
3. `runtime-confirmed` を出すのは、Harness が所有する決定論的な判定器だけである。証明は nonce 付き canary の回収に限る。エージェントや recipe の自己申告、リバースシェル、永続化、ホストへのアクセスは証明にしない。
4. 検証の失敗（環境、手順、観測、証拠の不足）は `incomplete` にする。`contradicted` にも棄却にもしない。
5. 判定は、Finding と検証結果の Target Snapshot digest が同じときだけ行う。digest が一致しなければ `incomplete` にする。
6. 人間の判断点は「提出前のレビュー」と「外部行動の承認」の 2 つとする。対象選定の承認と、未検証候補の採否は置かない。権限・対象範囲の拡張には、人間の明示の承認が要る。
7. 外部送信（報告、ベンダー連絡、公開）は、正確な Submission Candidate、文案の版、送信先に結び付いた承認があるときにだけ行う。Harness 自身は送信を実行しない。
8. 台帳は追記専用で、digest 参照しか持たない。ペイロード、HTTP 記録、画面画像、実行ログ、認証情報、未公開の発見は、Git 外の Private Evidence に置く。

## Harness と AI の責務（所有者決定 2026-10-18）

過去 4 世代と本リポジトリの 2026-10 は、同じ失敗を繰り返した。探索や検証の「やり方」を Harness のコードに入れ、Harness が肥大し、報酬が止まるという失敗である（LESSONS 14）。境界を次のとおり固定する。設計・実装・レビューでは、不変条件の次にこれを見る。

- **Harness は制御だけを受け持つ。** 受け持つのは次の処理である。
  - 選定
  - Snapshot と digest
  - gVisor と broker
  - プロンプトとソースを渡して走らせること
  - 制限時間と子の数
  - 出力の全件保存と、スキーマによる正規化
  - Programme Boundary 外の Finding を出口で止めること（park）
  - Finding 単位の Lab の供給と canary の播種
  - 判定器
  - 台帳と Private Evidence
  - レビューの記録

  判断の要らない処理だけをコードにする（LESSONS 4）。

- **探索と検証の中身はプロンプトとスキルが受け持つ。** どこを読むか、何を索引にするか、どの順で仮説を立てるか、どう再現するか、前提をどう作るかは、エージェントの仕事である。探索は、目的プロンプト（記事の wp2shell）を渡して Root に任せる。検証は、Harness が立てた Lab に対してスキルが行う。`runtime-confirmed` を出すのは判定器だけである。
- **移す合図。** Harness のコードに「エージェントにこう探させる」「この前提ならこのシナリオ」「索引の網羅率」のような判断が現れたら、プロンプトかスキルへ移す。エージェントの自己申告を Harness が根拠にするコードが現れたら、判定器か観測器へ移す。観測（読んだファイル、経過時間、トークン、出力）は Harness が取る。舵取りは取らない。
- **削除。** 次のものは境界の外側にあるので、スキル化と同時に削除する。使わない設定にして残す中間状態は置かない。
  - 入口・保存先索引の探索入力
  - task-plan と dispatch
  - coverage と `incomplete(depth)`
  - Verifier 指示の連鎖
  - precondition の文からシナリオを選ぶ正規表現
  - プラグイン別の Lab アダプタとシナリオ

  入口・保存先索引、coverage と `incomplete(depth)`、公開履歴カタログの生成は削除済みである（ADR 0034、2026-10-18）。SPEC と ADR 0029 の該当行も改訂した。Verifier 指示の連鎖とシナリオ / アダプタは、#352 のスキル化は済んだが、削除はまだ終わっていない（PR #374、ADR 0035）。#352 の受け入れの後に #353 で消し、そのとき ADR 0026 の該当行を改訂する。受け入れの条件は、Brizy / TranslatePress で受け渡し（handoff）が判定器の結論まで届くことである。それまでは、下の検証 Lab 節にあるシナリオの行を、既存 Trial の記録を読むための記述として扱う。

## 単一協調 Trial の探索（SPEC.md 第 6 節、ADR 0029）

- 新規探索で実行できる目的プロンプトは `wp2shell-bounty-v8` に限る。起動モードも `wp2shell` に限る。対象ごとに 1 回、Root と子が協調する Trial を行い、子は 4 体までとする。制限時間の上限は 120 分で、最低 60 分は能動的に探索する。最終報告が早く出たときは、同じ協調セッションで続ける。継続できない場合と、制限時間・provider・broker・スキーマなどの失敗は、理由付きの `incomplete` にする。これらは正常な候補 0 件に数えない（ADR 0033）。止まった Root のスレッドは、止まった理由を問わず（`completed` 以外）再開できる。Codex の run の `provider-limited` と死んだ持ち主の `interrupted` を除き、操作者が名指ししたときだけ再開する（ADR 0036 の 2026-10-19 追記 4）。Claude の `provider-refusal` も、Codex の `provider-cyber-policy` と同じく名指しで再開する（ADR 0036 の 2026-10-21 追記）。名指しには `campaign resume --run <runId>` を使う。再開は新しい使い捨てサンドボックスで行い、同じ Snapshot、同じ再開段落、残りの制限時間を使う。再開した続きは、同じ Trial の再開区間（segment）として数える。プロンプトの言い換えはしない（ADR 0036）。終了イベントの無い run（電源断など）も、持ち主のプロセスが死んでいれば、残ったセッションとメモを封じて `interrupted` で終わらせてから再開できる。ランナーの再起動が同じ対象をやり直した後は再開しない（ADR 0036 の 2026-10-19 追記 2）。持ち主のプロセスが死んだ run は、再起動したランナーが新しい Trial より先に自動で再開する（拒否された場合は従来どおり新しい Trial に戻る）。Codex の run の `provider-limited` は、Codex CLI の同一会話内再試行が尽きた後、ランナーが backoff して同じ Trial を再開区間最大 5 まで再開する。起動直後も再開し、拒否されたら理由付き `incomplete` にして新しい Trial は作らない。Claude の run の `provider-limited` は、backoff 後に新しい Trial としてやり直す（ADR 0029 の 2026-10-19 追記）。
- v8 には入口索引を渡さない。着眼点は、固定したソースから Root 自身が決める。最低時間を守るための同一セッション内の継続のほかには、screening から条件付き deep-dive へ進む分岐も、入口網羅の終了条件も置かない。子が出した有効な Finding と Lead は、Root の報告とは独立に保存する。
- Snapshot は、対象プラグイン、WordPress 本体、実行イメージに対応する PHP ソース、依存プラグインを版と digest で固定する。依存プラグインは、`Requires Plugins` と選定方針での明示指定から決める。自動選定の本番対象には凍結時点の公式安定版を使い、手動や歴史的な評価対象には明示した版の固定を使う。探索ではすべてのソースを読み取り専用で渡し、Lab にも固定したプラグイン依存を供給する。依存の欠落を黙って無視しない。
- 旧版の探索プロンプトと実験結果は、過去 Trial の digest と構成を照合するために残す。ただし、旧版を使う新規 Trial は起動しない。索引あり・なしの Trial や旧来の段付き Trial を、同じ比較の分母に混ぜない。v8 は、脆弱性が必ずあるという前提も、固定した攻撃経路も与えない。
- エージェントに渡る文章（プロンプト本文、スキル本文、Harness が生成する節の雛形）は、`owner-approved` ラベルが付くまでマージしない。2026-10-13 以降、所有者は採否とラベル付与を AI に委任している。AI は委任を明記した PR コメントを残す（DEVELOPMENT.md 第 5 節）。2026-10-18 以降は、所有者の読了もマージの条件ではない。ADR・SPEC・方針・判定器のパスも含めて、委任済みの AI が差分を確認してラベルを付ける。採否は探索の数字で決める（ADR 0032 の 2026-10-18 節）。AI は出典対照表にある要素だけを書き、要素を足さない。
- プロンプト本文を変えたら版を上げ、旧版を残して、固定した digest を更新する。旧プロンプトは、過去 Trial の目的文と digest を照合するために維持する。台帳にある旧 `stage` / `continuationOf` 付きのイベントも読み続け、既存のイベントを消さない。
- Finding / Lead の出力契約はプロンプト本文に書かない。Harness がスキーマから生成する節として渡す（ADR 0019）。候補は出力境界で棄却しない。正規化して受理するか、保留する（ADR 0018）。
- 受理した Finding のうち impact が次の 10 種に当たるものは、`finding-parked` として台帳と Private Evidence に残す。
  - Programme Boundary の外にある 5 種: `other`、`csrf-to-write`、`missing-authz`、`idor`、`reflected-xss`
  - 所有者が 2026-10-17 に「重大かどうかの判別が付きにくい」として外した 5 種: `sensitive-object-access`、`content-deletion`、`options-update`、`privesc-to-contributor+`、`auth-bypass-non-admin`

  これらは検証列、レビュー列、funnel の raw に入れない。この決定は、Q1 の `content-deletion` 復帰を上書きする（ADR 0032 の 2026-10-17 節）。探索プロンプトの目的文は変えず、出口で振り分ける。一覧は `review parked --campaign <id>` で見る。対象範囲内の Finding は、判定器の結果に関係なく全件がレビュー列に出る（#185、ADR 0031）。

- contributor 以上と、管理者が意図して付与する権限は、trust 境界の内側に置く。公開済み 7 件の再発見は配線と判定器の確認であり、未知の発見率は示さない。プロンプトとシナリオに、対象固有の関数名、オプション名、URL、画面名を入れない。

## 検証 Lab の前提（SPEC.md 第 7 節、ADR 0026）

- WordPress プロファイルの通常機能シナリオは、プラグインに依存しない状態を優先して追加する。追加するものは、頻出する `incomplete(precondition)` の理由を集計して決め、版と digest を固定する。
- 被害者側の操作は、Harness が所有する Lab 観測器が型付きの手順で行う。Verifier にブラウザを渡さない。管理者セッションは、前提を作るためだけに `verify next --handoff` のスキルへ渡す。`setup-done` 以後は攻撃者の位置に限る（ADR 0035）。Codex Verifier には渡さない。

## `profiles/wordpress/` の規則（ADR 0011）

WordPress 固有のものは `profiles/wordpress/` に置く。次のものがそれに当たる。

- WordPress.org からの取得
- WordPress + MySQL の Lab 供給
- PHP 向けの判定器
- Wordfence / Patchstack の対象範囲方針
- trust 境界宣言の雛形
- Lead 型
- 評価対象の分類

汎用モジュールは、プロファイルが実装するインターフェースの型だけに依存し、WordPress の型やパスを import しない。汎用モジュールとは selection / snapshot / lab / discovery / verification / ledger / review を指す。plugin、slug、hook、AJAX action、`wp_options` のような語が汎用モジュールに現れたら、それはプロファイルへ移す合図である。

プロファイルのインターフェースは、2 つ目のプロファイルができるまで汎用化しない。

## 品質ゲート

コミット前に `pnpm check` を通す。

## 開発の流れ（docs/DEVELOPMENT.md）

- 変更は、「今週の問い」1 つに答える PR 1 本にする。PR テンプレートの 5 項目（問い、変えたこと、変えなかったこと、測った数字、消し方）を日本語で埋める。
- 探索に触る PR は、開発セットで最低 Trial 3 回分の結果を貼る。数字のない探索変更はマージされない。
- 「調べて報告」の成果物は、`docs/reviews/` に日付を付けて置く。これは正本ではない。

## Agent skills

### Issue tracker

作業 Issue は GitHub Issues で管理する。手順は `docs/agents/issue-tracker.md` にある。

### Triage labels

Matt Pocock 系スキルの標準ラベル 5 つを使う。対応は `docs/agents/triage-labels.md` にある。

### Domain docs

単一コンテキストとして、用語集はルートの `GLOSSARY.md`、判断記録は `docs/adr/` に置く。読み方は `docs/agents/domain.md` にある。

### Measurement, review, briefs, ledger

AI が自分で回す手順は `docs/agents/` に置く。

- 計測: `measurement.md`
- PR のレビューとマージ: `pr-review-merge.md`
- Codex への依頼文: `codex-briefs.md`
- 台帳の読み方: `ledger-reading.md`
- 本番ランナーの監視: `production-monitoring.md`

進行中の状態は、Git ではなく Issue のコメントに書く。
