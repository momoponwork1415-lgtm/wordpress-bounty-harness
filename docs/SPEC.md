# WordPressバグバウンティHarness 仕様書

版: v0.23、2026-11-01。設計判断はこの文書と [ADR](adr/) に置き、食い違えば番号の新しい ADR が勝つ。いまの動きを段ごとに追う説明は [SYSTEM.md](SYSTEM.md)、開発と運用の規則は [DEVELOPMENT.md](DEVELOPMENT.md)、用語は [GLOSSARY.md](../GLOSSARY.md) にある。2026-10 の立ち上げ期の節（当初の ADR 一覧、縦断スライス、移植一覧、spike）は 2026-11-01 に削り、tag `archive/pre-docs-rewrite-2026-11-01` と Git 履歴に残る。

## 1. 目的と指標

- 目的: WordPress プラグインの未知の脆弱性を AI が固定ソースから探し、公開中の最新版の通常利用構成で人間が Lab で観測し、重複と対象範囲と根拠付き報告書を確かめたものを人間が提出して報奨を得る。提出先は Wordfence を主とし、Patchstack は報告が増えてから扱う（ADR 0038）。
- 収益の式: 月に回せる対象数 × 当たり率 × 対象範囲内の率 × 平均報奨 − 月費用。
- 分母は 1 つ: Codex 1 時間あたりの Lab 発火数と、Wordfence の結果（受理、重複、対象外）で設計を比べる（ADR 0045）。Finding の数は文面で動くので採否の根拠にしない。計測の手順は [docs/agents/measurement.md](agents/measurement.md)。
- 設計の優先順位: 公開されている設計と結果規則をまず当て、WordPress 固有で避けられない部分だけを自作する。探索と検証の中身はプロンプトとスキルが持ち、Harness は制御だけを持つ（[AGENTS.md](../AGENTS.md) の責務）。

## 2. 不変条件

