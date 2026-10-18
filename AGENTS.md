# AGENTS.md

設計段階のリポジトリ。正本は [docs/SPEC.md](docs/SPEC.md) と [docs/adr/](docs/adr/)。この文書はその要約で、食い違えば正本が勝つ。

## 読む順

1. [docs/SPEC.md](docs/SPEC.md) — 目的、不変条件、モジュール境界、受け渡し契約、単一協調Trialの主経路と最初の縦断スライス。
2. [docs/adr/](docs/adr/) — 番号順。設計の理由と、採らなかった選択肢。
3. [docs/DESIGN-WALKTHROUGH.md](docs/DESIGN-WALKTHROUGH.md) — 全体を1つの流れで理解したいときだけ。規則は増やさない。図で見るなら [docs/DESIGN-DIAGRAMS.md](docs/DESIGN-DIAGRAMS.md)（2026-10-13 確定版）、動きとデータの図は [docs/SYSTEM-DIAGRAMS.md](docs/SYSTEM-DIAGRAMS.md)。 開発の流れ（作業列、ゲート、憲章、逆圧、monitor / tune）を図で見るなら [docs/FACTORY.md](docs/FACTORY.md)。
4. [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 第 2 節 — 今の Step、完了条件、凍結しているもの。[docs/LESSONS.md](docs/LESSONS.md) — 過去 4 世代の教訓。新しい設計案はこの 2 つに反していないかを先に見る。止めてある案は [docs/PARKING.md](docs/PARKING.md)。過去 4 世代の実験記録と取り込んだ原本は [docs/knowledge/](docs/knowledge/) — 新しい問いを立てる前に同じ問いが無いか見る。

## 不変条件（SPEC.md 第2節）

設計・実装・レビューのすべてで守る。

1. 探索エージェントへ渡すのは、固定した source、人間が書いた trust 境界宣言、Programme Boundary、Lab、時点で切った対象の公開履歴（カタログ情報のみ、ADR 0012）だけ。評価対象の答え、held-out 公開日以降の記録、PoC、payload、再現手順は渡さない。
2. 対象の実行は gVisor（`runsc`）の使い捨て環境の中だけ。ホストでは実行せず、弱い隔離へ暗黙に切り替えない。外向き通信は認証ブローカー経由の provider API だけ。
3. `runtime-confirmed` は Harness 所有の決定論的判定器だけが出す。証明は nonce 付き canary の回収に限る。エージェントや recipe の自己申告、リバースシェル、永続化、ホストアクセスは証明にしない。
4. 検証の失敗（環境、手順、観測、証拠の不足）は `incomplete`。`contradicted` にも棄却にもしない。
5. 判定は Finding と検証結果が同じ Target Snapshot digest を持つときだけ行う。digest 不一致は `incomplete`。
6. 人間の判断点は「提出前のレビュー」と「外部行動の承認」の2つ。対象選定の承認と未検証候補の採否は置かない。権限・対象範囲の拡張は人間の明示承認を要する。
7. 外部送信（報告、ベンダー連絡、公開）は、正確な Submission Candidate、文案の版、送信先へ結び付いた承認があるときだけ。Harness 自身は送信を実行しない。
8. 台帳は追記専用で、持つのは digest 参照だけ。payload、HTTP 記録、画面画像、実行ログ、認証情報、未公開の発見は Git 外の Private Evidence に置く。

## Harness と AI の責務（所有者決定 2026-10-18）

過去 4 世代と本 repo の 2026-10 は同じ失敗を繰り返した。探索や検証の「やり方」を Harness の code に入れ、Harness が肥大し、報酬が止まる（LESSONS 14）。境界を次に固定する。設計・実装・レビューで不変条件の次に見る。

- **Harness は制御だけを持つ。** 選定、Snapshot と digest、gVisor と broker、prompt と source を渡して走らせること、wall と子の数、出力の全件保存と schema による正規化、Programme Boundary 外の出口での park、Finding 単位の Lab 供給と canary の播種、判定器、台帳と Private Evidence、review の記録。判断の要らない処理だけを code にする（LESSONS 4）。
- **探索と検証の中身は prompt と skill が持つ。** どこを読むか、何を索引にするか、どの順で仮説を立てるか、どう再現するか、前提をどう作るかは agent の仕事。探索は目的 prompt（記事の wp2shell）を渡して Root に任せる。検証は skill が Harness の立てた Lab に対して行い、`runtime-confirmed` は判定器だけが出す。
- **移す合図。** Harness の code に「agent にこう探させる」「この前提ならこの scenario」「索引の網羅率」のような判断が現れたら、prompt か skill へ移す。agent の自己申告を Harness が根拠にする code が現れたら、判定器か観測器へ移す。観測（読んだ file、wall、token、出力）は Harness が取る。舵取りは取らない。
- **削除。** 入口・保存先索引の探索入力、task-plan と dispatch、coverage と `incomplete(depth)`、Verifier 指示の連鎖、precondition 文から scenario を選ぶ正規表現、plugin 別 Lab adapter と scenario は境界の外側にあるので、skill 化と同時に削除する。使わない設定にして残す中間状態は置かない。入口・保存先索引、coverage と `incomplete(depth)`、公開履歴 catalog の生成は ADR 0034（2026-10-18）で削除済みで、SPEC・ADR 0029 の該当行は改訂した。Verifier 指示の連鎖と scenario / adapter は #352 と同時に消し、ADR 0026 の該当行をそのとき改訂する。それまで下の検証 Lab 節の scenario の行は、既存 Trial の記録を読むための記述として扱う。

## 単一協調Trialの探索（SPEC.md 第6節、ADR 0029）

- 新規探索で実行可能な目的promptは `wp2shell-bounty-v8` だけ。起動modeも `wp2shell` のみで、対象ごとにRoot＋最大4子の協調Trialを1回行う。wall上限は120分、最低60分は能動的に探索する。早期最終報告は同じ協調セッションで継続し、継続不能やwall・provider・broker・schema等の失敗は理由付き `incomplete` として正常な候補0件に数えない（ADR 0033）。`provider-cyber-policy` で止まった Root thread は操作者が `campaign resume --run <runId>` で名指ししたときだけ、同じ Snapshot・同じ再開段落・残り wall で新しい使い捨て sandbox に再開し、同じ Trial の segment として数える。自動再開と prompt の言い換えはしない（ADR 0036）。
- v8 には入口索引を渡さず、固定sourceからRoot自身が着眼点を決める。最低時間を守るための同一セッション継続以外に、screeningから条件付きdeep-diveへの分岐や入口網羅の終了条件は置かない。子の有効なFindingとLeadはRoot報告と独立して保存する。
- Snapshotは対象plugin、WordPress core、実行imageに対応するPHP source、`Requires Plugins` と選定方針の明示指定による依存pluginを版・digestで固定する。自動選定の本番対象はfreeze時点の公式stable版、手動・歴史的評価対象は明示版pinを使う。探索では全sourceを読み取り専用で渡し、Labにも固定したplugin依存を供給する。依存の欠落を黙って無視しない。
- 旧版の探索promptと実験結果は過去Trialのdigest・構成照合用に保持するが、旧版を使う新規Trialは起動しない。索引あり・なしや旧段付きTrialを同じ比較分母に混ぜない。v8は脆弱性が必ずあるという前提や固定された攻撃経路を与えない。
- agentに渡る文章（prompt本文、skill本文、Harness生成の節の雛形）は `owner-approved` ラベルが付くまでmergeしない。2026-10-13以降、採否とラベル付与は所有者がAIに委任しており、AIは委任を明記したPR commentを残す（DEVELOPMENT.md 第5節）。2026-10-18以降は所有者の読了もmergeの条件でなく、ADR・SPEC・policy・判定器のpathも含めて委任済みのAIが差分を確認してラベルを付ける。採否は探索の数字で決める（ADR 0032 の 2026-10-18 節）。AIは出典対照表にある要素だけを書き、要素を足さない。
- prompt本文を変えたら版を上げ、旧版を残してdigest pinを更新する。旧promptは過去Trialの目的文とdigestを照合するために維持する。台帳の旧 `stage` / `continuationOf` 付きeventも読み続け、既存eventを消さない。
- Finding / Leadの出力契約はprompt本文に書かず、Harnessがschemaから生成する節として渡す（ADR 0019）。候補は出力境界で棄却せず、正規化して受理するか保留する（ADR 0018）。
- 受理した Finding のうち impact が Programme Boundary の外にあるもの（`other`、`csrf-to-write`、`missing-authz`、`idor`、`reflected-xss`）と、所有者が 2026-10-17 に「重大かどうかの判別が付きにくい」として外した `sensitive-object-access`、`content-deletion`、`options-update`、`privesc-to-contributor+`、`auth-bypass-non-admin` は `finding-parked` として台帳と Private Evidence に残し、検証 queue・review queue・funnel の raw に入れない（ADR 0032 の 2026-10-17 節。Q1 の content-deletion 復帰を上書き）。探索 prompt の目的文は変えず、出口で振り分ける。一覧は `review parked --campaign <id>`。対象範囲内の Finding は判定器の結果に関係なく全件 review queue に出る（#185、ADR 0031）。
- contributor以上と管理者が意図して付与する権限はtrust境界の内側に置く。公開済み7件の再発見は配線と判定器の確認であり、未知の発見率を示さない。promptとscenarioに対象固有の関数名、option名、URL、画面名を入れない。

## 検証Labの前提（SPEC.md 第7節、ADR 0026）

- WordPress profileの通常機能scenarioはplugin非依存の状態を優先して追加する。頻出する `incomplete(precondition)` の理由を集計して決め、版とdigestを固定する。
- 被害者側の操作はHarness所有のLab観測器が型付き手順で行う。Verifierにブラウザを渡さない。管理者セッションは `verify next --handoff` の skill に前提作りのためだけに渡し、`setup-done` 以後は攻撃者位置のみ（ADR 0035）。Codex Verifierには渡さない。

## `profiles/wordpress/` の規則（ADR 0011）

WordPress 固有のもの（WordPress.org からの取得、WordPress + MySQL の Lab 供給、PHP 向けの判定器、Wordfence / Patchstack の対象範囲方針、trust 境界宣言の雛形、Lead 型、評価対象の分類）は `profiles/wordpress/` に置く。

汎用モジュール（selection / snapshot / lab / discovery / verification / ledger / review）は profile が実装するインターフェースの型だけに依存し、WordPress の型や path を import しない。plugin、slug、hook、AJAX action、`wp_options` のような語が汎用モジュールに現れたら、それは profile へ移す合図。

profile のインターフェースは、2つ目の profile ができるまで汎用化しない。

## 品質ゲート

コミット前に `pnpm check` を通す。

## 開発の流れ（docs/DEVELOPMENT.md）

- 変更は「今週の問い」1 つに答える PR 1 本。PR テンプレートの 5 項目（問い、変えたこと、変えなかったこと、測った数字、消し方）を日本語で埋める。
- 探索に触る PR は開発セットで最低 3 Trial の結果を貼る。数字のない探索変更は merge されない。
- 「調べて報告」の成果物は `docs/reviews/` に日付付きで置く。正本ではない。

## Agent skills

### Issue tracker

作業IssueはGitHub Issuesで管理する。手順は `docs/agents/issue-tracker.md`。

### Triage labels

Matt Pocock系スキルの5つの標準ラベルを使う。対応は `docs/agents/triage-labels.md`。

### Domain docs

単一コンテキストとして、用語集はルートの `GLOSSARY.md`、判断記録は `docs/adr/` に置く。読み方は `docs/agents/domain.md`。

### Measurement, review, briefs, ledger

AI が自分で回す手順は `docs/agents/` に置く。計測は `measurement.md`、PR のレビューと merge は `pr-review-merge.md`、Codex への依頼文は `codex-briefs.md`、台帳の読み方は `ledger-reading.md`。進行中の状態は Git ではなく Issue の comment に書く。
