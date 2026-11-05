# ADR の索引

ADR は追記専用で、番号順に読む。本文は書いた日の決定で、後から変えない。実測が本文と食い違ったときは、同じ file の末尾に日付付きの「追記」を足し、追記が本文より優先する（[DEVELOPMENT.md 第 6 節](../DEVELOPMENT.md)）。ADR を変える PR は `owner-approved` ラベルが要る。状態が `superseded` の ADR は、どの ADR に置き換わったかを frontmatter に持つ。

## 一覧

| 番号 | 題 | 状態 | 一言 |
| --- | --- | --- | --- |
| 0001 | 探索に既知脆弱性の答えを与えない | superseded → 0012 | 答えは渡さない |
| 0002 | 自動の実行時検証を人間レビューの前に置く | accepted | 検証が先、人間は後 |
| 0003 | 探索エージェントは隔離 Lab 内で対象を実行してよい | accepted（2026-10-25 追記） | 実行は gVisor の中だけ |
| 0004 | runtime-confirmed は Harness 所有の判定器だけが出す | superseded → 0040 | 判定器は廃止 |
| 0005 | 単一の追記専用台帳と snapshot digest による有効条件 | accepted | 台帳 1 つ、digest 一致 |
| 0006 | 対象選定に人間の承認を置かない | accepted | 方針だけ人が持つ |
| 0007 | run ごとにモデル実行の識別項目を記録する | accepted | model・usage を残す |
| 0008 | strict TypeScript のモジュラーモノリスと薄い CLI | accepted | 境界は型で守る |
| 0009 | provider 認証情報は有界の egress broker を通す | accepted | 鍵は sandbox に渡さない |
| 0010 | プログラム対象範囲は技術的検証を止めない | accepted | 範囲は review で評価 |
| 0011 | 対象固有のコードは Target Profile に閉じ込める | accepted | WordPress は profile へ |
| 0012 | 既知脆弱性は評価では時点で切り、本番は公開履歴をカタログで渡す | accepted | 履歴はカタログ情報だけ |
| 0013 | 探索 prompt の管理指示変種を版付きの A/B 軸にする | superseded → 0017 | ablation は削除 |
| 0014 | Lead の継続は同一 Trial 内の 1 hop に限る | superseded → 0016, 0025 | 旧単独 Trial の記録 |
| 0015 | 判定器の HTTP 証拠を Harness が捕捉する | accepted | HTTP 捕捉は Harness |
| 0016 | Root＋最大 3 subagent の縦断スライスを先に完成させる | superseded → 0025 | 初期の協調 Trial |
| 0017 | 短い管理 prompt と WP2Shell 式報奨 prompt を同条件で比較する | accepted | prompt 比較の作法 |
| 0018 | 探索候補を出力境界で失わない | accepted | 棄却せず保留 |
| 0019 | 出力契約を Harness が schema から生成する | accepted | prompt は目的文だけ |
| 0020 | 検証 Lab の前提を profile の版付きシナリオにする | accepted（0026 で変更、#353 で削除） | シナリオは退役 |
| 0021 | Stored XSS 判定器は宣言された被害者ロールと画面で観測する | accepted（判定器は 0040 で廃止） | 旧判定器の記録 |
| 0022 | Verifier の incomplete を理由ごとの再試行方針で前へ進める | accepted | incomplete の理由コード |
| 0023 | funnel に最終 JSON 到達と受理の列を加える | accepted | funnel は出力境界から |
| 0024 | sensitive-object-access を残すなら判定器を持つ | accepted（impact は 2026-10-17 に park） | park 対象 |
| 0025 | 主経路を二段構えにし、継続境界を Harness が持つ | superseded → 0029 | 二段は廃止 |
| 0026 | 検証 Lab は汎用 scenario を主とし、Verifier にブラウザを渡さない | accepted（2026-10-26 追記） | 観測器は Harness |
| 0027 | contributor 以上を信頼側に置き、再発見を配線の証明とする | accepted | 攻撃者は subscriber まで |
| 0028 | 人間と判定器の役割分担を所有者の作業時間で固定する | withdrawn → 0031 | 取り下げ |
| 0029 | 探索の主経路を単一の WP2Shell 協調 Trial に戻す | accepted（追記多数） | 対象 1 件 1 Trial |
| 0030 | 対象選定では公開履歴を採点しない | superseded → 0037 | 履歴は使わない（旧） |
| 0031 | 人間レビュー・報告書・重複照合は skill に置く | accepted | review は skill |
| 0032 | 2026-10-13 のグリルで所有者が決めた制約 | accepted | 出口 park の 10 種 |
| 0033 | 最低 1 時間の探索と依存 source の固定 | accepted | 依存も Snapshot に |
| 0034 | Harness は制御だけを持つ: 索引・coverage・catalog の削除 | accepted | 中身は AI、形は Harness |
| 0035 | 検証を skill にし、Harness は Lab 供給だけを持つ | accepted | wbh-verify と handoff |
| 0036 | provider の拒否で止まった Root を操作者の指示で再開する | accepted（追記あり） | resume の規則 |
| 0037 | 対象選定は公開履歴の件数と公開日を採点に使う | accepted（追記 1〜6 で上書き） | 今の選定規則は追記側 |
| 0038 | 検証から提出までを 6 段に分ける | accepted（追記多数） | 6 段と park |
| 0039 | 探索に deep と wide の 2 つの mode を置く | accepted（追記多数） | 目的文の版はここ |
| 0040 | 判定器と canary を削除し、確定は人間が Lab で観測する | accepted | 人間の観測だけが根拠 |
| 0041 | 外部サービス接続の一回限りの例外を記録する | accepted（0046 が常態化） | 一回限りの記録 |
| 0042 | 区画分配型の探索（段階 1、形） | superseded（2026-10-30、#685） | 区画分配は廃止 |
| 0043 | 探索の手順をスキルに分けて sandbox に渡す | accepted | wbh-recon / tools / setup |
| 0044 | 過去 Trial の Lead を名指しした第 2 Trial の入力にする | accepted | Lead 入力 Trial |
| 0045 | 変えないものを 5 つ凍結し、探索を 3 つの戦力に分ける | accepted | 凍結 5 項目、月 1 回 |
| 0046 | 外部サービス接続の Lab 通信を条件付きの通常運用にする | accepted | egress relay |
| 0047 | WordPress 本体は常に最新の安定版に追随する | accepted | 版は方針に書かない |
| 0048 | 過去 Trial の研究 file を同じ対象の後の Trial に渡す | accepted | prior research |
| 0049 | 全 Trial に Lab を付け、保存先の観測器 `find` / `sql` を足す | accepted | Lab 常設探索、`maxLookups` |
| 0050 | Cloudflare の監査スキルを WordPress 探索の派生元にする | accepted | 六段の監査手順をスキルに置く |
| 0051 | 7 月 30 日方式を一つの目的文として本番で試す | accepted | 2026-11-05 追記: v26-wide をリポジトリの主経路にし、六段階探索方式を実験用に移す |

