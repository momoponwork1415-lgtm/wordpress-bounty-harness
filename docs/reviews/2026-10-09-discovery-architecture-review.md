# 探索アーキテクチャの独立レビュー（2026-10-09）

位置づけ: 独立レビュアーの設計提案。正本（SPEC.md / ADR）ではない。コードは変更していない。未コミットの変更（入口分担、`short-source-http-v1`、`wp2shell-single-http-v1`、Lab `initialOptions`、exit code 非ゼロ run の受理）を現状として扱った。

読んだもの: AGENTS.md、SPEC.md（全節）、ADR 0001–0012、DESIGN-EVIDENCE.md、OPERATIONS.md、ARCHITECTURE.md、spike/results-2026-10-08.md、`src/discovery/campaign.ts`、`codex-native-agent-runtime.ts`、`codex-gvisor-sandbox.ts`、`native-run-receipts.ts`、`src/cli/wordpress.ts`、`pipeline.ts`、`wordpress-host.ts`、`src/ledger/index.ts`、`src/verification/index.ts`、profile の prompt 6 本、`lab/index.ts`、`verification/judges.ts`、`codex-verifier.ts`、`discovery/entry-points.ts`、`finding.ts`、選定方針。参照実装は v7 prompt 原文と TranslatePress 公開 CVE 比較文書の 2 本。

参照できなかったもの（推測で埋めていない）: 旧リポジトリの Research Campaign の継続・checkpoint 実装、DeepSeek 評価文書（`deepseek-wp2shell-v7-...-2026-09-20.md`）と比較集合 8 件の内訳、ADR 0115、Mantis の graph 定義、ChatGPT プランの quota の数値と Codex CLI が返す使用率の取得口。

## 0. 結論

- 推奨は **D を骨格にし、B の「深さ」と Mantis の「自前候補の継続」だけを取り込んだ混合**。名前は「索引分担つき深い独立 Trial」。A の独立性と統計単位、Harness が手順を持たない規則、判定器の独占は維持する。変えるのは「探索の単位を短い run から時間を使う Trial にする」「分担を登録 file ではなく保存先で結ばれた連結成分にする」「WordPress core を source pack に入れる」「Trial 内部に限って自前の Lead を継続できる」の 4 点。
- 現行 A の 0 Finding は方式の否定材料にならない。core なし、DB なし、実行失敗 49%、完了 run が 72–147 秒という計測条件の問題が先にある。
- 発見率より先に **報奨への転換率を止めている欠陥が verification にある**。RCE / Stored XSS の canary を本番で発行する経路がなく、ATO の session 証明の受け口もない。これは探索方式に関係なく最初に直す。
- SPEC 第 6 節「短い目的 prompt 1 本、当面 A/B しない」は **改訂を勧める**。理由は、現状の 0 件を説明する最有力仮説が「探索の管理（止めない、registry、継続）の指示の有無」であり、それを測る手段を SPEC が禁じているため。ただし「手順 checklist を Harness に持たせない」規則は残す。

## 1. 実測と現行コードから言えること