1. 探索エージェントへ渡すのは、固定source、人間が書いたtrust境界宣言、Programme Boundary、任意のLab、そして時点で切った対象の公開履歴（カタログ情報のみ）だけ。評価対象の答え（held-outのadvisory本文、原因箇所、PoC）と、評価runではheld-outの公開日以降の記録は渡さない。PoC、payload、他人の再現手順は本番でも渡さない（[ADR 0012](adr/0012-time-cut-known-vulnerability-history.md)）。例外として、campaign設定で名指ししたときに限り、同じTarget Snapshotに対する自分たちの過去Trialの Lead（群の代表）を、Harnessが生成する `## Prior leads` 節で渡してよい。節に入れるのは、固定sourceのfileと関数の名前と、そのLeadが書いた「示せなかったこと」の一文だけである。`labObservations`、storageのkey、payload、URL、HTTPの要求、公開記録の答え（advisory本文、原因箇所、修正差分）、PoCは渡さない。評価runでは、held-outの公開日以降に始まったTrialのLeadを渡さない（2026-10-31 追記、[ADR 0044](adr/0044-prior-leads-input.md)）。もう1つの例外として、campaign設定の `discovery.priorResearch` が `same-target` のときに限り、同じ対象の別のSnapshotに対する自分たちの最新の過去Trialが封じた研究fileのうち `recon-map.md` と `lab-setup.md` を、Harnessが生成する `## Prior research` 節で `/workspace/research/prior/` に置いて渡してよい。route file、tools の一覧、Finding と Lead は渡さない。渡せるのは不変条件1の範囲にあったTrialのfileだけである（2026-11-01 追記、[ADR 0048](adr/0048-prior-research-input.md)）。
2. 探索・検証はgVisor（`runsc`）の使い捨て環境でのみ対象を実行する。ホストで対象コードを実行しない。弱い隔離へ暗黙に切り替えない。外向き通信は認証ブローカー経由のprovider APIだけ。2026-10-26 に所有者が承認し、翌日に終了した一回限りの外部サービス接続実験は [ADR 0041](adr/0041-one-time-external-service-lab-connection.md) に記録する。この承認は本番ランナーや次の Lab に適用しない。2026-11-01 以降、外部サービス接続が通常の利用の前提になる検証に限り、[ADR 0046](adr/0046-external-service-lab-connection-as-normal-operation.md) の 6 条件を満たす専用 Lab の外向き通信と一時公開は、案件ごとの承認なしに行える。出口の中継器、`setup-done` 直後の停止と確認、記録は Harness が `--egress-plan` で持つ（ADR 0046 追記 1）。公開入口と資格情報は Harness の外にある。
3. Harnessは判定器を持たない。確定の根拠は、名指しした人間が、記録後も残した検証Labか新しいreview Labで記録した `review observe` のmatchと `review decide --reproduced match` だけである（観測の場所は [ADR 0038 追記 12](adr/0038-verification-phases-and-submission-flow.md)）。エージェントやrecipeの自己申告、捕捉を読んだだけの推定、AIが自分でLabを見て打った `review observe` / `--reproduced` は根拠にしない。所有者が会話の中で観測の結果を明言し、自分の画面画像を示したときに限り、AI操作役が所有者の名前で `review observe`（`--evidence` はその画像）と `review decide --reproduced` を代行記録できる。所有者の発言の原文、時刻、会話の識別子、画像のdigestはPrivate Evidenceのattestationに残す（2026-10-31 改訂、[ADR 0040 追記 3](adr/0040-human-lab-observation-replaces-judges.md)）。リバースシェル・永続化・ホストアクセスを使わず、証明にもしない。新しい検証は `runtime-confirmed` を出さず、既存の `runtime-confirmed` は判定器があった時期の記録として読み続ける（2026-10-25 改訂、2026-10-26 に根拠を明記、[ADR 0040](adr/0040-human-lab-observation-replaces-judges.md)）。
4. 検証の失敗（環境・手順・観測・証拠の不足）は `incomplete` であり、`contradicted` にも棄却にもしない。
5. 判定は、Findingと検証結果が同じTarget Snapshot digestを持つときだけ行う。digest不一致は `incomplete`。最新版への再検証では新しいSnapshotに結び付けたFindingを別に記録し、旧Findingへの由来だけを参照する。
6. 人間の判断点は「提出前のレビュー」と「外部行動の承認」の2つ。対象選定の承認、未検証候補の採否はない。権限・対象範囲の拡張は人間の明示承認を要する。
7. 外部送信（報告、ベンダー連絡、公開）は、正確なSubmission Candidate・文案の版・送信先へ結び付いた承認なしに行わない。Harnessは送信を実行しない。
8. 台帳は追記専用。payload、HTTP記録、画面画像、実行ログ、認証情報、未公開の発見はGit外のPrivate Evidenceに置き、台帳はdigest参照だけを持つ。

不変条件 1〜8 は ADR 0045 で凍結した 5 つの最初の項である。ほかの 4 つ（Harness は制御だけ、確定は人間の Lab 観測だけ、探索プロンプトの文面、設計変更は月 1 回）は [ADR 0045](adr/0045-frozen-core-and-three-exploration-forces.md) にある。

## 3. 流れ

対象は 6 つの段を通る。各段の持ち分と設定の鍵と台帳の event は [SYSTEM.md](SYSTEM.md) にある。

