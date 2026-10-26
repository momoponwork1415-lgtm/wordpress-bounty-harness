# システム全体の監査: 評価指標、探索の深さ、要らない機能、正本とコードの食い違い（2026-10-26）

調べて報告の成果物で、正本ではない（正本は [SPEC](../SPEC.md) と [ADR](../adr/)）。所有者の問い（2026-10-26）は次のとおり。「変更を加え続けているので、ここはこうするべきというところがあるかもしれない。たとえばプロンプトの評価指標は今の 7 件でやっていて、だいたいこれでいいと思う。ただ、こうなったら合格という基準や、探索が浅すぎるか深すぎるか、そもそもこの機能は要らないのではないか、というところを見たい」。

事実（第 B〜E 節の表）、選択肢と推奨（第 F 節）、未確認の仮定（第 G 節）を分けて書く。数字は台帳か、リポジトリの文書から取った。取れなかった数字は「取れない」と書く。前日の [システムの変遷と数字](2026-10-26-system-history-and-metrics.md)（以下「変遷の報告」）と重なる数字は、同じ問い合わせで取り直した。Finding の本文、経路、payload は書かない。

- リポジトリ: origin/main `e2a99ca`（#560 の後）
- 台帳: 本番 `~/.local/state/wordpress-bounty-harness/ledger.sqlite`、開発セット `…-devset-wide-20261025`、`…-devset-wide-20261026`、`…-devset-wide-v14-20261026`。どれも scratchpad に複写してから読み取り専用で読んだ。複写は 2026-10-26 09:08Z 時点で、本番台帳の最後の event は 09:07Z である。このとき `rr14-*`（v14-wide を本番の対象で回す campaign）が 4 本走っていた。

## A. 結論

1. 今の合格基準（開発セット 6 case で「scope 内 Finding が 1 件以上」）は、もう天井に当たっている。v14-wide は 1 run で 6/6 を取った。v13-wide の 4/6 との差も、1 run ずつでは揺れと区別できない。採否には、公開経路の一致を主指標にして、各 case 3 run で比べることを提案する（第 B.3 節）。
2. 「Finding が 1 件以上」は、偽陽性を許す v14-wide では件数で満たせてしまう。v14-wide は Finding が 36 件（group 16）に増えた一方で、common-usage の割合は 7/9 から 11/36 に下がった。精度は、判定器を消した後の記録がまだ 0 件なので測れない。
3. deep（v8）は最低 60 分の床で止まっている。本番の completed 158 Trial のうち 148 が 55〜70 分で終わり、70 分を超えた 10 Trial の Finding は 0 件だった。床が候補を増やしたかどうかは、v8 に最初の最終報告の時刻が無いので判定できない。現行の deep v11 は、どの台帳にも run が 0 件である。
4. wide v14 は浅すぎない。開発セットでは Root wall 12〜34 分で止まり、6/6 を取った。浅すぎたのは本番の v10-wide（中央値 6.4 分、24 Trial で Finding 0）である。
5. 詰まっているのは探索ではなく人間の確認である。10-19 以後の本番 Finding 147 件のうち、検証まで進んだのは 77 件で、判定器が確認したのは 15 件（すべて handoff）。人間の観測（`review observe`）、再現、文案、提出はどれも 0 件である。#541 の merge（10-25 18:05Z）の後は、検証の event も 0 件である。
6. 消してよいものがある。プラグイン別の Lab アダプタとシナリオ（9 file、761 行、#353 の塞ぎは 10-26 に解けた）、テストからしか使われていない `acceptance/`、古い例（`examples/campaign-v6-measure.json`）である。保留は、使われていない探索 Lab（run 0 件）と、10-23 から使っていない Claude の探索 runtime の 2 つで、所有者の判断が要る。
7. 判定器を消した後も、agent に渡る文章 3 つ（trust 境界、deep v11、wide v14 の節）が「判定器が runtime confirmation を決める」と書いている。正本のほうにも、判定器や 3 Trial を前提にした文が残っている（第 E 節、14 行）。

## B. 評価指標

### B.1 現状

ベンチマークは、所有者が発見者になっている公開 7 件だけである（ADR 0027、所有者決定 2026-10-16）。これを入れた開発セットが 6 case ある。brizy 2.8.11、relevanssi 4.28.3、simply-schedule-appointments 1.6.10.0（ssa）、translatepress-multilingual 3.2.6（tp326）、custom-facebook-feed 4.13.0（cff）、unlimited-elements-for-elementor 2.0.16（ue）。所有者の OK 基準（2026-10-26）は「scope 内 Finding が 1 件以上の case の数」で、公開経路一致の数を併記する。PR テンプレートは M1〜M6 の名前で数字を出すよう求めている（#560）。

