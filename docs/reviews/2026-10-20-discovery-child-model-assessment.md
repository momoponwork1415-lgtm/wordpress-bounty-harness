# 探索の子エージェントに必要なモデル能力（2026-10-20）

正本ではない。対象は、v8 の単一協調 Trial で子の `gpt-6-sol` を `gpt-6-luna` に下げる案である。**子に Sol が必須という証拠はないが、Luna で同等の候補を得られる証拠もない。子だけ Luna にする開発比較には価値がある。**

## 事実

- v8 は Root が分担・統合し、子は独立した着眼点から source を調べ、具体的な経路を反証する。子の Finding と Lead は Root の最終報告と独立に保存される。[目的文](../../src/profiles/wordpress/prompts/wp2shell-bounty-v8.md)、[SPEC §6](../SPEC.md)
- v8 の5対象はすべて Root・子とも `gpt-6-sol`。1対象が `high`、4対象が `xhigh` で、子だけ別モデルの比較はない。子4体を含む全 agent の観測読取は2,191〜4,314回、Root は377〜651回だった。この数字は読取の延べ回数で、成果の質ではない。[v8 評価](../evaluation/2026-10-19-v8-five-target-rediscovery.md)
- 旧配線 Trial では、Root が時間切れになっても子の Finding 1件が後続の判定器で `runtime-confirmed` になった。子は単なる索引係ではない。[配線計測](../evaluation/2026-10-16-wiring-gate-measurement.md)
- 過去の安価モデル実験には既知事例の部分的な再発見があるが、v8 の子だけ Luna にする案や未知脆弱性の発見率は測っていない。[実験一覧](../knowledge/experiments.md)
- OpenAI Docs は Luna を範囲の明確な反復作業向け、Sol を複雑な技術作業向けの出発点とし、同じ入力で比較して品質基準を満たす最も軽い設定を選ぶよう勧める。これは本 Harness の子の適格性を保証するものではない。[モデル選択](https://developers.openai.com/api/docs/guides/model-selection)、[reasoning effort](https://developers.openai.com/api/docs/guides/deployment-checklist)
- 現行の本番協調 profile は `gpt-6-sol` と Daybreak Blue を要求し、Root・子の model と effort の一致も admission と実行後の検査で要求する。子だけ Luna は設定値の変更だけでは実行できない。[profile](../../src/discovery/agent-runtime-profile.ts)、[子の検査](../../src/discovery/codex-native-agent-runtime.ts)、[SPEC §6](../SPEC.md)
- 費用は現状 Codex CLI の月額サブスクリプション経由。子を Luna にしても直ちに API 請求が減るわけではない。比較すべき便益は quota、provider 上限、遅延、単位時間当たりの確認済み成果である。[SPEC §14](../SPEC.md)

## 選択肢と判断

| 選択肢 | 判断 |
| --- | --- |
| Sol を全員に維持 | 現行の確認済み構成を維持できるが、子の能力に余剰があるか分からない。 |
| Root は Sol、子は Luna | 最初に比較したい構成。子の独立した候補と反証の質が落ちないか測る。 |
| 全員 Luna | Root の舵取りも変わり、子だけの能力差を切り分けられない。次の問いにする。 |

最初は同じ開発対象、Snapshot、v8、Root の model・effort、人数、wall で、子の model だけを `gpt-6-sol` から `gpt-6-luna` に変える。子の effort は両 arm で同じ `xhigh` とし、Luna の `high` への変更は次に測る。少なくとも異なる3対象の初回 Trial を記録するという runtime PR のゲートを満たし、比較には同じ対象の独立 Trial を用いる。[DEVELOPMENT §5](../DEVELOPMENT.md)

主要な比較値は、子だけが出した範囲内の source 根拠付き候補、その後の判定器による確認、既知事例との経路一致、子の報告 schema 失敗、usage、wall、provider 上限である。Finding と Lead の生件数だけでは判断しない。

## 未確認の仮定

- Codex CLI と Daybreak Blue の組合せで、Root Sol・子 Luna が実際に許可され、正しく記録されるか。実機 preflight が要る。
- Luna で quota がどれだけ緩むか。API の単価差をサブスクリプションの節約額と見なさない。
- 子のどの成果が後続の確認と報奨に寄与したか。本番の未検証候補とレビュー未完了が多く、現時点では Finding 数から換算できない。