1. 選定: WordPress.org の人気順一覧から、方針 file の数値（下限、鮮度、除外）で適格な候補を並べ、帯と公開日の順に 1 batch 10 件を束ねる。同版は 1 回。方法を変えた再開では `countTrialsFrom` より前の Trial を探索済みに数えない（ADR 0037）。
2. Snapshot: plugin、WordPress 本体（最新安定版、ADR 0047）、PHP ソース、依存 plugin を版と digest で固定する（ADR 0033）。
3. 探索: 対象ごとに 1 回、gVisor の使い捨て sandbox で Codex の Root と子が協調する Trial を回す。Harness は目的文、生成節、固定ソース、スキルを渡し、制限時間と子の数と出力の保存だけを受け持つ（第 6 節、ADR 0029、0039）。
4. 出口: Finding と Lead を契約で正規化して受理するか保留し、Programme Boundary 外の impact は park する。Lead は一覧で人間が見る（ADR 0018、0019、0032）。
5. 検証: 対象範囲内の Finding は全件がレビュー列に出る。AI の 6 段のスキルが Lab で前提を作り route を実行し、人間が review Lab で観測する。確定の根拠は人間の観測だけで、判定器は無い（第 7 節、ADR 0038、0040）。
6. 提出: AI が報告書と form JSON を作り、人間が送る。submitted と outcome を台帳に記録する。転帰は `wbh-screen` の規則と Lab の基線へ戻し、選定と探索には戻さない（第 8 節、ADR 0045）。

## 4. モジュール境界

strict TypeScriptのモジュラーモノリス。各モジュールは公開インターフェースと所有する記録だけを外へ出す。

| モジュール | 目的 | 公開インターフェース | 所有する記録 | 失敗時 | 出自 |
| --- | --- | --- | --- | --- | --- |
| `selection` | 方針に従って対象を機械的に選び、予算内で順序付ける | `select(policy) → TargetSelection[]`、`inspect` | 選定方針（人間が編集）、WordPress.org の観測、台帳の過去選定、選定記録と初回・版上昇の理由 | WordPress.org / Programme観測の unavailable / stale をeligibleにしない | 開発対象はslugと版を直接指定可。インストール数と更新日で並べ、同版は 1 Trial、新版なら戻す（ADR 0037 の 2026-10-28 追記） |
| `snapshot` | 対象plugin、WordPress本体、PHP、必要な依存pluginのsourceをdigestで固定する | `freeze(selection) → Snapshot`、`verify(digest)` | Target / Dependency Snapshot、canonical manifest | archiveの不正path・symlink・size超過を拒否し、必要な依存の欠落を黙って省略しない | 移植: `canonical-source-tree`、`canonical-json`、`immutable-file`、`private-artifact-store` |
| `lab` | WordPress + MySQLの使い捨てgVisor環境を供給し、ロール別アカウントと、HTTP捕捉のrecorder・Lab browserを付ける。検証Labと、人間が観測する新しいreview Labの両方を立てる | `provision(snapshot, setup) → LabHandle`、`teardown` | Lab Setup digest、ロール認証情報（Lab内のみ） | source / image / runsc不一致では起動しない。provision失敗は `incomplete` 用の理由コード | 移植: `human-os` のgVisor候補検証Lab。拡張: ロール基準の正常操作記録。canaryの播種は2026-10-25に削除した（ADR 0040）。旧discovery用Labは退役し、過去の記録だけを読む |
| `discovery` | 固定Snapshotで対象ごとにRoot＋子（上限は `discovery.maxChildren`、既定 4、上限 8）の協調Trialを1回回す | `run(campaignInput) → DiscoveryRun`、`campaign(stopRule)` | Trial id、Root / 子の実行記録、model profile digest、prompt digest、usage、FindingとLeadのdigest参照 | provider / schema / sandbox失敗はtyped receiptとして残し、有効な個別成果を失わない。provider上限はcampaignを止め、runnerがbackoff後に同じcampaign IDで再開する（`runtimeShare` で両 runtime に分けた探索Labなしのcampaignでは、上限に当たった runtime の対象だけを止める。ADR 0032 の 2026-10-20 追記 3）。対象単位の失敗は `target-skipped` で次の対象へ進む | ADR 0029。旧単独Trialと二段構えの記録は読み続ける |
| `verification` | 検証skillの出力を保存し、Harnessが捕捉したHTTP、Lab状態の差分、Lab browserの記録を残す。成立は判定しない（ADR 0040） | `verify(finding, snapshot, lab) → VerificationResult` | Verifier run記録、Harnessの証拠（HTTP捕捉、Lab状態の差分、Lab browserの記録）、Lab Setup digest | 前提不一致・observation失敗・cleanup失敗は `incomplete`。捕捉が残ったattemptは `incomplete(awaiting-human-observation)` | 新規 |
| `ledger` | 全イベントを追記し、funnelを読み取り専用で導く | `append(event)`、`read(query)`、`funnel(campaign)` | LedgerEvent（型付きunion、snapshot digest付き）、添付（Codex findings等）のdigest参照 | 同一identityへの異なる内容はconflict。削除しない | 新規。規則はADR 0024とMantisから |
| `review` | 人間が検証済みFindingを見て提出判断をする。scope、重複、文案、承認 | `queue() → ReviewItem[]`、`decide`、`assessScope`、`draft`、`authorize` | ReviewDecision、Programme Scope Assessment、Submission Candidate、Submission Draft（版付き）、External Action Authorization | scope評価失敗はscopeだけ `incomplete`、Verified Vulnerabilityを失わない。必要な承認がなければadmitしない | 移植: `human-os` のscope評価・Draft・Authorization。新規: review CLI、ローカルWordfence履歴DB照合 |
| `cli` | 上記を薄く接続する | コマンド | なし | | 移植: `cli.ts` の構成だけ |

