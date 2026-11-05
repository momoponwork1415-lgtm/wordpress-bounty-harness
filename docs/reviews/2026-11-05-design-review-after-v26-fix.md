# 探索方式を 7 月 30 日方式に固定した後の設計見直し（2026-11-05）

調べて報告。正本ではない。所有者の 2026-11-05 の決定「探索方法は過去の whitebox harness で 7/30 時点に使っていたプロンプトに固定する」（ADR 0051 と同日の追記 2 本）を受けて、固定したものを一覧にし、いまの設計と運転のうち固定と食い違う箇所、固定後に要らなくなる箇所、決めてもらう点を段ごとに並べる。本文は何も変えない。各案に消し方を付ける。

## 0. 先に結論

1. **固定したものは「目的文」だけで、運転条件は元 run と違う。** 7 月 30 日の元 run は Codex `gpt-5.6-sol` の effort `ultra`、制限時間 6 時間で最低時間なし、同時 4 体で子 9 体、tool 呼び出し 969 回、1 時間 36 分で自分から閉じた。いまのリポジトリ方針（v26-wide）は `gpt-6-sol` の effort `high`、制限 120 分で最低 60 分、子の上限 3。pilot 7 本の Root は、完了した 6 本すべてが**最低時間の 60 分ちょうど（61〜65 分）で最初の最終報告を出し、その後の候補は 0** だった。元 run に無かった「最低時間」が終了時刻になっている。これが設計見直しの中心である（§2 の決定 3-1〜3-3）。
2. **本番の v26 はまだ 1 Trial も走っていない。** 本番台帳に v26 の Trial は無い。11-04〜05 の本番ランナー（`prod-c22`）は Claude Opus の v22-wide（子 8、最低時間 0）を回し、11-05 12:02Z に方針変更で選定 batch を捨てて止まった（停止 marker は 21:03 JST）。v26 用に用意した Git 外の campaign 設定は **runtime が Claude 1 / Codex 0** で、pilot と元 run の Codex と食い違う（§2 段 3 の決定 3-4）。
3. **主経路が使わない機構が 4 群ある。** `deep` mode と v11、Cloudflare 派生の六段階（v23〜v25、`wbh-audit`、`checked/v1` 契約と `audit-*` の昇格）、`discovery.skills` の staging と 9 本のスキル、`followUp: leads` と `priorLeads` の第 2 Trial。所有者は 11-05 に「新たな探索手法の比較は始めない」と決めたので、実験用に残す理由は薄い。AGENTS.md の「使わない設定にして残す中間状態は置かない」に従えば削除候補である（§2 の決定 3-5〜3-8）。削除は 1 問 1 PR で、いずれも revert で戻る。
4. **段 1・2・4・5・6 は固定の影響を受けない。** 変えない。
5. **先に決めてもらう順**: 運転条件（3-1〜3-4）→ 本番再開（§4）→ 削除 PR（§3）→ 文書と Issue の整理（§5）。

## 1. 固定したものと元 run の対照