開発セットの版ごとの結果は次のとおり。v8 は [docs/evaluation/2026-10-19-v8-five-target-rediscovery.md](../evaluation/2026-10-19-v8-five-target-rediscovery.md)、wide は開発台帳から取った。

| 版（mode） | run | brizy | relevanssi | ssa | tp326 | cff | ue | 1 件以上 | 公開経路一致 | Finding（group） | common-usage | Root wall |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| v8（deep、10-18〜19） | 各 1（最終 r） | 1 | 1（Root は schema error） | 6 | 6 | — | 0 | 4/5（completed に限ると 3/5） | brizy の r2 だけ照合 | 14（記録なし） | 記録なし | 61〜64 分 |
| v11-wide（10-25） | 各 1＋再開区間 | 2 | 2 | 2 | 8 | 0 | 2 | 5/6 | 記録なし | 16 | 記録なし | 3〜7 分 |
| v13-wide（10-26） | 各 1 | 1 | 2 | 4 | 2 | 0 | 0 | 4/6 | 4 | 9（4） | 7/9 | 13〜21 分 |
| v14-wide（10-26） | 各 1（tp326 は 3 Trial、うち 2 は provider-limited） | 8 | 2 | 6 | 4 | 8 | 8 | 6/6 | 5 | 36（16） | 11/36 | 12〜34 分 |
| v11（deep、現行） | 0 | — | — | — | — | — | — | 測っていない | — | — | — | — |

公開経路一致の 4 と 5 は台帳に無い。比較のセッションで所有者に示した値である（変遷の報告 第 5 節）。台帳の `publicRecordMatch` はすべて `unassessed` のままである。

### B.2 問題点

1. **天井に当たっている。** v14-wide は 1 run で 6/6 になった。次の版がこれより良くても、この指標では差が出ない。逆に、どの case にも疑わしい Finding を 1 件ずつ出す版も 6/6 になる。v14-wide の `fixed-v14` は「不確かさが残っても明記して報告する」と書いており、件数が増える方向に寄せた版である。実際に、Finding が 4 倍に増えたのに、common-usage の Finding は 7 件から 11 件にしか増えていない。
2. **1 run では揺れと区別できない。** 同じ case でも run ごとに結果が変わる。v5 では relevanssi と tp326 が 3 run 中 2 run だった。cff は v11-wide と v13-wide で 0、v14-wide で 8 だった。仮に case ごとに 1 run あたり 0.8 の確率で Finding が出る版でも、6 case 中 4 以下になる確率は 34% ある（二項分布、case は独立と仮定）。v13-wide の 4/6 と v14-wide の 6/6 の差は、この範囲に入る。所有者の 10-26 の判断「確率的な揺れもありそう」と同じ結論である。
3. **主指標に近いものが台帳の外にある。** 開発セットで最も強い信号は、所有者の公開記録と同じ経路が出たかどうかである。これは手作業で照合していて、版をまたいで同じ問い合わせで出せない。
4. **精度を測っていない。** 判定器があった時期には、本番 v8 で検証を受けた 78 Finding のうち 16 が `runtime-confirmed` だった（変遷の報告 3.1 節）。判定器を消した後は、人間の観測が 0 件なので、Finding のうち本物がどれだけあるかは分からない。
5. **規則が 3 つに分かれている。** DEVELOPMENT 第 5 節と SPEC 第 6・10 節は「最低 3 Trial」、DEVELOPMENT 第 2 節（10-25）は「v10 と wide は本番の対象で試し、開発 Trial は取らない」、所有者決定 10-26 は「6 case で 1 件以上」（実際は各 1 run）である。
6. **人間が読める量を見ていない。** v8 は本番で約 6.6 日のあいだに Finding 148 件と Lead 1,628 件を出した（1 日あたり Finding 約 22 件）。DEVELOPMENT 第 2 節の Step 2 の引き金は「scope 内候補が週 15 件超」である。今の探索は、この引き金の 10 倍ほどの速さで候補を出している。

### B.3 「合格」の提案

prompt の採否に使う閾値を、次のように段に分けて置く。どれも、今の台帳と既存の event だけで出せる。ただし (2) の経路一致は、照合の結果を `docs/evaluation/` に書く運用が要る。

