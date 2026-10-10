---
status: accepted
---
# runごとにモデル実行の識別項目を記録する

各Discovery run / Verifier runに、要求したmodel IDとeffort、Codex CLIの正確な版と同梱カタログのdigest、認証方式、cyber access program、service tier、subagentのmodelとeffort、usage（providerが返さない項目は `unavailable`）を記録する。OpenAIのモデルには日付付きsnapshot IDがなく、`codex exec --json` のイベントにも応答モデルの欄がないため、これらを記録しないとベンチマークの腕と本番runを後から比較できない。モデルの既定とDaybreak Blueの実機確認は、後の [ADR 0016](0016-root-plus-three-first-vertical-slice.md) が定める。
