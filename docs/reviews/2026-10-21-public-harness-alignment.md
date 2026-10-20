# 公開ハーネスの共通点を設計に取り込む（2026-10-21）

所有者の指示（2026-10-20）: 公開されている脆弱性探索ハーネスに共通する点は、この Harness の設計に取り入れる。本報告は、共通点 5 つを「今あるもの」「欠けているもの」「最小の変更」に分けた対応表と、問い 1 つずつの PR に分けた順番である。正本ではない。所有者は 2026-10-21 にこの方針を承認し、Issue #423、#424、#425 を切った。コードは変えていない。

## 1. 共通点 5 つ

出典は [2026-10-11 の比較](2026-10-11-comparison-with-public-harnesses.md)、[prompt 出典対照表の公開ハーネス表](2026-10-13-prompt-source-comparison.md)（84〜107 行）、2026-10-20 の調査（Anthropic Project Glasswing、Cloudflare の探索基盤、Microsoft MDASH、FuzzingBrain V2、AISLE、Google Naptime / Big Sleep、OpenAI Codex Security）。

| # | 共通点 | 公開例での形 |
| --- | --- | --- |
| 1 | 短命で独立した子を多数走らせる | 1 仮説 1 子。子は報告して終わる。幅は子の数で取る |
| 2 | 発見と検証を別のエージェントに分け、再現を要求する | 発見者の文脈を持たない validator が、別環境で再現できたものだけを残す |
| 3 | 重複排除の段を置く | 同じ経路の報告を束ね、人間には群の代表だけを見せる |
| 4 | モデルを役割で階層化する | 仮説と検証は強いモデル、幅・圧縮・重複排除・一次 triage は安いモデル |
| 5 | 詰まるのは探索ではなく検証と triage | 候補は余り、人間に届く前の検証と triage が律速になる |

## 2. 対応表

### 2.1 短命で独立した子

- 今あるもの: Claude runtime の子は one-shot で、報告して終わる（[claude-runner.ts:17-20](../../src/discovery/claude-runner.ts)。`MAX_CHILDREN = 4` は同時数で、総数ではない）。本番の Claude 子 432 件は中央値 3.3 分、Root あたり中央値 16 体（[監査](2026-10-20-multi-agent-discovery-audit.md)）。所有者の有償期の prompt も子の寿命を制限していた（[出典対照表](2026-10-13-prompt-source-comparison.md) 66〜67 行）。
- 欠けているもの: 主経路として決まっていない。Codex runtime の子は永続スレッドで、寿命の制御が無い（[codex-native-agent-runtime.ts:1939-2000](../../src/discovery/codex-native-agent-runtime.ts)）。
- 最小の変更: コードは不要。campaign 設定の `runtimeShare` で Claude を主経路にし、Codex は比較 arm として残す。子の寿命を prompt に書く行は agent に渡る文章なので Step 1 の後に扱う。
- 置き場所: 運用（campaign 設定）。prompt 行は Step 1 後。

### 2.2 発見と検証の分離

- 今あるもの: 検証は gVisor の Lab と nonce 付き canary の判定器で、発見者の自己申告を使わない（SPEC 第 2 節 不変条件 3）。handoff の skill `wbh-verify` は review export と `lab.json` だけを読むので、発見者の文脈を持たない validator に当たる（ADR 0035）。
- 欠けているもの: 検証の適用範囲が揃っていない。自動 `verifier-v8` は 40 回で confirmed 0、handoff は 22 回で confirmed 3（[設計課題 3.1](2026-10-20-design-issues-from-production-results.md)）。`verify next` は `--campaign` で絞るため（[pipeline.ts:1060-1065](../../src/cli/pipeline.ts)）、handoff を回す campaign は操作者が選んでいる。Claude の scope 内 Finding 24 件のうち handoff に届いたのは 1 件（confirmed 1 件）で、23 件は自動検証の `incomplete(precondition)` か未検証のままである（2026-10-21 時点の本番台帳）。PR #415 の実測では、handoff 経路は 23 件中 12 件が判定器の結論に届いた。
- 最小の変更: 設計課題 3.1 の A。runner の自動検証を止め、受理した scope 内 Finding はすべて handoff 列に入れる。削除なので Step 1 の凍結の内側。#352 受け入れ後の #353 と同じ PR で消せる。Issue は #423。
- 置き場所: Harness（削除）。

### 2.3 重複排除

- 今あるもの: 2 つ。campaign 内の完全一致 signature（[record-discovery-report.ts:45-46,115-118](../../src/discovery/record-discovery-report.ts)。`foundNew` の判定にだけ使う）と、公開情報との照合（skill `wbh-dedupe`、[duplicate-lookup.ts](../../src/profiles/wordpress/wordfence-history/duplicate-lookup.ts)）。
- 欠けているもの: 近い Finding を束ねる段。acf-extended の 14 件が 14 回の Lab と 14 の review 項目になった（設計課題 3.3）。
- 最小の変更: 設計課題 3.3 の A。受理時に、同じ Snapshot 内で `sourceTrace` の plugin 側 `file:function`（[finding.ts:60-64](../../src/profiles/wordpress/discovery/finding.ts)）が 1 つでも重なる Finding を同じ群にし、群の識別子を `finding-recorded` に足す。`review` と `verify next` は群の代表を先に出す。捨てない。判定と提出の単位は Finding のまま。集合の重なりの判定で判断を要しないので Harness 側に置ける（AGENTS.md「Harness と AI の責務」）。14 件は 5 群、6 件は 1 群になる。Issue は #424。
- 置き場所: Harness（追加）。Step 1 の凍結は「バグ修正と削除」なので、例外は所有者が決める。

