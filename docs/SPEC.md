# WordPressバグバウンティHarness 仕様書（新リポジトリ）

版: v0.14、2026-10-08。設計決定の正本は [Issue 221 の設計決定comment](https://github.com/momoponwork1415-lgtm/wordpress-harness/issues/221#issuecomment-6057678317)。この文書はその決定をモジュール境界・受け渡し契約・最初の縦断スライスへ落としたもの。設計理由は [ADR](adr/) に置く。調査資料6本は旧リポジトリの `research/design-references` ブランチ `docs/knowledge/*-2026-10-08.md`。

## 1. 目的と指標

- 目的: WordPressプラグインの未知脆弱性をAIで発見し、実行時検証を通ったものだけを人間がWordfence / Patchstackへ提出して報奨を得る。
- 収益の式: 月に回せる対象数 × 当たり率 × in-scope率 × 平均報奨 − 月費用（約$700）。
- KPI: `runtime-confirmed` かつ in-scope の $250以上の発見が月2.5件超。
- 設計の優先順位: 大手が公開している設計・結果規則をまず当て、WordPress固有で避けられない部分だけを自作する。

## 2. 不変条件

1. 探索エージェントへ渡すのは、固定source、人間が書いたtrust境界宣言、Programme Boundary、Lab、そして時点で切った対象の公開履歴（カタログ情報のみ）だけ。評価対象の答え（held-outのadvisory本文、原因箇所、PoC）と、評価runではheld-outの公開日以降の記録は渡さない。PoC、payload、他人の再現手順は本番でも渡さない（[ADR 0012](adr/0012-time-cut-known-vulnerability-history.md)）。
2. 探索・検証はgVisor（`runsc`）の使い捨て環境でのみ対象を実行する。ホストで対象コードを実行しない。弱い隔離へ暗黙に切り替えない。外向き通信は認証ブローカー経由のprovider APIだけ。
3. `runtime-confirmed` はHarness所有の決定論的判定器だけが出す。エージェントやrecipeの自己申告は確認にしない。証明はnonce付きcanaryの回収に限り、リバースシェル・永続化・ホストアクセスを使わない。
4. 検証の失敗（環境・手順・観測・証拠の不足）は `incomplete` であり、`contradicted` にも棄却にもしない。
5. 判定は、Findingと検証結果が同じTarget Snapshot digestを持つときだけ行う。digest不一致は `incomplete`。
6. 人間の判断点は「提出前のレビュー」と「外部行動の承認」の2つ。対象選定の承認、未検証候補の採否はない。権限・対象範囲の拡張は人間の明示承認を要する。
7. 外部送信（報告、ベンダー連絡、公開）は、正確なSubmission Candidate・文案の版・送信先へ結び付いた承認なしに行わない。Harnessは送信を実行しない。
8. 台帳は追記専用。payload、HTTP記録、画面画像、実行ログ、認証情報、未公開の発見はGit外のPrivate Evidenceに置き、台帳はdigest参照だけを持つ。

## 3. 流れ

機械選定 → Snapshot固定 → Lab供給 → 短命Discovery run × N（Lab内で実行可） → 独立Verifier → 決定論的判定器 → 台帳 → 人間レビュー（confirmed + incomplete） → scope評価・重複照合・文案 → 外部行動承認 → 提出転帰の記録。評価は台帳を読むだけで、探索へ何も渡さない。

## 4. モジュール境界

strict TypeScriptのモジュラーモノリス。各モジュールは公開インターフェースと所有する記録だけを外へ出す。

| モジュール | 目的 | 公開インターフェース | 所有する記録 | 失敗時 | 出自 |
| --- | --- | --- | --- | --- | --- |
| `selection` | 方針に従って対象を機械的に選び、予算内で順序付ける | `select(policy) → TargetSelection[]`、`inspect` | 選定方針（人間が編集）、選定記録、スコア内訳 | WordPress.org / Wordfence観測の unavailable / stale をeligibleにしない | 新規。旧 `target-intelligence/acquisition`、`wordpress-org`、`wordfence-intelligence`、`programme` を移植 |
| `snapshot` | pluginとWordPress本体のsourceをdigestで固定する | `freeze(selection) → Snapshot`、`verify(digest)` | Target / Dependency Snapshot、canonical manifest | archiveの不正path・symlink・size超過を拒否 | 移植: `canonical-source-tree`、`canonical-json`、`immutable-file`、`private-artifact-store` |
| `lab` | WordPress + MySQLの使い捨てgVisor環境を供給し、canaryとロール別アカウントを仕込む | `provision(snapshot, setup) → LabHandle`、`seedCanaries`、`teardown` | Lab Setup digest、canary台帳（nonceと配置先）、ロール認証情報（Lab内のみ） | source / image / runsc不一致では起動しない。provision失敗は `incomplete` 用の理由コード | 移植: `human-os` のgVisor候補検証Lab。拡張: discovery用の複数Lab、canary seeding、ロール基準の正常操作記録 |
| `discovery` | 短命エージェントをfile分担で多数独立に回し、Findingを集める | `run(campaignInput) → DiscoveryRun`、`campaign(stopRule)` | Discovery Run記録（model profile digest、prompt digest、分担、usage）、Finding（claim、attacker position、property、trace、recipe ref） | provider / schema / sandbox失敗はtyped receiptとして残し、`incomplete`。自動retryしない | 新規。移植: `codex-native-agent-runtime`、`agent-runtime-profile`、egress broker、`native-run-receipts` |
| `verification` | 独立Verifierで反証を試み、判定器で `runtime-confirmed` を決める | `verify(finding, snapshot, lab) → VerificationResult` | Verifier run記録、判定器の証拠（canary回収、browser観測、ロール基準との差分）、Lab Setup digest | 前提不一致・observation失敗・cleanup失敗は `incomplete` | 新規。移植: Execution Canary |
| `ledger` | 全イベントを追記し、funnelを読み取り専用で導く | `append(event)`、`read(query)`、`funnel(campaign)` | LedgerEvent（型付きunion、snapshot digest付き）、添付（Codex findings等）のdigest参照 | 同一identityへの異なる内容はconflict。削除しない | 新規。規則はADR 0024とMantisから |
| `review` | 人間が検証済みFindingを見て提出判断をする。scope、重複、文案、承認 | `queue() → ReviewItem[]`、`decide`、`assessScope`、`draft`、`authorize` | ReviewDecision、Programme Scope Assessment、Submission Candidate、Submission Draft（版付き）、External Action Authorization | scope評価失敗はscopeだけ `incomplete`、Verified Vulnerabilityを失わない。必要な承認がなければadmitしない | 移植: `human-os` のscope評価・Draft・Authorization。新規: review CLI、ローカルWordfence履歴DB照合 |
| `evaluation` | 答えの鍵を使って台帳を採点し、ablationを回す | `score(campaign, answerKey)`、`ablate(config[])`、`prospective(campaign, advisory)` | Answer Key（Research外）、採点記録、区間 | 鍵の不備は採点失敗として残す | 新規 |
| `cli` | 上記を薄く接続する | コマンド | なし | | 移植: `cli.ts` の構成だけ |

持ち込まないもの: `research/` のResearch Campaigns内部、継続Campaignとcheckpoint再開、条件付き3試行、Human Candidate Review、Research Grant、Approved Target Batch、旧スキーマ、Grok / Claude Code / GLM / DeepSeek adapter（開発比較が必要になったら移す）。

## 4a. Target Profile（対象固有部分の置き場）

将来の別言語・別プラットフォームへの使い回しのため、WordPress固有のものは `profiles/wordpress/` に閉じ込める（[ADR 0011](adr/0011-target-specific-code-lives-in-a-profile.md)）。

| profileが提供するもの | WordPress版の中身 |
| --- | --- |
| source取得 | WordPress.orgからのplugin / 本体の取得と検査 |
| Lab provisioner | gVisor内のWordPress + MySQL、ロール別アカウント、canaryの配置先（options、post meta、ファイル、canaryユーザー） |
| 判定器集合 | 第7節の種別別判定器 |
| scope方針 | `src/profiles/wordpress/policy/programme-scope.md`（Wordfence / Patchstack） |
| prompt雛形 | 探索prompt（短い目的promptの1本、版付き）、trust境界宣言の雛形、file分担の規則（hook / route / AJAX action単位） |
| 答えの鍵の形式 | 入口の表現（hook名、route、action名） |

汎用モジュールはこれらをインターフェース経由で受け取り、WordPressの型やpathをimportしない。2つ目のprofileを作るまでインターフェースは汎用化せず、WordPress版の完成後に共通部分を抽出する。

## 5. 受け渡し契約（版付き、Zodで実行時検査）

| 契約 | 送り元 → 受け手 | 主な項目 |
| --- | --- | --- |
| `TargetSelection v1` | selection → snapshot | plugin slug、version、スコア内訳、方針の版、選定時刻 |
| `CampaignInput v1` | snapshot → discovery | Target / Dependency Snapshot digest、trust境界宣言（人間が書く、版付き）、Programme Boundary（匿名化）、対象の公開履歴（カタログ情報、`historyCutoff` とdigest付き。渡さないrunは `none`）、model profile digest、prompt digest、停止規則、Lab設定 |
| `Finding v1` | discovery → verification / ledger | claim、attacker position（`unauthenticated` / `subscriber` / `customer` のみ）、到達する影響の種別（第8b節の共通分類）、設定前提（`default` / 変更内容）、破られるproperty、入口からeffectまでのtrace（file、function、行）、既存controlへの評価、Lab内で観測した事実、recipe ref（Private）、discovery run id、snapshot digest |
| `VerificationResult v1` | verification → ledger / review | `runtime-confirmed` / `contradicted` / `incomplete`、判定器の種類、判定器が観測した条件（使ったrole、path / 拡張子の制御、到達role、XSSの発火context、変更したoption、設定前提）、証拠ref、Lab Setup digest、`incomplete` 理由コード、次の手（verifierが書く）、再現パッケージref（confirmedのみ） |
| `ReviewDecision v1` | review → ledger | 採否、理由コード、重複照合の結果、判断時刻、開いた証拠の一覧 |
| `SubmissionCandidate v1` | review → review（承認） | Verified Vulnerability ref、programme、scope判定、Draft revision digest、送信先 |
| `LedgerEvent v1` | 全モジュール → ledger | 型付きunion。全イベントがsnapshot digestとcampaign idを持つ |

別モジュールの保存先や内部型を直接参照しない。Private Evidenceはcontent-addressedで、台帳にはdigestと種別だけを置く。

## 6. Discovery runの仕様

- 攻撃者位置: 未認証とsubscriber（customer相当）だけ。contributor以上はtrust境界の内側として宣言する（第8a節）。
- 対象の公開履歴: ローカルWordfence履歴DBから、snapshotの版より前（評価runではheld-outの公開日より前）に公開された対象プラグインの記録を抽出して渡す。内容は種別、影響版、修正版、公開日、公開記録のタイトル、修正版との差分で変わったファイルの一覧まで。PoC・payload・再現手順は含めない。runの一部にだけ渡す分担にでき、渡した・渡さないを `CampaignInput` に記録する（ADR 0012）。
- 入力: 探索prompt（版付き、digestを記録。**短い目的promptの1本だけ**。目的、trust境界、影響の分類と報奨順、出力形式だけを書き、手順を書かない。wp2shell由来の変種は当面作らない。wp2shellの元になったCycle Double Cover型promptは「解が必ず存在し、費用を無制限にかけて解く」前提で、対象の大半に脆弱性がなく費用が収益を決めるバグバウンティには合わない。prompt変種の比較が必要になったら本番A/Bの軸として追加する）、trust境界宣言、分担されたfile集合、Lab endpointとロール別認証情報（Lab内のみ）、読み取り専用source。
- 許可する操作: sourceの読み取り、LabへのHTTP、Lab DBの読み取り、Lab内でのcanary確認。外向き通信なし。
- 出力: `Finding[]`（0件可）と、調べた範囲・調べなかった範囲の短い記述。
- Campaign停止規則: 新規Findingなしがk回連続（初期値 k = 4、Codex Security deep scanの既定に合わせる）、または対象あたりの上限run数（初期値 N = 40）。wall timeはrunごとに上限を持つ。
- 同時実行: ホストあたり最大4 run。
- 記録する項目（runごと）: 要求model IDとeffort、CLIの正確な版と同梱カタログのdigest、認証方式、cyber access program、service tier、subagentのmodel / effort、usage（providerが返さない項目は `unavailable` のまま）。
- 本番model: `gpt-6.1-sol`（Codex CLI ≥ 0.161）。開発セット: `gpt-6-luna`。

## 7. Verificationの仕様

- Verifier: 新しいコンテナ。渡すのはFinding、source、Lab。会話履歴と作業領域は渡さない。役割はrecipeの環境不備の修正と反証に限り、再探索はしない。
- 判定器（Harness所有、決定論的）。作るのは両プログラムで報奨に届く分類だけ。Reflected XSS、CSRF、到達先のないmissing authorization / IDOR、コンテンツ削除は判定器を作らず、探索の目的にも含めない（記録はする）:

| 種別 | 成功条件 | 不採用の観測 |
| --- | --- | --- |
| RCE / PHPファイル書き込み | Execution Canary（nonce）がLab内で実行された痕跡 | シェル取得、`.php.png` や安全な拡張子内のコード |
| SQLi | canary行の値が応答に現れる、またはcanary表への書き込みが観測される。Labは `wp_magic_quotes` 既定のまま | timing差 |
| 任意ファイル読み取り / LFI / RFI | Labが置いたcanaryファイルの内容が応答に現れる。pathと拡張子の両方を攻撃者が決めたことを記録 | パス文字列の反射 |
| options更新 | Labが置いたcanary option、または重大なoption（`users_can_register`、`default_role`、`siteurl`、`admin_email` 等）が低権限主体から変わる | 影響のないoption |
| 管理者への権限昇格 / 認証回避 / アカウント乗っ取り | 低権限主体が管理者の認証状態または管理者相当の能力を得る（Labのcanaryユーザー、各ロールの正常操作記録との差） | パスワードリセットメールの存在だけ、エラーメッセージの差 |
| contributor以上への権限昇格 / 非管理者の認証回避 | 低権限主体がcontributor以上の能力または他主体の認証状態を得る | 同上 |
| Stored XSS（サイト全体） | 低権限主体が置いたnonce付き値が、未認証訪問者が見る前面ページまたは全管理画面でheadless browserにより実行され、Labのcanary受信先へ届く。発火contextを記録 | alertの有無、文字列の存在だけ、特定ページだけの発火 |

- 結果: `runtime-confirmed` / `contradicted` / `incomplete`。`incomplete` は理由コード（provision、precondition、recipe、observation、evidence、cleanup、digest-mismatch）と次の手を持つ。
- 判定器を定義できない種別は自動確認せず、`incomplete(no-judge)` として人間へ回す。
- **再現パッケージ（Reproduction Package）**: `runtime-confirmed` になった各Findingについて、判定器が通った経路に限定して、人間が自分の手で再現できる資料を生成する。手順は遠隔攻撃者の視点（HTTPリクエストとブラウザ操作）で書き、WP-CLIやサーバー側だけの操作を成立条件に含めない（Patchstackの提出要件）。内容は (1) 手動手順（前提の設定、使うロールとアカウント、送るリクエスト、期待する観測）、(2) 最小スクリプト（Python、標準ライブラリと `requests` だけで動く）、(3) Labの再構築情報（WordPress版、プラグイン版とdigest、有効化した設定、ロール）、(4) 判定器が取った証拠（HTTP記録、画面画像、canary回収ログ）。置き場はPrivate Evidence（Git外）で、`review` から開く。レポートの査読と提出文案の根拠に使う。Verifierの作業ログをそのまま出さない。

## 8. 人間レビューとDisclosure

- レビュー列に出すもの: `runtime-confirmed`（証拠refと再現パッケージつき）と、次の手付きの `incomplete`。`contradicted` は件数と抽出だけ。人間は再現パッケージで自分の手で再現してから文案を査読する。
- 人間が決めること: 影響が意味を持つか、意図された動作ではないか、重複でないか（ローカルWordfence履歴DBで照合）、どのprogrammeへ出すか、文案の承認、外部行動の承認。
- 記録: 判断、理由コード、判断までの時間、開いた証拠。覆し率は監視信号。
- 提出転帰（triaged / resolved / duplicate / informative / N/A / rejected）を台帳へ戻し、選定方針と判定器の改善材料にする。自分の未公開の発見は公開されるまで探索へ戻さない（公開後はADR 0012の履歴として扱う）。

## 8a. プログラム対象範囲の方針

技術的な真偽（`runtime-confirmed`）とプログラム対象範囲は分ける。対象範囲は `review` で提出先ごとに評価し、検証を止める条件にしない。方針は [src/profiles/wordpress/policy/programme-scope.md](../src/profiles/wordpress/policy/programme-scope.md) に観測日付きで置き、提出前に公式ページで再確認する。

2026-10-08時点の方針（Wordfence公式ページの写しとPatchstack 2026年版ガイドライン、判断者の指示）:

- 攻撃者の権限は未認証とsubscriber / customer相当に限る。Wordfenceは contributor / author（中間権限）と administrator / editor / shop manager / `unfiltered_html`（PR:H）を要するものを明示的に対象外にしている。Patchstackはcontributorをx0.75のmVDPのみ、editor以上は不受理。したがってtrust境界宣言ではcontributor以上を信頼する側に置き、探索の攻撃者位置を未認証とsubscriberに限る。
- Wordfenceの分類と閾値（判断者は1337 tier）: High Threat（任意PHP file upload / read / delete、任意options更新、RCE、管理者への認証回避 / 権限昇格）は25件以上、Stored XSS / SQLiは500件以上、その他は500件以上。1,000件未満はWordPress.org掲載が条件、premiumは1,000件未満を除外。
- Wordfenceの対象外資産（WordPress core、Automattic、Facebook、Google、SiteGround、Yoast、配布停止、ベンダー側web service）は `selection` の除外リストに入れる。
- Reflected XSS、CSRF、Missing Authorization、IDORはWordfenceで明示的に対象外。候補としては記録するが、Submission Candidateにしない。ただし同じ欠陥が任意options更新、任意コンテンツ削除、権限昇格、認証回避、機微情報の漏えいに到達する場合は、到達先の種別として対象。判定器はauthz系も技術的に確認し、scope評価で到達先を問う。
- Wordfenceの却下条件のうちLabと判定器に効くもの: `wp_magic_quotes` 無効前提のSQLi、SVG / 二重拡張子 / 安全な拡張子内のコードによるupload、nonceで守られたactionのmissing authorization、管理者の誤設定前提。Labは既定設定で供給し、file upload系はExecution Canaryの実行で証明する。
- Patchstack（報告フォーム2026-06-01改定の写し `src/profiles/wordpress/policy/patchstack-scope-2026-10-08.md`）: 攻撃者は未認証 / subscriber / customerだけ（contributorはmVDPのみ）。受理種別には条件が付く: ファイル系とLFI / RFIはpathと拡張子の完全制御、権限昇格はcontributor以上へ到達、設定変更は重大な影響を持つoption、broken access controlは機微な対象、XSSはサイト全体に効くstoredかJS実行を伴うreflected、CSRFは受理種別の書き込みへ連鎖。1,000件未満はCVSS 8.5以上のみ、100件未満は不受理。
- Reflected XSSとCSRFはPatchstackでは条件付きで受理されるが、この設計では探索の目的にも提出候補にもしない（判断者の指示、2026-10-08）。記録だけ残す。
- 両プログラムとも最新版・既定設定での成立を要する。提出直前に最新版のsnapshotで再検証し、再現パッケージは遠隔攻撃者の視点の手順（HTTPリクエスト、画面画像）で書き、WP-CLIなどサーバー側だけの手順を含めない。
- 公開資料間で矛盾するときは `in-scope` にせず `ambiguous` として人間へ回す。

## 8b. 対象範囲の守らせ方

対象範囲は4か所で、それぞれ違う強さで効かせる。promptだけに頼らない。

| 場所 | 手段 | 強さ |
| --- | --- | --- |
| `selection` | 対象外資産（作者、配布停止、ベンダー側service）を除外リストで落とす。閾値（500件以上、WordPress.org掲載）を方針ファイルで持つ | 機械的。対象が入らない |
| `lab` | discoveryとverifierに渡す認証情報を未認証・subscriber・customer（WooCommerce有効時）に限る。contributor以上と管理者の認証情報は渡さない。設定は既定のまま、一般的な利用範囲の初期データ（公開フォーム1つ等）はprofileのsetup manifestで入れ、Lab Setup digestに記録する | 機械的。contributor以上の経路は試せない。設定変更もできない |
| `discovery` | 目的promptに到達すべき影響の共通分類（下表）と報奨順を書き、trust境界宣言でcontributor以上と管理者の明示設定を信頼側に置く | 誘導。agentは他も報告してよいが、台帳で分類される |
| `verification` と `review` | 判定器の成功条件をプログラムの受理条件に合わせる（下表）。scope評価はFindingと判定器の観測だけから、方針ファイルの規則で `in-scope` / `out` / `ambiguous` を出す。agentの自己申告は使わない | 機械的。提出候補にならない |

影響の共通分類（両プログラムの受理条件を1つの語彙にしたもの。判定器とscope評価が共有する）:

| 分類 | 判定器の成功条件 | Wordfence | Patchstack |
| --- | --- | --- | --- |
| `rce` / `php-file-write` | Execution Canaryが実行される。SVG、二重拡張子、安全な拡張子内のコードは不可 | High Threat ≥25 | 受理 |
| `arbitrary-file-read` / `delete` / `download` | canaryファイルに届く。pathと拡張子の両方を攻撃者が決められたことを判定器が記録する | High Threat（PHPファイル）/ その他 ≥500 | 受理（path + 拡張子の完全制御が条件） |
| `lfi` / `rfi` | 同上 | その他 ≥500 | 受理（同上） |
| `sqli` | canary行の読み出しまたは書き込み。Labは `wp_magic_quotes` 既定のまま | Common ≥500 | 受理 |
| `options-update` | Labが置いたcanary optionまたは重大なoption（`users_can_register`、`default_role`、`siteurl`、`admin_email` 等）が低権限から変わる | High Threat ≥25 | 受理（重大な影響が条件） |
| `privesc-to-admin` / `auth-bypass-to-admin` / `account-takeover` | 低権限主体が管理者の認証状態または管理者相当の能力を得る | High Threat ≥25 | 受理 |
| `privesc-to-contributor+` / `auth-bypass-non-admin` | 低権限主体がcontributor以上の能力または他主体の認証状態を得る | その他 ≥500 | 受理（contributor以上が条件） |
| `sensitive-object-access` | 判定器は後回し（`incomplete(no-judge)` として人間へ） | その他 ≥500（Sensitive Information Disclosure） | 受理（機微な対象が条件） |
| `content-deletion` | 判定器を作らない。探索の目的に含めない | その他 ≥500 | broken access controlの条件次第 |
| `stored-xss` | 低権限主体のnonce付き値が、未認証訪問者が見る前面ページまたは全管理画面で実行されcanary受信先へ届く。発火contextを記録 | Common ≥500 | 受理（サイト全体に効くことが条件。それ以外はmVDPのみ） |
| `reflected-xss` | 判定器を作らない。探索の目的に含めない。記録のみ | 対象外 | 受理（JS実行、nonce不要が条件）だが出さない |
| `csrf-to-write` | 判定器を作らない。探索の目的に含めない。記録のみ | 対象外 | 受理（連鎖が条件）だが出さない |
| `missing-authz` / `idor`（到達先なし） | 判定器を作らない。到達先がある場合はその分類で判定する | 対象外 | 機微な対象以外は対象外 |

分類に入らない主張（DoS、open redirect、SSRF、情報列挙等）は `other` として台帳に残し、探索の目的にも提出候補にもしない。



- イベント例: `target-selected`、`snapshot-frozen`、`lab-provisioned`、`discovery-run-started / finished`、`finding-recorded`、`verification-finished`、`review-decided`、`scope-assessed`、`draft-saved`、`external-action-authorized`、`submission-outcome`。
- 規則: 追記のみ。全イベントにsnapshot digest。判定系イベントはdigest一致時のみ有効。setup失敗はdiscovery試行に数えない。
- funnel view: raw findings → verifier通過 → confirmed / contradicted / incomplete → reviewed → in-scope → submitted → outcome。campaign別・種別別に読み取り専用で導く。
- 添付: Codex `findings.json` / `coverage.json` 等はPrivate Evidenceにdigest付きで保存し、台帳からは参照だけ。

## 10. 評価

主指標は本番から得る。held-outは任意で、回すときは予算で件数と試行を決める。理由は [DESIGN-EVIDENCE.md 第9節・第12節](DESIGN-EVIDENCE.md)。

### 主指標（本番の台帳から、追加費用なし）

- **本番A/B（ablation）**: runは独立なので、同じ対象に対してrunを構成A / 構成Bに分担して回す。どちらが見つけても提出でき、予算を無駄にしない。比較する軸: 履歴有無（ADR 0012）、分担単位、Verifier有無、判定器有無、Lab内実行有無。promptは短い目的promptの1本で固定し、当面は軸にしない。各runの構成は台帳のrun記録に残し、対象をまたいで集計する。差は同じ対象内の対で示し、区間を併記する。
- **前向き評価**: 本番Campaignの台帳を、後日公開されたadvisory（自分の提出以外も含む）で採点する。「あったのに見逃した」が分かる唯一の方法。採点はheld-outと同じ `location-overlap` と盲検rubric。
- **提出転帰**: triaged / resolved / duplicate / informative / N/A / rejected の率と、報奨額。収益に直結する最終の数字。
- **funnel**: raw → verifier通過 → confirmed / contradicted / incomplete → reviewed → in-scope → submitted → outcome。campaign別・種別別。

### 判定器の負の対照（安い。判定器のテストとして回す）

- 修正版pluginで同じ手順を流し、判定器が鳴らないことを確認する。鍵と同じpropertyを主張したFindingだけ `control-false-alarm` と数える。

### 答えの鍵（登録は行う。回すかは任意）

- Answer Key（Research外に保管）: 入口（hook / route / AJAX action）、破られるproperty、欠けているcheck、攻撃者権限、到達する影響、許容file / function集合、公開日、model cutoff、本人発見 / 補助の区分。
- 登録する鍵（2026-10-08時点、11件）: 本人発見の公開7件（旧リポジトリIssue 213）＋第三者の補助4件（任意ファイルアップロード / RCE、管理者への権限昇格、乗っ取り）。本人発見のうち2026-04-30（gpt-6.1-sol cutoff）以前の公開は contamination 可能性ありとして区間を分けて表示する。
- 開発セット: TranslatePress 2件（prompt調整と縦断スライスに使う。採点に使わない）。
- held-out評価を回す条件: 大きな設計変更（判定器の方式、探索の構造）をしたときに限る。回すときは、cutoff後の補助4件を優先し、試行数は予算で決め（1〜5）、区間の幅をそのまま示す。9件×5試行の全量は本番15〜17対象分の費用に相当するので、既定では回さない。
- 採点: 一次は機械の `location-overlap`（必要条件）。二次は人間の盲検rubric（場所、root cause、攻撃者条件、影響の4要素）で `target-hit` / `partial` / `non-target`。実行水準は `target-hit ∧ runtime-confirmed`。
- 統計: k/n にClopper-Pearson区間。pass@kはunion / 全回 / 試行別の3表示。種別別は件数のまま。重なる区間は「差なし」でなく「判定不能」と書く。
- held-outの結果を見てpromptを変えたら、そのcaseは開発セットへ移す。

## 11. ADR（新リポジトリで最初に書くもの）

1. 探索に既知脆弱性の答えを与えない（旧ADR 0003を引き継ぐ）。→ **0012で置き換え**: 評価では時点で切り、本番では対象の公開履歴（カタログ情報）を変種分析の入力として渡す。
2. 自動の実行時検証を人間レビューの前に置く（旧ADR 0135を置き換える）。
3. 探索エージェントは隔離Lab内で対象を実行してよい。Lab外への到達と外部行動は禁止。
4. `runtime-confirmed` はHarness所有の決定論的判定器だけが出す。
5. 単一の追記専用台帳と、snapshot digestによる判定の有効条件。
6. 対象選定の人間承認を持たず、方針だけを人間が所有する。
7. モデルの記録項目（model、effort、CLI版、カタログdigest、認証、access program、service tier、subagent）。
8. strict TypeScriptのモジュラーモノリスと薄いCLI（旧ADR 0054 / 0055 / 0084を引き継ぐ）。
9. provider認証情報は有界のegress brokerを通す（旧ADR 0142を引き継ぐ）。
10. プログラム対象範囲は技術的検証を止めず、reviewで提出先ごとに評価する。authz / IDORは重大な影響へつながる場合だけ対象。
11. 対象固有のコードはTarget Profileに閉じ込め、汎用モジュールはprofileを型でしか知らない。2つ目のprofileまで汎用化しない。
12. 既知脆弱性は評価では時点で切り、本番では対象の公開履歴を変種分析の入力として渡す（0001を置き換え）。

## 12. 最初の縦断スライスと受入条件

開発セット1件（TranslatePress 3.3.1 ATO。答えを知っていてよい）で、次が一度通ること。目的はHarnessが端から端まで動くことの確認で、当たり率の主張ではない。

1. `selection` が方針からその対象を含む選定を出す（手動pinで可）。
2. `snapshot` がTarget / Dependency Snapshotをdigestで固定する。
3. `lab` がgVisor内にWordPress + MySQLを供給し、canaryとロール別アカウントを仕込む。
4. `discovery` が `gpt-6.1-sol` でrunを回し、Findingを台帳へ記録する。停止規則が働く。1試行でよい。
5. `verification` がVerifierと判定器で結果を出し、`incomplete` の理由コードが残る。
6. `review` のCLIがconfirmedとincompleteを表示し、判断を記録する。
7. `ledger` がfunnelを表示し、`evaluation` が鍵に対して `location-overlap` を出す（鍵は開発セットのもの）。
8. `pnpm check` が通り、各モジュールの振る舞いテストが公開インターフェースから観測する。

受入: 上記が一度通り、台帳から「Finding数、verifier通過数、confirmed / contradicted / incomplete、run数と費用」が読める。提出は行わない。held-outは使わない。

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
- 費用の経路はChatGPT Proのサブスクリプション（Codex CLI認証）で始める。Proでの Sol の実利用量と、cyber access programの要否。上限に当たるならAPIキーへの切り替えをその時点で判断する。
- Sol 1 runあたりの費用と時間（分担file数とwall timeの初期値を決める）。
- Codex CLIをgVisor内で動かす際のCLI自身のsandbox（Bubblewrap）の扱い。

## 15. 用語

| 用語 | 意味 |
| --- | --- |
| Target Snapshot | plugin sourceをmanifest digestで固定した読み取り専用の対象 |
| Lab | 使い捨てのgVisor環境で動くWordPress + MySQL。canaryとロール別アカウントを持つ |
| Discovery Run | 短命エージェントの一回の独立実行。分担file集合とLabを持つ |
| Finding | Discovery Runが出した、攻撃者前提・property・traceを持つ主張。確認ではない |
| Verifier | 新しいコンテナで反証を試みる独立エージェント。再探索はしない |
| 判定器 | Harness所有の決定論的な確認手段。`runtime-confirmed` を出せる唯一の主体 |
| Verified Vulnerability | `runtime-confirmed` からだけ作る技術的記録。programme scopeと独立 |
| Trust境界宣言 | 人間が書く「何を信頼するか」の宣言。既知脆弱性を含まない |
| 公開履歴（history） | 対象プラグインの公開advisoryのカタログ情報。時点で切って探索に渡す。PoCは含まない |
| historyCutoff | 探索runに渡す履歴の時点。本番はsnapshotの版、評価はheld-outの公開日 |
| Answer Key | 評価側だけが持つheld-out caseの正解。探索へ渡さない |
