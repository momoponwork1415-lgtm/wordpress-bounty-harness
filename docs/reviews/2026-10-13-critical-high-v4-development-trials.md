# #214 探索 v4 開発 Trial の実測（2026-10-13）

この報告は Git 外の開発台帳から、Trial・Lab・使用量・検証・review export のメタデータだけを集計したもの。Finding / Lead の本文、未公開の経路、payload、HTTP 記録、認証情報は含めない。設計の正本は [SPEC](../SPEC.md) と [ADR 0032](../adr/0032-owner-decisions-on-constraints-2026-10-13.md)。

## 分母と固定条件

#214 の変更を含む source commit は `bdcc26d31dcd99e32d6f68a893202fcabfc9352b`。公開済み開発対象の TranslatePress 3.3.1 と WordPress core 7.1.3 を、別 campaign の独立した単一協調 Trial で3回測った。Target Snapshot は3回とも `sha256:d89681d233e2502521c271cb8501c3b836b9bc9afd158a7172e97f343a08a7c4`、source は `sha256:b859fc841841893c0717322b677af976e09a707f777f12c482f2f38d8e409127`、dependency は `sha256:4cf326b1261b5ea9ead8cac156e79e7ee34137b9b6e2725690c0dba0bf6b0d83`。

- 探索目的: `wp2shell-bounty-v4` / `sha256:6c823fe2ddb8a9af27ea743927f5d4a8203ec29ef4bca7dbadf3135c1739ab62`。Harness 生成の Finding / Lead 契約は `sha256:a74a93951d790aec174c3506a6df9ae2cd391bc44bdedea7fdf8ff74d503db3d`、入口索引は有効で `sha256:7288afdb5919c398234fc3c8a49be4d6dc030a28decde05c013bbaee6ae210c6`。
- Trust 境界は `trust-boundary-v1`、Programme Boundary は `wordfence-2026-10-08`。Verifier 指示は `verifier-v7`。探索は Root＋最大3子、対象ごとに1 Trial、wall 上限60分。探索 Lab は HTTP・read-only DB の到達がともに `ok`。
- 最初の2件は `scenarioId` を指定しない pilot。scenario の不在は通常初期設定を意味せず、別の Lab 設定は残る。campaign 設定ファイルの byte SHA-256 は `bd245579448a8bf7e2b27e0e6a3ec6ef8ab723d408d66743478957bff11d04a4`、Lab setup は `sha256:f4d592a2d47844ae38cc1e6fc5359af7f5f92350c3849f6a01ee`、実機 preflight receipt は `sha256:f1df444352a2ab6a7446b11fa6e7a297e447a154777336a68091835cb52a8429`。
- 3件目は既存の `translatepress-translation-data-v1` scenario を指定。scenario digest は `sha256:111ae6445c8290ae49494ebf4ae116994262722f74114994ed4115ad5930bffc`、Lab setup は `sha256:d4d7a006eca7922911a88401541774a91cdd3b166a784d6336784a1f9543c058`。campaign 設定ファイルの byte SHA-256 は `d578b5a56e8b5e31c18ca24b7fb510f76650b8dba6bf9fd13353937286a6fd5c`、実機 preflight receipt は `sha256:dc38bef6f63ef2180335b874f2be4769b828ad000f2e597e863dc937cdd010a9`。

## 結果

| Trial | Lab | Root / agent 完了 | Finding / Lead | 最新検証 | review queue / export | Root wall | 終了 |
| --- | --- | --- | ---: | --- | ---: | ---: | --- |
| `dev-critical-high-v4-01` | scenario なし | 1/1・4/4 | 3 / 0 | `incomplete(precondition)` 3 | 3 / 3 | 17.05分 | `max-runs` |
| `dev-critical-high-v4-02` | scenario なし | 1/1・4/4 | 1 / 4 | `incomplete(precondition)` 1 | 1 / 1 | 27.05分 | `max-runs` |
| `dev-critical-high-v4-scenario-01` | scenario v1 | 1/1・4/4 | 1 / 2 | `runtime-confirmed` 1 | 1 / 1 | 16.78分 | `max-runs` |

3 Trial とも Root は正常完了し、agent run は12/12完了。Finding 5、Lead 6、保留0、parked 0。最新検証は `incomplete(precondition)` 4 と `runtime-confirmed` 1。実行失敗は0、正常な候補0件終了も0。Root wall 中央値は17.05分。受理された Finding 5件は全件 review export まで到達した。review export は受け渡しであり、人間による採否や外部提出を意味しない。

| Trial | input tokens | cached input | output | reasoning output |
| --- | ---: | ---: | ---: | ---: |
| `dev-critical-high-v4-01` | 27,996,275 | 27,409,280 | 89,506 | 32,249 |
| `dev-critical-high-v4-02` | 45,333,126 | 44,514,560 | 117,200 | 41,940 |
| `dev-critical-high-v4-scenario-01` | 27,044,496 | 26,451,072 | 80,555 | 25,561 |
| 合計 | 100,373,897 | 98,374,912 | 287,261 | 99,750 |

usage の4項目はいずれも12 agent run すべてで取得できた。上の token は探索 agent の合計で、preflight や Verifier の token を加えていない。

## 読み方と限界

scenario なしの2 Trial は4 Finding を得たが、すべて Lab の前提不足で `incomplete` になった。これを反証や候補0件に数えない。scenario 付き Trial の `runtime-confirmed` は、使い捨て Lab で Harness 判定器が確認した技術的結果に限る。Lab の通常初期設定ではなく scenario に依存する条件があり、追加前提なしの成立、最新版での残存、報奨対象性、Critical／High の認定は示さない。開発対象は公開済みの既知脆弱版であり、未知脆弱性の発見率も示さない。

3件は同一 plugin・同一 Snapshot の反復で、Lab 条件も途中で変わった。v3 との同条件比較や複数対象での再現性の測定ではない。これら3件は、所有者による反復実行の新しい承認条件が決まる前に開始した。以後の追加 Trial は実施していない。候補の判断は review に残し、外部への報告・公開は行っていない。