### 2.4 モデルの階層化

- 今あるもの: 無い。Claude profile は Root も子も `claude-opus-5-5` の literal（[agent-runtime-profile.ts:57,71-74](../../src/discovery/agent-runtime-profile.ts)）。broker は grant 1 件に 1 モデル（[provider-credential-egress-broker.ts:454-459](../../src/discovery/provider-credential-egress-broker.ts)、[provider-credential-proxy.ts:360-363](../../src/discovery/provider-credential-proxy.ts)）。sandbox は子のモデル環境変数を Root と同じ値にしている（[claude-gvisor-sandbox.ts:342-345](../../src/discovery/claude-gvisor-sandbox.ts)）。
- 欠けているもの: 役割ごとにモデルを選ぶ配線（#418）。
- 最小の変更: 4 か所。profile の Claude モデルを Root と子で別に持つ enum、broker と proxy が profile digest に結び付いた 2 モデルだけを通す（受領書に両方残す）、sandbox が子のモデルを `CLAUDE_CODE_SUBAGENT_MODEL` と `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` で固定、Root の turn ごとのモデル確認を `incomplete(policy)` に落とす。既存の digest は変えない。
- 公開例との対応: 子は「幅」なので安いモデルの候補。`wbh-review` と `wbh-dedupe` の要約も安いモデルの候補で、これは skill を回す側の選択で済む。`wbh-verify` は強いモデルのまま。
- 実験: dev set（tp326、tp331、ssa、brizy、relevanssi、geodir）で Root を Opus に固定し、子を Opus / Sonnet / Haiku の 3 水準にする。Claude は dev set を走っていないので Opus/Opus も arm として走らせる。Snapshot、v8 digest、時間、同時数、handoff の Verifier を揃え、arm は交互に回す。同じ slug の反復は所有者の事前承認が要る（ADR 0032 Q6）。
- 置き場所: Harness（配線）。所有者が 2026-10-20 に実施を決めた。

### 2.5 検証と triage が律速

- 今あるもの: 数字がこの形を示している。scope 内 Finding 51 件のうち handoff 到達 12 件、confirmed 4 件、`review-decided` 0 件（2026-10-21 時点の本番台帳。設計課題 3.2）。
- 欠けているもの: 検証と review の処理量。探索を増やす前に、ここを通さないと候補が溜まるだけになる。
- 最小の変更: コードは不要。Claude の 23 件に `verify next --handoff` を回し、confirmed 3 件に `wbh-dedupe` → `wbh-review` → `review decide` を回して 1 件あたりの所要分を記録する。これは Step 1 の完了条件でもある。Issue は #425。
- 置き場所: 運用（skill）。

## 3. 取り入れないもの

- validator の自己申告を confirmed にすること。公開例の多くは validator agent の再現報告で確定するが、ここは判定器の canary 回収だけを証明にする（SPEC 第 2 節 不変条件 3）。再現の失敗も `incomplete` にとどめる（不変条件 4）。この差は意図した差なので残す。
- 同じ対象に独立した Trial を多数走らせること。Cloudflare 型の「1 対象に 50 本」は ADR 0029 の「対象ごとに 1 回の協調 Trial」と ADR 0032 Q6 に当たる。幅は Root の下の子の数で取る。やるなら所有者の決定として ADR に追記する。
- 探索の「やり方」を Harness のコードに入れること（LESSONS 14）。どの子に何を任せるかは Root の prompt の仕事で、Harness は子の数、時間、モデル、出力の保存だけを持つ。

## 4. 進める順番（問い 1 つ = PR 1 本）

| 順 | 問い | 種別 | 既存の参照 |
| --- | --- | --- | --- |
| 1 | Claude の 23 件を handoff で検証すると confirmed が何件出るか | 運用。コード無し。今日から回せる | #425、設計課題 3.2 |
| 2 | 自動検証を止めて全件 handoff にすると、Lab 1 回あたりの confirmed はどう動くか | 削除。凍結の内側 | #423、設計課題 3.1 A、#353 |
| 3 | `file:function` の重なりで束ねると、review 項目と Lab の回数は何分の一になるか | 追加。所有者が 2026-10-21 に例外として承認 | #424、設計課題 3.3 A |
| 4 | Root Opus 固定で子 Opus / Sonnet / Haiku を変えると、dev set の source 付き critical route と handoff の confirmed はどう動くか | 配線 + 実験。所有者決定済み | #418 |
| 5 | 子の寿命を prompt で制限すると候補の数と質はどう動くか | prompt 行。Step 1 後 | 出典対照表 66〜67 行 |

1 と 2 は 4 の前提になる。検証の経路が runtime で違ったままだと、モデル比較は検証経路の差を測ってしまう（[監査](2026-10-20-multi-agent-discovery-audit.md)の「3 対 0」の件）。

## 5. 未確認

- 公開例の「安いモデルで幅を取る」が、WordPress plugin の source 読解で成り立つかは測っていない。4 の実験で初めて数字が出る。
- 3 の群化で「同じ `file:function` でも別の脆弱性」がどの頻度で起こるかは未計測。群を表示と順序にだけ使うのはこのため。
- Claude Root の `filesRead` が 0 のまま（監査）。1 の前に観測を直さないと、Root の読みの幅は比較できない。
