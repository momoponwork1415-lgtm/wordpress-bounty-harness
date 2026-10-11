# 徹底設計レビュー（2026-10-11）

問い: 「現在の設計（SPEC v0.18、ADR 0001〜0027、`src/` 約22,600行）は、不変条件を実際に守っているか。収益装置として成果を失う構造はどこか。削るべき厚みと、足りない薄みはどこか」。

調べ方: 4つの独立した読み取り専用監査（探索・prompt、Lab・検証・判定器、台帳・review・選定・評価、文書整合）を並行で行い、各監査が挙げた高重大度の主張はすべて私が該当行を開いて再確認した。実機（runsc、Codex、Playwright、SQLite のロック）は動かしていない。作業ツリーは `930b5a0`（`origin/main` `d83c2ad` より5 commit 古い）で、差分のあるファイルは `origin/main` 版で読み、該当箇所に【main】と記す。先行レビュー（[完成度](2026-10-11-harness-completeness-review.md)、[公開ハーネス比較](2026-10-11-comparison-with-public-harnesses.md)）と Issue #118〜#132 で既知の項目は繰り返さない。正本ではない報告であり、所有者が選んだものだけが Issue / PR / ADR になる。

## 0. 前提の訂正（2026-10-11、所有者の指摘）

所有者は先月まで旧ハーネス（wp2shell 式の長い prompt、Root＋subagent、候補を人間が採否して手で再現）で Wordfence の報奨を得ていた。本リポジトリはその改善であり、ゼロからの立ち上げではない。したがって本レビューの「未知脆弱性の confirmed 0件、提出0件」は**この新リポジトリの数字**であり、「稼げていない」ことを意味しない。正しい比較軸は「旧ハーネスと同じ発見を、新ハーネスがより安く、所有者の時間をより少なく使って出せるか」である。

この軸で読み直すと、本レビューの重みは次のように変わる。

- 最も重要な未実施項目は、旧ハーネスで報奨になった7件の再発見（#127、ADR 0027）。これは新設計の回帰テストであり、主経路をこれ以上変える前に走らせる。7件の記録は Git 外にある（旧 Wordfence mirror、評価用 source）。
- 新設計が旧から**外した**要素（長い多段 prompt、人間による未検証候補の採否、無期限の継続、contributor 権限の探索）は「明らかに悪い」のではなく、**対照群**である。ADR 0017 の比較 arm に `wp2shell-bounty-v2` を残した判断は正しい。第6節の「比較なしの経路変更」は、旧の当たりを再現できるかを測らずに旧の要素を外したという意味で、より重い。
- 第3節（探索が成果を失う配線）と第4節（検証が本物を incomplete にする構造）は、旧で人間が吸収していた部分を機械に置き換えた箇所に集中している。旧の人間判断を外すなら、ここが新ハーネスの当たり率を決める。
- 第7節（削る・凍結）の優先度は下がらない。旧で稼げていたのは「探索と人間の目」であり、承認ワークフローや統計評価ではない。

## 1. 結論

**不変条件は「隔離」「認証情報」「送信しない」では守られている。「判定の独立」「人間の判断点」「追記専用」は文書上の約束で、コードが強制していない箇所がある。** 加えて、探索は限界まで働くほど成果を失う配線になっており、検証は本物の脆弱性5分類を構造的に `incomplete` にする。収益式の対象数と非重複率を動かす設計は SPEC 全体の2%未満で、ADR は0本。

重大度 high と判定したものは次の9件。

| # | 内容 | 不変条件 / 収益項 | 根拠 |
| --- | --- | --- | --- |
| H1 | `contradicted` が Verifier の `refutation.md`（自由文）の存在だけで出る。環境失敗が負の判定になり、人間の列から消える | 不変条件4 | `src/verification/index.ts:345-350` |
| H2 | `review-decided` が無くても scope → draft → authorize が通る。人間の「提出前レビュー」が記録上省略できる | 不変条件6 | `src/review/index.ts:498-516`、`tests/review/review.test.ts:179-257` が decide 無しを正常系として固定 |
| H3 | 9判定器のうち5つ（SQLi、file read/delete、options、非管理者 privesc、sensitive-object）は Verifier に「どの canary を狙うか」を伝えない。本物でも `incomplete(observation)` | 当たり率 H | `codex-verifier.ts:209-233` の `default: return undefined` |
| H4 | Stored XSS 判定器は Verifier が `route.json` に書いた URL を管理者で開く。query を許すので reflected XSS や open redirect でも `stored-xss` が confirmed になる | 不変条件3 | `lab/index.ts:102-105, 1566-1574, 1639-1650` |
| H5 | 30分の wall は SIGTERM で殺す実装。報告を回収する猶予が無く、限界まで働いた screening は Finding も `unexamined` も残らない | 当たり率 H | `wordpress-host.ts:192-195`【main】、`native-model-process.ts:65-73`、`codex-native-agent-runtime.ts:1207-1249`【main】 |
| H6 | 単独 agent の broker 要求上限は100。30分の入口網羅には足りず、超過は最終報告の抽出より前に `incomplete(policy)` で捨てられ再受理不能 | 当たり率 H | `codex-native-agent-runtime.ts:918, 1211-1218`【main】、`reaccept-candidates.ts:84-88` |
| H7 | `select` は今日も対象を出さない（`candidateSlugs: []`）。唯一の生成 script は台帳を見ず、履歴件数の多い順に並べる | 対象数 T、非重複率 D | `policy/selection.json:5`、`scripts/prepare-pilot-selection.mjs:158-163` |
| H8 | 主経路が3日で3回変わり（単独 → Root＋3 → 二段構え）、どの切り替えも新旧の同条件比較を持たない。ADR 0025 は一段目相当の Trial を一度も走らせずに決まった | 判断の規律 | ADR 0016:20「優劣は実測されていない」、0025:20（n=1 の観測）、#128 は 0025 と同日に起票 |
| H9 | 所有者の目標（月1,000ドル）が正本に無く、SPEC §1 は数値目標の固定を拒む。派生文書は消えた KPI（$250×2.5）を参照し続ける | 目標整合 | `SPEC.md:9`、`DEVELOPMENT.md:7`、`DESIGN-EVIDENCE.md:76` |