| 段 | 指標 | 閾値 | 根拠 |
| --- | --- | --- | --- |
| (1) 実行の健全性 | 6 case × 3 run の 18 Trial で、completed の数 | provider-limited と failed は理由付きで別に数え、同じ case を再試行する。completed が 15 未満なら判定しない | SPEC 第 6 節（失敗は候補 0 件に数えない）。v14-wide の tp326 では 3 Trial のうち 2 が provider-limited だった |
| (2) 主指標: 公開経路一致 | 18 run のうち、所有者の公開記録と同じ経路の Finding が出た run の数 | 現行版以上であること。現行版で 3 run 中 2 run 以上一致した case が、新版で 0/3 になったら不合格 | 開発セットで唯一、本物と分かっている信号。現行 v14-wide の基準値は、まだ 1 run（5/6）しかない |
| (3) M1（所有者の OK 基準） | case ごとに、3 run 中 2 run 以上で scope 内 Finding が 1 件以上 | 6 case 中 5 case 以上 | case ごとの出現率が 0.8 の版なら 88% の確率で通り、0.5 の版なら 11% しか通らない（二項分布）。1 run の 6/6 より差が見える |
| (4) 人間が読む量 | 本番で、scope 内 Finding の group（`group.id`）が週に何件出るか | 週 15 件以下。超えるなら、Trial の数を絞るか、所有者が読む枠を広げる判断をする | DEVELOPMENT 第 2 節の Step 2 の引き金と同じ数 |
| (5) 本番の当たり | 採用後、本番の最初の 30 Trial で、Finding が 1 件以上出た Trial の割合 | 0/30 なら戻す。目安は v8 の 10.7%（244 Trial 中 26） | 本当の率が 10% なら、0/30 になる確率は 4%。v10-wide は 24 Trial で 0 件だった（率 10% なら 8% の確率） |
| (6) 精度（記録が溜まってから） | 人間が観測した Finding のうち `match` の割合（M4） | 最初の 20 件の観測で決める。参考値は判定器時代の 16/78（21%） | 判定器を消した後の記録は 0 件で、今は閾値を置けない |

この段の順で読む。(1) が通らなければ (2) 以降は読まない。(2) と (3) は開発セットの数字で、採否を決める。(4)〜(6) は本番の数字で、採用した後に戻すかどうかを決める。費用は、18 Trial × wide の wall 中央値（v14-wide で約 22 分）で約 7 時間になる。deep で同じことをすると、1 Trial 60 分以上なので 18 時間以上かかる。

### B.4 何を測っていないか

- **公開経路一致**（台帳に field が無い。今は手作業）
- **精度**（人間の `review observe` が 0 件）
- **揺れの幅**（同じ版・同じ case で 3 run 以上回したのは v5 の 3 case だけ）
- **費用**（`costUsd` は全 run で `unavailable`。token と wall はある）
- **所有者の時間**（`human-effort-recorded` は 72 件、すべて `read`、合計 26 分）
- **本番の見落とし**。SPEC 第 10 節の「前向き評価」（後日公開された advisory と、探索した Snapshot の照合）は、Wordfence mirror があるのに回していない。本番の対象で何を見落としたかは、今どの数字にも出ていない
- **提出と報酬**（M5 と M6 の event は 0 件）

## C. 探索の深さ

### C.1 数字

Trial は `trialId`、Root run は `runKind != child` の run、子は `parentRunId` で数えた。「子の読取」は、Trial の子 run の `observed.filesRead` を足したもので、読んだ延べ回数の下限である。Claude の Root の読取は観測できていない（[docs/evaluation/2026-10-20-child-agent-shape-by-runtime.md](../evaluation/2026-10-20-child-agent-shape-by-runtime.md)）。

| 系統と場所 | Trial | completed | Trial wall 中央値 | 子の数 / Trial（中央値、最大） | 子の読取 / Trial（中央値） | Finding | Finding が出た Trial |
| --- | ---: | ---: | --- | --- | ---: | ---: | ---: |
| v8 deep・本番・Codex（runtime 記録なし） | 46 | 27 | 50.7 分 | 4、25 | 684 | 24 | 7 |
| v8 deep・本番・Codex（`codex-native/v1`） | 120 | 81 | 60.5 分 | 4、26 | 1,017 | 82 | 9 |
| v8 deep・本番・Claude（`claude-code/v1`） | 86 | 50 | 60.6 分 | 12、28 | 154（下限） | 42 | 10 |
| v10-wide・本番（wall 20 分） | 24 | 24 | 6.4 分 | 4、16 | 164 | 0 | 0 |
| v13-wide・本番 | 5 | 5 | 9.7 分 | 5、10 | 218 | 0 | 0 |
| v14-wide・本番の対象（`rr14-*`、`rerun-v14-*`、集計中） | 8 | 5（3 本は実行中） | Root run 10.0 分 | 4.5、7 | 124 | 10（group 3） | 3 |
| v8 deep・開発 5 case | 5 | 4 | 61〜64 分 | 4 | 全 agent 2,191〜4,314 | 14 | 4 |
| v13-wide・開発 6 case | 6 | 6 | 12.8〜20.6 分 | 8〜12 | 340〜633 | 9 | 4 |
| v14-wide・開発 6 case | 8 | 6 | 12.1〜34.4 分 | 6〜21 | 203〜1,364 | 36 | 6 |