## 4a. Target Profile（対象固有部分の置き場）

将来の別言語・別プラットフォームへの使い回しのため、WordPress固有のものは `profiles/wordpress/` に閉じ込める（[ADR 0011](adr/0011-target-specific-code-lives-in-a-profile.md)）。

| profileが提供するもの | WordPress版の中身 |
| --- | --- |
| source取得 | WordPress.orgからの対象・依存pluginの取得と検査、固定実行imageからのWordPress本体・PHP sourceの取得 |
| Lab provisioner | gVisor内のWordPress + MySQL、ロール別アカウント、HTTP捕捉のrecorder、Lab browser |
| Lab観測器 | 第7節のHTTP捕捉、Lab状態の差分、被害者画面の記録。成立は判定しない（判定器集合は2026-10-25に削除、ADR 0040） |
| scope方針 | `src/profiles/wordpress/policy/programme-scope.md`（Wordfence / Patchstack） |
| prompt雛形 | 新規探索の目的文は campaign 設定の `discovery.mode` で決まり、`deep` は `wp2shell-bounty-v11`、`wide` は `wp2shell-bounty-v21-wide` だけを実行できる（ADR 0039 の 2026-11-01 追記 19）。探索スキル `wbh-recon` v2、`wbh-tools` v1、`wbh-setup` v1 を sandbox に置き、目的文の 1 段落がその場所を示す。旧版の目的文は過去 Trial の digest と構成の照合のために残し、新規 Trial では起動しない。trust 境界宣言の雛形も持つ（ADR 0019、0029、0033、0039） |
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
| `Lead v1` | discovery → ledger | primitive、storage分類、欠けた辺、source trace。本文はPrivate Evidence、台帳はdigestとenumだけ |
| `VerificationResult v1` | verification → ledger / review | `incomplete` と理由コード（provision、precondition、recipe、observation、evidence、cleanup、digest-mismatch、awaiting-human-observation）、Harness の捕捉（HTTP、Lab 状態の差分、Lab browser の記録）の証拠 ref、Lab Setup digest、`evidenceCapture` enum。判定器があった時期の `runtime-confirmed` / `contradicted` は既存 event として読む（ADR 0040） |
| `ReviewDecision v1` | review → ledger | 採否、理由コード、重複照合の結果、判断時刻、開いた証拠の一覧 |
| `SubmissionCandidate v1` | review → review（承認） | Verified Vulnerability ref、programme、scope判定、Draft revision digest、送信先 |
| `LedgerEvent v1` | 全モジュール → ledger | 型付きunion。全イベントがsnapshot digestとcampaign idを持つ |

