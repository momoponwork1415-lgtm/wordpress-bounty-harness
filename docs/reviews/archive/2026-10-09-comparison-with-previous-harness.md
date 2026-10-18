# 旧 wordpress-harness との比較（2026-10-09）

位置づけ: レビュアーのまとめ。旧リポジトリ（公開 GitHub `momoponwork1415-lgtm/wordpress-harness`）の README と ADR 0125 / 0126 / 0128 / 0135 / 0136 / 0143 を読んで書いた。旧の Research Campaign の内部実装と評価文書は参照していない。「到達点」は [最終設計](2026-10-09-target-architecture.md)。図は別添の HTML。

## 1. 何が改善されたか（旧 → 現行）

| 観点 | 旧 | 現行 | 改善の中身 |
| --- | --- | --- | --- |
| 候補の採否 | 人間が未検証候補を採否（Human Candidate Review、旧 ADR 0135） | 検証を通ったものだけ人間が見る（ADR 0002） | 人間に最も難しい「本物か」の判断をさせない。人間が律速にならない |
| 確認の証明 | agent が書いた recipe を新環境で 1 回実行し、自己報告の条件で判定 | Harness 所有の決定論的判定器が nonce canary の回収で判定（ADR 0004） | 自己申告を証明にしない。修正版での負の対照で判定器自体を検査できる |
| 対象選定 | AI 提案を人間が承認 | 方針 file から機械選定（ADR 0006） | 承認待ちが消え、方針を直せば順位が変わる |
| 探索中の実行 | source のみ | gVisor Lab で HTTP を打てる（ADR 0003） | 仮説を実行で確かめられる |
| 既知脆弱性 | 全面禁止 | 時点で切った公開履歴を渡し、A/B で測る（ADR 0012） | 修正の回避と変種を狙える。評価の汚染は時点で防ぐ |
| 記録 | Research Record と opaque checkpoint | 単一の追記専用台帳、funnel、usage（ADR 0005） | どこで何件減ったかが読める |
| 評価 | 公開 CVE の結果だけ公開 | 答えの鍵、区間、前向き評価、負の対照、本番 A/B | Harness を変えたときの差が数字で出る |
| 構成 | 複数 provider、Root + subagent | Codex 1 本、broker 経由、subagent 無効 | 記録項目（ADR 0007）が埋まる。quota の消費が読める |

## 2. 旧にあって現行で失われたもの（到達点で有界に戻す）

| 観点 | 旧 | 現行 | 到達点 |
| --- | --- | --- | --- |
| 依存 source | core を RO mount（旧 ADR 0128） | plugin のみ。Dependency Snapshot は仕様だけ | core を image から取り出し `/workspace/wordpress` に RO mount。版を 2 点で照合 |
| 探索の深さ | 1 本の長い Campaign | run が 2 分で終わる | Trial 90 分。深さは Harness の wall time で切る |
| 候補の継続 | checkpoint で無期限に継続（旧 ADR 0126 / 0143） | 継続なし | Trial 内の 1 hop だけ。Harness が Lead の近傍だけを渡し、独立試行数を増やさない |
| 証拠の規律 | Research Report v2 が trace と control assessment を要求（旧 ADR 0136） | Finding に sourceTrace と existingControls | Lead 型で「1 辺欠けた primitive」も記録に残す |

## 3. 現行の欠陥で、旧の問題とも違うもの（到達点で直す）

- RCE / Stored XSS の canary を Verifier に発行する経路がなく、ATO の session 受け口もない。高い報奨帯が構造的に `incomplete` になる。
- prompt は DB 読み取りを許可するが、探索 container から DB に届かない。
- 失敗 run の理由が private receipt の中にしかなく、Lab に届いていたかも分からない。
- 読出し系の判定が agent の書いた `http.json` に依存する。

## 4. 変わらないもの

8 つの不変条件、profile 分離、gVisor と broker、追記専用台帳、人間判断点が 2 つ、Harness が外部送信しないこと。