## 2. 不変条件を守っているか（条項別）

| 条項 | 状態 | 根拠 |
| --- | --- | --- |
| 1. 答えを渡さない | **概ね守る。** prompt 13版に対象固有名・「必ずある」前提は無い（`discovery-prompts.test.ts:163-172` が機械検査）。入口索引は kind / name / file:line のみ。穴は3つ: (a) 探索 Lab にも canary を seed し、RO DB で `wbh_canary_*`、第2管理者、公開 canary 投稿が見える（`pipeline.ts:167-171`、SPEC §6「探索runにcanaryは渡さず」と矛盾）。(b) 履歴の `title` は Wordfence 表題で「… via 'id' parameter」のように原因箇所を含み得る（`wordfence-history/index.ts:453`。既定では渡らない）。(c) Lab 供給器に TranslatePress 固有の PHP（`trp_settings`、`TRP_Translate_Press::get_trp_instance()`）が TypeScript 文字列で埋め込まれている（`lab/index.ts:992, 1051`）。ADR 0027 は prompt と scenario を禁じるが、供給器は対象外になっている | |
| 2. gVisor のみ、broker 経由のみ | **守る。** 全 `docker run` に `--runtime=runsc` 明示、preflight で runsc 不在は起動前に止まる、fallback 経路なし。broker は `POST /v1/responses` 等の完全一致のみ、`--add-host` で IP 固定、`redirect: "error"`、bypass / debug フラグ無し、実 credential は broker container の `/run/secrets` だけ。軽微: `isolation` の検査は adapter の自己宣言（`codex-gvisor-sandbox.ts:434`）、health 8081 が `0.0.0.0`（`provider-credential-proxy-cli.ts:243`）、WP-CLI container だけ `--read-only` / `--cap-drop` 無し | |
| 3. confirmed は判定器のみ | **confirmed 側は守る。** execution canary は `WBH_EXECUTION_SALT`（WP container env のみ）が要り偽造不能、principal は `wp_validate_auth_cookie` 相当、sensitive は Harness 捕捉必須で cookie を Lab アカウントに解決する。**ただし判定器の入力に自己申告が混ざる**: H4 の victim URL、`attackerRole` / `defaultSettings` は `route.json` の自己申告で scope 評価がそれを使う（`judges.ts:571-584`、`scope-facts.ts:86-96`。SPEC §8b「agentの自己申告は使わない」と矛盾）。状態変化系判定器（principal、option、file-delete）は Lab 状態だけを見て HTTP 経路と結び付けない（`judges.ts:470-485, 666-711`）ので、Verifier が file read で `wp-config.php` を読み DB root（`root@'%'`、mariadb-client 同梱）で直接書いても confirmed になる | |
| 4. 失敗は `incomplete` | **破れている（H1）。** 加えて `teardown` 失敗は confirmed の `evidenceDigest` と再現パッケージ参照を台帳に残さず `incomplete(cleanup)` に上書きする（`verification/index.ts:216-222`）。`#judge` の全例外が `incomplete(evidence)` に丸まる（`:210-214`） | |
| 5. digest 一致 | **検証は守る。** Finding → provision → judge → 再現パッケージ → 台帳の全入口で検査がある。**判断系 event は台帳レベルで無検査**: `review-decided` / `scope-assessed` / `draft-saved` / `external-action-authorized` / `submission-recorded` は Review クラスの自前検査だけで、script 等の直接 writer は素通り（`ledger/index.ts:684-744` は `verification-finished` のみ）。`basis.findingSnapshotDigest` は常に Lab の digest を渡すため検査が自己参照（`pipeline.ts:562-565`） | |
| 6. 人間の判断点2つ | **破れている（H2）。** 承認は最新 revision を見ず、`admit` が初めて `superseded-draft` を返す（`review/index.ts:551-556`）。送信後に拒否される配置。`incomplete` に `accept` できる（`:286-293`） | |
| 7. Harness は送らない | **守る。** review / cli に HTTP・URL 無し | |
| 8. 追記専用、digest のみ | **コードの自制だけ。** trigger も `PRAGMA` も hash chain も無い（`ledger/index.ts:479-492`）。`sqlite3` で `DELETE` すれば funnel が黙って変わる。`nextStep` は2,000文字の自由文を台帳に入れる schema（今日は Harness 定数しか入らない）。Private Evidence store 自体は content-addressed、0700 / 0600、`O_NOFOLLOW`、再検証付きで堅い。ただし `--state` に Git 作業ツリー内を指定できる | |

## 3. 探索が成果を失う経路（収益に直結）

公開事例の共通点は「安い独立 run を多数」だが、本設計は 1 run の成果を失う配線を複数持つ。