| 項目 | 7 月 30 日の元 run（TranslatePress 3.2.6、provenance 文書 §2.1） | いまのリポジトリ方針 `src/profiles/wordpress/policy/campaign.json` | pilot 7 本の観測（11-05、別 state） | 差 |
| --- | --- | --- | --- | --- |
| 目的文 | `DISCOVERY.md`、SHA-256 `2b794ada…`（[原本](../../history/knowledge/imported/08-whitebox/DISCOVERY-2026-07-30-translatepress-original-run.md)） | `wp2shell-bounty-v26-wide`、8,834 B、SHA-256 `55248033…`（[訳と差分](2026-11-05-july30-single-prompt-ja.md)） | 同 | 現行 Harness に合わせた改変版。固定の対象はこの版 |
| model / effort | Codex `gpt-5.6-sol` / `ultra` | host 設定による。pilot は `gpt-6-sol` / `high` | `gpt-6-sol` / `high` | **effort が 2 段低い** |
| 制限時間 | 上限 21,600 秒（6 時間）、最低時間なし。1:36:34 で自分から閉じた | 上限 120 分、最低 60 分 | 6 本とも 61〜65 分で最初の最終報告、その後の候補 0 | **最低時間が終了時刻になっている** |
| 子 | 同時 4、合計 9 体（深さ 1 が 5、深さ 2 が 4） | 同時 3 | 合計 1〜3 体 | 元 run の 1/3 |
| tool 呼び出し / token | 969 回 / 174M（cache 含む） | — | 205〜665 回 / 入力 43〜58M | 元 run の 1/3〜2/3 |
| 入力 | 目的文、target card、出力先、ソース | 上に加えて trust-boundary-v2、Programme Boundary、`## Run parameters`、出力契約 v4（`direct/v1`）、`## Lab`、`## Prior research` | 同 | 生成節は Harness の制御。所有者承認済み |
| Lab | なし | attached（reset 2 / observe 20 / lookups 60） | lookups 4〜17、observe 0〜14 | 元 run に無い。ADR 0051 で採用済み |
| スキル | なし | なし（`discovery.skills` 未指定） | 0 本 | 一致 |
| 過去の研究 | なし | `priorResearch: same-target` | 2 本に渡した | 元 run に無い。ADR 0048 |
| 出力 | 検証 pipeline 向けの Lead | Finding / Lead（契約 v4） | F 11 / L 16（§1.1） | 契約は Harness の形。固定の対象外 |

### 1.1 pilot 7 本の結果（挙動の観測。採否の数字ではない）

| 対象 | Root の wall | 子 | 読んだ file | lookups / observe | Finding | Lead |
| --- | --- | --- | --- | --- | --- | --- |
| TranslatePress 3.3.9 | 61 分 | 3 | 56 | 12 / 6 | 6 | 0 |
| WP Data Access 5.5.91 | 62 分 | 2 | 58 | 13 / 14 | 5 | 1 |
| Fluent Booking 2.6.0 | 65 分 | 2 | 87 | 5 / 2 | 0 | 9 |
| UsersWP 1.2.81 | 61 分 | 1 | 77 | 4 / 0 | 0 | 6 |
| Booking Calendar 12.0 | 61 分 | 2 | 118 | 4 / 0 | 0 | 0 |
| Event Tickets 5.31.0 | 62 分 | 1 | 178 | 17 / 0 | 0 | 0 |
| Fluent Booking 2.6.0（2 回目、prior 付き） | 未終了（終了 event なし） | — | — | — | 0 | 0 |

Finding 11 件は段 5 の列にある。確定は人間の review Lab の観測だけで決まる（凍結 1）。この表は「探索がどう動いたか」を見るためのもので、旧版との比較にも、方式の優劣にも使わない（ADR 0051 の 11-05 追記）。

## 2. 段ごとの見直し

段の番号は [SYSTEM.md](../SYSTEM.md) に合わせる。各決定は A / B / C と推奨を書く。推奨は AI の案で、決めるのは所有者である。

### 段 1 選定、段 2 Snapshot

変えない。帯 1 万〜100 万、インストール数順、batch 10、鮮度 180 日、版上昇の再訪（ADR 0037、11-02 追記 7）。Snapshot と digest は凍結の土台。

### 段 3 探索

**決定 3-1: 最低時間と上限。** 元 run は最低時間なしで 6 時間上限、1 時間 36 分で閉じた。pilot は最低 60 分を置いたら全員が 60 分で閉じた。目的文に「いつ閉じるか」を任せるなら、最低時間が目的文の閉じ方を上書きしている。

| 案 | 内容 | 見るもの | 消し方 |
| --- | --- | --- | --- |
| A | いまのまま（最低 60、上限 120） | — | — |
| **B（推奨）** | 最低 0、上限 120。目的文の閉じ方で終える | Root の wall の分布と最初の最終報告の時刻。元 run の 96 分は 120 分に収まる | 方針 file の 1 行を戻す |
| C | 最低 0、上限 180〜360。Harness の上限 120 分（SPEC 第 6 節）を上げる | B で Root が上限に当たるときだけ | SPEC と schema の上限を戻す |

