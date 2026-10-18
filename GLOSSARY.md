# 用語集

[SPEC.md](docs/SPEC.md) 第 15 節と同じ語は SPEC が正。ここには AGENTS.md と運用の文書が引く語を置く。

| 用語 | 意味 |
| --- | --- |
| Target Snapshot | 調べる対象と必要な依存 source を版と digest で固定したもの。 |
| Campaign | 台帳の `campaignId` の単位。本番では選定 batch 1 つ（最大 `maximumTargets` 件の Target Snapshot）の探索と記録のまとまりで、検証は後から Finding 単位に同じ campaign へ記録する。開発の手動 run では 1 対象でもよい。 |
| Trial | Campaign 内の独立した探索試行。現行の探索では Root と最大4つの subagent が1つの Trial を構成する。 |
| Discovery run | モデル実行の記録単位。Trial の中で何回モデルを呼んだかと区別する。 |
| Finding | 攻撃者の立場、入口から影響までの source 上の経路、観測を持つ未確認の主張。 |
| Lead | source に根拠があり、影響までに未解決の辺が残る手がかり。Finding や検証結果ではない。 |
| VerificationResult | 新しい Lab の判定器が出す `runtime-confirmed`、`contradicted`、`incomplete` のいずれか。 |
| Reproduction Package | 人間が Lab を再構築し、遠隔攻撃者の手順で同じ結果を確かめるための証拠と手順。 |
| Submission Candidate | 最新版で確認済みの脆弱性、提出先、文案の版を結び付けたレビュー対象。 |
| Private Evidence | HTTP 記録、payload、画像、認証情報、未公開の発見を置く Git 外の保管先。 |
| 保留候補（candidate-held） | 探索 run の最終 JSON から抽出したが、正規化後も出力契約を通らない Finding / Lead 候補。分類と issue path だけを台帳に残し、本文は Private Evidence に置く。Finding でも検証対象でもない（ADR 0018）。 |
| finding-parked | Programme Boundary 外の impact と、判別の付きにくい 5 分類の Finding。台帳と Private Evidence に残し、検証・review queue・funnel の raw に入れない。一覧は `review parked`（ADR 0032）。 |
| cascade | 選定の主帯（100k–1M install）が尽きたときだけ順に試す段（50k → 30k → ≥1M かつ paying class 記録 ≥2）。`target-selected` に `cascadeStep` が残る（ADR 0037）。 |
| segment | `provider-cyber-policy` で止まった Root thread を、操作者が `campaign resume` で新しい sandbox に再開した続き。同じ Trial に数え、`resumesRun` / `resumeSegment` を持つ（ADR 0036）。 |
| handoff | `verify next --handoff <dir>` で Harness が Finding 単位の Lab を立て、skill `wbh-verify` が前提作りと再現を行う検証の経路。判定は判定器だけが出す（ADR 0035）。 |
| 通常機能シナリオ | profile が版と digest で管理する、対象プラグインの通常の利用状態の定義。Lab Setup に含め、Finding の前提と照合する。権限の付与や危険設定は含まない（ADR 0020）。 |