| 事実 | 出所 | 含意 |
| --- | --- | --- |
| 短い目的 prompt、完了 20 run で Finding 0。run は 72–147 秒 | 比較文書、メモ（2026-10-09） | 50k 行級 plugin を 2 分で終えるのは読んでいない。深さの不足が先 |
| 39 run 中 19 が未完了・失敗 | 同上 | 失敗理由（provider / schema / sandbox）が台帳イベントに出ない。`reason` は private receipt の中だけ |
| 探索 sandbox は plugin だけを `/workspace/main` に mount。core は渡していない | `wordpress-host.ts sourceFor`、`codex-gvisor-sandbox.ts` | SPEC 第 4・5 節の Dependency Snapshot は実装されていない。plugin→core→plugin の経路は source から追えない |
| 探索コンテナに渡すのは Lab の WordPress の address だけ。DB と canary 受信先は address も認証情報も渡していない（同じ internal network 上にはあるが、spike のとおり DNS は引けない） | `codex-gvisor-sandbox.ts`（`--add-host` 1 件）、spike | `short-objective-v1` は DB 読みと canary 確認を許可すると書くが実際はできない。prompt と能力の不一致 |
| Codex は `features.multi_agent=false`、profile は subagent を `unavailable` 固定 | `codex-native-agent-runtime.ts` | B（Root＋subagent）は transport 変更なしでは動かず、動かしても ADR 0007 の subagent 記録が埋まらない |
| `prepareExecutionCanary` / `prepareScriptCanary` を本番で呼ぶ箇所がない | grep: 呼び出しは tests のみ | RCE / php-file-write / Stored XSS の判定器は常に `incomplete(precondition)`。High Threat 2 分類が確認できない |
| Verifier の報告は `http.json` / `steps.md` / `route.json` / `refutation.md` / `precondition` のみ。`session.json` を書く経路がない | `verifier-v1.md`、`codex-verifier.ts`、`judges.ts observePrincipals` | 管理者 session cookie による ATO 証明は出せない。role 変更による昇格だけが観測可能。開発セットの ATO はこの経路で落ちる |
| SQLi 読出しと file 読出しの判定は Verifier が書いた応答本文に canary 値があるかを見る | `judges.ts returnedOnly` | Harness は HTTP を捕捉していない。nonce の秘匿だけが証明の強さ |
| 入口分担は `add_action` / `add_filter` / REST / shortcode の正規表現で登録 file ごとに束ねる | `entry-points.ts` | producer（書く入口）と consumer（読む入口）が別 file なら別 run に分かれる。公開 ATO 型の経路に不利 |
| v7 の Luna 単体追試（27 分）で公開 Stored XSS の source Candidate。DeepSeek v7 独立 3 試行で ATO は 1 試行 | 比較文書 | 1 Trial に時間を使えば候補は出る。独立反復と試行内の深掘りは別の予算判断 |
| Mantis は自前の読出し primitive を次段へ渡した改変 graph だけが ATO の source 経路を残した。標準 graph は途中で捨てた。`cross-functional` は core を 1 度も読まなかった | 比較文書 | 効いたのは「段階」ではなく「候補の引継ぎ」と「core を読める scope」。多段 workflow 自体の効果は示されていない |

## 2. 推奨アーキテクチャ: 索引分担つき深い独立 Trial

### 2.1 図

```mermaid
flowchart TB
  subgraph HARNESS[Harness（隔離・分担・停止・判定・記録だけを持つ）]
    direction TB
    SNAP[Snapshot<br/>plugin + WordPress core（Dependency）<br/>両方を digest 固定] --> IDX[profile: 機械索引<br/>入口 / 保存先 key / producer・consumer / core 交差 hook<br/>判断はしない。digest を記録]
    IDX --> PART[分担: 保存先で結ばれた連結成分ごと<br/>producer と consumer を同じ Trial に入れる]
    PART --> TQ[Trial 待ち行列<br/>対象あたり T_max（初期 6）]
    TQ --> T1[Trial 1] & T2[Trial 2] & Tn[Trial n]
    T1 & T2 & Tn --> STOP{新規 Finding も Lead もない<br/>Trial が k_t（初期 3）連続?}
    STOP -->|いいえ| TQ
    STOP -->|はい| END[discovery-concluded]
  end
  subgraph TRIAL[Trial 1 つ（独立試行の単位。他 Trial を知らない）]
    direction TB
    R0[探索 run: 新しいコンテナ<br/>wall 90 分（初期）<br/>入力: 目的 prompt / trust 境界 / 分担 scope / plugin+core RO / Lab HTTP + RO DB / subscriber] --> OUT0[出力: Finding[] + Lead[] + examined / unexamined]
    OUT0 -->|Lead あり、継続 axis が有効| C1[継続 run: 新しいコンテナ<br/>wall 30 分、Lead ≤2 件、1 hop<br/>入力: その Trial 自身の Lead + 索引の近傍だけ]
    C1 --> OUT1[出力: Finding[] + Lead[]]
    OUT0 & OUT1 --> LED[(ledger: trialId / continuationOf / scope / reason)]
  end
  T1 -.-> TRIAL
  LED --> V[Verifier（新コンテナ）+ 判定器<br/>canary を Harness が発行して渡す<br/>HTTP は Harness が捕捉 / 再生]
```

### 2.2 Q1. 探索の単位、境界、停止、時間、同時数、cap、quota 配分