1. **wall で殺す（H5）。** `screening-v1.md:13` は「run limit に達したら止めろ」と言うが limit も残り時間も渡さない。Harness 側に「報告を促してから止める」段が無い。非0終了は `extractRootCandidateReport` の救済を通らない。
2. **要求上限100（H6）。** Responses API は1ターン1 POST。入口を1件ずつ読む screening は30分で100を超えるのが普通（Root＋3 は 400 → 1,600 に上げた経緯あり）。
3. **単独 run の rollout を捨てる。** `collectRollouts` で読むが `cooperative` のときだけ `diagnostic` に保存し、solo は `finally` で削除（`codex-gvisor-sandbox.ts:415-439`、`runtime.ts:1065`【main】）。1・2 の失敗時に Private Evidence が空になる。ADR 0016「成果を失わない」は solo に適用されていない。
4. **未知 item type 1個で run 全体が `schema` 失敗。** 許可リスト（`runtime.ts:721-738`）は CLI の版が上がるたびに再発する。`file_change` で候補6件を失った後に追加された経緯がそのまま残る。gVisor 内なので許可リストは安全境界ではない。
5. **receipt は run 終了後にしか書かれない。** 30〜90分の run 中に crash すると `discovery-run-started` だけが残り、`NativeRunReceiptStore`（finalize / recover 付き）は export されているが使用箇所0。docker 子プロセスは `detached` で、container に `--name` が無いため leftover 掃除にも引っかからない。
6. **SPEC §6 の二段目・Harness 継続・`unexplored` は未実装。** `deep-dive-v1.md` 無し、`stage: "deep-dive"` は型のみ、`unexamined` は parse されるが台帳にも継続にも使われない。候補ありの screening は `discovery-concluded(max-runs)` を書くので、同じ campaign ID で二段目を回すと `campaign.ts:350-356` の早期 return に当たる。`screened-no-candidate` は `campaign-stopped` と `discovery-concluded` に二重に書かれ、読む側（funnel、select）は無い。
7. **fan-out の骨格は既にある。** `planWordPressEntryAssignments`（`entry-points.ts:252-382`）と `trialOrdinal % assignments.length` の配分（`cli/wordpress.ts:489-500, 621-624`）、同時実行 ≤4。しかし screening は `assignment` を拒否し（`wordpress.ts:424`）、非 screening で `assignment` を使うと partition ごとに Root＋3 が起動する。「N 個の solo × slice」は `coordination: "solo"` を config で選べないため作れない。
8. **失敗終端は19、うち8と約600〜700行が `multi_agent` 専用。** rollout デコーダ群、子ループ、`child-report-recovered`、`admitCooperativeRuntimeProfile`。

## 4. 検証が本物を confirmed にできない構造

| 分類 | 偽 confirm の経路 | 構造的な偽 incomplete |
| --- | --- | --- |
| rce / php-file-write | 無し（salt は WP container env のみ） | file 形の canary しか無く、`unserialize` / `eval` 型 RCE は「PHP ソースをそのまま置け」の指示で表現できない（`verifier-v6.md:9`）。`getenv` 経路は実 Lab で一度も marker を出していない |
| sqli | 無し | Verifier は表名 `wbh_canary` を知らされず、RO DB からも見えない（H3） |
| file read / lfi / delete | 無し | path `/etc/wbh-canary` 等を知らされない（H3）。`/etc/passwd` を読む古典的証明は `not-observed` |
| options-update | DB root 経由の直接書き込み（§2 条項3） | canary option 名を知らされない（H3） |
| privesc / auth-bypass / ATO | 同上 | `privesc-to-admin` と非管理者系は canary が無い（`#canaryFor` に case 無し） |
| stored-xss | **H4**（reflected / open redirect）、`<img>` / 自己 XSS（#119） | 観測器は `goto` + 3秒待ちだけで click / form 送信が無い（`lab/index.ts:91-92`）。所有者の実 Lab 記録（[issue-119 review](2026-10-11-issue-119-real-lab-dependency.md)）で、既知経路は管理者のドロップダウン操作が要り自動観測は0件。固定訪問先 `/`、`/wp-admin/`、`/wp-admin/edit.php` は plugin の XSS が描画される場所ではない |
| sensitive-object-access | 無し（最も堅い） | object id / meta key を知らされない（H3）。SPEC §8b は「後回し（no-judge）」、§7 と ADR 0024 は「判定器あり」で矛盾 |

その他: `incomplete(no-judge)` の出口が無い。不変条件3で人間が手で確かめても Verified Vulnerability にならず、pilot の Finding 2件は袋小路にいる。再現パッケージには Verifier が書いた `http.json`、手順の散文、探索 agent の `configurationPrecondition` がそのまま入る（`judges.ts:305`、`codex-verifier.ts:551-553`）。Verifier が beacon router へ数千行書けば `cat` が 64 KiB 上限で失敗し `incomplete(observation)` を自作できる。

## 5. 収益式の T と D が設計から欠けている

収益 = T（対象数/月）× H（当たり率）× S（in-scope 率）× D（非重複率）× 平均報奨 − 費用。SPEC 289 行の内訳は、H に効く行 ≈ 33、S ≈ 45（§8a は方針ファイルの複写）、T ≈ 3、D ≈ 1.5、記録・評価・構造・移植・用語 ≈ 170。ADR 27本のうち T を扱うものは0本、自 Finding の dedupe は0本、選定は ADR 0006 の1本でその内容は SPEC と逆。

