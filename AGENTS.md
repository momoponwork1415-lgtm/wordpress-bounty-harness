# AGENTS.md

設計段階のリポジトリ。正本は [docs/SPEC.md](docs/SPEC.md) と [docs/adr/](docs/adr/)。この文書はその要約で、食い違えば正本が勝つ。

## 読む順

1. [docs/SPEC.md](docs/SPEC.md) — 目的、不変条件、モジュール境界、受け渡し契約、単一協調Trialの主経路と最初の縦断スライス。
2. [docs/adr/](docs/adr/) — 番号順。設計の理由と、採らなかった選択肢。
3. [docs/DESIGN-WALKTHROUGH.md](docs/DESIGN-WALKTHROUGH.md) — 全体を1つの流れで理解したいときだけ。規則は増やさない。図で見るなら [docs/DESIGN-DIAGRAMS.md](docs/DESIGN-DIAGRAMS.md)（2026-10-13 確定版）。 開発の流れ（作業列、ゲート、憲章、逆圧、monitor / tune）を図で見るなら [docs/FACTORY.md](docs/FACTORY.md)。
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

## 単一協調Trialの探索（SPEC.md 第6節、ADR 0029）

- 主経路は対象ごとに `wp2shell-bounty-v4` を既定とするRoot＋最大3子の協調Trialを1回。wall上限は60分。Rootが早く報告すれば終了し、Harnessと既定promptは最低実行時間を設けない。wall・provider・broker・schema等の失敗は理由付き `incomplete` とし、正常な候補0件に数えない。
- 固定source由来の入口索引を既定でカタログとして渡す。索引は経路や分担を指示せず、全入口の処理は終了条件でない。Harnessの続行差し込み、screeningから条件付きdeep-diveへの分岐は行わない。子の有効なFindingとLeadはRoot報告と独立して保存する。
- `wp2shell-bounty-v3`、`wp2shell-bounty-v2` と `short-objective-managed-v4` は比較・履歴照合用、`screening-v1` は過去Trialの構成照合用に保持する。旧screeningを現行modeで新規起動しない。索引あり・なしや旧段付きTrialを同じ比較分母に混ぜない。どの版も脆弱性が必ずあるという前提や固定された攻撃経路を与えない。
- agentに渡る文章（prompt本文、skill本文、Harness生成の節の雛形）は `owner-approved` ラベルが付くまでmergeしない。2026-10-13以降、採否とラベル付与は所有者がAIに委任しており、AIは委任を明記したPR commentを残す（DEVELOPMENT.md 第5節）。AIは出典対照表にある要素だけを書き、要素を足さない。
- prompt本文を変えたら版を上げ、旧版を残してdigest pinを更新する。旧promptは過去Trialの目的文とdigestを照合するために維持する。台帳の旧 `stage` / `continuationOf` 付きeventも読み続け、既存eventを消さない。
- Finding / Leadの出力契約はprompt本文に書かず、Harnessがschemaから生成する節として渡す（ADR 0019）。候補は出力境界で棄却せず、正規化して受理するか保留する（ADR 0018）。
- 受理した Finding のうち impact が Programme Boundary の外にあるもの（`other`、`csrf-to-write`、`missing-authz`、`idor`、`reflected-xss`）は `finding-parked`。`content-deletion` は Wordfence が対象内なので除外しない（ADR 0032 Q1） として台帳と Private Evidence に残し、検証 queue・review queue・funnel の raw に入れない。一覧は `review parked --campaign <id>`。対象範囲内の Finding は判定器の結果に関係なく全件 review queue に出る（#185、ADR 0031）。
- contributor以上と管理者が意図して付与する権限はtrust境界の内側に置く。公開済み7件の再発見は配線と判定器の確認であり、未知の発見率を示さない。promptとscenarioに対象固有の関数名、option名、URL、画面名を入れない。

## 検証Labの前提（SPEC.md 第7節、ADR 0026）

- WordPress profileの通常機能scenarioはplugin非依存の状態を優先して追加する。頻出する `incomplete(precondition)` の理由を集計して決め、版とdigestを固定する。
- 被害者側の操作はHarness所有のLab観測器が型付き手順で行う。Verifierにブラウザや管理者セッションを渡さない。

## `profiles/wordpress/` の規則（ADR 0011）

WordPress 固有のもの（WordPress.org からの取得、WordPress + MySQL の Lab 供給、PHP 向けの判定器、Wordfence / Patchstack の対象範囲方針、trust 境界宣言の雛形、保存先索引と成分分担、Lead 型、評価対象の分類）は `profiles/wordpress/` に置く。

汎用モジュール（selection / snapshot / lab / discovery / verification / ledger / review / evaluation）は profile が実装するインターフェースの型だけに依存し、WordPress の型や path を import しない。plugin、slug、hook、AJAX action、`wp_options` のような語が汎用モジュールに現れたら、それは profile へ移す合図。

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