- **探索の単位 = Trial**。1 Trial は「1 つの分担 scope、新しいコンテナ、wall time 上限、他 Trial の情報なし」。pass@k の k は Trial 数で数える。現行の run は Trial の中の 1 run に降格する。
- **独立試行と試行内継続の境界**:
  - 独立試行: Trial 同士は何も共有しない。Finding / Lead / transcript を別 Trial に渡さない。
  - 試行内継続: 1 Trial は自分の Lead（完全経路に届いていない primitive）を seed に、最大 2 件 × 1 hop の継続 run を出せる。継続 run は新しいコンテナで、受け取るのは「その Lead の記録」と「索引上の近傍（同じ保存先 key の producer / consumer、交差する core hook）」だけ。継続 run の Finding は親 Trial の成果として数え、独立試行数を増やさない（比較文書の採点規則と同じ）。
  - 継続は opt-in の axis（campaign 設定 `continuation` ブロック、profile 1 file、台帳に `continuationOf`）。消せる形にする（メモ「実験軸は消せるように」）。
- **停止規則（Harness 所有、prompt には書かない）**:
  - run: wall time。探索 run 90 分、継続 run 30 分（初期値、推測。根拠は v7 Luna 27 分で候補、Mantis 23 分〜2 時間で候補なし、現行 2 分で 0 件）。
  - Trial: 探索 run 完了後、Lead が 0 なら終了。Lead があれば継続 run を上限まで。
  - 対象: T_max = 6（初期値、推測）。新規 Finding も新規 Lead も出ない Trial が k_t = 3 連続で早期終了。新規性は署名（claim / impact / sourceTrace、Lead は primitive / storageKey）の重複除外で判定。現行の k = 4 連続「run」は、Trial が少数になるので「Trial」に置き換える。
  - campaign: provider-limit と daily cap は現行のまま。
- **同時実行**: 初期 2 Trial / ホスト（推測）。メモリ上は 4 まで可能だが、ChatGPT プランは 5 時間窓の使用率で絞られる。同時 4 で 90 分 run を回すと窓の前半で使い切り、後半が provider-limit 停止になる可能性がある。2 で始めて `ledger usage` の日次合計と停止回数で上げる。
- **daily cap**: run 数でなく Trial 数で持つ。初期 6 Trial / 日（推測）。対象 1 つを 1 日で終える想定。
- **quota 配分**（週単位、初期値、推測）: 探索 run 65%、継続 run 20%、Verifier + 再検証 15%。配分は token でなく「Trial 数と継続数」で守る。`ledger usage` に Trial 種別（explore / continue / verify）ごとの token 合計を出し、1 Trial あたり中央値から週の Trial 数を決める。cache 混入は gross から分けられないので、配分の単位は token にしない。

### 2.3 Q2. plugin→core→plugin、設定変更時、producer / consumer

- **source pack**: plugin（`/workspace/main`）に加え WordPress core を `/workspace/wordpress` に RO mount。Dependency Snapshot の digest を CampaignInput と run 記録に入れる。SPEC 第 4・5 節がすでに Dependency Snapshot を定めているので、これは実装の追いつきであり設計変更ではない。
- **機械索引（profile、判断しない、text 走査）**。現行 `entry-points.ts` を拡張する:
  1. 入口: 現行の 7 種（ajax / admin-post / REST / shortcode / request-hook）に `template_redirect` 等の既存集合を維持。
  2. 保存先 key: `update_option` / `get_option`、`update_post_meta` / `get_post_meta`、`update_user_meta` / `get_user_meta`、`set_transient` / `get_transient`、`$wpdb->insert|update|get_*`（table 名）、`file_put_contents` / `wp_upload_bits` / `move_uploaded_file`。第一引数が文字列定数なら key、変数なら `dynamic` と記録。
  3. 辺: 入口 → その入口から到達する関数（同一 file と `include` 先、1 hop）→ 保存先の write / read。producer = write を持つ入口、consumer = read を持つ入口。
  4. **core 交差辺**: plugin が core の秘密生成・送信・認証 hook に掛ける callback（`retrieve_password_message`、`wp_mail`、`authenticate`、`wp_login`、`user_register`、`lostpassword_post`、`password_reset`、`wp_insert_post_data`、`pre_option_*`、`rest_pre_dispatch` 等）と、plugin が呼ぶ core API（`get_password_reset_key`、`wp_generate_password`、`wp_set_auth_cookie`、`wp_create_nonce`、`wp_mail`、`wp_update_user`）。これを「秘密の producer が core、保存先が plugin、consumer が匿名入口」の候補として scope 文に明記する。
  5. 分担は「保存先 key で結ばれた連結成分」。1 Trial に producer と consumer が同居する。成分が大きければ key 数で分割し、分割境界の key を両側の scope に書く。