- **選定方針が3文書で逆方向。** SPEC §8b:144「低権限・高影響の公開履歴を強い優先信号」、OPERATIONS:121「公開履歴の多い plugin を避ける」、`selection.md:12`「既知脆弱性の件数は選定にも採点にも使わない」。コードは `log2(1+history) × weight` で加点（`wordpress-selection.ts:88-90`）。install 下限も SPEC「1万以上」、`selection.json` は500、DEVELOPMENT は「30〜40万規模」の3通り。
- **自 Finding の同一性規則が無い。** Root と子の同一経路の二重報告は既に起きている（BENCHMARK:180）。同一性キー、畳む段階、台帳 event のいずれも未定義。
- **programme 方針が2系統。** `programme-intelligence` + Wordfence 転記（選定用、35日で stale）と `scope-policy.ts` + `programme-scope.md`（review 用、無期限）。同じ公式ページを2度手で写し、相互照合は無い。scope 方針は `observedAt: 2026-10-08` を等値検査するだけで年齢を見ない。
- **方針ファイル内の矛盾。** `programme-scope.md:86`「管理画面だけで発火する Stored XSS は出さない」と `:74`「特定ページだけでも被害者が開いて JS が実行されれば Wordfence では候補」、ADR 0021 は管理画面 XSS のために判定器を拡張した。Wordfence の件数最多クラスの扱いが決まっていない。

## 6. 判断の揺れと測定の欠如

- **主経路の時系列（H8）。** 10-08 短い prompt 1本（A/B 軸を外す）→ 10-09 Trial 化・A/B 軸・Lead 継続（軸を戻す）→ 10-10 ADR 0016 Root＋3（「優劣は未実測」と自記）→ 10-11 ADR 0017 既定 v4 + 比較 arm（7 Trial、各構成 n=1。ここが最も数字がある）→ 同日 ADR 0025 二段構え（文書のみ、Trial 0）。DEVELOPMENT:35「探索に触る PR は最低3 Trial」は同日に制定され、同日に0 Trial の経路変更が merge された。開発セットの定義も 3.2.5 の3件 → 3.2.6 / 3.3.1 → 本人7件と3回変わった。
- **DESIGN-EVIDENCE の「測る」12項目で測定結果があるものは実質0。** 判定器 ablation は SPEC:184 が禁止（同文書内で矛盾）、履歴 ablation は一度も走らず軸ごと停止、Trial 上限6 / k=3 / 同時2 は未測定のまま 0016 と 0025 で廃止、盲検 rubric は未使用、費用は `unavailable` のまま推定換算も無し。
- **理由も判定式も無い数。** 30分（一段目 wall）、30分（継続下限）、90分、最大3子、7:3（単位すら未定義）、継続1回、被害者経路5件、install 1万、履歴2件以上。ADR 0022（観測6回・1時間 → 再試行2回 → 受入試験で比較）だけが「観測 → 数 → 受入試験」の手本。
- **実装者が文書から作れない語。** 「具体的 Lead」（二段目の開始条件なのに判定規則が無い）、「未処理の入口」（agent の自己申告か Harness の読取観測か）、「`unexplored` の再訪」（いつ・何を変えて・分母に入るか）、「Programme Boundary（匿名化）」（何を匿名化するか、コードは自由文を渡すだけ）、購読上限の停止・再開の状態機械、人間の手動再現の道具。
- **現行既定 prompt が4通りに読める。** SPEC（screening-v1）、ADR 0025（「切替は一段目実装時」）、OPERATIONS HEAD 版（v4）、`origin/main`（screening-v1 既定、OPERATIONS も更新済み）。HEAD で測った数字と main の数字は既定が違う。

## 7. 過剰な部分（削る・凍結する候補）

| 対象 | 根拠 | 提案 |
| --- | --- | --- |
| 台帳 event 23種のうち5種（`candidate-rejected` / `-normalized` / `-held`、`child-report-recovered`、`discovery-report-recovered`）と `configuration.axis/arm/arms` の二重保持、`daily-run-cap` | Codex `multi_agent` と手書き契約の schema 失敗への対処。funnel で最も複雑な部分を占める（`ledger/index.ts:950-1104`） | 上流を単純化できた時点で2種に畳む。今は増やさない |
| `evaluation/` の `compare` / `interval` / `score` / `blind-rubric` / `key-registry` と CLI 4本（≈450行） | screening-v1 は A/B 設定を受けないので `configuration.arms` は常に空、`compare` は永遠に「対なし」。`prospective` だけ本番向きだが advisory 入力の生成経路が無い | 凍結。`prospective` の入力を履歴 mirror から機械生成する1本だけ残す |
| review の draft 版管理・authorize・admit・submitted / outcome 分離（824行、CLI 9本、record 5種） | 提出0件。価値があるのは `queue`、`decide`、`openReproductionPackage`、`reverify`、`assessWordpressScope`（純関数） | 最初の in-scope confirmed まで OPERATIONS から外す。凍結しても H2 の gate は先に塞ぐ |
| programme 方針の2系統 | §5 | review 用 JSON を転記 JSON から派生させ1系統に |
| broker の2モード並存（API-key / ChatGPT の listener 2本、receipt enum 2種）と手書き X.509 DER（`grant-tls.ts` 164行） | 安全性に寄与していない部分。本番で使うのは1モード | 約250行減。broker 本体は維持（既製 proxy では header 差し替えと body の model 検査ができない） |
| profile 分離（ADR 0011） | import 境界は合格（`src/profiles` からの import 0件）。ただし `/workspace/wordpress` 定数が discovery に4か所、`ledger` が `verification` の内部型を import | 2つ目の profile まで層を増やさない。mount path は profile から渡す |
| 文書 ≈ 4,600行（docs 1,613 + ADR 約700 + reviews 約1,800 + policy 約400） | 主経路の説明が10か所に4版同居（SPEC §3/§4/§6、AGENTS、ADR 0025 = 現行。ARCHITECTURE、DESIGN-WALKTHROUGH、IMPLEMENTATION-PLAN、TEST-STRATEGY、BENCHMARK 図 = 0016版。OPERATIONS HEAD、DESIGN-EVIDENCE = 単独 Trial 版。SPEC §14 = 10-08 版）。ゲート図4か所、用語集2つ（Trial の定義が違う）、ADR 一覧2つ | §8 の最小集合へ |
| ADR の frontmatter | 書式4通り（`status: superseded by 0012` / `superseded-by:` / 部分置換を status 文字列に埋め込み）、日付キー無し。accepted のまま設計と食い違う ADR 6本（0003 canary 確認、0006 重複重み付け、0007 model 要件の参照先、0013 既定 prompt、0017 既定 v4、0020 TP 向け scenario 優先） | `status` / `date` / `supersedes` / `superseded-by` の4キーに統一。SPEC §11 の一覧は削除 |

