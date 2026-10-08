---
status: accepted
---
# runごとにモデル実行の識別項目を記録する

各Discovery run / Verifier runに、要求したmodel IDとeffort、Codex CLIの正確な版と同梱カタログのdigest、認証方式、cyber access program、service tier、subagentのmodelとeffort、usage（providerが返さない項目は `unavailable`）を記録する。OpenAIのモデルには日付付きsnapshot IDがなく、`codex exec --json` のイベントにも応答モデルの欄がないため、これらを記録しないとベンチマークの腕と本番runを後から比較できない。本番は `gpt-6.1-sol`、開発セットは `gpt-6-luna` を既定とし、変更はカタログだけで行う。
