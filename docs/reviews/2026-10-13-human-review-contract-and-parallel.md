# 2026-10-13 人間レビューの契約と並列化: 本番 4 周の読みから

調べて報告の成果物。正本ではなく、食い違えば [SPEC.md](../SPEC.md) と [ADR](../adr/) が勝つ。対象は本番 campaign `production-2026-10-12-v3-01`〜`03`（完了）と `production-2026-10-13-v3-04`（進行中、3 対象完了時点）、既定台帳、Private Evidence。候補本文、payload、HTTP 記録はこの文書に含めない。

## 0. 所有者の決定（2026-10-13、この作業スレッド）

- 前の harness の問題は「対象選定に人間が入る」「結果確認に人間が入る」の 2 点だった。前者は自動選定で解けている。後者は人間を排除することではなく、人間が読む件数を Harness が絞ることで解く。
- 偽陰性（本物を落として報奨を逃す）は偽陽性より高くつく。Programme Boundary 内の候補は、判定器が確認できなくても人間に届ける。
- Smash Balloon のように外部サービスが要る対象は、Harness で検証が終わる必要はない。source 根拠のある経路が出ていれば人間が確認する。
- 判定器は増やさない。修正版の負の対照、ベンチマークの公正さ装備、plugin 別 scenario、新 prompt 版、新 ADR は止める。
- 対象の処理を並列化する（#184）。

## 1. 本番 4 周の事実

| 周 | 対象 | Trial 正常 / 失敗 | Finding | Lead | confirmed | incomplete の理由 | 非 cache 入力 |
| --- | ---: | --- | ---: | ---: | ---: | --- | ---: |
| 01 | 5 | 4 / 1 | 2 | 10 | 0 | no-judge 2 | 3,137,543 |
| 02 | 5 | 2 / 1、Lab 失敗 2 | 4 | 6 | 0 | no-judge 4 | 2,207,091 |
| 03 | 5 | 5 / 0 | 8 | 12 | 0 | no-judge 5、observation 2、precondition 1 | 2,533,648 |
| 04（途中） | 3 / 5 | 3 / 0 | 6 | 7 | 0 | no-judge 3、observation 2、precondition 1 | 1,479,688 |

第 3 周の 5 対象は 82 分で、1 対象 15〜20 分。`review --campaign` は `incomplete` 8 件を全部列挙し、人間が開いた Finding は 0 件。

## 2. `incomplete` 14 件（第 1〜3 周）を人間が読んだ結果

| impact ラベル | 件数 | 読んだ評価 |
| --- | ---: | --- |
| `options-update` | 2 | 1 件は未認証で保護機能の whitelist を書ける本物らしい候補（10 万インストール、公開履歴上は新規）。判定器は watch 外の option で `not-observed`。もう 1 件は旧版からの移行 site 限定で軽い |
| `sensitive-object-access` | 1 | 購読者が他訪問者のログを読める本物。Harness 捕捉の HTTP に entry が出ているが、仕込んだ canary ではないので `not-observed` |
| `csrf-to-write` | 2 | 設定依存で実害なし |
| `other` | 9 | 保護機能の弱点、無害な transient 書き込み、forwarded IP の信用。Wordfence の有償 scope に乗るものは 0 |

- 本物らしい 2 件はいずれも判定器の「見る場所」の外に落ちた。候補が偽だったからではない。
- `other` 9 件は検証 Lab を起動しておらず、費用 0。無駄は検証ではなく、探索がこれらに時間を使うことと、人間の review queue に並ぶこと。
- 第 3 周の Verifier の反証 memo は、option 書き込みの成立を自分で観測しながら「反証」として書いていた。LLM の判定は両方向にぶれる。不変条件 3 は維持する。

## 3. 既知 7 件（#127）での探索と検証の切り分け

| 事例 | 探索 | 検証 |
| --- | --- | --- |
| TranslatePress 3.3.1 ATO | 経路到達 | `runtime-confirmed`（Verifier 6 回目） |
| Brizy 2.8.11 Stored XSS | 経路到達（CVE と source 一致） | `runtime-confirmed`（Verifier 5 回目、scenario 追加後） |
| Relevanssi 4.28.3 Stored XSS | 同系統の候補 | `incomplete(recipe)`。Verifier の出力形式 |
| Simply Schedule Appointments SQLi | 対象経路は未到達。別経路の SQLi | 別経路を `runtime-confirmed` |
| TranslatePress 3.2.6 Stored XSS | Trial 未完走（未実施 2、中断 1） | 未測定 |
| Smash Balloon 4.13.0 | 未実施（Lab から外部 API に出られない） | 未実施 |
| Unlimited Elements 2.0.16 | 未実施（依存 Snapshot 未接続） | 未実施 |

