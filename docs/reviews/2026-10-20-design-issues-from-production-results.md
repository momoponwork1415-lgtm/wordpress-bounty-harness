# 本番の探索結果から読む設計課題（2026-10-20）

日付: 2026-10-20。正本ではない。正本は [SPEC](../SPEC.md) と [ADR](../adr/) である。

## 1. 範囲

2026-10-18T16:00Z の再起動（v8、Lab なし探索、Codex と Opus の併用）から 2026-10-20T04:30Z までの本番台帳 `~/.local/state/wordpress-bounty-harness/ledger.sqlite` を読んだ。event 3,384 件、campaign 54 本。第 2.1〜2.6 節は分類と件数だけで書いた。第 2.7 節は所有者の許可を得て Finding、保留候補、Lead の本文を読んだ結果で、この文書には手順と payload を写していない。

探索は安定してきたので、探索を増やす提案はしない。見るのは「探索の後ろで何が詰まっているか」「Harness の制御に穴がないか」の 2 点で、検証とレポートを作り込むときの起点にする。

## 2. 事実

### 2.1 探索

| 項目 | 値 |
| --- | --- |
| 選定 | `target-selected` 205（slug 82 種。選定 batch と campaign の両方に記録されるので 1 対象 2 件が基本） |
| Snapshot | 91 |
| explore run | 120（終了 114、実行中 6） |
| 子 run | 686 |
| explore の結末 | completed 64、provider-limited 34（Claude の 429 が 18、Codex の満杯 `cli-exit:1` が 16）、`provider-cyber-policy` 8、`provider-refusal` 3、その他 5 |
| completed の wall | 中央値 61 分。64 件のうち 53 件が 60〜70 分。120 分の上限に近づいた run はない |
| 対象の skip | `deferred` 53、`provider-refused` 12、`run-failed` 2 |
| campaign の停止 | `provider-limit` 33、`operator` 1 |

runtime 別の completed Trial（`configuration.runtime` が無い 33 件は runtimeShare 導入前の Codex）:

| runtime | Trial | Root が読んだ file（中央値） | 子の数（中央値） | 子の wall（中央値） | Finding | Lead |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Codex（記録なし） | 33 | 75 | 4 | 55 分 | 12（7 Trial） | 88 |
| Codex（`codex-native/v1`） | 10 | 90 | 4 | 57 分 | 1（1 Trial） | 30 |
| Opus（`claude-code/v1`） | 21 | 1（観測できていない。2.6 節） | 18 | 3 分 | 23（4 Trial） | 323 |

子の最終報告が schema に合わず捨てられた run（`child-final-message-not-report`）は 72 件で、子 run の 10.5%。うち 40 件は 2026-10-19T02 台の 1 時間に集中している（Codex）。Opus では 10-19 以降も 1 日 8 件前後で続いている。

### 2.2 Finding

| 項目 | 値 |
| --- | --- |
| 受理 | 42（stored-xss 39、arbitrary-file-download 2、account-takeover 1）。対象 15 種 |
| 偏り | acf-extended 14（Opus の 1 Trial）、wp-seopress 6、optimole-wp 3、enable-media-replace 3。残り 11 対象で 16 |
| preconditionClass | unknown 29、common-usage 13 |
| parked | 3 |
| 保留（`candidate-held` の finding） | 6（3 対象。`issuePaths` は全件 `configurationPrecondition`） |
| Lead | 465（`missingEdge` は producer 175、consumer 136、precondition 91、auth-use 27） |

### 2.3 検証

| 経路 | 回数 | `runtime-confirmed` | 主な結末 |
| --- | ---: | ---: | --- |
| runner の自動検証（`verifier-v8`、attempt 1） | 40 | 0 | `incomplete(precondition)` 37（「catalogue に無い前提」22、`common-usage-scenario-missing` 15） |
| handoff skill（`wbh-verify/v2`〜`v3`、attempt 2〜7） | 22 | 3 | observation 9、recipe 4、evidence 2、precondition 4 |

