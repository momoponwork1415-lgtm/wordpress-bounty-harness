# Claude Opus 5.5 接続で agent に渡る文章の対照

日付: 2026-10-14。Claude 側の探索目的は既存の `wp2shell-bounty-v4` 本文と、Harness が生成する `wordpress-discovery-contract-v2` をそのまま使う。本文と digest は変更しない。既存目的文の全文・日本語訳は [v4 出典対照](2026-10-13-critical-high-prompt-v4-source-map.md) にある。この文書は今回追加した Claude runner の短い agent-facing 文字列の全文と日本語訳であり、探索には渡さない。

## 英語原文と日本語訳の全文

| 出現箇所 | 英語原文 | 日本語訳 |
| --- | --- | --- |
| worker の説明 | Investigate a source area delegated by the Root and report source-grounded candidates. | Root が委ねた source の範囲を調べ、source に根拠のある候補を報告する。 |
| Finding schema の説明 | One Finding encoded as a JSON object string | JSON object を文字列に符号化した Finding 1 件 |
| Lead schema の説明 | One Lead encoded as a JSON object string | JSON object を文字列に符号化した Lead 1 件 |
| 許可外 tool の拒否 | Tool is outside the Trial surface | その tool は Trial の許可範囲外にある。 |
| Root 以外や別種の子の拒否 | Only direct Root-to-worker delegation is admitted | Root から worker への直接の委任だけを認める。 |
| 4 人目の子の拒否 | Three-child Trial limit reached | Trial の子 3 人の上限に達した。 |
| 許可外宛先への続行の拒否 | Only this Trial's children can receive follow-ups | この Trial の子だけが続行メッセージを受け取れる。 |

## 出典対照表

| 追加した要素 | 出典 | 採否 |
| --- | --- | --- |
| Root が固定 source に基づき子へ分担する | [SPEC 第6節](../SPEC.md)、[ADR 0029](../adr/0029-single-wp2shell-cooperative-trial.md)、既存 v4 本文 | 採用。worker 説明は対象固有の入口や攻撃経路を足さない |
| Finding / Lead を JSON object 文字列で受け渡す | [ADR 0019](../adr/0019-harness-generated-output-contract.md)、既存 Codex runtime の schema | 採用。契約項目を追加しない |
| 許可する tool、Root＋最大3子、同じ子への続行だけ | [SPEC 第2・6節](../SPEC.md)、[ADR 0029](../adr/0029-single-wp2shell-cooperative-trial.md)、[Claude Code 公式の子再開仕様](https://code.claude.com/docs/en/sub-agents#resume-subagents) | 採用。新規子の上限を SDK hook で強制し、別 session へのメッセージを拒否する |

`owner-approved` は DEVELOPMENT 第5節で委任された AI が PR に付け、委任を PR comment に明記する。3 件の開発 Trial と #215 の個別承認が揃うまで、この PR は Draft のままにする。