- **設定変更時の経路**: 索引が `get_option` で読む plugin 設定 key と、その設定画面の既定値を列挙する。campaign の Lab `initialOptions`（未コミットで追加済み）を使い、Trial の一部に「plugin 自身の設定で有効化できる 1 機能を on にした Lab」を割り当て、Lab Setup digest と Trial 記録に残す。Finding の `configurationPrecondition` に設定名を書かせ、scope 評価で「管理者の誤設定」か「通常の機能有効化」かを人間が判断する（Wordfence は前者を却下、後者は通例受理。推測）。既定設定 Lab を過半に保つ。
- **producer / consumer の追い方**: Trial の探索 run が「読出し primitive は見つけたが consumer が不明」「書込み primitive は見つけたが特権 consumer が不明」を **Lead** として出す。Lead は Finding と別の型で、`attackerPosition`、`primitive`（read / write）、`storageKey`、`sourceTrace`、`missingEdge`（producer / consumer / auth-use）、`evidence`（Lab 観測）を持つ。継続 run は Lead の `storageKey` の近傍を scope に受け取る。これが Mantis で効いた「自前 primitive の引継ぎ」を Harness が最小の形で持つもの。v7 の「primitive の lifecycle を全部追ってから park する」規則と同じ内容を、prompt の手順でなく出力型と scope の設計で実現する。

### 2.4 Q3. 切り分けのための台帳項目

現在の `discovery-run-started` / `finished` は promptVariant、assignmentUnit、history、usage、wallTimeMs、outcome しか持たない。失敗理由は private receipt の中にある。次を台帳イベントに追加する（値はすべて digest か列挙、本文は Private Evidence）:

| 項目 | 何を切り分けるか | 置き場 |
| --- | --- | --- |
| `trialId`、`runKind: explore / continue`、`continuationOf: leadId` | 独立試行と継続の区別、pass@k の分母 | run-started |
| `scope: { indexDigest, partition, of, componentKeys[] の digest }` | 分担の効果、producer / consumer 同居の有無 | run-started |
| `sourcePack: { targetDigest, dependencyDigest \| none }` | core 同梱の有無 | CampaignInput、run-started |
| `labAccess: { http, dbRead, canaryRead }` と `labReachability: ok / failed`（agent 起動前に Harness が sandbox 内から `curl` と DB ping を打つ） | 「Lab に届いていた run」と「届いていなかった run」の分離。現状は分からない | run-started |
| `promptDigest`、`trustBoundaryVersion`、`managementVariant: none / registry` | prompt 差 | run-started（promptVariant は既存） |
| `reason: provider / schema / sandbox / policy / evidence`、`providerLimit`、`sandboxExitCode`、`diagnosticArtifactDigest` | 実行失敗の種類。現状は receipt の中 | run-finished（receipt から昇格） |
| `observed: { toolCalls, filesRead, uniqueFilesRead, labRequests, dbQueries }`（transcript の `command_execution` を Harness が数える。agent の自己申告ではない） | 読んだ深さ。2 分 run と 90 分 run を同じ「completed」にしない | run-finished |
| `usage.cachedInputTokens` を分けて集計（既存）に加え `quotaWindowPercentBefore / After`（Codex が返すなら。返さなければ `unavailable`） | quota 配分 | run-finished |
| `leadsRecorded`、`lead-recorded` イベント（leadId、storageKey の digest、missingEdge） | Lead の発生と継続の効果 | 新イベント |
| verification: `evidenceCapture: agent-authored / harness-captured / replayed`、`canaryIssued: execution / script / none` | 判定の証明の強さ | verification-finished |

### 2.5 Q4. SPEC「短い目的 prompt 1 本、A/B しない」をどうするか

**改訂を勧める。** 根拠:

- 現行 0 件の最有力説明は「探索の管理（止めない、registry、primitive の lifecycle を追う）の指示がない」ことと「深さを使える条件がない」ことの 2 つで、どちらが効いているかは prompt を軸にしないと分けられない。
- SPEC 第 6 節が wp2shell 型を退ける理由は「解が必ず存在し費用無制限」の前提。しかし費用の上限は Harness の wall time と Trial 数が持つ（第 6 節自身がそう定める）ので、prompt が「frontier が残る限り続けよ」と言っても費用は Harness が切る。退ける理由は prompt でなく停止規則の設計で解消している。
- リポジトリにはすでに `wp2shell-derived-v1`、`wp2shell-single-http-v1` が入っており、campaign 設定で選べる。SPEC と実装がすでに食い違っている。