- 検証 Lab は 63 回立った。`verification-finished` 62 件はすべて自分の `lab-provisioned` を持ち、試行を重ねた Finding（7 回、5 回、3 回×3、2 回×6）も試行ごとに Lab を立て直している。forminator の confirmed は 7 回の Lab 供給の後に出た。
- Finding ごとの最新結果は `incomplete(precondition)` 33、`runtime-confirmed` 3、observation 2、evidence 1。未検証 3。
- 自動検証しか受けていない Finding は 29 件、handoff まで進んだのは 11 件。
- confirmed 3 件は mw-wp-form 5.1.8、forminator 1.58.2、kirki 6.4.0。到達までの handoff 試行は 3、7、3 回。
- acf-extended の 14 件は 14 回の Lab で全件 `incomplete(precondition)`。

### 2.4 レビュー

- `review-decided` は全期間で 0 件。`review-item-opened` は全期間で 10 件、再起動後は 0 件。`review dedupe` の記録もない。
- confirmed 3 件は 2026-10-19T14 と 10-20T01 から `decision: none` のままである。
- `review` を campaign 指定なしで出すと、2026-10-11 の開発セット（`tp326-*`、`issue103-*`）が本番と混ざって並ぶ。

### 2.5 公開記録（mirror 2026-10-14、slug と版の照合のみ）

| 対象 | mirror の最新記録 | 件数 |
| --- | --- | ---: |
| mw-wp-form 5.1.8 | 「<= 5.1.7 Unauthenticated Stored XSS」2026-10-01 公開 | 13 |
| forminator 1.58.2 | 「<= 1.58.1」2026-10-15 公開 | 40 |
| kirki 6.4.0 | 「<= 6.3.2」2026-10-16 公開 | 40 |

3 件とも mirror の最新記録より新しい版で確認している。ただし「同じ sink の修正漏れ」か「別の sink」かは版の境界では分からない。`wbh-dedupe` を回すまで新規とは言えない。

### 2.6 制御の穴（コードで確かめたもの）

- `deferred` の診断本文は `{"detail":{"status":"deferred"},"kind":"deferred"}` だけで理由がない（`src/profiles/wordpress/acquisition/plugin-dependency-source.ts` は `invalid-required-plugins-header` などの理由を投げるが、Private Evidence に落ちていない）。除外にもならないので、post-smtp 4.0.2 は 14 回、cmp-coming-soon-maintenance 4.1.22 は 11 回、modula-best-grid-gallery 3.0.13 は 10 回選ばれて毎回 skip された。7 対象で 53 回。10 枠の batch のうち 2〜3 枠が毎回空振りになる。
- `provider-limit` の停止は対象単位で起きたものを campaign 全体の停止に広げる（`src/cli/pipeline.ts:529-538`、`:699-705`）。runtime を見ないので、Claude の 429 が Codex の対象も止める。2026-10-20 朝のアカウント単位の 429 で batch 全体が止まったのはこれである。
- Claude runner の `MAX_CHILDREN = 4` は「同時に 4」であって総数ではない（`src/discovery/claude-runner.ts:21,51`）。Codex は総数 4 で動くので、SPEC §6 の「Root＋最大 4 子」が runtime で意味を変えている。
- `observed.filesRead` は command 記録（Bash）から数える（`observedFromCommands`）。Claude の Root は Read ツールで読むので、`toolCalls: 48` でも `filesRead: 0` と記録される。Opus Trial の「読んだ file」は観測できていない。
- 保留（`candidate-held`）には出口がない。`review` にも `review parked` にも並ばず、funnel の件数にだけ出る。
- 探索 run の `inputTokens` は Claude では 90 前後で、実体は `cachedInputTokens`（880 万）に入る。runtime をまたいで token を足すと Claude が過小に見える。

### 2.7 本文を読んで確かめたこと（所有者の許可 2026-10-20。手順と payload は書かない）