v8 本番の 3 行は再開区間で runtime の表記が変わる Trial を両方に数えるので、合計は 244 より多い。v8 本番の completed Trial を wall で分けると、次のようになる。

| runtime | 55 分未満 | 55〜70 分 | 70〜110 分 | 110 分以上 | 70 分超の Trial の Finding |
| --- | ---: | ---: | ---: | ---: | ---: |
| Claude | 0 | 48 | 2 | 0 | 0 |
| Codex（記録なし） | 0 | 25 | 1 | 1 | 0 |
| Codex（`codex-native/v1`） | 0 | 75 | 6 | 0 | 0 |

### C.2 判定

- **deep は床で止まっている。** completed 158 Trial のうち 148 が、最低 60 分の床から 10 分以内で終わる。上限の 120 分はほとんど使われない。床より長く続いた 10 Trial の Finding は 0 件だった。LESSONS 3（時間をかけても成果は増えない）と同じ形である。床が Finding を増やしたかどうかは、v8 の receipt に最初の最終報告の時刻（`firstFinalReportAt`）と、その後の候補数（`candidatesAfterFirstFinalReport`）が無いので判定できない。この 2 つは 10-26 から記録しているが、記録が残っているのは wide の 10 run だけで、どれも 0 である（wide は最初の最終報告で終わるので、0 になって当然である）。
- **deep の現行版を測っていない。** campaign.json の既定は deep v11 だが、v11 の run はどの台帳にも無い。2026-10-25 の再設計報告 第 12 節は、最低 60 分を「最初の最終報告の後の候補数を読んでから、0 分と 60 分の 1 arm で決める」としていた。この比較はまだ回していない。
- **wide v14 は浅すぎない。** 開発セットでは、停止規則で 12〜34 分で止まり、wall 上限 120 分には届かない。それでも 6/6 で、Finding 1 時間あたりは約 14 件だった。v8 の開発 5 case（約 5.2 時間で 14 件、1 時間あたり約 2.7 件）より多い。ただし model の effort、prompt、子の形が同時に違うので、時間だけの差としては読めない。
- **浅すぎたのは本番の v10-wide である。** Trial wall の中央値は 6.4 分、子の読取の中央値は 164 で、24 Trial で Finding は 0 件だった。v13-wide の本番 5 Trial も 9.7 分で 0 件だった。v14-wide は本番の対象で、5 Trial が completed になった時点で 3 Trial から Finding が出ている。ただし Root run の中央値 10.0 分は、開発セットの中央値（約 22 分）より短い。対象の大きさが違う可能性があるが、台帳には plugin の大きさが無いので確かめていない。
- **深さの目安。** 今の数字で引ける線は、「Trial wall が 10 分未満で、子の読取が 200 未満なら浅い」（v10-wide と v13-wide の本番）くらいである。これを Harness の停止条件にはしない（ADR 0034、LESSONS 14）。読む側の目安に留める。

### C.3 変えるなら

設定値だけで変えられるもの（prompt の版を上げない）:

- deep の床を測る。deep v11 を、開発 6 case で `discovery.minimumActiveMinutes` を 60 と 0 の 2 通りにして各 1 run 回す（約 6 時間＋約 1〜2 時間）。`candidatesAfterFirstFinalReport` が、床の効果をそのまま示す。床の延長は提案しない（LESSONS 3）。
- 本番の既定 mode を決める。campaign.json は deep v11 だが、実際の運用は v14-wide を別の設定で回している。どちらを既定にするかは、所有者の判断である（第 F 節）。
- wide の `runWallTimeMinutes` は 120 のままでよい。停止規則が先に効いていて、上限に届いた Trial は無い。

prompt を変えるもの（版を上げる）:

- v14-wide を浅くも深くもする理由は、今の数字には無い。所有者の 10-26 の判断（「しばらくはこのプロンプトで行こう」）を変える根拠は無い。
- 変えるとすれば、判定器の文の削除だけである（第 E 節 1〜3 行）。