別モジュールの保存先や内部型を直接参照しない。Private Evidenceはcontent-addressedで、台帳にはdigestと種別だけを置く。

## 6. Discovery runの仕様

- 攻撃者位置: 未認証と subscriber（customer 相当）だけ。contributor 以上は trust 境界の内側として宣言する（第 8a 節）。
- 入力: 固定ソース（読み取り専用）、人間が書いた trust 境界宣言、Programme Boundary、目的文、Harness が生成する節（`## Run parameters`、Finding / Lead の出力契約 v4、スキルの場所、`discovery.priorResearch: same-target` のときの `## Prior research`）。評価対象の答え、PoC、公開履歴の中身、入口索引は渡さない（不変条件 1、ADR 0012、0034）。
- 目的文: `discovery.mode` が `deep` なら `wp2shell-bounty-v11`、`wide` なら `wp2shell-bounty-v21-wide` に限る（ADR 0039）。本文を変えたら版を上げ、旧版と digest を残す。文面は ADR 0045 で凍結し、消すだけを許す。探索スキル `wbh-recon` v2、`wbh-tools` v1、`wbh-setup` v1 は sandbox に置き、どこを読み何を仮説にするかは Root が決める。
- 構成: 対象ごとに Root と子の協調 Trial を 1 回。同時に生きる子の上限は `discovery.maxChildren`（既定 4、1〜8）で Harness が強制し、何体使うかは Root が決める。子の有効な Finding と Lead は Root の最終報告と独立に保存する。Claude runtime は `runtimeShare` で分けられるが、本番の share は 0 である。
- 許可する操作: 固定ソースの読み取り、Lab があればそこへの HTTP。外向き通信は認証ブローカー経由の provider API だけ（不変条件 2）。`discovery.lab: attached`（既定、ADR 0049）では Trial ごとに探索 Lab を 1 台立て、制御口は `reset` / `observe` と、保存先の観測器 `find`（植えた印の table / column / file）と `sql`（読み取り専用ユーザーで SELECT 1 文、200 行まで）を受ける。`find` と `sql` は 1 つの予算 `discovery.lab.maxLookups`（既定 60）を共有する。Harness は捕捉と状態の差分と要求・答えを封じて回数を数えるだけで、答えを読まず判定しない（ADR 0003 の 2026-10-25 追記と 2026-11-02 追記）。Lab を付けないのは `none` を名指ししたときだけである。
- 停止規則: 制限時間の上限は 120 分（`runWallTimeMinutes`）。どちらの mode にも既定の最低時間は無く（`discovery.minimumActiveMinutes` の既定 0、ADR 0039 追記 20）、終了は探索スキルの手順（`wbh-recon` 手順 9）が判断して、最初の最終報告で終える。`minimumActiveMinutes` を 1 以上にした `deep` の Trial だけ、早い最終報告を同じセッションで続ける。値は目的文に書かず `## Run parameters` で伝える。継続不能、制限時間、provider、broker、スキーマの失敗は理由付きの `incomplete` で、候補 0 件には数えない（ADR 0033、0039）。
- 再開: 止まった Root（`completed` 以外）は同じ Snapshot、同じ再開段落、残りの制限時間で新しい sandbox に再開できる。Codex の `provider-limited` は backoff 後に再開区間 5 まで自動で、死んだ持ち主の `interrupted` は再起動したランナーが自動で、それ以外は `campaign resume --run` で名指しして再開する。言い換えはしない（ADR 0036）。
- 出力: `Finding[]` と `Lead[]`（どちらも 0 件可）。候補は出力境界で棄却せず、正規化して受理するか理由付きで保留する（ADR 0018）。スキーマ失敗は 0 件の正常完了にしない。Lead はソースに根拠があり影響までの辺が 1 つ足りない primitive で、検証列には入らないが `review leads` で人間が全件を見る。
- 出口の park: impact が Programme Boundary 外の 5 種（`other`、`csrf-to-write`、`missing-authz`、`idor`、`reflected-xss`）と所有者が外した 5 種（`sensitive-object-access`、`content-deletion`、`options-update`、`privesc-to-contributor+`、`auth-bypass-non-admin`）は `finding-parked` として残し、検証列と funnel の raw に入れない。文言からは判定しない。`review restore` で戻せる（ADR 0032、0038 追記 13）。
- 第 2 Trial（ADR 0044）: `discovery.priorLeads` で Snapshot と Lead の代表を名指ししたときだけ、同じ Snapshot に入力違いの Trial を 1 回行う。自動の追加 Trial でも pass@k でもない。
- 以前の調査（ADR 0048）: `discovery.priorResearch: same-target` のとき、同じ plugin の別の版の最新 Trial が封じた `recon-map.md` と `lab-setup.md` を `/workspace/research/prior/` に置く。tsv と route file は渡さない。
- 同時実行: `resources.maxConcurrentTargets`（1〜10）と runtime 別の上限、`memoryBudgetMiB` で Harness が決める。live の上書きは `continuous concurrency`。provider の上限は backoff して同じ campaign で再開する。
- 記録する項目（run ごと）: trialId / trialOrdinal、Root と子の役割、要求 model ID と effort、CLI の版と同梱カタログの digest、認証方式、各 agent の usage（provider が返さない項目は `unavailable`）、読んだ file と command の件数の下限、prompt と source の digest、wall と停止理由。診断 artifact は Private Evidence に置く。
- 本番 model: Daybreak Blue 対応の `gpt-6-sol` 系。暗黙に別 model へ切り替えない。