B で Root が 15〜30 分で閉じるなら、それがこの目的文の素の挙動であり、床で引き延ばすより元 run との差（effort、子）を先に埋める。所有者は 11-02 夜に wide の床 90 分を採って同日撤回し、11-05 に 60 分を指定している。この決定は凍結 5 の外（制限時間は数字で動かす部分）。

**決定 3-2: effort。** 元 run は `ultra`、いまは `high`。Harness の host 設定は `ultra` まで受ける（`src/discovery/agent-runtime-profile.ts`）。

| 案 | 内容 | 費用の目安 | 消し方 |
| --- | --- | --- | --- |
| A | `high` のまま | pilot 1 本 入力 43〜58M token | — |
| **B（推奨）** | `ultra`。元 run と同じ | 元 run は 174M token（cache 含む）。約 3 倍 | host 設定の 1 行 |
| C | `xhigh` | 中間 | 同上 |

「方式を固定する」の方式に effort を含めるなら B。費用を先に見たいなら C を 1 週間。

**決定 3-3: 子の上限。** 元 run は同時 4 で合計 9 体、pilot は上限 3 で合計 1〜3 体。Root が上限まで使っていないので、上限を 4 にしても挙動は変わらない可能性が高い。推奨は 4（元 run と同じ値にし、上限が理由で減っていないことを確かめる）。消し方は方針 file の 1 行。

**決定 3-4: 本番の runtime。** 元 run と pilot は Codex。Git 外の v26 用 campaign 設定 `campaign-production-claude-opus-v26-lab-20261105.json` は runtime Claude 1 / Codex 0 で、SPEC 第 6 節の「本番 model は `gpt-6-sol` 系」「Claude runtime の share は 0」と食い違う。推奨は Codex 1 / Claude 0（pilot と同じ条件で本番を始める）。Claude は provider 拒否の時の片側試行（#435）として残す。Claude で回す判断なら SPEC の 2 行を改める。

**決定 3-5: Cloudflare 派生の六段階（v23 / v24 / v25-wide、`wbh-audit-v1/v2`、契約 `checked/v1`、台帳の `audit-candidate-*` 昇格）。** 11-05 に `experimental/` へ移した。所有者は同日「新たな探索手法の比較は始めない」と決めたので、起動する機会が無い。

| 案 | 内容 | 残るもの | 消し方 |
| --- | --- | --- | --- |
| A | 実験用に残す（いま） | SPEC 第 6 節の v25 の 4 行、`checked/v1` の昇格コード、`review audit-pending`、Issue #807 #808 #810 #812 | — |
| **B（推奨）** | 削除する。tag `archive/pre-v26-cleanup` を打ち、台帳の `audit-*` event は読み続ける | 既存 Trial の digest 照合に要る目的文の digest 表だけ | tag から戻す |

B のとき、関係する Issue 4 本を close し、ADR 0050 を superseded にする。

**決定 3-6: `deep` mode と `wp2shell-bounty-v11`。** v11 は `deep` の current だが、11 月の運転は wide だけで、ADR 0045 の「名指しの深掘り」も wide Trial を名指しで立てる形である。推奨は `deep` mode を退役し v11 を archived にする（`discovery.mode` は台帳を読むために型だけ残す）。v26 を 1 本の目的文にする決定と一致する。消し方は PR の revert。

