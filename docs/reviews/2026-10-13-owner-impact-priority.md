# Critical／High の影響を探索目標にする判断（2026-10-13）

調べて報告。正本は [SPEC](../SPEC.md) と [ADR 0032](../adr/0032-owner-decisions-on-constraints-2026-10-13.md)。実装作業は #214。未公開の候補本文、payload、HTTP記録、Lab証拠はGit外のPrivate Evidenceに保持する。

## 実測と今回の9件

現行mainによる実対象3件の単一協調Trialはすべて正常終了し、Finding 9件（`sensitive-object-access` 8件、`options-update` 1件）、Lead 6件を記録した。Findingの独立検証は計16試行で、9件の最新結果は`incomplete(observation)` 2件、`incomplete(precondition)` 7件。`runtime-confirmed` と`contradicted` はともに0件だった。

現時点の観測と候補の主張からは、所有者が示したCritical／Highの具体例に届く効果を**どの件も実証できていない**。これは「9件に脆弱性がない」「重大な効果が存在しない」という判定ではない。2件は効果を観測できず、7件は通常利用の前提を満たすLab構成が不足しており、成立可否は未確定である。所有者は今回の9件を、現時点のCritical／High目標に照らして積極的な追跡対象にしないと判断した。候補の具体的な内容と再検証条件はPrivate Evidenceと既存のreview exportに残る。

## 今後の判断

- 所有者の目標は、未認証またはsubscriber／customerから成立するコード実行、任意ファイルの読み取り・削除、コード実行に至るアップロード、SQL injection、Stored XSS、重大なデータの読み取り・改変、未認証からの権限昇格と管理者への認証回避、subscriber／customerから管理者への権限昇格など、提示されたCritical／Highの**効果**である。`options-update` と`sensitive-object-access` を分類名だけで一律に除外しない。
- 新しい`wp2shell-bounty-v4`目的文にこの目標を反映し、旧v3の本文とdigestは残す。v4は版・digestを固定する。promptの誘導だけで低価値候補が消えるとは限らず、新規Findingは既存の受理・独立検証・review経路を維持する。Critical／Highに該当するか、提出価値があるかは証拠を見て人間が決める。
- [Wordfence公式Programme Boundary](https://www.wordfence.com/threat-intel/bug-bounty-program/)は所有者の目標と別に評価する。公式ページは任意options更新をHigh Threatに含める一方、保護記事へのアクセス、基本的な情報露出、実質的影響のない認可欠落を対象外に挙げる（2026-10-13確認）。分類ラベルだけで公式の受理可否も決めない。
- 旧TrialのFinding・検証・review export・台帳eventを変更しない。`incomplete`は未確定のまま保持する。新しい証拠が出るか所有者の優先順位が変わった場合に、必要なLab前提と観測を補って効果を再評価する。