改訂案:

- SPEC 第 6 節「入力」: 「短い目的 prompt の 1 本だけ」→「目的 prompt は短く、目的・trust 境界・影響分類と報奨順・出力形式だけを書く。探索の手順、checklist、役割分担、段階は書かない。**探索の管理（止める条件の考え方、primitive の lifecycle を追うこと、自分の仮説の registry）を書く版は、版と digest を記録した上で本番 A/B の軸にできる**。既定は A/B の結果で決める」。
- SPEC 第 10 節「本番 A/B」: 「prompt は 1 本で固定し当面軸にしない」→「prompt 変種（管理指示の有無）を軸に加える」。
- AGENTS.md「探索 prompt の規則」: 「wp2shell 由来の prompt を持ち込まない」→「wp2shell 由来の**手順 checklist と役割分担**を持ち込まない。管理指示の変種は版付きで A/B する」。
- ADR 0013（新規）: 「探索 prompt の変種は管理指示に限り本番 A/B の軸にする」。退けた選択肢: 1 本固定（測れない）、手順 checklist の導入（Anthropic の観察どおり新規性を下げる懸念、DESIGN-EVIDENCE 第 4 節）。
- DESIGN-EVIDENCE 第 4 節: 「当面は測らない」→「測る」に更新。
- SPEC 第 4 節「持ち込まないもの」から「継続 Campaign」を外し、「Trial 内の 1 hop 継続（opt-in axis）」を第 6 節に加える。ADR 0014（新規）: 「候補の継続は同一 Trial 内に限り、Harness が Lead の近傍だけを渡す」。独立試行数を増やさない採点規則を明記。

### 2.6 Q5. Verifier が作った HTTP 記録を判定器が読む経路は十分か

**分類別に答えが違う。読出し系は不十分。**

| 判定器 | 証拠の出所 | 評価 |
| --- | --- | --- |
| 管理者 / 非管理者 principal（role 変更） | Harness が Lab の role を読む | 独立。十分 |
| 管理者 principal（session） | Verifier が書く `session.json` の cookie を Harness が Lab で照合 | 設計上は独立だが、**Verifier が `session.json` を書く経路がない**。ATO は現状確認不能 |
| SQL 書込み | Harness が canary 表を読む | 独立。十分 |
| SQL 読出し、file 読出し / LFI | **Verifier が書いた `http.json` の応答本文**に canary 値があり、request に無いこと | Harness は HTTP を捕捉していない。証明の強さは nonce の秘匿のみ。agent が別経路で値を得て本文に貼れば通る。request 側の検査は `JSON.stringify` の部分一致で、encode された値を見逃す |
| Execution Canary | Harness が Lab 内の marker を読む | 独立だが **canary を発行して Verifier に渡す経路がない**。常に `not-prepared` |
| file 削除、options | Harness が Lab を読む | 独立。十分 |
| Stored XSS | Harness の browser と受信先 log | 独立だが **script canary を発行する経路がない**。常に `not-prepared` |

直し方（順に強くなる）:

1. 最小: Verifier run の前に Harness が `prepareExecutionCanary` / `prepareScriptCanary` を呼び、nonce と beacon URL を Verifier prompt の `## Lab` に入れる。報告 schema に `session.json`（取得した cookie）を加える。これで RCE / XSS / session ATO が判定可能になる。
2. **Harness 捕捉**: Lab network に記録用 reverse proxy（`wbh-<id>-proxy`）を置き、Verifier には proxy の address を Lab endpoint として渡す。判定器は proxy の記録を読み、`http.json` は人間向けの補助にする。request 側の canary 検査も proxy 記録に対して行う。
3. **再生**: `route.json` の `steps` を構造化 request 列にし、Harness の決定論的 replayer が新しい Lab で再生して観測する。再現パッケージの Python script はこの request 列から機械生成できる（SPEC 第 7 節の要件と一致）。runtime-confirmed の定義を「Harness の再生で canary 回収」に寄せれば、ADR 0004 の趣旨に最も近い。

1 は数十行、2 は Lab 1 コンテナ、3 は新モジュール。1 と 2 を先に、3 は確認件数が出てから。

### 2.7 Q6. 探索以外の実際のボトルネックと、今は作らないもの

発見率・転換率を止めている順:

1. **verification の canary 発行と session 受け口の欠落**（上記 1）。最も高い報奨帯（High Threat の RCE / file write、ATO）が構造的に `incomplete` になる。探索がどれだけ当たっても報奨に変換されない。
2. **source pack に core がない**。探索と Verifier の両方が core の挙動を記憶で補うことになる。Dependency Snapshot の実装。
3. **探索コンテナから DB に届かない**のに prompt が許可すると書く。RO の DB account を Lab に作り `--add-host` で渡すか、`short-source-http-v1` を既定にして約束を消す。前者を勧める（ADR 0003 の趣旨）。
4. **失敗 49% の理由が台帳で見えない**。`reason` の昇格と Lab 到達 preflight。
5. **Verifier の HTTP 記録が agent 自己申告**（2.6 の 2）。

今は作らないもの: 2 つ目の profile 向けの汎用化、Patchstack adapter の拡張、held-out 評価、`sensitive-object-access` 判定器、Codex subagent 対応、Mantis 型の多段 graph、coverage 台帳、selection の採点精緻化、重複照合の自動化。selection / snapshot（core 同梱を除く）/ scope / review / ledger（項目追加を除く）は現状で律速ではない。

## 3. 他案を退ける根拠と、未確認の仮定

- **A（現行の短い独立 run を多数）**: 1 run あたりの当たり確率 p が 0 に近いとき、1 − (1 − p)^k は k を増やしても 0 のまま。計測は p ≈ 0 を示す（完了 20 で 0）。独立反復は p がある程度あるときに効く設計で、まず 1 Trial の p を上げる必要がある。また独立 run は producer と consumer を別 run に分けるので、公開 ATO 型（core が秘密を作り plugin が保存し匿名入口が読み、core が認証に使う）の 4 段経路を 1 run で閉じにくい。退けるのは「短い run」であり「独立性」ではない。
- **B（Root＋subagent の深い Campaign を独立複数）**: 現行 transport は multi-agent を無効にし、subagent の model / effort を記録できない（ADR 0007 の必須項目が埋まらない）。DeepSeek v7 の 4/8 が subagent のおかげか単に時間のおかげかは分からず、Luna の単体追試（subagent の有無は文書に記載なし。限界）は 1 セッションで候補を出した。quota の消費が subagent 分だけ不透明になる。**推測**: 効いたのは「深さ」と「primitive の lifecycle を追う管理」で、4 agent の並列ではない。この仮定は A/B の prompt 軸で測る。
- **C（Mantis 型の段階的 workflow）**: Harness が段階を持つのは AGENTS.md の「手順はエージェントが決める」に反する。実測では標準 graph が途中段階で経路を記述しながら最終 Finding で捨て、`cross-functional` は 2 時間 444 呼び出しで core を 1 度も読まなかった。効いた唯一の要素（自前 primitive の継続）だけを 2.3 の Lead 継続として取り込む。
- **D 単独（索引で候補だけ深掘り）**: 索引を「候補の filter」にすると索引の漏れがそのまま見逃しになる。索引は scope と近傍の供給に限り、agent の探索を制限しない（現行 `file-assignment-v1` 第 3 項と同じ立場）。

未確認の仮定（すべて推測）:

1. wall time を 30 分から 90 分にすると Luna / Sol が実際に時間を使う（現行 2 分で終えるのは prompt の性質か、model の性質か未分離）。
2. Lead 継続が独立 Trial の追加より quota 効率が良い。
3. 保存先 key の text 走査が TranslatePress 以外の plugin でも producer / consumer を十分に結ぶ（動的 key、class 経由の間接呼び出しは取りこぼす）。
4. ChatGPT プランの 5 時間窓で同時 2 Trial × 90 分が収まる。
5. 「plugin 設定の有効化」を Wordfence / Patchstack が既定設定と同等に扱う。

## 4. 現行コード・SPEC との具体的な差分