## D. 要らない機能の候補

「最終使用」は台帳の event か、このホストの Claude Code の記録（`~/.claude/projects/-home-dev-wordpress-bounty-harness` の tool 呼び出し）から取った。所有者の Codex アプリで打ったコマンドは、このホストには残っていない。そのため、台帳に書かない読み取りコマンドの最終使用は下限である。照らした規則は、AGENTS.md「Harness と AI の責務」の削除の一覧と、LESSONS 8（先回りで作らない）と 14 である。

| 機能 | 最終使用 | 消したときに失うもの | 推奨 |
| --- | --- | --- | --- |
| プラグイン別の Lab アダプタとシナリオ（`src/profiles/wordpress/lab/` の `scenarios.ts`、brizy / relevanssi / ssa / user-registration / wp-members / wpdiscuz など 9 file、761 行。campaign の `lab.scenarioId`） | `lab-provisioned.scenario` は 10-11 が最後（32 件）。検証の event に scenario が出るのは 10-23 が最後 | 開発セットの Lab で、前提を Harness が作る経路。今は wbh-verify skill が前提を作る | **消す。** AGENTS.md の削除の一覧に載っている。塞いでいた #352 は 10-26 09:08Z に close された。#353 で消し、ADR 0026 の該当行を直す |
| 旧 Verifier の指示の連鎖（`verifier-v6`〜`v8` の実行経路、`wordpress-verifier.ts` の旧経路） | `verifier-v8` の検証は 94 件で、10-21 が最後。自動検証は 75 件中 0 件確認 | 無し。prompt の md は digest の照合に要る | **コードは消す**（#353）。**prompt の md は残す**（AGENTS.md の旧版を残す規則） |
| `src/profiles/wordpress/acceptance/`（種別ごとの受理基準 3 本、再現パッケージの雛形、`index.ts`） | `tests/profiles/wordpress/acceptance.test.ts` からしか読まれていない（`src` に import が無い） | 判定器時代の `judgeSuccessCriterion` の記述 | **消す。** テストだけが使うコード |
| `scope-facts.ts` の canary 条件と、`runtime-confirmed` の再現パッケージを読む経路 | 判定器時代の確認は 10-19 以後の本番で 15 Finding。うち 10 件はまだ review の判断が無い | 既存の `runtime-confirmed` を `review scope` と `review draft` に通す経路 | **残す**（ADR 0040 が読み続けると決めている）。15 件の扱いが決まったら、もう一度見る |
| 探索 Lab（`discovery.lab: attached`、`/observe`、`maxResets`、`maxObservations`。#543、#547） | どの台帳でも run 0 件（全 run が `mode: none`） | PRISM 型の「探索中に実行して確かめる」実験 | **保留（所有者の判断）。** 再設計報告の Q1 は「本番投入は wide の数字を見て決める」としていた。2 週間使わなければ消す、という期限を切ることを提案する（LESSONS 8） |
| Claude の探索 runtime（`claude-*.ts`、`runtimeShare`、`maxConcurrentTargetsByRuntime`、Claude の拒否からの再開、PreToolUse hook） | 本番で最後に起動したのは 10-23 12:47Z。v8 で 86 Trial、Finding 42、確認 7 | Codex と違う子の形（使い捨ての子、1 Trial に 12 体前後）。Codex の provider 上限のときの逃げ道 | **保留（所有者の判断）。** 10-20 の所有者メモは「Claude 型が主経路」、10-26 は「検証は Codex が主経路」で、探索の runtime は決まっていない |
| deep mode と最低時間の継続（`minimum-active-runner.ts`） | v8 は 10-25 が最後。v11 は 0 件 | 粘る探索。v8 の実績（本番の確認 16 件はすべて v8） | **残す。** ただし第 C.3 節の測定をする |
| 提出候補の連鎖（`review scope` / `draft` / `authorize` / `submitted` / `outcome`） | `scope-assessed` は 38 件で、10-25 が最後。`draft-saved`、`external-action-authorized`、`submission-recorded`、`submission-outcome` は 0 件 | 不変条件 7 の承認の結び付き、M5 と M6 | **残す。** 消すのではなく、使う（wbh-submit は `review submitted` も `review outcome` も呼ばない。第 E 節 13 行） |
| `review held` | このホストの記録では 0 回。`candidate-held` は 103 件 | 保留した候補の一覧 | **残す**（小さい読み取りコマンド） |
| `ledger stops` / `ledger resumes` / `lab down` / `lab cleanup` | 10-18 / 10-20 / 10-13 / 10-19 | 運用の確認と後始末 | **残す** |
| `examples/campaign-v6-measure.json` | promptId が `wp2shell-bounty-v6`（archived で起動できない） | 無し | **消す** |
| `examples/campaign-wide-20.json` | wide の設定例。Programme Boundary が `wordfence-2026-10-17` のまま（本番は `wordfence-2026-10-26`）、wall 20 分 | wide の最小の設定例 | **直す**（boundary を本番と同じ版にする。wall は ADR 0039 の記述と合わせて決める） |
| 旧 prompt（wp2shell v1〜v13-wide、short-objective、screening、derived、whitebox-v1.7 など） | 過去 Trial の digest の照合 | 照合 | **残す**（AGENTS.md の規則） |

