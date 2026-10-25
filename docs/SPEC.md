# WordPressバグバウンティHarness 仕様書（新リポジトリ）

版: v0.22、2026-10-19。設計判断はこの文書と [ADR](adr/) に置く。旧リポジトリの [Issue 221](https://github.com/momoponwork1415-lgtm/wordpress-harness/issues/221#issuecomment-6057678317) は経緯の資料であり、現在の探索主経路は [ADR 0029](adr/0029-single-wp2shell-cooperative-trial.md) と [ADR 0033](adr/0033-minimum-exploration-and-pinned-dependency-sources.md) に従う。[IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) は 2026-10-10 時点の作業計画の記録で、今の Step と作業順は [DEVELOPMENT.md](DEVELOPMENT.md) 第 2 節。TranslatePressでの最小ベンチマークと本番移行は [TRANSLATEPRESS-BENCHMARK.md](TRANSLATEPRESS-BENCHMARK.md)。

## 1. 目的と指標

- 目的: WordPressプラグインの未知脆弱性をAIで発見し、公開中の最新版の通常利用構成で人間が手動再現し、重複・対象範囲と根拠付き報告書を確認したものを、人間が承認して提出し報奨を得る。当面はWordfenceを主な提出先とし、Patchstack向けの追加自動化は報告が増えてから扱う（ADR 0038）。
- 収益の式: 月に回せる対象数 × 当たり率 × in-scope率 × 平均報奨 − 月費用（約$700）。
- 比較指標: 提出先で受理された報奨見込みと実際の報奨を、対象数・探索時間・provider使用量で割って見る。実測前に月間件数を達成条件として固定しない。
- 設計の優先順位: 大手が公開している設計・結果規則をまず当て、WordPress固有で避けられない部分だけを自作する。

## 2. 不変条件

1. 探索エージェントへ渡すのは、固定source、人間が書いたtrust境界宣言、Programme Boundary、任意のLab、そして時点で切った対象の公開履歴（カタログ情報のみ）だけ。評価対象の答え（held-outのadvisory本文、原因箇所、PoC）と、評価runではheld-outの公開日以降の記録は渡さない。PoC、payload、他人の再現手順は本番でも渡さない（[ADR 0012](adr/0012-time-cut-known-vulnerability-history.md)）。
2. 探索・検証はgVisor（`runsc`）の使い捨て環境でのみ対象を実行する。ホストで対象コードを実行しない。弱い隔離へ暗黙に切り替えない。外向き通信は認証ブローカー経由のprovider APIだけ。
3. Harnessは判定器を持たない。確定の根拠は、名指しした人間が新しいreview Labで記録した `review observe` のmatchと `review decide --reproduced match` だけである。エージェントやrecipeの自己申告、捕捉を読んだだけの推定、AIが打った `review observe` / `--reproduced` は根拠にしない。リバースシェル・永続化・ホストアクセスを使わず、証明にもしない。新しい検証は `runtime-confirmed` を出さず、既存の `runtime-confirmed` は判定器があった時期の記録として読み続ける（2026-10-25 改訂、2026-10-26 に根拠を明記、[ADR 0040](adr/0040-human-lab-observation-replaces-judges.md)）。
4. 検証の失敗（環境・手順・観測・証拠の不足）は `incomplete` であり、`contradicted` にも棄却にもしない。
5. 判定は、Findingと検証結果が同じTarget Snapshot digestを持つときだけ行う。digest不一致は `incomplete`。最新版への再検証では新しいSnapshotに結び付けたFindingを別に記録し、旧Findingへの由来だけを参照する。
6. 人間の判断点は「提出前のレビュー」と「外部行動の承認」の2つ。対象選定の承認、未検証候補の採否はない。権限・対象範囲の拡張は人間の明示承認を要する。
7. 外部送信（報告、ベンダー連絡、公開）は、正確なSubmission Candidate・文案の版・送信先へ結び付いた承認なしに行わない。Harnessは送信を実行しない。
8. 台帳は追記専用。payload、HTTP記録、画面画像、実行ログ、認証情報、未公開の発見はGit外のPrivate Evidenceに置き、台帳はdigest参照だけを持つ。

## 3. 流れ

開発対象のslugと版を指定（運用時は機械選定） → Snapshot固定 → WP2Shell目的promptによるRoot＋subagent（上限は `discovery.maxChildren`、既定 4）の協調Trialを対象ごとに1回（探索用Labは既定で付けない、`discovery.lab: none`） → Finding単位にLabを供給し、既存の検証skill（`verify next --handoff`、ADR 0035）が再現 → Harnessが捕捉とLab browserの記録を残し、人間の観測を待つ（`incomplete(awaiting-human-observation)`、ADR 0040） → 最新版で再検証 → 重複・scope照合 → 人間がreview Labで観測と再現を記録（`review observe`、`review decide --reproduced`） → 英語レポートJSON案 → 人間の査読 → 外部行動承認 → 人間が提出し転帰を記録。台帳は全段階を追記する。評価は台帳を読むだけで、探索へ答えを渡さない（ADR 0029）。

この流れの最終目標では、nonce付きcanaryを回収した `runtime-confirmed` は提出の必須条件ではない。Harnessの捕捉した発火などの軽量観測はそのまま事実として記録し、成立の最終確認は同じ最新版Snapshotの手動Lab再現で行う。現行の `incomplete` から正式な文案・Submission Candidateへ進む経路は未実装であり、内部プレビューだけを作れる（ADR 0038 の2026-10-24追記9・10）。

## 4. モジュール境界

strict TypeScriptのモジュラーモノリス。各モジュールは公開インターフェースと所有する記録だけを外へ出す。

| モジュール | 目的 | 公開インターフェース | 所有する記録 | 失敗時 | 出自 |
| --- | --- | --- | --- | --- | --- |
| `selection` | 方針に従って対象を機械的に選び、予算内で順序付ける | `select(policy) → TargetSelection[]`、`inspect` | 選定方針（人間が編集）、WordPress.org の観測、台帳の過去選定、選定記録とスコア内訳 | WordPress.org / Programme観測の unavailable / stale をeligibleにしない | 開発対象はslugと版を直接指定可。公開履歴は mirror の件数と公開日だけを採点に使う（ADR 0037） |
| `snapshot` | 対象plugin、WordPress本体、PHP、必要な依存pluginのsourceをdigestで固定する | `freeze(selection) → Snapshot`、`verify(digest)` | Target / Dependency Snapshot、canonical manifest | archiveの不正path・symlink・size超過を拒否し、必要な依存の欠落を黙って省略しない | 移植: `canonical-source-tree`、`canonical-json`、`immutable-file`、`private-artifact-store` |
| `lab` | WordPress + MySQLの使い捨てgVisor環境を供給し、ロール別アカウントと、HTTP捕捉のrecorder・Lab browserを付ける。検証Labと、人間が観測する新しいreview Labの両方を立てる | `provision(snapshot, setup) → LabHandle`、`teardown` | Lab Setup digest、ロール認証情報（Lab内のみ） | source / image / runsc不一致では起動しない。provision失敗は `incomplete` 用の理由コード | 移植: `human-os` のgVisor候補検証Lab。拡張: ロール基準の正常操作記録。canaryの播種は2026-10-25に削除した（ADR 0040）。旧discovery用Labは退役し、過去の記録だけを読む |
| `discovery` | 固定Snapshotで対象ごとにRoot＋子（上限は `discovery.maxChildren`、既定 4）の協調Trialを1回回す | `run(campaignInput) → DiscoveryRun`、`campaign(stopRule)` | Trial id、Root / 子の実行記録、model profile digest、prompt digest、usage、FindingとLeadのdigest参照 | provider / schema / sandbox失敗はtyped receiptとして残し、有効な個別成果を失わない。provider上限はcampaignを止め、runnerがbackoff後に同じcampaign IDで再開する（`runtimeShare` で両 runtime に分けた探索Labなしのcampaignでは、上限に当たった runtime の対象だけを止める。ADR 0032 の 2026-10-20 追記 3）。対象単位の失敗は `target-skipped` で次の対象へ進む | ADR 0029。旧単独Trialと二段構えの記録は読み続ける |
| `verification` | 検証skillの出力を保存し、Harnessが捕捉したHTTP、Lab状態の差分、Lab browserの記録を残す。成立は判定しない（ADR 0040） | `verify(finding, snapshot, lab) → VerificationResult` | Verifier run記録、Harnessの証拠（HTTP捕捉、Lab状態の差分、Lab browserの記録）、Lab Setup digest | 前提不一致・observation失敗・cleanup失敗は `incomplete`。捕捉が残ったattemptは `incomplete(awaiting-human-observation)` | 新規 |
| `ledger` | 全イベントを追記し、funnelを読み取り専用で導く | `append(event)`、`read(query)`、`funnel(campaign)` | LedgerEvent（型付きunion、snapshot digest付き）、添付（Codex findings等）のdigest参照 | 同一identityへの異なる内容はconflict。削除しない | 新規。規則はADR 0024とMantisから |
| `review` | 人間が検証済みFindingを見て提出判断をする。scope、重複、文案、承認 | `queue() → ReviewItem[]`、`decide`、`assessScope`、`draft`、`authorize` | ReviewDecision、Programme Scope Assessment、Submission Candidate、Submission Draft（版付き）、External Action Authorization | scope評価失敗はscopeだけ `incomplete`、Verified Vulnerabilityを失わない。必要な承認がなければadmitしない | 移植: `human-os` のscope評価・Draft・Authorization。新規: review CLI、ローカルWordfence履歴DB照合 |
| `evaluation` | 2026-10-18 に削除（所有者指示）。`eval compare / prospective / case-blocked` と location-overlap 採点は運用・skill・runner のどれも呼んでいなかった。費用と転帰の集計は `ledger` の `funnel` / `usage` が持つ | — | — | — | — |
| `cli` | 上記を薄く接続する | コマンド | なし | | 移植: `cli.ts` の構成だけ |

持ち込まないもの: `research/` のResearch Campaigns内部とcheckpointによる長期セッション再開、条件付き3試行、Human Candidate Review、Research Grant、Approved Target Batch、旧スキーマ、Grok / Claude Code / GLM / DeepSeek adapter（開発比較が必要になったら移す）。旧単独Trialの1 hop Lead継続は書き込み経路から削除済みで、過去の台帳は読み続ける。

## 4a. Target Profile（対象固有部分の置き場）

将来の別言語・別プラットフォームへの使い回しのため、WordPress固有のものは `profiles/wordpress/` に閉じ込める（[ADR 0011](adr/0011-target-specific-code-lives-in-a-profile.md)）。

| profileが提供するもの | WordPress版の中身 |
| --- | --- |
| source取得 | WordPress.orgからの対象・依存pluginの取得と検査、固定実行imageからのWordPress本体・PHP sourceの取得 |
| Lab provisioner | gVisor内のWordPress + MySQL、ロール別アカウント、HTTP捕捉のrecorder、Lab browser |
| Lab観測器 | 第7節のHTTP捕捉、Lab状態の差分、被害者画面の記録。成立は判定しない（判定器集合は2026-10-25に削除、ADR 0040） |
| scope方針 | `src/profiles/wordpress/policy/programme-scope.md`（Wordfence / Patchstack） |
| prompt雛形 | 新規探索では、campaign 設定の `discovery.mode` に応じて `wp2shell-bounty-v11`（`deep`）か `wp2shell-bounty-v13-wide`（`wide`）だけを実行可能にする。v8、v10、v10-wide、v11-wide、v12-wide を含む旧版は過去Trialのdigest・実験結果の照合用に保存し、新規探索には使わない。trust境界宣言の雛形も持つ。ADR 0019、0029、0033、0039 |
| source補助 | （削除済み、ADR 0034）保存先索引と登録入口の生成は 2026-10-18 に Harness から外した。どこを読み何を索引にするかは prompt 側の Root が決める |
| Lead型 | sourceに根拠があり、影響までの辺が1つ足りないprimitiveの分類と記録 |
| 評価対象の表現 | 開発対象のslug、版、修正版、影響分類。正解表の手入力は初期受入条件にしない |

汎用モジュールはこれらをインターフェース経由で受け取り、WordPressの型やpathをimportしない。2つ目のprofileを作るまでインターフェースは汎用化せず、WordPress版の完成後に共通部分を抽出する。

## 5. 受け渡し契約（版付き、Zodで実行時検査）

| 契約 | 送り元 → 受け手 | 主な項目 |
| --- | --- | --- |
| `TargetSelection v1` | selection → snapshot | plugin slug、version、スコア内訳、方針の版、選定時刻、必要なら対象slugに結び付けた依存pluginの明示pin |
| `CampaignInput v1` | snapshot → discovery | Target / Dependency Snapshot digest、trust境界宣言（人間が書く、版付き）、Programme Boundary（匿名化）、公開履歴は `none` のみ（時点で切ったカタログの生成は ADR 0034 で削除。旧runの `catalog` は台帳から読む）、model profile digest、prompt digest、Trial単位の停止規則、Lab設定 |
| `PlannedTrial` | profile → discovery | Trial id / ordinal、Rootと子（上限は `discovery.maxChildren`）の実行枠、固定sourceの参照、単一Trialのwall上限。旧形式の入口索引・段・Lead継続planは互換読取のみ |
| `Finding v1` | discovery → verification / ledger | claim、attacker position（`unauthenticated` / `subscriber` / `customer` のみ）、到達する影響の種別（第8b節の共通分類）、設定前提（`default` / 変更内容）、破られるproperty、入口からeffectまでのtrace（file、function、行）、既存controlへの評価、Lab内で観測した事実、recipe ref（Private）、discovery run id、snapshot digest |
| `Lead v1` | discovery → ledger | primitive、storage分類、欠けた辺、source trace。本文はPrivate Evidence、台帳はdigestとenumだけ。Verifierへは送らない |
| `VerificationResult v1` | verification → ledger / review | `runtime-confirmed` / `contradicted` / `incomplete`、判定器の種類、判定器が観測した条件（使ったrole、path / 拡張子の制御、到達role、XSSの発火context、変更したoption、設定前提）、証拠ref、Lab Setup digest、`incomplete` 理由コード、次の手（verifierが書く）、再現パッケージref（confirmedのみ）。台帳にはoptionalな `evidenceCapture` enum |
| `ReviewDecision v1` | review → ledger | 採否、理由コード、重複照合の結果、判断時刻、開いた証拠の一覧 |
| `SubmissionCandidate v1` | review → review（承認） | Verified Vulnerability ref、programme、scope判定、Draft revision digest、送信先 |
| `LedgerEvent v1` | 全モジュール → ledger | 型付きunion。全イベントがsnapshot digestとcampaign idを持つ |

別モジュールの保存先や内部型を直接参照しない。Private Evidenceはcontent-addressedで、台帳にはdigestと種別だけを置く。

## 6. Discovery runの仕様

- 攻撃者位置: 未認証とsubscriber（customer相当）だけ。contributor以上はtrust境界の内側として宣言する（第8a節）。
- 旧Trialの公開履歴入力・照合仕様: ローカルWordfence履歴DBから、snapshotの版より前（評価runではheld-outの公開日より前）に公開された対象プラグインの記録を抽出した。内容は種別、影響版、修正版、公開日、公開記録のタイトル、修正版との差分で変わったファイルの一覧までで、PoC・payload・再現手順は含めない。渡した・渡さないは `CampaignInput` に記録する（ADR 0012）。v8 以降の新規探索にはこの履歴を渡さない。
- 入力: 新規探索には `wp2shell` の単一協調Trialだけを使う。目的promptは campaign 設定の `discovery.mode` で決まり、`deep` は版・digest付きの `wp2shell-bounty-v11`、`wide` は `wp2shell-bounty-v13-wide` に限る（ADR 0039 の 2026-10-25 追記 4。v10、v10-wide、v11-wide、v12-wide は archived）。目的文には子の数、最低時間、wall の数を書かず、生成節 `## Run parameters` が伝える。mode は Trial の属性として台帳の `configuration.mode` に残し、Trial の途中で変えない。v8・v10・v10-wide・v11-wide・v12-wide を含む旧版と旧modeは過去Trialの目的文・digest・実験結果の照合用に残すが、新規Trialには選べない。人間が書いたtrust境界宣言、Programme Boundary、固定した対象plugin、WordPress core、実行imageに対応するPHP、必要な依存pluginの読み取り専用source pack、Lab（任意）のHTTP endpointと低権限認証情報、provision時点のtableだけを読めるRO DB accountを渡す。依存pluginは `Requires Plugins` ヘッダ、WooCommerceの版ヘッダ（`WC requires at least` / `WC tested up to`、`woocommerce` に対応づける）、選定方針の明示指定から決める。版ヘッダだけから決めた `woocommerce` は、版pinだけで決める対象（手動・歴史的評価とreverify）でpinが無ければ固定せず、依存のpinsetに `header-derived-unpinned` と残す。自動選定の本番対象はfreeze時点の公式stable版、手動・歴史的評価対象は明示版pinを使い、全て版とdigestをSnapshotに固定する。v11 と v13-wide には固定source由来の入口索引や公開履歴カタログを渡さず、分担と仮説はRootが決める。旧Trialの索引と公開履歴の記録は読み続ける。
- 許可する操作: 固定sourceの読み取り、LabへのHTTP、Lab DBのRO accountによる読み取り。探索runにcanaryは渡さない（検証段階もcanaryを発行しない、ADR 0040）。外向き通信は認証ブローカー経由のprovider APIだけ。`discovery.lab: attached` では Trial ごとに探索 Lab を 1 台立て、HTTP、Trial の間ずっと使える管理者と低権限の account、`discovery.lab.maxResets` 回までの再供給（`POST http://labctl/reset`）と、`discovery.lab.maxObservations` 回までの観測コマンド（`POST http://labctl/observe`、型付きの要求で Harness の観測器が被害者の役割で画面を開く）を渡し、Harness は HTTP の捕捉と状態の差分を封じて回数を数えるだけで判定しない。再開区間には同じ setup digest の新しい Lab を立て、Trial 全体の再供給予算の残りを渡す（ADR 0003 の 2026-10-25 追記）。
- 構成: 対象ごとにRoot＋子（上限は `discovery.maxChildren`、既定 4）の協調Trialを1回行う。Harnessは人数上限、隔離、wall、証拠保存、停止を管理し、子の有効なFindingとLeadはRootの最終JSONと独立して保存する。開発セットの3回反復は独立したTrialとして測り、本番の対象ごと1回という既定を変えない（ADR 0029）。
- 出力: `Finding[]`（0件可）、`Lead[]`（0件可）。v8 以降に入口索引のcoverage recordや網羅の終了条件を課さない。Leadはsourceに根拠があり、影響までの辺が1つ足りないprimitiveであり、Findingや検証結果ではない。schema失敗は0件の正常完了にしない。候補は生のまま保存し、profileの正規化を通してから受理する。受理できない候補は `candidate-held` として分類とissue pathだけを台帳に残し、保留だけのTrialは無成果に数えない（ADR 0018）。Finding / Leadの出力契約はprompt本文ではなくHarnessがschemaから生成する節として渡し、目的文と契約節のdigestを別に記録する（ADR 0019）。
- 停止規則: `deep` の1 Trialの既定wall上限は120分。最低60分は能動的な探索を指示し、Rootの早期最終報告は同じ協調セッションで継続させる。Harnessが保証するのは60分の経過時間であり、能動性はsource読取・子の活動・ラウンド・provider使用量で事後評価する。継続不能、wall到達、provider上限、broker制限、実行・schema失敗は理由付きの `incomplete` とし、既に保存した子の成果を失わない。最終JSONに到達しなかったTrialを候補0件の正常完了にしない。`wide` は最低時間を置かず、既定wall 120分（上限、2026-10-25 までは20分）で、Rootの最初の最終報告でTrialを終える（ADR 0039、追記 3）。子の上限（`discovery.maxChildren`、既定4）、最低時間（`discovery.minimumActiveMinutes`）、Labの再供給予算（`discovery.lab.maxResets`）は設定値で、Harnessが強制し、同じ値を生成節 `## Run parameters` でRootに伝える（ADR 0039 追記 3）。旧版本文は変更せず履歴照合に残す。同一対象の自動追加Trialはしない。provider上限では新規Trialを止め（`runtimeShare` で両 runtime に分けた探索Labなしのcampaignでは、上限に当たった runtime の新規Trialだけを止める）、runner（`continuous run`）がbackoff後に同じcampaign IDで、Codex のrunは止まったTrialを同じRoot threadのsegmentとして再開する（Claude のrunは新しいTrialとしてやり直す）。拒否・wall・schema等の対象単位の失敗は `target-skipped` として次の対象へ進み、campaignを止めない。止まった Root thread は、止まった理由を問わず（`completed` は除く）、操作者が `campaign resume --run` で名指ししたとき、同じ Snapshot・同じ目的promptの再開段落（v8 以降の `deep` は `Before giving up,`、v10-wide 以降の `wide` は `Stop when` で始まる最後の段落）・残り wall で新しい使い捨て sandbox に再開し、同じ `trialId` の segment として記録する（Codex のrunの `provider-limited` と `interrupted` の runner 自動再開を除く、ADR 0036）。終了eventの無いrun（ホストの電源断など）は、sandboxが開始時に書く印で持ち主のプロセスが死んだと分かるときだけ、`campaign resume` が残ったsessionとnotesを封じて `failed(interrupted)` の終了eventを追記してから再開する。runnerの再起動が同じ対象を新しいTrialとしてやり直した後のrunは `superseded` で拒否する（ADR 0036 の 2026-10-19 追記 2）。持ち主のプロセスが死んだrunは、再起動したrunnerが新しいTrialを始める前に同じ経路で自動再開を試み、同じ対象の枠の中で走らせる。`interrupted` の再開が拒否されたら理由をログに書いて従来どおり新しいTrialに戻り、再開したsegmentが `incomplete` で終わってももう一度は自動再開しない（ADR 0036 の 2026-10-19 追記 3）。Rootがsourceを1件も読まず、子を起動せず、broker転送が1以下で終わったrunはTrialに数えず、その対象は次の選定で戻る（途中まで走ったTrialはTrialとして数え、再選定しない）。provider上限（`provider-limited`）で終わった初回runは、単独ではTrialに数えない。Codex のrunは、runnerが Codex CLI の同一会話内再試行が尽きた後にbackoffし、起動直後も含め同じTrialを、再開segment最大5まで、残りwallが5分以上ある間だけ再開する。再開が拒否されたら理由付き `incomplete` として対象を閉じ、Trial 1 回に数えて次の選定から除外し、新しいTrialを作らない。Claude のrunの `provider-limited` は、backoff後に新しいTrialとしてやり直し、選定でも除外しない（ADR 0029 の 2026-10-19 追記）。`provider-cyber-policy` と Claude の `provider-refusal` は名指し再開のみとする（ADR 0036 の 2026-10-19 追記 4、2026-10-21 追記）。正常完了の0件も脆弱性なしを意味せず、source読取とwallから早期終了と探索後の0件を分ける。
- 同時実行: 最初はTrialを1つずつ回す。provider要求総数・usage・wallを観測し、安全に増やせることを確かめてから対象間の並列数を決める。
- 記録する項目（runごと）: trialId / trialOrdinal、Root・子の役割、要求model IDとeffort、CLIの正確な版と同梱カタログのdigest、認証方式、cyber access program、service tier、各agentのusage（providerが返さない項目は `unavailable`）、観測できたsource読取とcommand件数の下限、prompt・sourceのdigest、wallと停止理由。v8 以降のrunは入口索引を持たず、過去の索引・段・継続付きrunは読めるようにする（ADR 0034）。
- 本番model: Daybreak Blue対応の `gpt-6-sol` 系を使う。正確なmodel IDとsubagentへの継承は実機preflightで固定する。`gpt-6.1-sol`やLunaへ暗黙に切り替えない。

## 7. Verificationの仕様

2026-10-23 に旧 Codex Verifier を退役した（ADR 0035）。実 host は `--handoff` のない `review reverify` を退役エラーで止める（`discovery.lab: attached` は 2026-10-25 に探索 Lab として戻した。ADR 0003 の追記）。既存の handoff と共有の境界検査・判定器は変更しない。scenario の生成・選択と plugin 別 adapter は #353 の残る削除対象で、今回の退役は #352 の受入完了を意味しない。

- 旧 Codex Verifier の入力契約（履歴参照）: 新しいコンテナ。渡すのはFinding、固定source pack、Lab endpoint、低権限account、RO DB account、Lab Setup（profileの版付き通常機能シナリオIDを含む、ADR 0020・0026）と、impactに応じてLabが検証時に発行したcanary。Findingの前提はplugin非依存の通常利用scenarioを優先するcatalogueと照合し、不足は `incomplete(precondition)` の次の手に次のscenario IDを書く。`incomplete(precondition)` の理由コードを台帳から、次の手の本文をPrivate Evidenceから集計し、頻出前提をcatalogueへ追加する。探索の会話履歴と作業領域、ブラウザ、管理者セッションは渡さない。役割はrecipeの環境不備の修正と反証に限り、再探索はしない。被害者側の操作はHarness所有のLab観測器が型で制限した手順で実行する。
- 既存 handoff: `verify next` は `--handoff <dir>` を必須とし（runner は自動検証しない、#423）、Verifier の transport を skill `wbh-verify` への受け渡しに替え、前提作りのためだけに Lab の設定管理者を渡し、`<dir>/setup-done` 以後に HTTP 捕捉と Lab 状態の基線を取り、攻撃者位置のみで route を実行させる。判定器と event 形は同じ（ADR 0035）。

WordPress profile は Finding の `configurationPrecondition` と Verifier attachment の `precondition` を Harness 所有の決定論的規則で `default` / `common-usage` / `admin-configuration` / `unknown` に分ける。この分類を記録して検証の準備で参照するが、`admin-configuration` という文言分類だけでは park しない。一般利用は対応 scenario ID への有界再検証へ回し、未収録なら `common-usage-scenario-missing` を残して #213 の集計対象にする。規則で決められない前提は `incomplete(precondition)` として review queue に残す。Verifier 自身の分類申告は判定に使わない。管理者の誤設定・明示的な権限付与が Wordfence の明示除外に当たる事実を確認できる場合は段 1 で分け、未確認なら検証で設定と利用形態を確かめる（ADR 0038 の 2026-10-24 追記 8）。

旧規則で `admin-configuration-precondition` に park された Finding は、元の Finding artifact の identity・Snapshot・Programme Boundary を照合し、`finding-recorded` と `finding-park-restored` を追記して検証列へ戻せる。旧 park は残す。検証列、レビュー列、群、funnel と `review parked` は、対応する記録済み Finding に結び付く復帰イベントがある場合だけ旧 park を無効として投影する。Programme Boundary 外の Finding と検証中に park された Finding はこの復帰操作の対象外とする。旧版の runner が新 event を読めるまでは、本番台帳への復帰 event 追記を保留する。
- HTTP証拠: Verifierの宛先はLab内のHarness所有reverse proxyへ向け、request / responseをPrivate EvidenceにJSON Linesで捕捉する。捕捉が無い場合だけVerifierの `http.json` を補助資料として読み、台帳のoptionalな `evidenceCapture` は `harness-captured` / `agent-authored` のenumだけを記録する。2026-10-25 以降、捕捉の無いattemptは `incomplete(evidence)` にする（ADR 0040）。
- Verifierの出力: `http.json`、`steps.md`、`route.json`、別主体のcookieをLabが検査する `session.json`、`refutation.md`、設定前提。payload、cookie、HTTP本文はPrivate Evidenceに置く。
- 判定器は2026-10-25に削除した（ADR 0040）。判定器があった時期の成功条件は ADR 0004・0021・0024 とこの文書の Git 履歴に残り、既存の `runtime-confirmed` / `contradicted` の記録はそれで読む。新しい検証では、Harnessは `setup-done` 以後のHTTP捕捉、Verifierの `http.json`、Lab状態の差分、`route.json` の `victim` が宣言した画面をLab browserが開いた記録（数値dialogと画面）を残し、成立は判定しない。canaryは播種しない。人間が新しいreview Labで種別ごとに確かめる観測は下表のとおりで、名指しした人間が `review observe` の match と `review decide --reproduced match` を記録したときだけ確定の根拠になる（不変条件 3）:

| 種別 | 人間がreview Labで確かめる観測 | 根拠にしない観測 |
| --- | --- | --- |
| RCE / PHPファイル書き込み | 攻撃者が決めたPHPコードがLab内で実行される | シェル取得、`.php.png` や安全な拡張子内のコード |
| SQLi | 攻撃者の読めない行の値が応答に現れる、または攻撃者の書き込めない表への書き込みが起きる。Labは `wp_magic_quotes` 既定のまま | timing差 |
| 任意ファイル読み取り / LFI / RFI | Lab内の攻撃者が決めたファイルの内容が応答に現れる。pathと拡張子の両方を攻撃者が決めたことを記録 | パス文字列の反射 |
| options更新 | 重大なoption（`users_can_register`、`default_role`、`siteurl`、`admin_email` 等）が低権限主体から変わる。2026-10-17 から `finding-parked` で検証に入らない（ADR 0032） | 影響のないoption |
| 管理者への権限昇格 / 認証回避 / アカウント乗っ取り | 低権限主体が管理者の認証状態または管理者相当の能力を得る（各ロールの正常操作記録との差） | パスワードリセットメールの存在だけ、エラーメッセージの差 |
| contributor以上への権限昇格 / 非管理者の認証回避 | 低権限主体がcontributor以上の能力または他主体の認証状態を得る。2026-10-17 から `finding-parked`（ADR 0032） | 同上 |
| Stored XSS | 低権限主体が置いた値が、影響を受けるページ、またはFindingが宣言する被害者ロールで開いた画面（ADR 0021）を開いたときに実行される（Lab browserのdialogの記録と、人間がreview Labで開いた画面）。発火contextとサイト全体への広がりを分けて記録 | 文字列の存在だけ、ブラウザ操作なしの自己申告 |
| 機微な対象の読み取り（`sensitive-object-access`） | 低権限主体の読めない対象の値が、低権限または未認証の主体への応答に現れる。読めた対象の種類を記録し、scope判定は別段階（ADR 0024）。2026-10-17 から `finding-parked`（ADR 0032） | 文字列の反射、件数・応答長・エラーメッセージの差 |

- 結果: `runtime-confirmed` / `contradicted` / `incomplete`。2026-10-25 以降の新しい検証は `incomplete` だけを出し、Harnessの捕捉が残ったattemptは `incomplete(awaiting-human-observation)` として人間の観測を待つ（ADR 0040）。`incomplete` は理由コード（provision、precondition、recipe、observation、evidence、cleanup、digest-mismatch、awaiting-human-observation）と次の手を持つ。再試行は理由ごとに決める: `recipe` は同じLab Setupで最大2回自動再試行（`observation` の自動再試行は判定器とともに止めた）、`precondition` はシナリオIDが変わったときだけ、`provision` は再供給1回、それ以外は人間へ回す。attempt番号と前のverificationIdを台帳に残す（ADR 0022）。
- 判定器を定義できない種別は自動確認せず、`incomplete(no-judge)` として人間へ回す。2026-10-25 以降の新しい検証は `incomplete(no-judge)` を出さない。既存の記録は読み続ける（ADR 0040）。
- **再現パッケージ（Reproduction Package）**: 2026-10-25 以降の新しい検証は再現パッケージを作らない。既存の `runtime-confirmed` の再現パッケージは読み続け、人間の再現は `lab up --for-review` の review Lab で行う（ADR 0040）。以下は既存の記録の説明である。`runtime-confirmed` になった各Findingについて、判定器が通った経路に限定して、人間が自分の手で再現できる資料を生成する。手順は遠隔攻撃者の視点（HTTPリクエストとブラウザ操作）で書き、WP-CLIやサーバー側だけの操作を成立条件に含めない（Patchstackの提出要件）。内容は (1) 手動手順（前提の設定、使うロールとアカウント、送るリクエスト、期待する観測）、(2) 最小スクリプト（Python、標準ライブラリと `requests` だけで動く）、(3) Labの再構築情報（WordPress版、プラグイン版とdigest、有効化した設定、ロール）、(4) 判定器が取った証拠（HTTP記録、画面画像、canary回収ログ）。置き場はPrivate Evidence（Git外）で、`review` から開く。レポートの査読と提出文案の根拠に使う。Verifierの作業ログをそのまま出さない。

## 8. 人間レビューとDisclosure

- レビュー列に出すもの: 対象範囲内の Finding は検証の結果に関係なく全件出す。`incomplete(awaiting-human-observation)` はHarnessの捕捉とLab browserの記録、ほかの `incomplete` は次の手を付ける。判定器があった時期の `runtime-confirmed` は証拠refと再現パッケージ、`contradicted` は判定器の証拠refと、あれば反証を付ける（#185、ADR 0031、ADR 0040）。人間は `lab up --for-review` の新しいreview Labで自分の手で再現し、`review observe` と `review decide --reproduced` で記録してから文案を査読する。
- 並べ方: 同じ Snapshot で plugin 側の `file:function` が 1 つでも重なる Finding は、受理時に同じ群にする（連結成分）。`review` と `verify next` は群の代表（受理順で最初の Finding）を先に出し、残りはその後に群ごとに並べる。捨てない。群は順序と表示だけに使い、判定・判断・提出は Finding ごとに行う（#424）。
- 人間が決めること: review Lab（既存の `runtime-confirmed` は再現パッケージ）を使って自分の手でLab上の攻撃を再現し、影響が意味を持つか、意図された動作ではないか、重複でないか、どのprogrammeへ出すか、文案と外部行動を承認する。Labの再構築とプラグイン設定はHarnessが保存したsetup manifestから自動化する。
- 重複: 検証後・提出前にWordfence Intelligence mirrorの更新と照合を試み、PatchstackとWPScanの公開記録も照合する。照合元と時刻を記録し、staleまたは不明を「重複なし」にしない。候補の同一性は人間が最終判断する。
- 文案: Harnessは、人間が観測と再現を記録した結果のHTTP捕捉・Lab browserの記録・必要な画面証拠（既存の `runtime-confirmed` では判定器の証拠）に基づき、短い英語レポートとWordfence入力用JSONを作る。新しい証拠を文章で創作しない。提出は人間だけが行う。
- 記録: 判断、理由コード、判断までの時間、開いた証拠。覆し率は監視信号。
- 提出転帰（triaged / resolved / duplicate / informative / N/A / rejected）を台帳へ戻し、選定方針と検証の改善材料にする。自分の未公開の発見は公開されるまで探索へ戻さない（公開後はADR 0012の履歴として扱う）。

当面の提出準備完了条件は、公開中の最新版の同一Snapshotと通常利用構成で人間の手動再現が `match`、重複照合が解決済み、Wordfenceのscopeが確認済み、証拠に結び付いた英語報告書とFill-Only JSONが人間の最終査読に渡せること。人間の有効な手順で `mismatch` ならその候補は提出へ進めず、環境・手順・観測の不足で再現できない場合は `incomplete` / `defer` として次の手を残す。どちらも観測だけを `runtime-confirmed` や `contradicted` に読み替えない。手動再現の記録と正式な提出basisを結ぶ実装は別途必要である（ADR 0038）。

## 8a. プログラム対象範囲の方針

技術的な真偽（`runtime-confirmed`）とプログラム対象範囲は分ける。対象範囲は原則 `review` で提出先ごとに評価する。Programme Boundary 外の影響分類は第7節の規則で検証前に park する。管理者による機能設定はそれだけで除外せず、明示除外の事実が既に確認できれば段 1 で分け、未確認なら検証後に誤設定・権限付与・通常の利用形態を評価する。方針は [src/profiles/wordpress/policy/programme-scope.md](../src/profiles/wordpress/policy/programme-scope.md) に観測日付きで置き、提出前に公式ページで再確認する。

2026-10-08時点の方針（Wordfence公式ページの写しとPatchstack 2026年版ガイドライン、判断者の指示）:

- 攻撃者の権限は未認証とsubscriber / customer相当に限る。Wordfenceは contributor / author（中間権限）と administrator / editor / shop manager / `unfiltered_html`（PR:H）を要するものを明示的に対象外にしている。Patchstackはcontributorをx0.75のmVDPのみ、editor以上は不受理。したがってtrust境界宣言ではcontributor以上を信頼する側に置き、探索の攻撃者位置を未認証とsubscriberに限る。
- Wordfenceの分類と閾値（判断者は1337 tier）: High Threat（任意PHP file upload / read / delete、任意options更新、RCE、管理者への認証回避 / 権限昇格）は25件以上、Stored XSS / SQLiは500件以上、その他は500件以上。1,000件未満はWordPress.org掲載が条件、premiumは1,000件未満を除外。
- Wordfenceの対象外資産（WordPress core、Automattic、Facebook、Google、SiteGround、Yoast、配布停止、ベンダー側web service）は `selection` の除外リストに入れる。
- Reflected XSS、CSRF、Missing Authorization、IDORはWordfenceで明示的に対象外。候補としては記録するが、Submission Candidateにしない。ただし同じ欠陥が任意options更新、任意コンテンツ削除、権限昇格、認証回避、機微情報の漏えいに到達する場合は、到達先の種別として対象（2026-10-17 以降、このうち options 更新・コンテンツ削除・管理者未満への昇格と認証回避・機微情報は `finding-parked`。ADR 0032 の 2026-10-17 節）。検証はauthz系も技術的に確かめ、scope評価で到達先を問う。
- Wordfenceの却下条件のうちLabと人間の観測に効くもの: `wp_magic_quotes` 無効前提のSQLi、SVG / 二重拡張子 / 安全な拡張子内のコードによるupload、nonceで守られたactionのmissing authorization、管理者の誤設定前提。Labは既定設定で供給し、file upload系は、攻撃者が決めたコードの実行を人間がreview Labで確かめる。
- Patchstack（報告フォーム2026-06-01改定の写し `src/profiles/wordpress/policy/patchstack-scope-2026-10-08.md`）: 攻撃者は未認証 / subscriber / customerだけ（contributorはmVDPのみ）。受理種別には条件が付く: ファイル系とLFI / RFIはpathと拡張子の完全制御、権限昇格はcontributor以上へ到達、設定変更は重大な影響を持つoption、broken access controlは機微な対象、XSSはサイト全体に効くstoredかJS実行を伴うreflected、CSRFは受理種別の書き込みへ連鎖。1,000件未満はCVSS 8.5以上のみ、100件未満は不受理。
- Reflected XSSとCSRFはPatchstackでは条件付きで受理されるが、この設計では探索の目的にも提出候補にもしない（判断者の指示、2026-10-08）。記録だけ残す。
- 両プログラムとも最新版・既定設定での成立を要する。提出直前に最新版のsnapshotで再検証し、再現パッケージは遠隔攻撃者の視点の手順（HTTPリクエスト、画面画像）で書き、WP-CLIなどサーバー側だけの手順を含めない。
- 公開資料間で矛盾するときは `in-scope` にせず `ambiguous` として人間へ回す。

## 8b. 対象範囲の守らせ方

対象範囲は4か所で、それぞれ違う強さで効かせる。promptだけに頼らない。

| 場所 | 手段 | 強さ |
| --- | --- | --- |
| `selection` | 対象外資産（作者、配布停止、ベンダー側service）を落とす。install下限と上限は[選定方針 JSON](../src/profiles/wordpress/policy/selection.json)を正本とし、プログラムの報奨対象下限は別のscope規則として記録する。公開履歴はローカル mirror の slug 単位の件数と公開日だけを採点に使い、記録の内容は読まず探索にも渡さない。mirror が方針の鮮度を超えて古ければ選定を止める（ADR 0037、ADR 0030 を上書き） | 機械的。方針と除外理由を残す |
| `lab` | discoveryとverifierに渡す認証情報を未認証・subscriber・customer（WooCommerce有効時）に限る。contributor以上と管理者の認証情報は渡さない（例外: 検証skillのhandoffには前提作りのためだけにLabの設定管理者を渡し、`setup-done` 以後は攻撃者位置の資格だけを使う。ADR 0035）。設定は既定のまま、一般的な利用範囲の初期データ（公開フォーム1つ等）はprofileのsetup manifestで入れ、Lab Setup digestに記録する | 機械的。contributor以上の経路は試せない。設定変更もできない |
| `discovery` | Harnessが付けるProgramme Boundaryの節に対象内の影響（下表）を書き（v5以降、目的promptは分類の順位を持たない。ADR 0032 の 2026-10-16 節）、trust境界宣言でcontributor以上と管理者が意図して付与する権限を信頼側に置く（通常のサイトが有効にし得る設定は除外せず前提として書く。ADR 0038 の 2026-10-26 追記 11） | 誘導。agentは他も報告してよいが、台帳で分類される |
| `verification` と `review` | 人間がreview Labで確かめる観測をプログラムの受理条件に合わせる（下表）。scope評価はFindingと検証の観測（2026-10-25 以降は人間の観測と再現の記録、既存の記録では判定器の観測）だけから、方針ファイルの規則で `in-scope` / `out` / `ambiguous` を出す。agentの自己申告は使わない | 機械的。提出候補にならない |

影響の共通分類（両プログラムの受理条件を1つの語彙にしたもの。検証とscope評価が共有する）:

| 分類 | 人間が確かめる観測 | Wordfence | Patchstack |
| --- | --- | --- | --- |
| `rce` / `php-file-write` | 攻撃者が決めたコードがLab内で実行される。SVG、二重拡張子、安全な拡張子内のコードは不可 | High Threat ≥25 | 受理 |
| `arbitrary-file-read` / `delete` / `download` | Lab内の攻撃者が決めたファイルに届く。pathと拡張子の両方を攻撃者が決められたことを記録する | High Threat（PHPファイル）/ その他 ≥500 | 受理（path + 拡張子の完全制御が条件） |
| `lfi` / `rfi` | 同上 | その他 ≥500 | 受理（同上） |
| `sqli` | 攻撃者の読めない行の読み出しまたは書き込み。Labは `wp_magic_quotes` 既定のまま | Common ≥500 | 受理 |
| `options-update` | 重大なoption（`users_can_register`、`default_role`、`siteurl`、`admin_email` 等）が低権限から変わる。2026-10-17 から `finding-parked`（ADR 0032） | High Threat ≥25 | 受理（重大な影響が条件） |
| `privesc-to-admin` / `auth-bypass-to-admin` / `account-takeover` | 低権限主体が管理者の認証状態または管理者相当の能力を得る | High Threat ≥25 | 受理 |
| `privesc-to-contributor+` / `auth-bypass-non-admin` | 低権限主体がcontributor以上の能力または他主体の認証状態を得る。2026-10-17 から `finding-parked`（ADR 0032） | その他 ≥500 | 受理（contributor以上が条件） |
| `sensitive-object-access` | 第7節の観測（ADR 0024）。2026-10-17 から `finding-parked`（ADR 0032） | その他 ≥500（Sensitive Information Disclosure） | 受理（機微な対象が条件） |
| `content-deletion` | 検証しない。2026-10-17 から `finding-parked`（ADR 0032） | その他 ≥500 | broken access controlの条件次第 |
| `stored-xss` | 低権限主体の置いた値が、影響を受けるページで実行される（Lab browserのdialogと、人間がreview Labで開いた画面）。発火contextと範囲を記録 | Common ≥500。特定ページだけでも候補 | 受理（サイト全体に効くことが条件。それ以外はmVDPのみ） |
| `reflected-xss` | 検証しない。探索の目的に含めない。記録のみ | 対象外 | 受理（JS実行、nonce不要が条件）だが出さない |
| `csrf-to-write` | 検証しない。探索の目的に含めない。記録のみ | 対象外 | 受理（連鎖が条件）だが出さない |
| `missing-authz` / `idor`（到達先なし） | 検証しない。到達先がある場合はその分類で確かめる | 対象外 | 機微な対象以外は対象外 |

分類に入らない主張（DoS、open redirect、SSRF、情報列挙等）は `other` として台帳に残し、探索の目的にも提出候補にもしない。

## 9. 台帳

- イベント例: `target-selected`、`selection-batch-bound`（自動選定したcampaignのバッチと対象集合を固定）、`snapshot-frozen`、`lab-provisioned`、`discovery-run-started / finished`、`lead-recorded`、`finding-recorded`、`verification-finished`、`review-decided`、`scope-assessed`、`draft-saved`、`external-action-authorized`、`submission-outcome`。
- 規則: 追記のみ。全イベントにsnapshot digest。判定系イベントはdigest一致時のみ有効。setup失敗はdiscovery試行に数えない。
- funnel view: raw findings → verifier通過 → confirmed / contradicted / incomplete → reviewed → in-scope → submitted → outcome。campaign別・種別別に読み取り専用で導く。
- 添付: Codex `findings.json` 等はPrivate Evidenceにdigest付きで保存し、台帳からは参照だけ。旧Trialの `coverage.json` は参照を読み続ける（ADR 0034）。
- Trialの台帳項目: `trialId`、`trialOrdinal`、`runKind`。再開した segment は同じ `trialId` に `resumesRun` / `resumeSegment` を付け、元 run の `failed` は残す（ADR 0036）。旧Trialの arm、source索引・分担のdigest、`stage` / `continuationOf`、`incomplete(depth)` は既存eventの読取互換として残し、新しい主経路では書かない（ADR 0034）。Leadは欠けた辺・primitive・storage分類と本文のdigestだけを記録する。
- `lab-provisioned.reachability.http`、`verification-finished.evidenceCapture`、`finding-recorded.group`（群の識別子と、群を作る鍵の digest。#424）は追加されたoptional項目。旧eventは引き続き読める。過去の `campaign-stopped.reason = daily-run-cap` も読めるが、新しいcampaignに日次上限の設定・停止はない。

## 10. 評価

TranslatePressの公開済み脆弱版・修正版で縦断経路を実証した記録は [TRANSLATEPRESS-BENCHMARK.md](TRANSLATEPRESS-BENCHMARK.md) に残す。現在の開発評価は単一のWP2Shell協調Trialと、本人発見の公開7件での再発見を扱う（ADR 0029、0027）。主指標は最新版の本番から得る。既知事例の再発見は配線と種別ごとの判定能力の証明であり、未知脆弱性の発見率を示さない。

### 主指標（本番の台帳から、追加費用なし）

- **過去の比較結果**: 旧単独Trialと二段構えの段・継続付きTrialはv8 以降の主経路の分母に混ぜない。旧prompt armと索引あり・なしの結果は履歴として読むが、新規探索ではprompt A/B・ablation・assignment・入口索引切替のmodeを起動しない。隔離と判定器を外すablationも行わない。
- **前向き評価**: 本番Campaignの台帳を、後日公開されたadvisory（自分の提出以外も含む）と照合する。未発見の経路を後から分析できるが、個別の脆弱性の存在を実行時に知ることはできない。
- **提出転帰**: triaged / resolved / duplicate / informative / N/A / rejected の率と、報奨額。収益に直結する最終の数字。
- **提出準備の進捗**: 同じ最新版Snapshotでの人間の再現 `match`、重複・scopeの確認、根拠付き英語報告書とFill-Only JSON、人間の最終査読の準備が揃ったFinding件数を数える。`runtime-confirmed` 件数を提出完了の代理指標にしない。既存のfunnelはこの判断のために変更しない。
- **funnel**: 協調Trialの実行と完了 → 最終JSON到達 → 受理 / 保留 → verifier通過 → confirmed / contradicted / incomplete → reviewed → in-scope → submitted → outcome。campaign別・種別別にTrial wall中央値、usage、失敗理由を読む。旧arm・旧入口索引のexamined率・旧段・継続付きTrialは履歴として別に読めるようにする。非cache入力1M tokenあたりとagent wall 1時間あたりの `runtime-confirmed` と、Findingごとの検証attempt数を同じ表で出す（ADR 0023、0029）。

### 判定器の負の対照（安い。判定器のテストとして回す）

- 修正版pluginで**脆弱版で確認した同一の経路と手順**を流し、判定器が鳴らないことを確認する。修正版にも別経路の脆弱性が残る可能性があるため、plugin全体が安全という意味にはしない。

### 初期ベンチマークと追加評価

- 初期対象はTranslatePress 3.2.6のStored XSSと3.3.1のアカウント乗っ取りを**評価側の公開事例**として扱う。3.2.5のReflected XSSは対象外分類の診断用で、本番開始ゲートに数えない。
- 旧TranslatePress縦断ゲートは3.2.6のRoot＋3を先に1回、必要なら3.3.1を1回とした。新しい開発セットでは対象ごとの単一協調Trialを独立して反復し、探索に触る変更は最低3 Trialの completed、Finding、Lead、wall中央値、usage、失敗理由を記録する。候補0件はsource読取とwallから「読まずに終わった」か「読んで出なかった」かを分け、無条件にTrialを増やさない。具体的Leadは保存するが、Leadだけで判定器のゲートを満たさない。
- 探索時の入力に評価対象のadvisory、原因箇所、PoC、payload、修正差分を混ぜない。評価情報はrunner・判定器側に隔離する。旧#73の単独TrialによるTranslatePress 3.2.5の2×2は候補0件で、協調Trialの優劣や当たり率を示さない。
- 本番探索の開始ゲートは、上記2対象の**少なくとも1件**でsource根拠付きFindingを新しいLabのHarness判定器が `runtime-confirmed` とし、同一経路を修正版で再実行してconfirmedにならず、子の成果と費用・停止理由が欠落なく残ること。これで示せるのは配線と1分類の能力だけで、未知脆弱性の発見率ではない。
- 本人発見の公開7件の再発見では、協調Trialにsource根拠付き候補が出るかと、新Labの判定器でconfirmedかつ修正版の別Snapshotで同じ経路が成立しないかを別指標にする。TranslatePress以外でStored XSS 1件以上とSQLi 1件以上を目標とし、各caseの落ちた段階と理由を台帳と日付付き評価文書に残す。探索のpromptとscenarioに対象固有の関数名、option名、URL、画面名を入れない。評価対象の記録本文、PoC、payload、原因箇所、修正差分を探索へ渡さない（ADR 0027）。
- ゲート通過後は、現行最新版を対象とした少数の本番探索へ進む。対象選定の最小方針・Snapshot固定・隔離が機能していれば、レポートJSONの完全自動化や多数のheld-out事例を待たない。ただし提出候補を人間に渡す条件（最新版での独立確認、重複・scope照合、証拠、手動Lab再現、承認）は第8節のまま守る。
- 複数手法の比較が必要になった時だけ、同じ対象・model・予算でA/Bまたはpass@kを事前登録する。旧 `eval score --keys` とAnswer Keyは2026-10-18に削除した（§4 の `evaluation` 行）。

## 11. ADR（新リポジトリで最初に書くもの）

一覧は 0029 までの当初の記録。現在の効力は各 ADR の front matter（status / amended-by）を正とし、0030〜0037 は [docs/adr/](adr/) を見る。

1. 探索に既知脆弱性の答えを与えない（旧ADR 0003を引き継ぐ）。→ **0012で置き換え**: 評価では時点で切り、本番では対象の公開履歴（カタログ情報）を変種分析の入力として渡す（本番で catalog を渡す経路は 0034 で削除）。
2. 自動の実行時検証を人間レビューの前に置く（旧ADR 0135を置き換える）。
3. 探索エージェントは隔離Lab内で対象を実行してよい。Lab外への到達と外部行動は禁止。
4. `runtime-confirmed` はHarness所有の決定論的判定器だけが出す（2026-10-25 に ADR 0040 で改訂）。
5. 単一の追記専用台帳と、snapshot digestによる判定の有効条件。
6. 対象選定の人間承認を持たず、方針だけを人間が所有する。
7. モデルの記録項目（model、effort、CLI版、カタログdigest、認証、access program、service tier、subagent）。
8. strict TypeScriptのモジュラーモノリスと薄いCLI（旧ADR 0054 / 0055 / 0084を引き継ぐ）。
9. provider認証情報は有界のegress brokerを通す（旧ADR 0142を引き継ぐ）。
10. プログラム対象範囲は技術的検証を止めず、reviewで提出先ごとに評価する。authz / IDORは重大な影響へつながる場合だけ対象。
11. 対象固有のコードはTarget Profileに閉じ込め、汎用モジュールはprofileを型でしか知らない。2つ目のprofileまで汎用化しない。
12. 既知脆弱性は評価では時点で切り、本番では対象の公開履歴を変種分析の入力として渡す（0001を置き換え。catalog の生成は 0034 で削除）。
13. 探索promptの版を保持する（A/B軸の mode は PR #357 で削除）。既定の選択は0017から0025を経て0029が更新する。
14. 旧単独TrialのLead継続は同一Trial内の1 hopに限る。0025のHarness継続も主経路から外し、過去記録を読む。
15. 判定器のHTTP証拠はHarnessが捕捉し、Verifierの記録は補助として扱う。
16. Root＋最大3 subagentで探索から人間の手動再現までの縦断を先に実証する。主経路の入口は0029が更新する。
17. 短い管理promptとWP2Shell式報奨promptを同条件で比較する。
18. 探索候補を出力境界で失わず、受理できない候補は保留として理由付きで保持する。
19. 出力契約はHarnessがschemaから生成し、promptは目的文だけを持つ。
20. 検証Labの前提はprofileの版付き通常機能シナリオにし、Findingの前提と照合する。
21. Stored XSS判定器はFindingが宣言する被害者ロールと画面で発火を観測する。
22. Verifierの `incomplete` は理由ごとの再試行方針で前へ進める。
23. funnelは最終JSON到達と受理から数え、tokenあたりの `runtime-confirmed` で費用を示す。
24. `sensitive-object-access` を優先順位に残し、判定器を持つ（2026-10-17 に `finding-parked` へ。ADR 0032）。
25. 単独screeningから条件付きRoot＋3 deep-diveへ進み、入口網羅の継続境界をHarnessが持つ（旧主経路。0029が置き換え）。
26. 通常利用の汎用Lab scenarioを優先し、被害者のブラウザ操作はHarness観測器に限る。
27. contributor以上を信頼側に置き、公開7件の再発見を配線と判定器の証明として評価する。
28. 人間の作業を読む・手で再現する・提出するに絞り、分類ごとの受理基準と再現の形を固定する（proposed）。
29. 単一のWP2Shell協調Trialを対象ごとに1回、Root＋最大4子・既定wall上限120分で回す。新規Trialの目的promptはv8だけで、最低60分は能動的に探索し、入口索引は渡さない（ADR 0033）。2026-10-25 から、`deep` の目的promptを v10 にし（#522）、下限なし・既定wall 20分の `wide`（v10-wide）を mode として足した（ADR 0039）。同日、`wide` の目的promptを、種別ごとの専門エージェントを固定で置く v11-wide にし、v10-wide を archived にした（ADR 0039 の 2026-10-25 追記）。

## 12. 最初の縦断スライスと受入条件

TranslatePressの公開済み開発対象を脆弱版と修正版で固定し、まず探索から判定器までを通す。開発対象は人間がslugと版を指定してよい。これは配線と判定器の実証であり、未知脆弱性の発見率の主張ではない。

この節はADR 0016に基づく最初の縦断スライスの受入記録である。後続の探索の主経路はADR 0029の単一協調Trialに従う。

1. `snapshot` が対象、WordPress core、必要な依存をdigestで固定し、gVisor Labを供給する。
2. 実機preflightでDaybreak対応model ID、Rootと最大4つの子、broker、Lab到達を確認する。別モデルや単独agentへ自動fallbackしない。
3. 協調Trialがsourceを読み、Findingまたは具体的Leadを出す。子の成果はRootの最終JSONと独立して保存され、schema失敗は正常な0件にならない。
4. Findingが出たら新しいLabの独立VerifierとHarness判定器へ渡す。nonce証拠、HTTP記録、失敗時の `incomplete` 理由を保存する。同じ経路の修正版ではconfirmedが出ない。
5. 上のゲートを満たしたら、最小の選定方針で公開中最新版の少数の本番探索を始める。confirmedなら最新版の同じSnapshotで独立確認し、Wordfenceを含む重複候補とscopeを照合する。最新版で成立しなければ提出候補にしない。
6. 証拠付きの短い英語レポートJSONと再現パッケージを出し、人間がsetup manifestからLabを立てて自分の手で同じHTTP手順を再現する。レポート生成の完全自動化がまだ無い期間は、既存のdraft登録口を使って証拠から文案を作れる。
7. 台帳からFinding、Lead、各agentの実行と使用量、検証結果、レビューの段数を読める。`pnpm check` と [テスト戦略](TEST-STRATEGY.md) の実環境ゲートを通す。

本番探索への受入は、第10節のTranslatePressゲートと隔離・記録・最小選定方針。最初の外部提出への受入は、最新版の独立確認、重複・scope照合、証拠、英語文案、人間の手動再現と版・送信先を指定した承認まで。ベンチマークで確認した旧版の発見自体は提出しない。

## 13. 移植一覧（旧リポジトリ → 新モジュール）

| 旧 | 新 | 備考 |
| --- | --- | --- |
| `src/target-intelligence/acquisition`、`wordpress-org`、`wordfence-intelligence`、`programme`、各test | `selection`、`snapshot` | Approved Target Batch、Target Proposal、Research Historyは持ち込まない |
| `src/infrastructure/canonical-json.ts`、`canonical-source-tree.ts`、`immutable-file.ts`、`private-artifact-store.ts`、`native-model-process.ts`、各test | `snapshot`、共通基盤 | そのまま |
| `src/infrastructure/agent-runtime-profile.ts`、`src/research/agent-led/codex-native-agent-runtime.ts`、`native-run-receipts.ts`、egress broker、各test | `discovery` | 記録項目をADR 7に合わせて拡張。他providerのadapterは持ち込まない |
| `src/human-os` のgVisor Lab供給、Execution Canary、scope評価、Submission Draft、External Action Authorization、各test | `lab`、`verification`、`review` | Candidate Verification RequestとHuman Candidate Reviewは持ち込まない |
| `skills/wordpress-target-selection`、`wordpress-human-verification` | `selection` の方針、`review` の手順 | 内容を方針ファイルと手順へ置き換える |

## 14. 未確認事項（最初のスライスの前にspikeで確かめる）

2026-10-08の#6 spike実測（[結果と再現手順](../spike/results-2026-10-08.md)）:

- 探索コンテナからLabへのinternal network到達: **条件付きでできた**。network aliasのDNSは `EAI_AGAIN`、Labの内部IPを `--add-host` で渡すとHTTP応答を750 ms（再試行1,269 ms）で回収。
- gVisor Lab内のheadless browser: **できた**。Playwright Chromiumで同じLab応答を1,438 ms（再試行1,189 ms）で回収。
- Codex CLIの追加sandbox: **できない**。0.162.0-alpha.2の `codex sandbox` はgVisor内でbubblewrapのloopback設定に失敗（exit 1）。CLI sandboxを無効にしたローカルprobeはexit 0。provider接続を伴うrunは未確認で、#7前に人間の方式選択が必要。

- 探索agentのコンテナからLabへ、コンテナソケットを渡さずにネットワーク到達できるか（runごとのinternal network）。
- gVisor Lab内でheadless browserが動くか（XSS判定器）。
- 費用の経路はChatGPT Proのサブスクリプション（Codex CLI認証、月額固定）。Harnessは金額や日付で区切る上限を持たず、購読の使用量（rate limit / quota）を観測する。上限応答を受けたらcampaignを安全に止めて再開可能にし、providerが返すusageを台帳に記録する。APIキーへの切り替えは購読で足りなくなった時点で判断する。
- Sol 1 runあたりの費用と時間（分担file数とwall timeの初期値を決める）。
- Codex CLIをgVisor内で動かす際のCLI自身のsandbox（Bubblewrap）の扱い。→ 決定（2026-10-08、判断者）: CLIの内側sandboxは無効にし（`--sandbox danger-full-access`）、外側のrunsc、読み取り専用source mount、read-only rootfs、capability除去、internal network、brokerによる外向き制限を必須にする。これらの強制は実運用前にテストする。

## 15. 用語

| 用語 | 意味 |
| --- | --- |
| Target Snapshot | plugin sourceをmanifest digestで固定した読み取り専用の対象 |
| Lab | 使い捨てのgVisor環境で動くWordPress + MySQL。ロール別アカウント、HTTP捕捉のrecorder、Lab browserを持つ |
| Trial | 独立試行の単位。主経路では対象ごとにRoot＋子（上限は `discovery.maxChildren`、既定 4）の協調Trialを1回行う。旧単独・二段構えTrialも台帳では区別して読む |
| Discovery Run | モデル実行の記録単位。Rootと子の実行をTrialの中で区別する |
| Finding | Discovery Runが出した、攻撃者前提・property・traceを持つ主張。確認ではない |
| Lead | sourceに根拠があるが、影響までの辺が1つ不足するprimitive。Findingでも確認結果でもない |
| Verifier | 新しいコンテナで反証を試みる独立エージェント。再探索はしない |
| 判定器 | 2026-10-25 に削除したHarness所有の決定論的な確認手段（ADR 0040）。既存の `runtime-confirmed` はこれで出た。新しい確定は人間の `review observe` の match と `review decide --reproduced match` で行う |
| Verified Vulnerability | `runtime-confirmed` からだけ作る技術的記録。programme scopeと独立 |
| Trust境界宣言 | 人間が書く「何を信頼するか」の宣言。既知脆弱性を含まない |
| 公開履歴（history） | 対象プラグインの公開advisoryのカタログ情報。旧Trialでは時点で切って探索に渡した。生成は ADR 0034 で削除し、台帳の記録を読むだけ。PoCは含まない |
| historyCutoff | 旧Trialで探索runに渡した履歴の時点（本番はsnapshotの版、評価はheld-outの公開日）。台帳の読取のみ（ADR 0034） |
| Answer Key | 評価側だけが持つheld-out caseの正解。探索へ渡さない |
