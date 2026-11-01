# AGENTS.md

正本は [docs/SPEC.md](docs/SPEC.md) と [docs/adr/](docs/adr/) である。この文書はその要約で、食い違えば正本が勝つ。本番ランナーが動いており、本番の数字がそのままベンチである（所有者決定 2026-10-26）。

## 読む順

1. [docs/SPEC.md](docs/SPEC.md) — 目的、不変条件、モジュール境界、受け渡し契約。
2. [docs/adr/](docs/adr/) — 番号順に読む。設計の理由と、採らなかった選択肢。索引は [docs/adr/README.md](docs/adr/README.md)。
3. [docs/SYSTEM.md](docs/SYSTEM.md) — 選定から提出までの 6 段を、Harness・AI・人間の受け持ちで追う。規則は増やさない。
4. [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — 運用規則、PR の規則、止めてある案。[docs/LESSONS.md](docs/LESSONS.md) — 過去 4 世代の教訓。新しい設計案は、この 2 つに反していないかを先に見る。過去 4 世代の実験記録と原本は [docs/knowledge/](docs/knowledge/) にある。新しい問いを立てる前に、同じ問いが無いかを見る。
5. [docs/OPERATIONS.md](docs/OPERATIONS.md) — 実際に打つコマンド。

## 不変条件（SPEC.md 第 2 節）

設計・実装・レビューのすべてで守る。

1. 探索エージェントへ渡すのは、固定したソース、人間が書いた trust 境界宣言、Programme Boundary、Lab、時点で切った対象の公開履歴だけである。公開履歴はカタログ情報に限る（ADR 0012）。評価対象の答え、held-out 公開日以降の記録、PoC、ペイロード、再現手順は渡さない。例外は 2 つで、どちらも campaign 設定で名指ししたときだけ渡る。同じ Snapshot に対する過去 Trial の Lead の代表を `## Prior leads` 節で渡すこと（ADR 0044）と、同じ対象の別 Snapshot に対する最新の過去 Trial の `recon-map.md` と `lab-setup.md` を `## Prior research` 節で渡すこと（ADR 0048）である。
2. 対象は gVisor（`runsc`）の使い捨て環境の中でだけ実行する。ホストでは実行せず、弱い隔離へ暗黙に切り替えない。外向き通信は、認証ブローカー経由の provider API に限る。外部サービス接続が通常の利用の前提になる検証では、ADR 0046 の 6 条件を満たす専用 Lab に限って外向き通信と一時公開を行える。出口の中継器と `setup-done` 直後の停止確認は Harness が `--egress-plan` で持ち、公開入口と資格情報は持たない。
3. Harness は判定器を持たない。確定の根拠は、名指しした人間が review Lab で記録した `review observe` の match と `review decide --reproduced match` だけである（ADR 0040）。エージェントや手順の自己申告、捕捉を読んだだけの推定、AI が自分で Lab を見て打った記録は根拠にしない。所有者が会話の中で観測の結果を明言したときに限り、AI 操作役が所有者の名前で代行記録し、発言の原文と時刻を Private Evidence の attestation に残す（ADR 0040 追記 3、所有者決定 2026-10-31）。リバースシェル、永続化、ホストへのアクセスは証明にしない。
4. 検証の失敗（環境、手順、観測、証拠の不足）は `incomplete` にする。`contradicted` にも棄却にもしない。
5. 判定は、Finding と検証結果の Target Snapshot digest が同じときだけ行う。digest が一致しなければ `incomplete` にする。
6. 人間の判断点は「提出前のレビュー」と「外部行動の承認」の 2 つとする。対象選定の承認と、未検証候補の採否は置かない。権限・対象範囲の拡張には、人間の明示の承認が要る。
7. 外部送信（報告、ベンダー連絡、公開）は、正確な Submission Candidate、文案の版、送信先に結び付いた承認があるときにだけ行う。Harness 自身は送信を実行しない。
8. 台帳は追記専用で、digest 参照しか持たない。ペイロード、HTTP 記録、画面画像、実行ログ、認証情報、未公開の発見は、Git 外の Private Evidence に置く。

## Harness と AI の責務（所有者決定 2026-10-18）

探索や検証の「やり方」を Harness のコードに入れると、Harness が肥大し、報酬が止まる（LESSONS 14）。境界を次のとおり固定する。不変条件の次にこれを見る。

- **Harness は制御だけを受け持つ。** 選定、Snapshot と digest、gVisor と broker、プロンプトとソースを渡して走らせること、制限時間と子の数、出力の全件保存とスキーマによる正規化、Programme Boundary 外の Finding を出口で止めること（park）、Finding 単位の Lab の供給と HTTP 捕捉・Lab browser の記録、人間の観測の記録、台帳と Private Evidence、レビューの記録。判断の要らない処理だけをコードにする（LESSONS 4）。
- **探索と検証の中身はプロンプトとスキルが受け持つ。** どこを読むか、どの順で仮説を立てるか、どう再現するか、前提をどう作るかは、エージェントの仕事である。確定は、Lab で観測した人間の記録だけで行う。
- **移す合図。** Harness のコードに「エージェントにこう探させる」「この前提ならこのシナリオ」のような判断が現れたら、プロンプトかスキルへ移す。エージェントの自己申告を Harness が根拠にするコードが現れたら、観測器の記録へ移すか、人間の観測に回す。観測（読んだファイル、経過時間、トークン、出力）は Harness が取る。舵取りは取らない。

## いまの運用（2026-11-01）

- **凍結 5 項目**（ADR 0045）: 不変条件、Harness と AI の責務、単一協調 Trial、人間の観測による確定、本番をベンチにすること。変更の提案はしない。設計の変更は月 1 回までで、目的文の新版を言い換えで増やさない。
- **探索**: campaign 設定の `discovery.mode` で `deep` か `wide` を選ぶ（ADR 0039）。目的文は `wide` が `wp2shell-bounty-v21-wide`、`deep` が `wp2shell-bounty-v11` に限る。旧版は過去 Trial の照合用に残し、新規 Trial には使わない。対象ごとに 1 回、Root と子が協調する Trial を行う。子の上限は `discovery.maxChildren`（既定 4、1〜8）、制限時間は 120 分。`wide` は最初の最終報告で終え、`deep` は最低時間（既定 60 分）まで続ける。これらの値は Harness が生成する `## Run parameters` 節で Root に伝える。探索の手順は目的文に足さず、スキル（`src/profiles/wordpress/prompts/skills/<id>/SKILL.md`）に分けて `discovery.skills` で名指しする（ADR 0043）。
- **止まった Trial**: 制限時間・provider・broker・スキーマの失敗は理由付き `incomplete` にし、正常な候補 0 件に数えない（ADR 0033）。Codex の `provider-limited` と持ち主の死んだ `interrupted` はランナーが自動で再開し、それ以外は操作者が `campaign resume --run <runId>` で名指しして再開する。再開は新しいサンドボックス、同じ Snapshot、残りの制限時間で行い、同じ Trial の再開区間として数える。プロンプトの言い換えはしない（ADR 0036）。
- **選定**: WordPress.org の人気順から、インストール数 5,000 以上、180 日以内更新の対象を 1 バッチ 10 件選ぶ。順序は `install-band-then-published`（帯 100 万 / 10 万 / 1 万の高い帯を先に、帯の中は stable 版の公開日が新しい順。ADR 0037 追記 4）。同じ版の Trial は 1 回で、版が上がれば戻す。探索の方法を変えて再開したときは、方針の `revisitPolicy.countTrialsFrom` に再開時刻を入れ、それより前の Trial を探索済みに数えない（追記 6）。凍結が `deferred` で止まった版は 7 日で再試行する（追記 5）。
- **Snapshot**: 対象プラグイン、WordPress 本体（Lab image の最新安定版）、実行イメージに対応する PHP ソース、依存プラグインを版と digest で固定する。依存は `Requires Plugins`、WooCommerce の版ヘッダ、選定方針の明示指定から決める。依存の欠落を黙って無視しない。
- **出口**: 受理した Finding のうち impact が次の 10 種は `finding-parked` にし、検証列・レビュー列・funnel の raw に入れない。Programme Boundary の外の 5 種 `other`、`csrf-to-write`、`missing-authz`、`idor`、`reflected-xss` と、所有者が外した 5 種 `sensitive-object-access`、`content-deletion`、`options-update`、`privesc-to-contributor+`、`auth-bypass-non-admin`（ADR 0032）。一覧は `review parked` で見る。Lead は検証列に入らないが、`review leads` で人間が全件を見る。対象範囲内の Finding は、検証の結果に関係なく全件がレビュー列に出る（ADR 0031）。
- **検証**: Harness は通常機能のシナリオを持たない。前提は `verify next --handoff` のスキル `wbh-verify` が Lab の通常機能で作る（ADR 0035）。被害者側の操作は Harness の Lab 観測器が型付きの手順で行い、`setup-done` 以後のエージェントは攻撃者の位置に限る。確定は人間の観測の記録だけで行う（不変条件 3）。
- **提出**: 6 段（選別、ソース確認、検証、重複照合、提出先、報告書）を AI 操作役がスキルと CLI で進め、所有者が Lab で観測して文案と送信先を承認する（ADR 0038）。Harness は送信しない。

## エージェントに渡る文章の規則

- プロンプト本文、スキル本文、Harness が生成する節の雛形は、`owner-approved` ラベルが付くまでマージしない。所有者は採否とラベル付与を AI に委任している（2026-10-13、2026-10-18）。AI は委任を明記した PR コメントを残し、REST API でラベルを付ける（DEVELOPMENT.md 第 5 節）。ADR・SPEC・方針のパスも同じ。
- プロンプト本文を変えたら版を上げ、旧版を残して、固定した digest を更新する。台帳にある旧イベントは読み続け、消さない。
- Finding / Lead の出力契約は目的文に書かず、Harness がスキーマから生成する節として渡す（ADR 0019）。候補は出力境界で棄却せず、正規化して受理するか保留する（ADR 0018）。
- プロンプトとスキルに、対象固有の関数名、オプション名、URL、画面名を入れない。脆弱性が必ずあるという前提も、固定した攻撃経路も与えない。contributor 以上と、管理者が意図して付与する権限は、trust 境界の内側に置く。

## `profiles/wordpress/` の規則（ADR 0011）

WordPress 固有のもの（WordPress.org からの取得、WordPress + MySQL の Lab 供給、PHP 向けの Lab 観測器、Wordfence / Patchstack の対象範囲方針、trust 境界宣言の雛形、Lead 型、評価対象の分類）は `profiles/wordpress/` に置く。汎用モジュール（selection / snapshot / lab / discovery / verification / ledger / review）は、プロファイルが実装するインターフェースの型だけに依存し、WordPress の型やパスを import しない。plugin、slug、hook、AJAX action、`wp_options` のような語が汎用モジュールに現れたら、プロファイルへ移す合図である。インターフェースは、2 つ目のプロファイルができるまで汎用化しない。

## 品質ゲートと開発の流れ

- コミット前に `pnpm check` を通す。
- 変更は「問い 1 つ」に答える PR 1 本にする。PR テンプレートの 5 項目（問い、変えたこと、変えなかったこと、測った数字、消し方）を日本語で埋める。探索に触る PR は本番の数字を貼る。数字のない探索変更はマージしない。
- 「調べて報告」の成果物は `docs/reviews/` に日付を付けて置く。正本ではない。進行中の状態は Git ではなく Issue のコメントに書く。
- 文書と Issue は、日本の技術者が書く自然な日本語で書く（GLOSSARY.md「表記の決め事」）。

## docs/agents/

AI が自分で回す手順。Issue の扱いは `issue-tracker.md`、ラベルは `triage-labels.md`、用語集と ADR の読み方は `domain.md`、計測は `measurement.md`、PR のレビューとマージは `pr-review-merge.md`、Codex への依頼文は `codex-briefs.md`、台帳の読み方は `ledger-reading.md`、本番ランナーの監視は `production-monitoring.md`、静的解析の道具は `static-analysis.md`。
