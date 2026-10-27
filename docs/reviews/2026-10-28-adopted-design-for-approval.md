# 採用する設計（承認用、2026-10-28）

「調べて報告」の記録。正本ではない。所有者の指示（2026-10-28）: 調べた範囲で AI が良いと思うものを組み合わせて設計を組み立て、所有者が承認する。Cloudflare VDH / VVS、Mandiant AVDH、Anthropic defending harness は所有者が思いついた参考で、採用の義務は無い。

この文書は [設計文書](2026-10-27-partitioned-exploration-design.md) と [構造の図（2026-10-28）](2026-10-28-architecture.svg) の要約に、部分ごとに「何を採り、何を採らず、なぜか」を足したものである。承認されたら、段階 1 の PR の ADR にこの表を写す。

## 1. 一言で

線は「中身は AI、形は Harness」。対象 1 つの中は Harness が順に起こす。

1. 列挙役 1 体が、固定ソースと道具（列挙 script、本体の固定一覧）から、入口・出口の一覧と区画の案を出す。
2. Harness が形だけ検査する（schema、重複行、上限）。超えたら差し戻す。切り分けはしない。
3. 追跡役が区画ごとに 1 体、一発で、互いに隔離されて読む。出すのは Finding と Lead。基準は渡さない。
4. Harness が正規化・park・群（Finding と Lead の両方）を行い、記録する。
5. 別の体が読み直す（段 1b、追跡役の文脈を持たない）。
6. Lab と nonce 付き canary で再現し、人間が観測する（既存）。

Root は置かない。組合せ役（Lead を組む多段の探索）は 24 時間の輪に入れず、人が対象を名指ししたときだけ起こす。

## 2. 部分ごとの採用と出典

| # | 部分 | 採る形 | 出典 | 理由 | 採らなかった代案 |
|---|---|---|---|---|---|
| 1 | 区画の切り方 | AI が「関連する機能」でまとめ、1 区画を自分の context の 2〜3 割に収める | Shopify | 区画の良し悪しは中身の判断。公開実装で区画を AI に出させているのは Shopify だけで、目安が数字で書かれている | Cloudflare の「入口 × 境界 × subsystem × 攻撃クラス」の格子。攻撃クラスの列挙は recall を下げる（Anthropic、契約 v5 の教訓と同じ）。Mantis の tree-sitter 索引を Harness が先に作って渡す形。動的 hook を拾えず、列挙役が何も足さない床になる（所有者の懸念） |
| 2 | 列挙の道具 | script は sandbox に道具として置き、列挙役が自分で走らせて点検し、拾えない分を足す | Mantis（索引は tool であり HINT）、AVDH（入口の抽出は安い model で並列） | 出力は AI の責任のまま、機械で拾える分の手間を減らす | AVDH の形そのもの（Harness が先に走らせて渡す）。床になる |
| 3 | 追跡役 | 区画ごと 1 体、一発、隔離、Finding / Lead のみ、基準を渡さない | Shopify（区画ごとの hunter）、Anthropic（finder に自己検証させない。出力は lead）、Cloudflare（hunter に自分の宿題を採点させない） | 発見と検証は欲しいものが逆。1 体 1 入力 1 出力なら、何を読んで何を出したかが機械の記録になる | 現行の Root + 子の協調。Root が文章で配る配分は記録に残らず、子の数と範囲を Harness が強制できない |
| 4 | Harness の検査 | 形だけ（schema、重複行、未知の行 id、区画の件数、区画数、差し戻し回数）。超えたら前回の案と超えた箇所だけ添えて差し戻す | Cloudflare（`validate-coverage-ledger` / `validate-findings`。形と状態機械だけを検査） | 中身に触らない検査なら決定論で書ける | Harness が区画を機械的に分割する。中身への介入になる |
| 5 | 重複と群 | Harness は群の鍵を出す（HINT）。同根かの最終判断は後段の AI | Anthropic（重複の判断は agent、判断があったことの強制は pipeline）、Mantis（相関は HINT） | 鍵だけで自動 merge すると、違う根の候補を落とす | Harness が鍵で自動 merge |
| 6 | 読み直し | 追跡役の文脈を持たない別の体。model は別でもよい | Cloudflare（候補ごとに新しい verifier）、Mantis（reviewer は finder の文章を見ない）、Shopify（別 model の verifier） | 同じ文脈で読み直すと同じ誤りを通す | 追跡役に自分で確かめさせる |
| 7 | 判定 | Lab で再現し、nonce 付き canary の回収だけを証明とし、人間が観測する | 自前（不変条件 3、ADR 0040） | logic bug の oracle を持つ公開実装は無い。ここは他社より強い | Cloudflare の `needs_validation` 止まり（不足事実 1 つを書いて人に渡す）。Lead の形としては採る |
| 8 | 失敗の扱い | 環境・手順・観測の失敗は `incomplete`。負の証拠にしない。snapshot が合わなければ判定しない | Mantis（`not_attempted`、snapshot 不一致で verdict を出さない）、既存の不変条件 4・5 | 失敗を棄却に数えると分母が壊れる | — |
| 9 | 上限と順序 | 体数・時間・件数・差し戻し回数と段の順序は code。prompt には書かない | Anthropic（制約は code）、AVDH（段の順序は決定論）、Cloudflare（対象ごとの予算） | prompt の数字は守られず、記録にも残らない | prompt に体数・最低時間を書く（現行の wide 断片。段階 5 で消す） |
| 10 | 記録 | 役の判断ごとに機械の記録（`enumeration-recorded`、`partition-assigned`、`composition-recorded`、Finding / Lead の `partition`）。台帳が coverage の主張 | Cloudflare（coverage ledger が主張で、文章は証拠にならない） | 「何を読んだか」が残らないと、分担の正否を数字で決められない | 文章の最終報告だけを残す |
| 11 | 多段の探索 | 組合せ役は名指しのみ。Harness は Lead の全件を渡し、組むかは AI が決める | Wordfence Argus と Austin Ginder の記録（高度な脆弱性は人が対象・方向・証明の要求を担う） | いまの Lead の質では、自動で組む根拠の数字が無い | 24 時間の輪に入れる。Harness が組の候補を作る（所有者が却下） |
| 12 | model | 役ごとに profile で差し替える。agent loop は Claude Code 1 つ | Cloudflare（model は交換部品）、Shopify | 役の定義は Markdown なので、model を変えても形は変わらない | 役ごとに別の runtime を持つ |

