---
status: accepted
---
# Root＋最大3 subagent の縦断スライスを先に完成させる

## 決定

WordPress プラグインの探索は、固定した Target Snapshot ごとに Root 1つと最大3つの subagent を使う協調 Trial を主経路にする。Root は分担と統合を行うが、Harness は脆弱性探索の手順・checklist・固定した役割を prompt に書かない。既定 prompt は短い目的 prompt のまま版と digest を記録する。WP2Shell から採るのは協調の形であり、旧 prompt の「必ず脆弱性がある」「最低6時間」などの前提は持ち込まない。

**更新:** promptの選択と比較方針はADR 0017で更新した。Root＋3の構成、隔離、独立検証の決定は維持する。

最初は人間が指定した公開済みTranslatePress 3.2.6を1協調Trialで調べる。独立確認と同一経路の修正版対照が通らなければ診断後に3.3.1を1協調Trialで調べる。どちらかでゲートを通したらベンチマークを止め、最小の自動選定で最新版3対象の本番探索を始める。レポートJSONの完全自動化や多数の評価caseを本番探索開始の条件にしない。実Findingの外部提出には最新版の独立確認、重複・scope照合、証拠、人間の手動Lab再現と承認を要する。詳細は [TranslatePressベンチマーク](../TRANSLATEPRESS-BENCHMARK.md)。pass@k、安価な広域スクリーニング、複数探索方式の切替は、本番の費用と歩留まりを観測してから判断する。スクリーニングを追加しても、陰性だけで Root Trial を止める規則は設けない。

本番 runtime は Daybreak Blue に対応する `gpt-6-sol` 系を要求する。正確な CLI の model ID、subagent 継承、認証ブローカーの並列許容量は実機 preflight で固定し、未確認の組合せを設定に書いて通ったものとみなさない。失敗時に別モデル・単独agent・弱い隔離へ暗黙に切り替えない。

## 理由

利用者が優先するのは、別の機能やファイルをつないだ高影響の欠陥を見つけ、低い人手負担で報奨に至ること。現行の独立・単独 Trial は、探索経路の統合を同じ Trial 内で扱えない。旧 WP2Shell で Root と subagent の構成を使った経験はある一方、WordPress バグバウンティでの構成間の優劣はまだ実測されていない。まず既存の snapshot、gVisor Lab、判定器、台帳を使った縦断スライスで実際に動くかを確かめ、最適化はその後に行う。

## 既存決定との関係

- ADR 0013の短い目的 prompt と版・digestの規則、SPEC第2節の安全・証拠の不変条件は維持する。
- ADR 0014の「独立単独 Trial＋任意の1 hop Lead継続」は、主経路の既定から外す。旧データの読み取りと比較用設定は必要な間残す。Root の中で subagent が Lead を調べることは、独立 Trial 数を増やさない。
- 1 Trial の後に同じ版を再探索するか次の対象へ移るかの数値規則は、最初の実測後に決める。現行の上限6・無成果連続3は旧実装の設定値で、Root＋3の最適値とは扱わない。

## 帰結

最初の本番探索への受入条件は、provider 上限・schema 失敗を含めて子の成果が失われないこと、Root と各 subagent の source 読取・時間・使用量を追えること、Finding / Lead が snapshot digest を持つこと、TranslatePressの少なくとも1件で判定器が独立した Lab で canary を確認し、同じ経路の修正版でconfirmedにならないこと。外部提出には追加で人間が再現パッケージから手動で再現できることを要する。手順を人間が再現する前に外部送信は行わない。