**決定 3-7: `discovery.skills` の staging と 9 本のスキル（`wbh-recon-v1〜3`、`wbh-tools-v1`、`wbh-setup-v1`、`wbh-lab-v1`、`wbh-falsify-v1/v2`、実験の `wbh-audit`）。** v26 は 1 本も名指さない。`## Lab` 節は `wbh-lab` が staged のときだけ 1 文を足す作りで、無ければ従来どおり。決定 3-5 を B にするなら staging の唯一の利用者が消える。推奨は staging ごと削除（ADR 0043 を superseded）。過去 Trial のスキル digest は台帳にあり、本文は tag に残る。段 5 の提出前検証のスキル（`.claude/skills/wbh-*`）は別物で対象外。

**決定 3-8: `followUp: leads` と `priorLeads`（ADR 0044、0049 追記 2）。** 方針は `followUp: none`。所有者が望む「未解決経路があるときだけ 2・3 回目を自動、4 回目以降は手動」は別の契約が要る（ADR 0051 追記）。推奨は両方を削除し、新しい契約を設計するときに 1 問 1 PR で入れ直す。Lead の生の件数で起動する機構は、その契約と形が違うので残しても流用できない。

**変えないもの（段 3）。** Lab attached と find / sql / trace / observe、`priorResearch: same-target`、Programme Boundary、trust-boundary-v2、`## Run parameters`、出力契約 v4、再開（ADR 0036）、Claude の片側試行、旧目的文 36 本と節の合成コード（過去 Trial の digest 照合に要る。整理は別の問いで、急がない）。

### 段 4 出口

変えない。正規化、park の 10 種、Lead の保存、seen before。契約は `direct/v1` 1 本になる（決定 3-5 B のとき）。

### 段 5 検証、段 6 提出と転帰

変えない。pilot の Finding 11 件（TranslatePress 6、WP Data Access 5）は `review next` の列にある。WP Data Access は AI が Lab で観測した段階で、人間の review Lab の観測待ち。開いている PR #806（Lab のメール捕捉）、#789（中継の名前解決）、#709（検証ループの道具）は固定の影響を受けない。

### 人間の判断点、凍結 5

変えない。目的文の文面の凍結は、ADR 0051 の限定例外（v26 の版だけ）がすでに記録されている。この文書の提案はいずれも凍結 5 に触れない。制限時間、子の数、Lab の構成、スキルの中身は「数字で動かす部分」である。

## 3. 削除候補の一覧と順

| 順 | 問い | 消すもの | 触る場所の目安 | 依存 |
| --- | --- | --- | --- | --- |
| 1 | Cloudflare 派生の六段階は要るか（3-5） | `experimental/` の目的文 3 本とスキル 2 本、`checked/v1`、`audit-candidate-*` の昇格、`review audit-pending` | `src/profiles/wordpress/prompts/`、`src/discovery/`、`src/ledger/`、`src/review/`（参照 9 file）、SPEC 第 6 節、ADR 0050 | なし |
| 2 | スキルの staging は要るか（3-7） | `discovery.skills`、staging、スキル 9 本、`## Lab` 節の 1 文 | `src/discovery/skill-definition.ts` ほか参照 8 file、ADR 0043 | 1 の後 |
| 3 | `deep` mode は要るか（3-6） | v11 の current、`deep` の既定値と最低時間の分岐 | `src/profiles/wordpress/prompts/index.ts`、`src/cli/wordpress.ts`、ADR 0039 | なし |
| 4 | Lead 件数で起動する第 2 Trial は要るか（3-8） | `followUp: leads`、`priorLeads`、`follow-up-scheduled` の生成 | 参照 10 + 9 file、ADR 0044、0049 追記 2 | なし |

各 PR は「問い、変えたこと、変えなかったこと、測った数字（削除は 0）、消し方（revert）」の 5 項目で出す。コードの行数は目安で、削除後に `pnpm analyze:unused` で孤立した file を拾う。

## 4. 本番再開に要るもの（設計ではなく運転）