SPEC 冒頭（`SPEC.md:3`）は「現在の探索方針は ADR 0016 が優先する」と書き、版も 10-10 のまま。0016 は 0025 で superseded。正本の1行目が古い。

## 8. 最小文書集合（提案）

生かす: SPEC（§1 目的に目標を含める、§2〜§9、§8b 表。§11 / §12 / §13 / §14 / §15 は削除か移動、目標 ≈ 180行）、GLOSSARY（唯一の用語集、SPEC §15 を吸収）、AGENTS（二段構え節は SPEC §6 参照1行に）、OPERATIONS（現行コードの runbook）、DEVELOPMENT（TEST-STRATEGY を吸収）、`docs/records/`（PILOT、BENCHMARK §6〜7、7件の対象表。日付付き実測記録）、ADR（frontmatter 統一）、reviews（DESIGN-EVIDENCE を 2026-10-08 付きで移す）。

畳む: ARCHITECTURE（§1 を SPEC §3 へ）、DESIGN-WALKTHROUGH、IMPLEMENTATION-PLAN（Issues へ）、TEST-STRATEGY、BENCHMARK の計画部。期待効果: 主経路の記述 10 → 2か所、ゲート図 4 → 1、用語集 2 → 1。

## 9. 良い点（確認済み。変えない）

- runsc のみ、fallback 無し、preflight で止まる。broker の allowlist は狭く正しく、bypass フラグが無い。credential は agent に届かない。
- prompt 13版に対象固有名も「必ずある」前提も無く、テストが機械検査する。
- 検証の digest gating は全入口を覆う。修正版での負の対照が実機で `contradicted` を出した。
- execution / principal / sensitive の3判定器は偽 confirm の経路が無い。sensitive は Harness 捕捉必須で cookie を Lab アカウントに解決する設計で、他の判定器の手本になる。
- Private Evidence store は content-addressed で権限・symlink・再検証が揃う。
- Harness は外部送信をしない。不変条件を弱める CLI フラグは存在しない。
- ADR 0022 の「観測 → 数 → 受入試験」の書き方。

## 10. 優先順位付きの推奨（今週の問いの候補）

収益への効き × 実装の軽さの順。1〜4 は不変条件の穴で、探索の数字が出る前に塞ぐ。

1. **`contradicted` を fixed-version の負の対照に限定する（H1）。** 原 Finding では `incomplete(observation)` + refutation digest を添付。1 PR、数十行。
2. **`authorize` と `saveDraft` に最新 `review-decided = accept` と最新 revision を要求する（H2）。** 逆を正常系にしているテストを反転。
3. **台帳に `BEFORE UPDATE / DELETE` の trigger と `timeout`、判断系 event の digest 検査を足す（条項5・8）。** 数十行。
4. **Stored XSS の victim / route URL を型付き手順に制限する（H4）。** query を allowlist にするか、ADR 0026 の観測器が画面を選ぶ形へ。#119 と同じ PR でよい。
5. **wall を二段にし、solo の要求上限を wall から導き、solo rollout を常に保存し、非0終了でも報告抽出を試みる（H5、H6、§3-3、§3-4）。** screening の数字はこれを直す前に測ると過小評価になる。#130 の受入条件に含める。
6. **`#canaryFor` を全判定器に広げ、canary の「identity」（表名、path、option 名、object id、username）を Verifier に渡す（H3）。** 値は秘密のまま。SPEC §7「impactに応じてLabが検証時に発行したcanary」に合致する。
7. **`coordination: "solo"` を config で選べるようにし、screening と `assignment` の併用を許す（§3-7）。** これで #128（Root＋3 vs 単独×4）の比較が走り、比較レビュー §5 の fan-out 置き換えを協調専用経路を使わずに試せる。
8. **選定の1規則を ADR で決め、`select` が WordPress.org から候補を列挙し台帳の `target-selected` を除く（H7、§5）。** T と D に効く最初の ADR。
9. **SPEC §1 に目標（月1,000ドル）と中間指標を1行で置き、`SPEC.md:3` を 0025 に直す（H9、§7）。** 文書のみ。
10. **「具体的 Lead」「未処理の入口」「unexplored の再訪」「自 Finding の同一性」を SPEC §5 / §6 に定義する（§6）。** 二段目（#132）と継続（#131）の実装前に要る。

削る・凍結（§7）は 1〜10 の後でよい。候補が confirmed にならない間は後段を減らしても収益は変わらないが、読む負担は減る。

## 11. 全所見の一覧

重大度: high / medium / low。領域: D = 探索、V = 検証、L = 台帳・review・選定、S = 文書。「再確認」= 私が該当行を開いて確認したもの。