| 場所 | 現状 | 差分 |
| --- | --- | --- |
| SPEC 第 4 節「持ち込まないもの」 | 継続 Campaign、条件付き 3 試行を持ち込まない | 「継続 Campaign（checkpoint 再開）」は引き続き持ち込まない。「Trial 内 1 hop 継続」を第 6 節に追加 |
| SPEC 第 4・5 節 Dependency Snapshot | 定義あり、実装なし | `snapshot` / `sourceFor` が core を materialize し `/workspace/wordpress` に RO mount。CampaignInput に `dependencyDigest` |
| SPEC 第 6 節 入力・停止規則・同時実行 | 短い prompt 1 本、k = 4 run、N = 40、同時 4、wall は run ごと | Trial 単位（T_max 6、k_t 3）、wall 90 / 30 分、同時 2、daily cap を Trial 数で。prompt 変種を A/B 軸に |
| SPEC 第 6 節 許可する操作 | DB 読みと canary 確認を許可 | Lab に RO DB account を作り到達させるか、許可文を消す。どちらかに揃える |
| SPEC 第 7 節 Verifier | Finding / source / Lab を渡す | canary nonce と beacon URL を渡す。報告に `session.json`。HTTP は Harness 捕捉 |
| SPEC 第 9 節 台帳 | run 記録の項目 | 2.4 の項目を追加。`lead-recorded` イベント |
| SPEC 第 10 節 本番 A/B | prompt は軸にしない | prompt（管理指示）と継続（有無）を軸に追加 |
| AGENTS.md 探索 prompt の規則 | wp2shell 由来を持ち込まない | 手順 checklist と役割分担を持ち込まない、に限定 |
| ADR | 0012 まで | 0013 prompt 変種の A/B、0014 Trial 内 Lead 継続 |
| `src/profiles/wordpress/discovery/entry-points.ts` | 入口の正規表現と file 束ね | 保存先 key、producer / consumer、core 交差 hook の走査。連結成分で分担。同 file に閉じるので削除可能性は保てる |
| `src/profiles/wordpress/discovery/finding.ts` | Finding のみ | `Lead` 型と `admitWordPressLead` |
| `src/discovery/campaign.ts` | run の列を回す | Trial の列を回す。`runKind`、`continuationOf`、Lead 署名の重複除外、k_t を Trial で数える。継続は `continuation` option が無ければ現行動作 |
| `src/cli/wordpress.ts` | `assignment` axis、prompt 組立 | `continuation` ブロック、Trial 設定、scope 文に索引近傍。Lab の RO DB 情報 |
| `src/discovery/codex-gvisor-sandbox.ts` | source 1 mount、`--add-host` 1 件 | core の第 2 mount、DB の `--add-host`、起動前 reachability probe |
| `src/profiles/wordpress/lab/index.ts` | canary 発行 API あり、未使用 | RO DB user、記録 proxy コンテナ（任意）、発行 API を Verifier 経路で呼ぶ |
| `src/profiles/wordpress/verification/codex-verifier.ts`、`verifier-v1.md` | 5 fields | canary を prompt に、`session.json` を schema に、proxy address を endpoint に |
| `src/profiles/wordpress/verification/judges.ts` | `http.json` を読む | proxy 記録を優先し、無ければ `http.json`（`evidenceCapture` を記録） |
| `src/ledger/index.ts` | イベント union | 2.4 の項目と `lead-recorded` |
| `examples/translatepress-3.2.5/` | 40 run の設定 | 4 arm の A/B 設定（第 5 節） |

## 5. 実装順

1. **verification の穴を塞ぐ**（canary 発行を Verifier に渡す、`session.json`、`reason` の台帳昇格、Lab 到達 preflight）。探索方式に依存せず、開発セット 3 件の判定器テストで確かめられる。
2. **source pack に core を入れる**（Dependency Snapshot の materialize と第 2 mount）。Verifier にも効く。
3. **Lab の RO DB 到達**か prompt の約束の削除。前者を推奨。
4. **Trial 化**（wall 90 分、T_max、k_t、daily cap の単位変更、台帳項目）。継続はまだ入れない。
5. **索引の拡張**（保存先 key、producer / consumer、core 交差、連結成分分担）。
6. **A/B 軸**: prompt 変種と継続。継続の Lead 型と `continuationOf`。
7. 第 5 節の A/B を開発セットで回し、既定を決める。
8. Harness 捕捉 proxy。再生 replayer は confirmed が出てから。

1〜3 で現行 A のまま再計測すると、方式を変える前に「条件を揃えた A の p」が得られる。これが A/B の対照になる。

## 6. 最小 A/B 実験（同一 model、同一 source pack、同一予算）