## 7. Verificationの仕様

検証の中身はスキルが持ち、Harness は Lab の供給と観測器と記録だけを持つ（ADR 0035、0040）。判定器と canary は 2026-10-25 に削除した。既存の `runtime-confirmed` / `contradicted` は判定器があった時期の記録として読む。

- 入口: 対象範囲内の Finding は検証の結果に関係なく全件がレビュー列に出る（ADR 0031）。AI は 6 段のスキルで進める。段 1 `wbh-screen`（公式規則で明白に外れるものだけ分ける）、段 1b `wbh-source-check`（固定ソースだけで成立 / 不成立 / 未決）、段 2 群（同じ Snapshot で plugin 側の `file:function` が重なる Finding は同じ群。順序と表示だけに使い、判断は Finding ごと）、Lab の前の `wbh-dedupe`（possible-match なら Lab を立てない）、段 3 `wbh-verify`、段 4 `wbh-dedupe`、段 5 `wbh-destination`、段 6 `wbh-report`。中間判断は `review decide --by ai` で記録する（ADR 0038）。
- Lab: `verify next --config <path> --handoff <dir>` が Finding 単位に使い捨ての gVisor Lab（WordPress + MySQL）を立てる。host ごとに 1 台で、基線は `hosting-default-v3`（Wordfence が受理する入口は攻撃面として残し、制限しない）。前提作りのためだけに Lab の設定管理者をスキルへ渡し、`<dir>/setup-done` 以後は HTTP 捕捉と Lab 状態の基線を取り、攻撃者位置の資格だけで route を実行させる。Harness は通常機能のシナリオもプラグイン別のアダプタも持たない（ADR 0026、0035）。
- 外部サービス: 外部サービスに繋がる Lab は `--egress-plan <path>` で宛先ごとの中継器を置き、`setup-done` 直後に消して Lab から届かないことを確かめ、receipt と台帳に残す。公開入口の開閉と API キーの入力は Harness の外で人間が行う。6 条件が揃えば通常運用で、件ごとの承認は要らない（ADR 0046）。
- Harness の証拠: `setup-done` 以後の HTTP 捕捉（Lab 内の reverse proxy、JSON Lines）、Lab 状態の差分、Lab browser の記録。捕捉が無い attempt は `incomplete(evidence)`、捕捉が残った attempt は `incomplete(awaiting-human-observation)` として人間の観測を待つ。
- スキルの出力: `http.json`、`steps.md`（先頭に前提の部）、`route.json`、`session.json`、`refutation.md`、設定前提。payload、cookie、HTTP 本文は Private Evidence に置く。
- 確定: 名指しした人間が review Lab で記録した `review observe` の match と `review decide --reproduced match` だけが根拠である（不変条件 3）。人間はコマンドを打たず、会話で見たことを述べ、AI が `--by <人間>` で記録する（2026-10-31 の所有者決定、ADR 0040）。AI が自分で打った観測は根拠にしない。
- 失敗: 環境、手順、観測、証拠の不足は `incomplete` と理由コードで記録し、`contradicted` にも棄却にもしない（不変条件 4）。Finding と検証の Snapshot digest が違えば `incomplete(digest-mismatch)`（不変条件 5）。
- 旧 Codex Verifier の経路と、文言から前提を分類して park する規則は退役した。旧規則で park された Finding は `finding-park-restored` で検証列へ戻せる。

