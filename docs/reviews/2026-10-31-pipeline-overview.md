# 選定 → 探索 → 検証 → 提出の流れ（2026-10-31 時点の整理）

所有者の依頼「この辺も含めてターゲット選定・探索・検証・提出の流れを整理してみて」への報告。正本ではない。正本は [SPEC.md 第 3 節](../SPEC.md)、[ADR 0038](../adr/0038-verification-phases-and-submission-flow.md)、[ADR 0039](../adr/0039-discovery-launch-modes.md)、[ADR 0040](../adr/0040-human-lab-observation-replaces-judges.md)、Issue #533 / #663 である。食い違えば正本が勝つ。

「この辺」= 2026-10-31 に Wordfence の却下 40 件を読んで分かったこと（重複 29、CVE のみ 5、偽陽性・低影響 6）と、直近 3 件の「CVE は付くが報酬なし」の中身（本体依存 2 件、外部サービス経路の読み違い 1 件）。却下の一覧そのものは Git 外にある。

## 0. 一枚の図

```
[選定]  WordPress.org 母集団 ──install 順の列──▶ 対象 slug + 版（同じ版は 1 回、版が上がれば戻す）
            │ 操作者の候補一覧（operatorCandidates）も同じ列に入る
            ▼
[探索]  Snapshot 固定 ──▶ gVisor sandbox で Root + 子の協調 Trial（wide v14、子 ≤ maxChildren、≤120 分）
            │ 任意の skill（wbh-recon、wbh-tools）を sandbox に置く
            ▼ Finding / Lead を全件保存 ── Programme Boundary 外は出口で park
[検証]  段 1 規則の篩（wbh-screen） → 段 1b ソース読み直し（wbh-source-check） → 段 2 群 →
        段 3 Lab 再現（verify next --handoff + wbh-verify、人間が観測）→ 段 4 重複照合（wbh-dedupe）→
        段 5 提出先（wbh-destination）→ 段 6 英語報告書（wbh-report）
            ▼
[提出]  人間が自分の拡張機能で送る → `review submitted` で台帳に記録 → 転帰（paid / CVE のみ / 重複 / 却下）
            │
            └──▶ 転帰は検証側の規則（wbh-screen）と Lab の基線に戻す。探索の目的文には戻さない（不変条件 1）。
```

Harness が持つのは制御（選定、Snapshot、sandbox、時間と子の数、保存と正規化、出口の park、Lab の供給、台帳）だけである。判断（どこを読むか、成立か、提出範囲か）は skill と人間が持つ（AGENTS.md「Harness と AI の責務」）。

## 1. 選定

| 項目 | 現状（#533、#663 merge 済み） |
| --- | --- |
| 母集団 | WordPress.org の popular browse とタグ。install 10,000 以上、365 日以内に更新、`excludedAuthors` / `excludedSlugs` 以外の全件 |
| 順序 | install の多い順。同じ install 段の中は最終更新の新しい順 |
| 再訪 | 同じ版は 1 回。版が上がった slug は同じ順序で列に戻す（理由コード `version-increased`）。日数の待ち、未提出 Finding による除外、`legacy-*` 除外は廃止 |
| 操作者の候補 | 自動方針の `operatorCandidates`（slug・版・根拠 digest）を同じ列に統合。指定版と stable が違えば理由付きで除外 |
| 使わないもの | Wordfence mirror（選定では開かない。段 1 と段 4 で使う）、帯、cascade、履歴の採点 |
| 台帳 | `target-selected`（理由コード `initial` / `version-increased`） |

選定の問いは「どの順で全件を回すか」だけになった。報酬の有無は選定では判断しない。Wordfence の転帰（却下 40 件）から選定に戻すものは、いまのところ無い。重複 29 件は「同じ plugin の同じ版を他の研究者が先に出した」であり、選定で避けられるものではなく、段 4 で落とすものである。

## 2. 探索

| 項目 | 現状 |
| --- | --- |
| 形 | 対象 1 件につき 1 Trial。Root + 子の協調。`discovery.mode: wide`（既定の目的文 `wp2shell-bounty-v14-wide`）。`deep` は名指しのときだけ |
| Harness が強制するもの | Snapshot と digest、gVisor、broker 経由の provider API、同時に生きる子 ≤ `discovery.maxChildren`（既定 4、最大 8）、制限時間 ≤ 120 分、出力の全件保存とスキーマ正規化（契約 v4、申告欄なし） |
| skill | sandbox の `<home>/skills/<name>/` に置く（ADR 0043）。現在 `wbh-recon-v1`、`wbh-tools-v1`（補助 file 3 つ付き）。campaign 設定で名指ししたときだけ入る。残りは trace / refute / coverage（#682 系列） |
| 出口の park | Programme Boundary 外の impact 10 種は `finding-parked`。検証列に入れず `review parked` で見る |
| Lead | 検証列に入らない。`review leads` で人間が全件を見る |
| 止まっているもの | 区画分配型（partitioned）は廃止・削除済み（ADR 0042 superseded、PR #690）。本番の探索は所有者の go 待ち。再開時は v14-wide（skill なし）と recon+tools の 2 腕を交互に回して数字で採否を決める |

探索に Wordfence の転帰を戻すことはしない。「本体依存は contributor+」「外部サービスは書けるかで決まる」を目的文に書くと、契約 v5 のときと同じく出力そのものが減る（ADR 0038 追記 15 の 76 → 8）。広く出して検証側で落とす（所有者決定 2026-10-26）。

## 3. 検証

6 段 + 段 1b（ADR 0038）。それぞれの問いと、今日の教訓をどこに入れるかを並べる。