- 対象: 開発セット TranslatePress 3.2.5（鍵 3 件: reflected XSS は目的外なので採点対象から外し、Stored XSS と ATO の 2 件を主、reflected を参考）。
- 固定するもの: model `gpt-6-luna` effort high（本番の Sol では再実施）、source pack = plugin 3.2.5 + WordPress 6.8.3 core（両 digest 記録）、Lab 既定設定、RO DB あり、Lab 到達 preflight ok の Trial だけを分母に入れる、1 Trial の wall 90 分、継続 run は 30 分 × 最大 2、同時 2。
- 要因 2 × 2（4 cell、各 3 Trial、計 12 Trial。継続ありの cell は最大 +6 継続 run）:

| cell | prompt | 継続 |
| --- | --- | --- |
| P0C0 | `short-objective-v1`（目的のみ） | なし |
| P1C0 | 管理指示あり（`wp2shell-single-http-v1` 相当、手順 checklist なし） | なし |
| P0C1 | 目的のみ | あり |
| P1C1 | 管理指示あり | あり |

- 分担は全 cell で索引の連結成分（同じ `indexDigest`）。分担の有無は今回の軸にしない（現行の run 時間が短すぎて分担効果を測れないため、先に深さを揃える）。
- 割り当ては `allocateArm` と同じ決定論的規則で ordinal から決め、台帳に `promptVariant` と `continuation` を残す。
- 予算の揃え方: 各 cell の合計 wall time 上限を同じにする（継続ありは探索 run 90 分 + 継続 60 分 = 150 分 × 3）。継続なし cell は探索 run を 150 分にする（時間を揃える）か 90 分のまま（run 構成を揃える）かで結果の読みが変わるので、**両方を記録して「時間一定」と「構成一定」を別表にする**。token は `ledger usage` で cell ごとに合計し、cache 込みの gross と cached を分けて示す。
- 先行の基準（比較文書・メモの 0/20）は条件が違うので対照に数えず、参考として併記する。

事前登録する判定規則:

- 主指標は「公開 ATO の完全経路（source）を出した Trial 数 / Trial 数」と「Stored XSS の source Candidate を出した Trial 数 / Trial 数」。Clopper-Pearson 95% を付け、重なれば「判定不能」。
- n = 3 では差が大きいときしか分からない。それでも決めるため: ATO 完全経路が継続あり cell で 1 件以上、継続なし cell で 0 件なら継続を既定にする。逆または両方 0 なら継続を既定にしない（安い方）。prompt も同じ規則。両方とも 0 なら、次に疑うのは model（Sol で再実施）と wall time（180 分）で、方式ではない。
- 補助指標: Trial あたり token（gross / cached）、`observed.filesRead`、core を読んだ run の割合、Lead 数、失敗率と理由、Verifier まで届いた Finding 数、`runtime-confirmed` 数。

## 7. 成功・失敗の判定指標（分けて数える）

| 指標 | 定義 | 出所 |
| --- | --- | --- |
| source Candidate | 鍵の `allowedLocations` と `location-overlap` を満たす Finding または Lead | `eval score`（Lead も採点対象に加える） |
| 完全な攻撃経路 | 盲検 rubric で target-hit（場所、root cause、攻撃者条件、影響の 4 要素） | 人間、arm を見ずに採点 |
| Lab 再現 | 判定器が `runtime-confirmed`。`evidenceCapture` を併記 | verification-finished |
| 最新版での成立 | `review reverify` が最新 snapshot で `runtime-confirmed` | verification-finished（basis: latest-version） |
| programme 適格性 | `review scope` が in-scope | scope-assessed |
| 報奨 | `submission-outcome` の rewardUsd | ledger |
| 費用 | Trial あたり token（gross / cached）と wall time、週の Trial 数、provider-limit 停止回数 | `ledger usage` |
| 健全性 | 失敗率と `reason` 分布、Lab 到達 preflight 失敗率、修正版での `control-false-alarm` | ledger、負の対照 |

成功の線（推測、本番 Sol で 3 か月）: Trial あたり source Candidate 率が 0 から有意に離れる（区間の下限が 0 を超える）、`runtime-confirmed` が月 1 件以上、in-scope 提出が月 2 件（SPEC KPI の月 2.5 件に向かう）。失敗の線: 1〜3 を直した上で Sol の 12 Trial でも source Candidate が 0 なら、方式でなく model か対象選定を疑う。

## 8. 公開してはいけないもの（この文書の扱い）

この文書は公開 CVE と公開文書の内容だけを引いた。未公開候補、payload、transcript、Lab 手順は含めていない。A/B の結果を書くときも比較文書と同じ規則（公開 CVE に対応する結果だけ）に従う。