人間が review Lab で確かめる観測の形（種別ごと）:

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

## 8. 人間レビューとDisclosure

- レビュー列に出すもの: 対象範囲内の Finding 全件。`incomplete(awaiting-human-observation)` には Harness の捕捉と Lab browser の記録を、ほかの `incomplete` には次の手を付ける。同じ対象の別の Snapshot で同じ経路を見ていれば `seen before` を表示する（ADR 0038 追記 17）。判定はしない。
- 人間が決めること: review Lab で自分の目で観測し、再現したか、影響が意味を持つか、意図された動作でないか、重複でないか、どの programme へ出すかを述べる。文案と外部行動を承認する。記録は AI が代行する。
- 重複: Lab の前と提出前の 2 回、Wordfence Intelligence mirror、Patchstack、WPScan の公開記録と slug と版で照合する（`wbh-dedupe`）。照合元と時刻を記録し、stale や不明を「重複なし」にしない。
- 提出先: `wbh-destination` が Wordfence → Patchstack → 個別 vendor の順に調べ、自前の bounty を持つ vendor の plugin は Wordfence の対象外として除く。
- 文案: `wbh-report` が人間の観測と Harness の捕捉に基づいて短い英語報告書と Wordfence 入力用 JSON を Private Evidence に作る。新しい証拠を文章で創作しない。送信は人間だけが自分のブラウザと拡張機能で行い、Harness は送らない（不変条件 7）。
- 記録: 中間判断は `review decide --by ai`、承認は `review authorize`、送信は人間の言葉を受けて `review submitted`、転帰はメール本文を受けて `review outcome`（triaged / resolved / duplicate / informative / not-applicable / rejected）。転帰は `wbh-screen` の規則と Lab の基線に戻し、選定と探索には戻さない。自分の未公開の発見は公開されるまで探索へ戻さない。
- 提出の条件: 公開中の最新版の同じ Snapshot と通常利用構成で人間の観測が `match`、重複照合が解決済み、対象範囲が確認済み、証拠に結び付いた英語報告書と form JSON が揃うこと。人間の有効な手順で `mismatch` なら提出へ進めず、環境や手順の不足は `incomplete` として残す。

## 8a. プログラム対象範囲の方針