## 今も効いている ADR（段ごと）

本文が古くなった ADR は追記側を読む。0037、0038、0039 は追記で本文の大半を上書きしている。

- 選定: 0006（人の承認なし）、0037 の追記（版上昇再訪 #533、下限 5,000・180 日・batch 10、帯優先の順序、deferred の 7 日再試行、`countTrialsFrom`）、0027（攻撃者位置）。
- Snapshot: 0012（公開履歴は時点で切る）、0033（依存 source の固定）、0047（WordPress 本体は最新安定版）。
- 探索: 0029（単一協調 Trial）、0036（再開の規則）、0039（deep / wide と目的文の版）、0043（sandbox のスキル）、0044（Lead 入力）、0045（凍結 5 項目）、0048（prior research）、0049（Lab 常設と `find` / `sql`）、0050（六段階の比較方式）、0051（7 月 30 日方式の主経路と実験方式の分離）、0018 / 0019（Finding / Lead の契約と保留）。
- 出口: 0032（park する impact 10 種）、0038 の追記（申告欄による park と `review restore`）。
- 検証: 0026 の追記（Harness は観測器だけ）、0035（wbh-verify と handoff）、0040（人間の観測が唯一の根拠）、0046（外部サービス接続は条件付き通常運用。0041 はその前の一回限りの記録）、0015（HTTP 捕捉）、0022（incomplete の理由コード）。
- 提出とレビュー: 0031（review・報告書・重複照合は skill）、0038（6 段と提出の流れ）、0010（対象範囲は review で評価）。
- 境界と基盤: 0011（profile）、0034（制御だけを持つ）、0005（台帳）、0009（broker）、0008（型の境界）、0007（model 記録）、0003（Lab 内実行）。