## E. 正本とコードの食い違い

| # | 場所 | 文 | 実態 | 直し方 |
| --- | --- | --- | --- | --- |
| 1 | `src/profiles/wordpress/prompts/trust-boundary-v1.md` 9 行（全 Trial に渡る） | 「The independent judge decides runtime confirmation.」 | 判定器は #541 で削除（ADR 0040） | trust-boundary-v2 を作り、版と digest を上げる。所有者の判断（第 F 節） |
| 2 | deep v11 の節 `sections/objective/task-v10.md` | 「Runtime confirmation belongs only to the later, independent Harness-owned deterministic judge, which must observe the corresponding nonce canary outcome in a fresh Lab.」 | 判定器も canary も無い | deep の版を上げるときに、人間の観測の文に替える。v11 はまだ run が 0 件なので、上げても照合の手間は小さい |
| 3 | wide v14 の節 `sections/coordination/fixed-v14.md` | 「Runtime confirmation is decided later by the independent Harness judge」 | 同上 | v15-wide で替える。行動への影響は小さいとみる（未確認、第 G 節） |
| 4 | `.claude/skills/wbh-report/SKILL.md` 8、31、38、99、215 行 | Wordfence の暫定版は「Harness の判定器が `runtime-confirmed` とした Finding」から作る | 新しい検証は `runtime-confirmed` を出さない。ADR 0040 の 2026-10-26 追記で、根拠は `review observe` の match と `--reproduced` に替わった | 根拠の行を ADR 0040 追記に合わせる（skill の版を上げる） |
| 5 | `.claude/skills/wbh-submit/SKILL.md` 29 行 | 「`runtime-confirmed` は nonce canary を照合した Harness 判定器だけが出す」 | 過去の記録の説明としては正しいが、現在形で書かれている | 「判定器があった時期（〜10-25）の記録」と明記する |
| 6 | AGENTS.md 58 行 | 「実 host は … `discovery.lab: attached` を退役エラーで止める」 | #543 で探索 Lab として戻った（SPEC 第 6・7 節は改訂済み。設定の schema も受け付ける） | AGENTS.md の文を SPEC に合わせる |
| 7 | AGENTS.md 58 行と「検証 Lab の前提」節 | 削除は「#352 の受け入れの後」。受け入れは「`review observe` まで届くこと」。一方で「通常機能シナリオは … 追加する」 | #352 は 10-26 に close（close の comment は「人間の観測待ちまで届くこと」と読み替えた）。`manual-observation-recorded` は 0 件 | #353 の削除と一緒に、受け入れの文と検証 Lab 節のシナリオの行を直す |
| 8 | ADR 0039 帰結 | 「2 つの mode は、quota 1 時間あたりの Finding・Lead・`runtime-confirmed` で比べる」 | `runtime-confirmed` は出ない | M1〜M4 で比べる、に改める（ADR 0040 の注記と同じ形） |
| 9 | SPEC 第 10 節 | 「新規探索では prompt A/B・ablation … を起動しない」。判定器の負の対照、本番開始ゲート（判定器の `runtime-confirmed`）、funnel の「1M token あたりの `runtime-confirmed`」 | 開発セットで v13-wide と v14-wide を比べている（#556）。判定器は無い | 第 10 節を M1〜M6 と第 B.3 節の段（採るなら）に書き換える。判定器の文は「判定器があった時期」とする |
| 10 | SPEC 第 15 節 用語「Verified Vulnerability」 | 「`runtime-confirmed` からだけ作る」 | ADR 0040 以後、確定は人間の match と `--reproduced` | 用語の定義を ADR 0040 に合わせる |
| 11 | DEVELOPMENT 第 5 節、SPEC 第 6 節、`docs/agents/measurement.md` | 探索に触る PR は「最低 3 Trial」 | 所有者決定 10-26 の OK 基準は 6 case で各 1 run（#556 も 1 run）。DEVELOPMENT 第 2 節は「wide は開発 Trial を取らない」（10-25） | 第 B.3 節の段を採るなら「6 case × 3 run」に揃える。採らないなら、所有者決定 10-26 を正本に 1 行で書く |
| 12 | `docs/agents/measurement.md` 開発セットの表、campaign.json の手順 | 表は 10-16 時点で、tp331 と geodir を回す、cff と ue は「動かない」。手順は「promptId は v11、`lab.scenarioId` を合わせる」、表の列に「検証 confirmed」 | 開発セットは 6 case で、cff と ue も回っている。wide の比較は v14-wide で、scenario は削除対象 | 表を 6 case に直し、手順を mode ごとにし、confirmed の列を M4 の列にする |
| 13 | ADR 0038 の段 6、SPEC 第 10 節「提出転帰」 | 提出と報酬を台帳で数える | wbh-submit は `review submitted` と `review outcome` を呼ばない。`submission-recorded` と `submission-outcome` は 0 件 | wbh-submit の最後に `review submitted` を、結果が出たら `review outcome` を打つ手順を足す（変遷の報告の M5、M6 と同じ指摘） |
| 14 | ADR 0027、AGENTS.md「公開済み 7 件の再発見は配線と判定器の確認」 | 7 件は判定器の確認に使う | 判定器は無い。今は prompt の採否（M1）に使っている | ADR 0027 に、目的が変わったことを注記する |