技術的な成立（人間の観測の `match`）とプログラム対象範囲は分ける。対象範囲は原則 `review` で提出先ごとに評価する。Programme Boundary 外の影響分類は第7節の規則で検証前に park する。管理者による機能設定はそれだけで除外せず、明示除外の事実が既に確認できれば段 1 で分け、未確認なら検証後に誤設定・権限付与・通常の利用形態を評価する。方針は [src/profiles/wordpress/policy/programme-scope.md](../src/profiles/wordpress/policy/programme-scope.md) に観測日付きで置き、提出前に公式ページで再確認する。

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
| `selection` | 対象外資産（作者、配布停止、ベンダー側service）を落とす。install下限は[選定方針 JSON](../src/profiles/wordpress/policy/selection.json)を正本とし、プログラムの報奨対象下限は別のscope規則として記録する。選定は mirror を開かず、インストール数と更新日で並べる。新版なら待たずに戻し、未提出 Finding と旧世代の履歴では除外しない（ADR 0037 の 2026-10-28 追記） | 機械的。方針と除外理由を残す |
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

- イベント例: `selection-batch-bound`、`selection-batch-discarded`、`target-selected`、`target-skipped`、`snapshot-frozen`、`discovery-run-started / finished`、`thread-resume`、`candidate-normalized / held / rejected`、`finding-recorded`、`finding-parked`、`finding-park-restored`、`lead-recorded`、`discovery-concluded`、`lab-provisioned`、`verification-lab-failed`、`verification-finished`、`manual-observation-lab-ready`、`manual-observation-recorded`、`human-reproduction-recorded`、`review-item-opened`、`review-decided`、`scope-assessed`、`draft-saved`、`external-action-authorized`、`submission-recorded`、`submission-recorded-externally`、`submission-outcome-recorded`。型は `src/ledger/` の union が正本。
- 規則: 追記のみ。全イベントに snapshot digest。観測と判断の event は digest 一致時だけ有効。setup 失敗は discovery の試行に数えない。
- funnel: 協調 Trial の実行と完了 → 最終報告の到達 → 受理 / 保留 / park → レビュー列 → 人間の観測 → 対象範囲 → submitted → outcome。campaign 別・種別別に読み取り専用で導く（`ledger funnel`）。読み方は [docs/agents/ledger-reading.md](agents/ledger-reading.md)。
- 添付: Codex `findings.json` 等はPrivate Evidenceにdigest付きで保存し、台帳からは参照だけ。旧Trialの `coverage.json` は参照を読み続ける（ADR 0034）。
- Trialの台帳項目: `trialId`、`trialOrdinal`、`runKind`。再開した segment は同じ `trialId` に `resumesRun` / `resumeSegment` を付け、元 run の `failed` は残す（ADR 0036）。旧Trialの arm、source索引・分担のdigest、`stage` / `continuationOf`、`incomplete(depth)` は既存eventの読取互換として残し、新しい主経路では書かない（ADR 0034）。Leadは欠けた辺・primitive・storage分類と本文のdigestだけを記録する。
- `lab-provisioned.reachability.http`、`verification-finished.evidenceCapture`、`finding-recorded.group`（群の識別子と、群を作る鍵の digest。#424）は追加されたoptional項目。旧eventは引き続き読める。過去の `campaign-stopped.reason = daily-run-cap` も読めるが、新しいcampaignに日次上限の設定・停止はない。

## 10. 評価

開発セットの gate と判定器の負の対照は役目を終えた。本番が bench である（所有者決定 2026-10-26）。agent 入力を変える PR は本番の同じ選定帯で旧版と新版を交互に回し、[DEVELOPMENT.md](DEVELOPMENT.md) 第 5 節の 6 段で採否を決める。開発セットに戻すのは、本番で対象範囲内の Finding は出るのに人間の観測の `match` が 1 週間 0 件のときだけ。既知の公開事例を再発見する benchmark は、現行の方法が 1 回の Trial で既知の型を外したときに、その型を名指しして回す。手順は [docs/agents/measurement.md](agents/measurement.md)。

## 11. 用語

用語は [GLOSSARY.md](../GLOSSARY.md) に置く。この文書は GLOSSARY と同じ語を使い、別の定義を持たない。
