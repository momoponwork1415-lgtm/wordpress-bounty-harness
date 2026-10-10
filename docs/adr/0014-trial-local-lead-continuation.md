---
status: superseded
superseded-by: 0016
---
# Leadの継続は同一Trial内の1 hopに限る

この文書は旧単独Trialの履歴と互換読取のために残す。新しい主経路は [ADR 0016](0016-root-plus-three-first-vertical-slice.md)。

## 決定

独立試行の単位はTrialとする。1 Trialは保存先索引から作ったscope、新しい探索container、探索runを持つ。探索runがsourceに根拠のあるLeadを報告した場合に限り、opt-inの `continuation` ブロックとarmに従い、最大2件を1 hopだけ新しいcontainerで継続できる。継続のwall timeは既定30分、設定上限120分。継続へ渡すのは選んだLeadと索引上の近傍だけで、探索transcript、別のLead、Findingは渡さない。継続のFindingは親Trialの成果であり、pass@kの独立試行数を増やさない。LeadそのものはVerifierへ渡さない。

既定は継続なし。対象あたりのTrial上限6、新規FindingもLeadもないTrialの連続3件、探索runのwall 90分、同時2 Trialを初期値とする。日次Trial上限の設定は持たない。provider limitでは新規Trialを止め、自動retryせず同じcampaign IDで再開する。失敗した継続runは親Trialを失敗にしない。

## 理由と観測

primitiveの発見と影響までの残る1辺の調査を同じTrialに結び付ければ、独立試行数を水増しせず深さを測れる。索引の近傍だけを渡して、他Trialや評価の答えを混ぜない。#73の開発セットではLeadが0件で継続は発火せず、効果は未確認。日次上限はproviderのquotaとは別の自己制限で、探索前の失敗を翌日まで補えなくしたため廃止した。

## 採らなかった選択肢

- Leadごとに独立Trialを追加する: 分母と費用を比較できなくする。
- 長期Campaignのcheckpointへ全transcriptを引き継ぐ: 他の発見や評価条件が混ざる。
- 失敗した継続を親Trialの失敗にする: 成功した探索runの観測を失う。

## 帰結

台帳にはoptionalな `trialId`、`trialOrdinal`、`runKind`、`continuationOf`、Leadのdigestと分類を追加し、旧eventを読み続ける。WordPress固有の索引とLead型はprofileに置く。