本番の既定値と運用も食い違っている。campaign.json の `promptId` は deep v11 だが、v11 は一度も走っていない。継続ランナーは 10-26 06:35Z に操作者が止めた（`continuous.json` の `reason: operator`）。今は v14-wide を、別の設定ファイル（`~/.config/wordpress-bounty-harness/rerun-v14-20261026/`）で 1 対象ずつ回している。

## F. 推奨する順番と、所有者の判断が要る点

### F.1 推奨する順番（所有者の判断が要らないもの）

1. **人間の観測を 1 件通す。** 判定器時代に確認した 15 件のうち、review の判断が無い 10 件から 1 件を選ぶ。`lab up --for-review` → `review observe` → `review decide --reproduced` まで打つ。#541 の後の経路は、本番で一度も通っていない。M4 が 0 のままでは、第 B.3 節の (6) も、ADR 0040 の受入も読めない。
2. **#353 の削除。** シナリオとアダプタ（761 行）、旧 Verifier の連鎖、`acceptance/`、`examples/campaign-v6-measure.json` を消す。AGENTS.md の 58 行と検証 Lab 節を同じ PR で直す（第 E 節 6、7 行）。Harness の変更はバグ修正と削除だけ、という 10-18 の方針の範囲に入る。
3. **文書だけの食い違いを直す**（第 E 節 4、5、8〜14 行）。agent に渡る文章のうち skill の 2 つ（wbh-report、wbh-submit）は版を上げる。
4. **wbh-submit に `review submitted` と `review outcome` の手順を足す**（第 E 節 13 行）。提出が始まった時点で、M5 と M6 が台帳に残る。
5. **v14-wide の基準値を 3 run で取る**（第 B.3 節の (2) と (3)。約 7 時間）。このとき、公開経路一致の照合結果を `docs/evaluation/` に書く。

### F.2 所有者の判断が要る点

1. **合格の基準。** 第 B.3 節の 6 段を採るか。採るなら、DEVELOPMENT 第 5 節と SPEC 第 10 節を書き換える。採らないなら、10-26 の OK 基準（各 1 run）を正本に書く。
2. **本番の既定 mode。** campaign.json は deep v11 のままにするか、wide v14 にするか。deep を残すなら、第 C.3 節の床の測定（約 7〜8 時間）をするかどうか。
3. **探索の速さと人間の確認の速さの釣り合い。** v8 は 1 日あたり約 22 件の Finding を出したが、人間の観測は 0 件である。確認の列が空くまで探索を絞るか、このまま回して列を溜めるか。
4. **探索 Lab**（run 0 件）。wide で 1 arm 試すか、期限を切って消すか。
5. **Claude の探索 runtime**（10-23 から使っていない）。残すか、消すか。
6. **agent に渡る文章の判定器の文**（第 E 節 1〜3 行）。版を上げて直すか、次に版を上げるときまで置くか。trust 境界を変えると、全 Trial の `inputDigest` が変わる。
7. **Lead の量。** v8 の本番は Lead 1,628 件で、`review leads` は全件を見せる（#558）。全件を見せる方針（2026-10-26）のまま、読む順の付け方を skill に任せるか。