| ID | 重大度 | 所見 | 根拠 | 再確認 |
| --- | --- | --- | --- | --- |
| D-A1 | high | wall 到達は SIGTERM。報告の猶予無し、非0終了は救済なし | `wordpress-host.ts:192-195`【main】、`native-model-process.ts:65-73`、`runtime.ts:1207-1249` | ○ |
| D-A2 | high | solo の broker 要求上限100、超過は報告抽出前に破棄、再受理不能 | `runtime.ts:918, 1211-1218`、`reaccept-candidates.ts:84-88` | ○ |
| D-A3 | medium | 履歴 `title` が原因箇所を含み得る。SPEC §6 と ADR 0027 が矛盾。既定では渡らない | `wordfence-history/index.ts:453` | |
| D-A4 | medium | solo の rollout を捨てる。失敗時に証拠が空 | `codex-gvisor-sandbox.ts:415-439`、`runtime.ts:1065` | ○ |
| D-A5 | low | `isolation` 検査は自己宣言 | `codex-gvisor-sandbox.ts:434` | |
| D-A6 | low | agent `/tmp` に `noexec` 無し（broker にはある） | `codex-gvisor-sandbox.ts:271` | |
| D-A7 | low | health 8081 が `0.0.0.0`、コメントと矛盾 | `provider-credential-proxy-cli.ts:243` | |
| D-B1 | medium | 二段目・継続・`unexplored` 未実装。`discovery-concluded` が同 campaign ID の再訪を塞ぐ | `campaign.ts:350-356, 1025-1029`【main】 | |
| D-B3 | low | `runBudget 0` の対象が Trial 0件で `max-runs` と結論される | `cli/wordpress.ts:471-474`【main】 | |
| D-C1 | medium | fan-out 骨格（assignment）はあるが solo と併用不可 | `entry-points.ts:252-382`、`wordpress.ts:424`【main】 | |
| D-C2 | medium | 未知 item type 1個で run 全体が `schema` 失敗 | `runtime.ts:721-738` | |
| D-D1 | medium | screening-v1 は run limit を知らされない | `screening-v1.md:13`【main】 | |
| D-D2 | low | screening-v1 に軽い手順文（三分類、索引を全部回す） | `screening-v1.md:7`【main】 | |
| D-D3 | low | 必須非空欄（`configurationPrecondition` 等、`function`）が捏造圧力 | `finding.ts:91-102`、`lead.ts:227` | |
| D-E1 | low | broker 2モード並存と手書き X.509。約250行減らせる | `grant-tls.ts`、`provider-credential-proxy.ts` | |
| D-F1 | medium | receipt は run 終了後のみ。crash で container が孤児化し掃除対象外 | `runtime.ts:1297`、`native-run-receipts.ts:190-262`（未使用）、`native-model-process.ts:55` | ○ |
| D-F2 | low | root の `turn_context`（応答 model）を solo で取れない | `runtime.ts:394-398` | |
| V-F1 | high | `contradicted` が自由文 refutation の存在だけで出る | `verification/index.ts:345-350`、`codex-verifier.ts:595-600` | ○ |
| V-F2 | high | 5判定器が Verifier に canary を知らせない | `codex-verifier.ts:209-233` | ○ |
| V-F3 | high | Stored XSS 判定器が Verifier 指定 URL を管理者で開く。reflected / redirect で confirmed | `lab/index.ts:102-105, 1566-1574, 1639-1650` | ○ |
| V-F4 | medium | `attackerRole` / `defaultSettings` が自己申告で scope 評価に入る | `judges.ts:571-584`、`scope-facts.ts:86-96` | |
| V-F5 | medium | 探索 Lab に canary を seed し RO DB で見える | `pipeline.ts:167-171`、`lab/index.ts:1203-1244` | ○ |
| V-F6 | low | 使われない canary（nonce、postId、postMeta、file）、公開 canary 投稿 | `lab/index.ts:1203-1235` | |
| V-F7 | medium | RCE canary は file 形のみ。`getenv` 経路は実 Lab 未実証 | `lab/index.ts:1462`、`verifier-v6.md:9` | |
| V-F8 | medium | Verifier が DB root に届く（`root@'%'`、mariadb-client 同梱）。file read から横断 confirm | `lab/index.ts:807-844`、`containers/development-set/codex/Dockerfile:4` | |
| V-F9 | low | Verifier の digest 不一致が `precondition` と報告される | `codex-verifier.ts:254-298` | |
| V-F10 | low | `basis.findingSnapshotDigest` が自己参照。cleanup 失敗が confirmed の証拠参照を消す | `pipeline.ts:557-565`、`verification/index.ts:216-222` | |
| V-F11 | medium | 状態変化系判定器が効果を HTTP 経路に結び付けない | `judges.ts:470-485, 666-711, 274-282` | |
| V-F12 | low | 再現パッケージに agent 作成物（`http.json`、散文、`configurationChanges`）が入る | `judges.ts:305`、`codex-verifier.ts:551-553` | |
| V-F13 | medium | XSS 観測器は操作無し。既知経路は実 Lab で0件 | `lab/index.ts:91-92`、issue-119 review | |
| V-F14 | low | Verifier が log flooding で `incomplete` を自作できる | `lab/index.ts:69-74, 1558-1563` | |
| V-F15 | medium | 供給器 1,721行に TP 固有 PHP、埋め込み JS / PHP、4回の `docker inspect`、health loop、WP-CLI 出力の文字列 parse | `lab/index.ts:992, 1051, 789-954` | ○（TP 固有 PHP） |
| V-F16 | low | `#judge` 全例外が `incomplete(evidence)`、`/translat/` の regex が他 plugin に誤反応、WP-CLI container の権限 | `verification/index.ts:210-214`、`scenarios.ts:50-73`、`lab/index.ts:482-508` | |
| L-L1 | medium | 追記専用は trigger 無し。コードの自制のみ | `ledger/index.ts:479-492` | ○ |
| L-L2 | medium | 同時 writer は `SQLITE_BUSY` で即例外。campaign 側なら `target-skipped` | `ledger/index.ts:479`、`pipeline.ts:355-373` | ○（timeout 無し） |
| L-L3 | medium | `appendOnce` が conflict を捨てる。再開ごとに孤児 artifact | `pipeline.ts:120-122, 142-158` | |
| L-L4 | medium | `nextStep` が2,000文字の自由文を台帳に入れる schema | `reproduction-package.ts:49`、`ledger/index.ts:274` | |
| L-L5 | low | 判断系 event の identity に時刻を含み、replay で重複 | `review/index.ts:307, 519` | |
| L-L6 | low | event 23種のうち5種が上流の不安定さの帳簿 | `ledger/index.ts:360-386, 950-1104` | |
| L-L7 | low | `submission-recorded` に destination / revisionDigest が無く programme 別に出せない | `ledger/index.ts:296-300` | |
| L-L8 | low | 「最新の verification」の取り方が3か所で違う（後勝ち2、先勝ち1） | `ledger:1012`、`review:196`、`review:656` | |
| L-L9/L10 | low | 全件再 parse のホットパス、`limit: 1000` 一回読みで超過は黙って落ちる | `ledger:566-585`、`pipeline.ts:298-318`、`duplicate-lookup.ts:28` | |
| L-D1 | medium | 判断系 event は台帳レベルで digest 無検査 | `ledger/index.ts:684-744` | ○ |
| L-D2 | low | `basis.findingSnapshotDigest` が自己参照（V-F10 と同件） | `pipeline.ts:562-565` | |
| L-R1 | high | `review-decided` 無しで draft → authorize が通る | `review/index.ts:432-442, 498-516`、`review.test.ts:179-257` | ○ |
| L-R2 | medium | 承認が旧 revision に付く。`admit` で初めて拒否 | `review/index.ts:498-516, 551-556` | |
| L-R4 | low | `incomplete` に `accept` が許される | `review/index.ts:286-293` | |
| L-R5 | medium | review 824行は提出0件に対して過大 | | |
| L-S1 | high | `select` は空集合。生成 script は台帳を見ず履歴件数順 | `selection.json:5`、`prepare-pilot-selection.mjs:150-179` | ○ |
| L-S2 | medium | `selection.md` とコードが矛盾（履歴を採点に使うか） | `selection.md:12`、`wordpress-selection.ts:88-90` | ○ |
| L-S3 | medium | scope 方針に stale 検出が無い。PR:H 分岐は enum が受けず到達不能。programme 方針が2系統 | `scope-facts.ts:8`、`scope-policy.ts:132-133`、`transcription.ts:36` | |
| L-E | medium | `compare` 系は新主経路で分母を失う。評価 ≈ 450行が dead weight | `cli/index.ts:742-891` | |
| L-P1 | low | `--state` に Git 作業ツリー内を指定できる。`.gitignore` も不足 | `cli/main.ts:36-38` | |
| L-P2 | low | Private Evidence の掃除経路が無い。孤児が増える | `private-artifact-store.ts:147, 207` | |
| L-C1 | medium | `screened-no-candidate` は書くだけで読まれず、`campaign-stopped` の意味を曲げる | `pipeline.ts:292-301`【main】 | |
| L-C4 | low | テストの空白: 同時 append、UPDATE/DELETE 耐性、conflict 握りつぶし、decide 無し authorize の拒否 | | |
| S-F1 | high | `SPEC.md:3` が superseded の 0016 を「優先」、版・日付が古い | | ○ |
| S-F2 | high | 選定での公開履歴の扱いが SPEC / OPERATIONS / selection.md で逆 | §5 | ○ |
| S-F3 | medium | install 下限が3通り | | ○ |
| S-F4 | medium | sensitive-object の判定器の有無が SPEC §7 と §8b で食い違う | `SPEC.md:107, 160` | ○ |
| S-F5 | medium | 管理画面 XSS の扱いが programme-scope.md 内で逆 | `programme-scope.md:74, 86` | ○ |
| S-F6〜F16 | low〜medium | ADR 0003 の canary 確認、判定器 ablation の有無、0016:14 と 0025 の反転、用語集2つ、消えた KPI、修正差分 vs 変更ファイル一覧、AGENTS の不変条件1の強さ、funnel 起点、方針 JSON に判定器無し分類の観測名、§12 受入条件の「単独agentへ fallback しない」、Verifier の環境修正の範囲 | | |
| S-F17/18 | medium | frontmatter 4書式、accepted のまま食い違う ADR 6本、現行既定 prompt が4通り | | |
| S-F20 | high | 主経路3回変更、同条件比較0 | §6 | |
| S-F21〜F25 | medium | 未測定のまま廃止された初期値、「測る」12項目の結果0、解釈不能な数字、根拠の無い数 | §6 | |
| S-F26〜F35 | high〜low | 「具体的 Lead」「未処理の入口」「unexplored 再訪」「一段目 Finding の検証タイミング」「自 dedupe」「購読上限の状態機械」「人間の再現道具」「Programme Boundary」「no-judge の出口」「一段目の第3の終了状態」が未定義 | §6 | |
| S-F36〜F39 | high〜low | 目標が正本に無い、T と D の仕様量が2%未満、「いまの優先」が旧開発セット、換算の算術が未照合 | §5 | |
| S-F40〜F42 | high | 主経路の説明10か所4版、図・表の複写、最小文書集合 | §7、§8 | |

