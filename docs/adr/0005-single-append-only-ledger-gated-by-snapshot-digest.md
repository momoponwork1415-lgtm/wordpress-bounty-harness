---
status: accepted
---
# 単一の追記専用台帳と、snapshot digestによる判定の有効条件

全モジュールのイベントを一つの追記専用台帳へ書き、削除しない。判定系イベント（`runtime-confirmed` / `contradicted`）は、FindingとLabが同じTarget Snapshot digestを持つときだけ有効で、不一致は `incomplete`。setup失敗はdiscovery試行に数えない。funnelは台帳から読み取り専用で導き、第二の台帳や集計DBを作らない。Google Mantisの記録規則とCloudflareのfunnel計測、旧リポジトリADR 0024を引き継ぐ。Codexの `findings.json` 等はPrivate Evidenceへdigest付きで保存し、正本にしない。