探索は走った 4 件で 3 件が経路に到達した。確認できた 2 件は 5〜6 回の Verifier 試行と人手を要した。弱いのは検証で、「網の狭さ」と「Verifier の 1 回勝負」の 2 つ。

## 4. 人間レビューの契約（案）

人間が読む件数を Harness が絞り、絞った残りは判定結果に関係なく人間に届ける。

1. **Finding と Lead の境界を Programme Boundary で引く。** 候補の impact が Programme Boundary の impact 一覧（`rce`、`php-file-write`、`arbitrary-file-*`、`lfi`、`rfi`、`sqli`、`options-update`、`privesc-to-admin`、`auth-bypass-to-admin`、`account-takeover`、`privesc-to-contributor+`、`auth-bypass-non-admin`、`sensitive-object-access`、`stored-xss`）に無いもの（`other`、`csrf-to-write`、`missing-authz`、`idor`、`reflected-xss`、`content-deletion`）は、正規化後に Finding ではなく Lead として記録する。検証 queue に入れず、funnel の raw Finding に数えない。台帳と Private Evidence には残す（ADR 0018 の「棄却しない」を守る）。
2. **review queue は scope 内の Finding を全部出す。** `runtime-confirmed` と、理由を問わない `incomplete`（no-judge、observation、precondition、recipe）。外部サービス依存の `incomplete(precondition)` もここに乗る。契約は「Programme Boundary 内で source 根拠のある Finding は、判定器の結果に関係なく人間に届く」。
3. **人間が 1 画面で読める材料を付ける。** claim、attackerPosition、brokenProperty、Verifier の HTTP 捕捉の要約（method、path、status の列）、反証 memo、Lab の実行前後の差分。差分は `wp_options` 全体、users と役割、全テーブルの行数と checksum で、分類に依存しない決定論の観測。LLM に要約させる skill は、読む件数が溢れてから足す。
4. **Lead に落ちた候補の `brokenProperty` を周回ごとに一覧で出す。** ラベル付けミスで本物が落ちる経路の安全網。1 周 5〜10 行。
5. **Verifier の自動再試行（#107）。** `recipe` と `observation` は同じ Lab で 2 回まで。確認できた既知 2 件が 5〜6 回目だった事実が根拠。

やめること: 新しい判定器、修正版の負の対照、`contradicted` の自動化、plugin 別 scenario、新 prompt 版、新 ADR。1〜4 は SPEC 第 7〜8 節の状態を変えないので ADR なしで入れられる。5 は #107 が ADR を要すると書いているが、状態を足さず再試行回数を足すだけなら SPEC 第 7 節の 1 行で足りる。

## 5. 並列化（#184）の実測値

- 対象は `src/cli/pipeline.ts` の `for (const target of await pipeline.select())` で直列。`resources.maxConcurrentRuns` は同一対象の Trial 用で、対象あたり 1 Trial の既定では効かない。
- 第 4 周の実測: 協調 sandbox 約 160 MiB（上限 8 GiB）、Lab 4 コンテナ約 350 MiB、broker 約 90 MiB。ホストは 24 CPU、WSL2 に見えるメモリ 47 GiB、空き 43 GiB。
- 対象ごとの Lab、broker、sandbox は UUID 付きで名前が分かれ、同時実行で衝突しない。
- 上限の候補は provider 側の同時接続と rate limit。2 並列から始め、台帳の `incomplete(provider)` を見て上げる。3 並列なら 5 対象が 30 分弱。
- 並列化は候補の数も増やす。第 4 節の 1 と 2 を先に入れないと review queue が溢れる。

## 6. 順序と測る数字

| 順 | 作業 | 測る数字 |
| --- | --- | --- |
| 1 | 第 4 節 1〜2（Finding / Lead の境界、review queue の契約） | 1 周の review queue 件数（第 3 周なら 8 → 3）、Lead 一覧の行数 |
| 2 | 第 4 節 3〜4（差分観測器、1 画面の材料、Lead 一覧） | 人間が 1 件を読む分数 |
| 3 | #184 並列化（上限 2 から） | 5 対象の経過時間、`incomplete(provider)` の件数 |
| 4 | #107 自動再試行 | `incomplete(recipe)` / `observation` が再試行で確定に変わった件数 |

本番 campaign は止めない。第 4 周の完走後に PR #182 を merge し、以降の周回は上の変更を入れた版で回す。

## 7. 消し方

この文書は記録で、採用しなくても消すものはない。第 4 節の変更は各 PR の revert で戻る。台帳は追記専用なので、Lead に落ちた候補を Finding に戻すときは再正規化の event を足す。