## G. 未確認の仮定

- 本番台帳は 09:08Z の複写である。そのとき `rr14-*` の 3 Trial（その後もう 1 本）が実行中だった。v14-wide の本番の数字（8 Trial、Finding 10）は途中の値である。
- Finding の `occurredAt` は Trial の開始時刻になっている（#212）。「10-19 以後」の絞り込みは、Trial の開始で切った近似である。
- `group.id` は、本番台帳では 276 件中 196 件の Finding に無い（10-26 より前の記録）。そのため、本番 v8 の group 数は出していない。開発セットの group は全件にある。
- Claude の Root の読取数は観測できていないので、Claude の行の読取は下限である。
- 二項分布の計算は、case どうしと run どうしが独立で、case の出現率が同じという仮定に立つ例示である。実際の case ごとの率は違う。
- 公開経路一致の 4 と 5 は、所有者に示した比較の結果で、この監査では照合し直していない。
- コマンドの最終使用は、台帳とこのホストの Claude Code の記録から取った。所有者の Codex アプリで打ったコマンドは含まない。
- `acceptance/` が使われていないことは、`src`、`scripts`、`package.json` に参照が無いことで確かめた。動的な読み込みは grep では見えない可能性がある。
- 判定器の文が agent の行動を変えているかどうかは測っていない（第 E 節 1〜3 行）。Lab が付かない Trial で「後で判定器が確かめる」と読ませても、出す Finding の量は変わらないとみているが、確かめていない。
- 第 B.3 節 (5) の 10.7% は、v8 の deep で、run の途中の provider-limited を含む値である。wide の Trial の形とは違う。

## 出典と問い合わせ

- 版ごとの集計: 本番台帳と開発台帳の `discovery-run-started` / `discovery-run-finished` を `runId` で結び、Root run（`runKind != child`）を `trialId` でまとめた。子は `parentRunId` で Trial に結んだ。Finding、Lead、parked は `findingId` / `leadId` で重複を除き、記録した run の版に数えた。本番は `campaign_id` が `prod` で始まるもの、本番の対象での v14-wide は `rr14-*` と `rerun-v14-*` に分けた。
- 深さ: v8 本番の completed Trial について、Root の再開区間の `wallTimeMs` を足して wall の区分を作った。
- funnel: 2026-10-19T00:00Z 以後の `prod*` の `finding-recorded`（147 件）に、`verification-finished`（`promptVersion` で自動の `verifier-v8` と handoff の `wbh-verify/*` を分けた）、`review-decided`（Finding ごとの最新）、`manual-observation-*`、`human-reproduction-recorded`、`draft-saved`、`submission-*` を結んだ。変遷の報告の 148 件（v8 の版で数えた本番の全期間）とは、絞り方が違う。
- funnel の結果: 検証まで進んだ 77（自動 75、handoff 30。両方ある Finding を含む）、確認 15（すべて handoff。自動は 0/75）、最新の結果は `incomplete(precondition)` 45・`runtime-confirmed` 13・`incomplete(provider)` 8・`incomplete(observation)` 5・`incomplete(recipe)` 4・`incomplete(evidence)` 2、未検証 70、review の判断 24（accept 1、reject 12、defer 11）、人間の観測・再現・文案・提出 0。段 1（wbh-screen）の結果は台帳に無く、Git 外の Private Evidence の報告（10-22〜10-24）にだけある。
- コマンドの最終使用: `~/.claude/projects/-home-dev-wordpress-bounty-harness/**/*.jsonl` の tool 呼び出しから、`main.js … <command>` に当たる行の timestamp の最大値を取った。
- 文書: AGENTS.md、[SPEC](../SPEC.md) 第 2・6・7・10・15 節、[DEVELOPMENT](../DEVELOPMENT.md) 第 2・5 節、[LESSONS](../LESSONS.md)、[ADR 0027](../adr/0027-contributor-out-of-scope-and-rediscovery-as-wiring-proof.md)、[0039](../adr/0039-discovery-launch-modes.md)、[0040](../adr/0040-human-lab-observation-replaces-judges.md)、[2026-10-25 再設計報告](2026-10-25-exploration-architecture-redesign.md) 第 12 節、[docs/agents/measurement.md](../agents/measurement.md)、[変遷の報告](2026-10-26-system-history-and-metrics.md)。