- 止まり方: `prod-c22` は 11-05 12:02Z に `selection-batch-discarded reason=policy-changed` を記録して止まり、`continuous-prod-c22.json` は `running` のまま、pid 336585 は死んでいる。停止 marker `continuous-prod-c22.stop` は 21:03 JST。
- 再開の条件: 所有者の言葉、新しい log path、使う prefix の marker を外す、決定 3-1〜3-4 を反映した Git 外の campaign 設定（いまの v26 用設定は Claude 1 / Codex 0、最低 60、子 3）、Codex の同時数（11-03 の 8 で 429 なし。5〜8）。
- 終了 event の無い Trial（pilot の Fluent Booking 2 回目）は別 state にあり、本番には影響しない。
- 11-04 の prod-c22（Claude Opus、v22-wide、子 8）の Trial は本番台帳にある。v26 の数字と混ぜないため、campaign prefix を変える。

## 5. 文書と Issue の整理

- SPEC 第 6 節: 決定 3-5 B なら v25 の 4 行（子の `checks`、昇格、未昇格）を消す。決定 3-6 なら「`deep` の `wp2shell-bounty-v11`」を消す。決定 3-1 なら最低時間の行を直す。
- AGENTS.md 「いまの運用」と SYSTEM.md 段 3: 同じ 3 点。
- ADR: 0050 を superseded（3-5 B）、0043 を superseded（3-7）、0044 と 0049 追記 2 を superseded（3-8）、0039 に deep 退役の追記（3-6）。新しい ADR は 1 本にまとめず、PR ごとに追記で足りる。
- Issue の close 候補: #807 #808 #810 #812（Cloudflare 派生）、#786 #791（falsify スキル、不採用）、#793（完了）、#715（ADR 0051 の別契約に置き換え）、#629 #633 #680（区画分配、ADR 0042 superseded）。#724（3 つの戦力）は所有者の判断待ちとして残す。11-05 の固定は「入口を規則と差分に替える」案を否定していないが、11 月は v26 の運転を見る月にするのが ADR 0045 の月 1 回に合う。
- worktree: `/home/dev/worktree` に 44 本。所有者の規則はマージ後に消す。prod26〜prod39 の 14 本は再開に使う 1 本を除いて消せる。
- 本文書は正本ではない。採った決定は方針 file、SPEC、ADR 追記に書く。

## 6. 固定後に測るもの

方式を比較しないので、測るのは運転の健全性だけ（DEVELOPMENT 第 2 節、ADR 0045 の分母）。

- Trial ごと: 完了 / 停止理由、Root の wall と最初の最終報告の時刻、子の数、読んだ file、lookups と observe、Finding / Lead（診断値）。
- 週ごと: Codex 1 時間あたりの Lab 発火数、Wordfence の転帰（受理、重複、対象外、却下）。
- 決定 3-1〜3-3 を変えたときは、変えた日を台帳の `configuration` で区切り、前後を並べる。対にしない。

## 7. 出典

- [ADR 0051](../adr/0051-july30-prompt-pilot.md) と同日の追記 2 本、[ADR 0045](../adr/0045-frozen-core-and-three-exploration-forces.md)、[ADR 0050](../adr/0050-cloudflare-audit-skill-as-wordpress-discovery-base.md)。
- 元 run の条件: whitebox-harness `34af667:docs/research/owned-finding-original-discovery-provenance-2026.md` §2.1。
- pilot の数字: `~/.local/state/wordpress-bounty-harness-jul30v26-*/state/ledger.sqlite` と `…-july30-v26-20261105/state-manual/ledger.sqlite` の `discovery-run-started` / `discovery-run-finished` / `finding-recorded` / `lead-recorded`（読み取り専用で集計）。
- 本番の状態: `~/.local/state/wordpress-bounty-harness/continuous-20261105-prod-c22-v26.out`、`continuous-prod-c22.json`、`~/.config/wordpress-bounty-harness/campaign-production-claude-opus-v26-lab-20261105.json`。
- 参照数: `git grep -l` を `origin/main` の `src/` に当てた file 数（followUp 10、priorLeads 9、skills の staging 8、`checked/v1` と `audit-candidate` 9、runtimeShare 5）。