| 段 | skill | 問い | 2026-10-31 に足す規則 |
| --- | --- | --- | --- |
| 1 | `wbh-screen` | 規則の写し（`policy/wordfence-scope-2026-10-21.md`）で明示除外されるか。提出可 / 不可と確度 | **本体依存の格下げ**: 未認証の位置がコメント・pingback・見本コメントの名乗り・Latest Comments のショートコード展開など本体の挙動から来るなら、本体が直った前提で採点し直す（contributor+ なら CVE のみ）。**外部サービス**: 「そのサービスに誰でも書けるか」で判断（公開ページのコメントは可、設定済みフィードの乗っ取りや自前のキャッシュ行は不可）。**多段連鎖**: cron・キャッシュ・レポート画面を経る連鎖は「成立しにくい」と読まれる前提で確度を下げる。**競合状態**は不可のまま |
| 1b | `wbh-source-check` | 固定ソースだけで、低権限の入力支配と既定設定での到達の 2 問 | 変えない。本体依存の見分けは段 1 の問いなので、段 1b では「入力支配 yes」のまま通してよい（段 1 が先に落とす） |
| 2 | Harness の群 + review 表示 | 同じ Snapshot の同じ経路を群にし、代表から検証 | 変えない。提出済み 8 報告と同根の 36 件は群で止まっている |
| 3 | `verify next --handoff` + `wbh-verify` | Lab で再現できるか。人間が観測を記録 | **Lab の基線は 1 つ**: 素の WordPress に管理ホスティング（Sakura / Xserver 級）の堅牢な既定設定を重ねたもの（所有者決定 2026-10-31 夕: その設定の下で攻撃が通れば提出できる）。設定は調査して版付きで `lab-provisioned` に記録。**最新版の鮮度印**: Lab を立てる時点の WordPress.org 最新版と Snapshot の版を記録（却下 2 件が「最新版で修正済み」）。**plugin 単位でまとめて立てる**（Lab 待ち 70 件は 15 plugin） |
| 4 | `wbh-dedupe` | 同じ plugin・版で公開済みか | **提出前に必ず**（却下 40 件中 29 件が重複）。明らかに公開済みなら出さない。Wordfence の内部キューにある重複は読めないので止めない（所有者決定 2026-10-31）。自分の未決着 ticket だけは照合に入れる |
| 5 | `wbh-destination` | Wordfence → Patchstack → vendor の順で報酬の出る先 | 変えない |
| 6 | `wbh-report` | 英語報告書と form JSON | 人間の観測記録が揃ったものだけ review draft。本体依存を使わない経路で書く |

検証の最終根拠は人間の `review observe` の match と `review decide --reproduced match` だけである（不変条件 3、ADR 0040）。Harness は判定器を持たない。段 1 と段 1b と段 4 は AI の中間判断（`--by ai`）で、人間が覆せる。

## 4. 提出と転帰

| 項目 | 現状 | 足すもの |
| --- | --- | --- |
| 送信 | 人間が自分の拡張機能で Wordfence に送る。Harness は送らない（不変条件 7） | 変えない。所有者は CLI を使わないので、人間向けの入口は skill の会話と Artifact / HTML の盤だけにする |
| 台帳 | `review submitted`（#656）で `submission-recorded-externally` を記録。10 件記録済み | 送信時に段 4 の結果 digest と最新版の鮮度印を一緒に記録する |
| 転帰 | 台帳に event が無い。Gmail と dashboard にだけある | 新しい event（paid / validated-cve-only / duplicate / rejected と理由コード、金額、ticket）。Codex 向けの依頼文にする |
| 戻し先 | なし | 転帰 → `wbh-screen` の規則（出典対照表に ticket 番号で根拠を付ける）と Lab の基線。選定・探索には戻さない |

## 5. 数字（2026-10-31 の台帳と Gmail）

| 段 | 件数 |
| --- | --- |
| Finding 受理 | 480 |
| 出口 park | 約 100 |
| 段 1b 成立 / 不成立 / 未決（未検証 173 件） | 106 / 45 / 22 |
| 段 3 Lab 待ち | 70 件（15 plugin） |
| review の最新判断 reject / defer / accept | 200 / 92 / 1 |
| 人間の観測パッケージ | 10 |
| 台帳の提出記録 | 10 |
| Wordfence の harness 期 ticket | 有償 1（USD 152）、validated で報酬待ち 1、CVE のみ 3、重複 2、最新版で修正済み 1、triage 中 2 |

探索は 1 日 50〜90 件の Finding を出し、提出は累計 10 件である。詰まりは段 3 の Lab と、段 1 の採点の精度（CVE のみ 3 件はすべて段 1 で読めた型）にある。

## 6. 進め方（2 本の並行線）

探索線: アーキテクチャは固定。残り skill 3 つ（trace / refute / coverage）と #686（下限 → 設定で 0）。所有者の go で 2 腕の計測を Codex に依頼。

検証線（所有者承認 2026-10-31、順は 7 → 6 → 1 → 2 → 4 → 5）:

1. 転帰 event と提出記録の拡張（Codex 依頼文）
2. 状況盤: Artifact（集計だけ）+ ローカル HTML（詳細）。`scripts/` の AI 用道具として生成
3. `wbh-screen` 次版: 規則の写しを現行 Wordfence ページと突き合わせてから、却下 40 件を出典対照表にして規則を足す（本体依存、外部サービス、多段連鎖、鮮度、重複）
4. 段 4 を Lab の前にも 1 回置く（自分の ticket を含む）
5. Lab: plugin 単位でまとめる、基線 1 つ（素の WP + ホスティング既定）、鮮度印（Codex 依頼文。Sakura / Xserver の既定は先に調べる）
6. 人間の観測パッケージの標準化

## 7. 変えないこと

探索の目的文と契約 v4。出口 park の 10 種。不変条件 1〜8。選定の列。Harness に「提出可」を決める判定器を置かないこと。