## 12. 確認していないこと

- 実機: runsc、Codex CLI（401 / 429 を受けたときに final report を出すか、`multi_agent` の thread 再利用、未知 item type の実出現）、Playwright の selector、Apache → mod_php の `getenv`、`node:sqlite` のロック挙動（timeout=0 は仕様からの推論）、MariaDB 固定 digest の `MARIADB_ROOT_HOST` 既定。
- Private Evidence と台帳の実データ、履歴 mirror の実 DB。数字は PILOT / BENCHMARK / reviews の記載を転記した。
- Wordfence / Patchstack の現時点の公式規則（方針ファイルは 2026-10-08 観測の写し）。
- `tests/cli/cli.test.ts`（1,875行）は test 名と review flow だけ。`recover-child-reports.mjs` の中身。recorder の chunked / `Expect: 100-continue` / WebSocket の扱い。
- 文書監査は HEAD（`930b5a0`）を読んだ。`origin/main` で解消済みのもの（screening-v1 の存在、OPERATIONS の既定 prompt）は本文で訂正した。
- 公開ハーネスの内部コード（比較レビューに同じ）。

## 13. 追記: 人間と判定器の役割分担（所有者の目的「自分の作業時間を減らす、発見数は旧と同等でよい」に対して）

前提（所有者、2026-10-11）: 旧ハーネスでは所有者が全候補を読んで採否し、採用分を使い捨て環境で recipe 実行し、手で再現して提出した（旧 ADR 0135）。報奨になった7件は Stored XSS 4、SQLi 2、ATO 1、すべて未認証。新設計は「判定器だけが confirmed を出し、人間は confirmed と次手付き incomplete だけを見る」（ADR 0002、SPEC §8）。