- **重複の形**: Finding の `sourceTrace` は完全一致しない。plugin 側の `file:function` が 1 つでも重なるものを束ねると、acf-extended 14 件 → 5 群（1 / 4 / 7 / 1 / 1）、wp-seopress 6 件 → 1 群、enable-media-replace 3 件 → 1 群、optimole-wp 3 件 → 1 群になる。42 件は 25 群前後に収まる。
- **保留 6 件の原因**: 5 件は `configurationPrecondition` が 1,013〜1,129 文字で、schema 上限 1,000 を僅かに超えている。1 件は `attackerPosition` が enum でなく「Authenticated Subscriber (…)」の自由文で、`impact` も enum 値で始まる 228 文字の自由文になっている（2026-10-20 の実装 PR #416 で確認。初稿では object と書いていた）。6 件とも stored-xss の実質のある主張（未認証 3、subscriber 3）で、切り詰めと enum への寄せで全件受理できる。
- **最頻の前提**: 「subscriber が自分で変えられる core の profile 項目が、plugin の管理画面か出力に未 escape で出る」という族が、forminator（confirmed）、wp-seopress 6、enable-media-replace 3、acf-extended 4、optimole-wp 2 で 42 件中 16 件を占める。自動検証はこの族を全件 `catalogue に無い前提` にしたが、handoff skill は同じ族で confirmed を出している。SPEC §7「頻出する `incomplete(precondition)` の理由を集計して決める」の答えはこの族である。
- **confirmed 3 件と公開記録**: mirror の各対象の記録（mw-wp-form の 2026-10-01、forminator の 10-15、kirki の 10-16）と機構が異なるので、新規の可能性が高い。前提の重さは 3 件で違う。mw-wp-form は管理者の操作と時間窓、forminator は subscriber と管理者の画面遷移、kirki は同時要求の競合を要する。正式な判定は `wbh-dedupe` で出す。
- **wp-seopress 6 件**は、2026-10-02 公開の「Author Display Name 経由の Stored XSS（<= 10.2）」と同じ族で、10.3 は修正後の版である。修正の抜けか別経路かは dedupe で `possible-match` として扱うべき種類。
- **ATO 候補 1 件**（breeze 2.6.2）は、cache が利用者ごとの秘密を含む応答を保存する種類で、自動検証の `incomplete(precondition)` のまま handoff が 1 回も走っていない。列の中で最も価値の高い候補が最も後ろにいる。
- **wpvivid 2 件**（arbitrary-file-download）は、web server の設定、PHP 拡張の欠落、管理者の同時操作という配備条件を要する。Wordfence の「誤設定前提」に当たる可能性が高く、review の 1 画面目で前提の重さが見える必要がある。
- **Lead 465 件**は全件 `sourceTrace` と 200〜1,800 文字の summary を持ち、見本は「どの handler に何の検査が無いか」まで具体的である。同じ対象の Finding や保留と内容が重なるものもある。構造は Finding と同等で、消費先が無いだけである。

## 3. 設計課題（報酬への影響が大きい順）

### 3.1 自動検証が 0 件のまま Finding 1 件ごとに Lab を立てている

自動検証 40 回で confirmed 0、handoff 22 回で confirmed 3。自動経路の結末は 37/40 が `incomplete(precondition)` で、precondition catalogue と scenario 正規表現（#353 で削除予定）がそのまま出ている。Lab 1 回分の時間と provider の使用量を 40 回払って、review queue に「catalogue に無い前提」が 22 件並んだ。

選択肢:

- A. runner の自動検証を止め、Finding は受理と同時に handoff 列に入れる。`verify next` は `--handoff` 専用にする。Lab は skill が呼ぶときだけ立つ。
- B. 自動検証を残すが、仕事を「Lab を立てて precondition を分類する」までに限り、`incomplete(precondition)` を review queue に出さず handoff 列に送る。
- C. 現状維持。

推奨は A。#352 の受け入れ（Brizy / TranslatePress で handoff が判定器まで届く）が済めば、#353 の削除と同じ PR 1 本で消せる。所有者の 2026-10-18 決定「検証は skill が担う」にも一致する。B は catalogue を残すので LESSONS 14 に反する。

### 3.2 レビュー段が一度も動いていない

全期間で `review-decided` 0 件。confirmed 3 件が 1 日以上 `decision: none`。LESSONS 5「人間に見えない成果は無いのと同じ」の状態である。Step 1 の完了条件「所有者が skill で 1 回のレビュー batch を完了し所要時間を記録する」も未達。

提案: 新しい設計より先に、confirmed 3 件に `wbh-dedupe` → `wbh-review` → `review decide` を回し、1 件あたりの所要分を記録する。この数字が「検証とレポートを作り込む」ときの最初の分母になる。3 件のうち 1 件でも no-match なら、`wbh-report` の下書きまで進めて報告書の経路も 1 周させる。