## 3. 採らなかったもの

- Mantis の workflow graph engine（独自の状態機械と node 型）。Harness の肥大（LESSONS 14）。段の順序は既存の Trial の枠で足りる。
- Cloudflare の攻撃クラスの格子と severity 欄。型の列挙は recall を下げる。重大度は既存の wbh-screen / wbh-report の範囲。
- AVDH の「threat model を人間が承認してから進む」を輪の中に置くこと。24 時間無人の方針と衝突する。trust 境界宣言を人間が書く既存の形で足りる。
- Anthropic の ASan / crash 再現の oracle。logic bug には当たらない。Lab の canary で代替する。
- Cloudflare の 50〜200 worker の並列。memory 予算で sandbox は 1 つなので、段階 1 は逐次で測る。

## 4. 所有者の決定（2026-10-28）

- この構成を承認した。
- ①〜④（洗い出す、形を検査する、区画ごとに読む、整える）と、⑤⑥（別の体が読み直す、再現して人が見る）は分ける。人が関わるのは主に ⑤⑥ である。①〜④ は 24 時間の輪の中で無人で回り、出力は台帳の候補と手がかりで終わる。⑤⑥ は別の流れとして、列から取り出して動かす（診断は Codex、観測は人。2026-10-26 の決定のまま）。
- 残りの 4 点（契約 v4 の solo 版、model の初期値、上限の初期値、段階 1 の受け入れ）は下の提案のとおり進め、数字が出たら見直す。

## 4a. 所有者に決めてもらったこと（提案時の文）

1. この構成の承認。
2. 契約 v4 の solo 版（Root 向けの 1 文を抜く）を新しい版と数えるか。提案: 同じ v4 のまま、描画の id だけ分けて digest を固定する。本文は変えない。
3. 役ごとの model の初期値。提案: 追跡役は現行 wide と同じ model、列挙役も同じ model で始め、数字が出てから列挙役を安い model に替える比較を足す。
4. 上限の初期値。提案: 1 区画 60 行、区画 8 まで、差し戻し 2 回。
5. 段階 1 の受け入れ。提案: dev set は既知 7 件の入口が inventory にあるかの受け入れ試験だけ。比較は本番 20 対象 k=2（群、段 1b 通過、Lab 観測、時間と token、script の行と AI の行の使用率）。

## 5. 進み方

PR 1（形: schema、検査、台帳、設定、役の Markdown、道具、test、ADR）→ PR 2（runtime: 一発の runner、mount、役ごとの実行）→ PR 3（測定の腕と比較）。消し方は `discovery.mode` を外すこと。役の Markdown と新しい event は残っても読まれない。