### 13.1 時間が減る箇所（設計どおり動けば）

- 未検証候補を人間が読まない。旧で最も時間を使った「偽物を見分ける」工程が消える。
- confirmed には再現パッケージが付き、人間は読むだけでよい。

### 13.2 時間が減らない、または増える箇所（現状のコードと文書から）

1. **稼いでいた2分類で判定器が confirmed に届かない。** Stored XSS（4/7）は観測器が操作を行えず（§4、V-F13）、実 Lab の既知経路で0件。SQLi（2/7）は Verifier に canary の表名を伝えない（H3）。この2分類は人間の前に `incomplete` として並ぶ。人間は「なぜ機械が失敗したか」を診断した上で旧と同じ手作業をするので、**旧より時間が増える**。ベンチマークの実測は1件に Verifier 6回・人手約1時間（ADR 0022）。
2. **`incomplete` の列に機械の前処理が無い。** ADR 0022 の理由別再試行は未実装（#107）。`recipe` / `observation` の失敗（脆弱性の有無と無関係）がそのまま人間に届く。
3. **`contradicted` が人間に見えない。** Verifier の自由文だけで出るため（H1）、人間が旧なら拾っていた候補が無言で消える。発見数「旧と同等」の条件を見えない形で壊す。
4. **`no-judge` の出口が無い。** 人間が手で確かめても Verified Vulnerability にならず提出候補にもなれない（S-F34）。人間の時間を使って何も生まない工程が設計に残っている。7件は全て判定器のある分類なので、「no-judge は提出しない」と決めれば済むが、決めていない。
5. **confirmed でも人間の手動再現が必須。** SPEC §8「人間は再現パッケージで自分の手で再現してから文案を査読する」。これは旧と同じ工程で、判定器が決定論的である意味を人間の時間に還元していない。再現パッケージが経路を正しく表す保証が無い（V-F11）、agent 作成物が混ざる（V-F12）ので、現状では省けない。パッケージが Harness 捕捉だけから生成されるようになるまで、ここは短縮されない。
6. **人間の時間を測る項目が無い。** `review-decided.elapsedMs` は採否の決定時間だけ。手動再現、incomplete の診断、文案の時間は記録されない。目的関数を測る指標が台帳に無い。

### 13.3 設計として決まっていないこと（所有者の判断）

- 判定器の無い分類に「人間が確認した」という別状態を置くか、置かずに提出対象外と割り切るか。
- confirmed の手動再現を全件必須にするか、再現パッケージが Harness 捕捉だけから生成された場合は省く（または抜き取り）か。
- `incomplete` を人間に見せる条件。機械の再試行が尽きた後だけか、理由別に集計した形か、Finding ごとか。
- 人間の時間の指標と、旧の基準値（所有者の見積り）。提出1件あたりの所有者分数、confirmed 1件あたりに人間が開いた候補数。

### 13.4 判定

方向は目的に合っている（人間を最後に1回だけ置く）。しかし現状のコードでは、報奨の6/7を占める2分類で機械が失敗して診断を人間に渡すため、旧より所有者の時間は増える。時間削減が実現する条件は「Stored XSS と SQLi の判定器が7件の該当ケースで confirmed に届くこと」と「再現パッケージが Harness 捕捉だけから作られること」の2つで、どちらも未達。それまでの間、役割分担の設計を詰めても時間は減らない。詰める順番は、判定器の到達（#127 で測る）→ incomplete の機械前処理（#107）→ 手動再現の省略条件、になる。
