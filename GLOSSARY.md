# 用語集

| 用語 | 意味 |
| --- | --- |
| Target Snapshot | 調べる対象と必要な依存 source を版と digest で固定したもの。 |
| Campaign | 1つの Target Snapshot に対する探索、検証、記録のまとまり。 |
| Trial | Campaign 内の独立した探索試行。目標構成では Root と最大3つの subagent が1つの Trial を構成する。 |
| Discovery run | モデル実行の記録単位。Trial の中で何回モデルを呼んだかと区別する。 |
| Finding | 攻撃者の立場、入口から影響までの source 上の経路、観測を持つ未確認の主張。 |
| Lead | source に根拠があり、影響までに未解決の辺が残る手がかり。Finding や検証結果ではない。 |
| VerificationResult | 新しい Lab の判定器が出す `runtime-confirmed`、`contradicted`、`incomplete` のいずれか。 |
| Reproduction Package | 人間が Lab を再構築し、遠隔攻撃者の手順で同じ結果を確かめるための証拠と手順。 |
| Submission Candidate | 最新版で確認済みの脆弱性、提出先、文案の版を結び付けたレビュー対象。 |
| Private Evidence | HTTP 記録、payload、画像、認証情報、未公開の発見を置く Git 外の保管先。 |
| 保留候補（candidate-held） | 探索 run の最終 JSON から抽出したが、正規化後も出力契約を通らない Finding / Lead 候補。分類と issue path だけを台帳に残し、本文は Private Evidence に置く。Finding でも検証対象でもない（ADR 0018）。 |
| 通常機能シナリオ | profile が版と digest で管理する、対象プラグインの通常の利用状態の定義。Lab Setup に含め、Finding の前提と照合する。権限の付与や危険設定は含まない（ADR 0020）。 |