### 3.3 同じ対象に同じ種別の Finding が 14 件並ぶ

acf-extended 14 件、wp-seopress 6 件。全件が別の Lab と別の review 項目になり、acf-extended は 14 回の Lab がすべて `incomplete(precondition)` だった。`sourceTrace` の完全一致では束ねられない（2.7 節）が、plugin 側の `file:function` が 1 つでも重なる Finding を同じ群にする規則なら、14 件が 5 群、6 件が 1 群になる。集合の重なりの判定で、判断を要しない。

選択肢:

- A. 受理時に群の識別子（同じ Snapshot 内で plugin 側 `file:function` が重なる Finding の連結成分）を `finding-recorded` に足し、`review` と `verify next` は群の代表 1 件を先に出す。捨てない。
- B. 群は作らず、review export に「同じ対象の他の Finding」を並べる。
- C. 現状維持。

推奨は A。ただし「同じ sourceTrace でも別の脆弱性」は起こり得るので、群は表示と順序にだけ使い、判定・提出の単位は Finding のままにする。

### 3.4 保留 6 件に出口がない

`candidate-held` の finding 6 件（3 対象）は全件 `configurationPrecondition` の schema 不一致で、`review` に並ばない。ADR 0018 は「棄却せず保留する」と決めたが、保留を人間に届ける経路を置いていない。

原因は 2.7 節のとおり、5 件が `configurationPrecondition` の 1,000 文字超（最大 1,129）、1 件が `attackerPosition` と `impact` の自由文である。

提案: 正規化で `configurationPrecondition` を 1,000 文字に切り詰め、`attackerPosition` は enum 名を含む自由文を enum に寄せ、どちらも `candidate-normalized.changes` に残す（ADR 0018 の「正規化して受理する」の範囲）。それでも保留になるものには `review held --campaign <id>` を `review parked` と同じ形で足す。今の 6 件はこれで全件 review 列に出る。

### 3.5 Codex と Opus の Trial が別物になっている

Codex は子 4 体 × 55 分、Opus は子 18〜25 体 × 3 分で、同じ「Root＋最大 4 子・60 分」の名前で動いている。Opus の Root が読んだ file は観測できず、Finding と Lead の数は Opus が多い（Trial あたり Finding 1.1 対 0.3、Lead 15 対 3）。これは観測と分母の問題で、どちらが良いかは confirmed の数が出るまで分からない。

提案（3 つとも Harness の制御の範囲）:

- 子の総数の上限を Harness が持つか、「同時 4」を SPEC §6 の意味にするかを決めて SPEC に書く。今は Codex の挙動が SPEC、Claude の挙動がコードになっている。
- `observedFromCommands` に Claude の Read / Glob / Grep の tool_use を足し、`filesRead` を runtime に依らず数える。
- `ledger funnel` / `ledger runtime` を `configuration.runtime` で分ける（opus-runtime-plan の PR 4）。runtime をまたいだ合算をやめる。

### 3.6 provider-limit の停止が runtime をまたぐ

`pipeline.ts:529` の `requestStop("provider-limit")` は campaign 全体を止める。Claude の 429 で Codex の対象も止まり、`campaign-stopped(provider-limit)` が 33 件出た。所有者は「探索はずっと動かしておいてほしい」と言っている。

提案: 停止要求に runtime を付け、同じ runtime の対象だけ新規起動を止める。他 runtime の対象は続ける。`continuous` の backoff も runtime 別に持つ。`maxConcurrentTargetsByRuntime`（#412）と同じ軸なので置き場は決まっている。

### 3.7 deferred が除外されず、理由も残らない

7 対象が 53 回選ばれて毎回 skip された。`lab-provision-failed` を版付きで除外した #308 と同じ形で、`deferred` も版付きで除外する。あわせて `SourceAcquisitionError` の `reason` を `target-skip-diagnostic.json` に書く（#284 と同じ欠落）。

### 3.8 子の最終報告の喪失（#276）

10.5%。2026-10-19T02 台の 40 件は一過性だが、Opus では続いている。#276 の「Root と同じ merge を子にも」をそのまま進める。Opus の子は本文で答える（`children answer in text`）ので、JSON を取り出す merge が効くはずである。数字は #276 に貼る。

### 3.9 provider の拒否で対象の 10% が未探索のまま終わる

`provider-refused` で skip された対象は 12（選定 91 の 13%）。#408 は run 内の model 切り替えを止めたが、対象単位で「Codex が拒否した対象を Opus で 1 回だけ試す」余地は残っている。これは舵取りではなく配線で、runtimeShare の振り分けに「拒否された対象はもう片方へ 1 回」の規則を足すだけである。ただし Opus の拒否率が Codex と同程度なら効果は薄い。拒否 12 件の runtime 内訳（Codex の `cyber-policy` 8、Claude の `refusal` 3）を見ると Codex 側の方が多いので、試す価値はある。

### 3.10 60 分の床が実質の終了時刻

completed 64 件のうち 53 件が 60〜70 分で終わる。LESSONS 3「時間をかけても成果は増えない」により延長は提案しない。ただし「床に達するまでの継続区間（Root の早い最終報告の後）で Finding が増えたか」は台帳に無く、判断の材料がない。receipt に Root の最初の最終報告の時刻と、その後に受理した Finding の数を残す（#332 の観測項目として 1 行足す）。

### 3.11 履歴重み付きの選定は「研究者が集中している plugin」を選ぶ

confirmed 3 件はいずれも公開記録 13〜40 件の対象で、kirki と forminator は直近 1 か月に 10 件前後の記録がある。確認率は高いが重複の確率も高い。これは ADR 0037 の想定どおりで、設計の変更ではなく `wbh-dedupe` の結果で評価する。3.2 の 3 件で初めて数字が出る。

## 4. 検証とレポートを作り込むときの起点

探索が安定した後に作り込む順を、上の数字から出す。

1. **3.2 を先に 1 周する。** confirmed 3 件を dedupe → review → decide まで回し、1 件の所要分と結論を記録する。no-match があれば `wbh-report` で下書きまで。ここで初めて「週のレビュー batch が何時間か」が測れる。あわせて、唯一の ATO 候補（breeze 2.6.2）を次の handoff に名指しで回す。列の順が価値の順になっていないことが 2.7 節で分かった。
2. **3.1 で自動検証を止める。** #352 受け入れ → #353 削除と同じ流れに乗せる。Lab は handoff が呼ぶときだけ立つ。
3. **handoff の `incomplete` 理由を潰す。** 22 回のうち observation 9、recipe 4、evidence 2。confirmed に 3〜7 回かかっている。理由の分布は skill 本文の改善材料である。Harness 側は、試行ごとに Lab を立て直している（2.3 節）ので、同じ Finding の連続試行で Lab を使い回せるか（canary の再播種と `lab-state-before` の取り直しだけで済むか）が所要分を減らす唯一の制御側の手になる。
4. **3.3 の群と 3.4 の保留一覧。** review queue を人間が 1 画面で読める件数にする。
5. 3.5〜3.9 は Harness の制御の修正で、探索を触らない。順は 3.6（停止の範囲）→ 3.7（deferred）→ 3.5（観測）→ 3.9（拒否後の再試行）→ 3.8（#276）。

## 5. 未確認の仮定

- 群の規則「plugin 側 `file:function` の重なり」は 4 対象で試しただけで、別の脆弱性を同じ群に入れる誤りの頻度は見ていない。群を表示と順序にだけ使う理由はこれである。
- confirmed 3 件が公開記録と機構が異なるという判断は、mirror の記録の説明文と Finding の主張を読み比べたもので、`wbh-dedupe` の手順（Patchstack / WPScan を含む）は踏んでいない。
- 3.9 の「Opus なら拒否しない」は Codex 拒否 8 件・Claude 拒否 3 件の比から言っているだけで、同じ対象での比較ではない。
- 子の報告喪失 40 件（2026-10-19T02）の原因は見ていない。#276 の作業で receipt を読むときに分かる。

## 6. 今回触らなかったもの

- 探索 prompt、skill 本文、Programme Boundary。
- 選定方針の数値。
- Lead の消費先。465 件が書き込み専用だが、LESSONS 10「見込み薄の候補は捨てずに残す」に沿って残す。消費先を作るのは Step 2 以降。
- `/home/dev/wordpress-bounty-harness-prod6`〜`prod18` の 13 checkout。動いているのは prod18 で、他は消せる（運用の片付けで、設計ではない）。
