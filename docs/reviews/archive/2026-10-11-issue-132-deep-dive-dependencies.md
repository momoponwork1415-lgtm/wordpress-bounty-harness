# Issue #132 の二段目 Trial に残る依存と計測の空白

## 確認したこと

- [Issue #132](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/132)、`docs/reviews/2026-10-11-implementation-plan-two-stage.md:108-117`、`docs/reviews/2026-10-11-two-stage-prompts-draft.md:25-43`、`docs/adr/0025-two-stage-discovery-with-harness-continuation.md:8-16`、`docs/SPEC.md:82-87` を照合した。受入条件は、同じ Snapshot の一段目に受理された Finding か Lead がある場合だけ Root＋最大3子の二段目を90分以内で起動し、一段目が無ければ拒否すること、開発セットの3 Trialから Lead の確認・反証件数、`runtime-confirmed`、継続回数、wall、usageを示すことである。Issue は #121 を明示的な依存としている。2026-10-11 時点で #121 と #131 はともに open である。
- 現行の `src/cli/wordpress.ts:122-155` は既定の `screening-v1` と入口索引を設定し、`src/cli/wordpress.ts:419-434` は一段目を単独・30分以下に制限する。`src/cli/wordpress.ts:613-709` は Trial を実行前にすべて作るため、一段目の結果を見て二段目を組み立てる箇所はまだない。新しい目的文の登録先は `src/profiles/wordpress/prompts/index.ts:4-75`、digest pin の先例は `tests/profiles/wordpress/discovery-prompts.test.ts:126-135` にある。旧IDとpinは残す。
- `src/cli/pipeline.ts:251-269` は発見を1回呼んだ直後に Lab を片付ける。`src/discovery/campaign.ts:350-357` は同じ対象の `discovery-concluded` があれば次の呼び出しを即終了し、`src/discovery/campaign.ts:1063-1078` は一段目の完了でもその event を書く。一段目と二段目を単純に2回呼ぶ実装では、二段目が実行されない。`src/discovery/campaign.ts:507-515` と `src/ledger/index.ts:55-63` には段を記録する欄が既にあるが、完了境界はまだ対象単位である。
- 受理された Finding/Lead の本文は Private Evidence に保存され、台帳には digest 参照と分類だけが残る（`src/discovery/campaign.ts:681-699,757-774`）。元の一段目の `runId`、`stage`、Snapshot digestを台帳で照合し、`PrivateArtifactStore.readFile` の既存経路（`src/cli/pipeline.ts:520-539`）で本文を検査してから、Finding の `claim`、Lead の `summary` と `missingEdge` のみを二段目の `## Unresolved questions` に投影する必要がある。Finding の `privateRecipeReference` と `recipeRef` は `src/profiles/wordpress/discovery/finding.ts:79-97` に存在するため、Finding 全体の直列化は要件に反する。`unexamined` は自由文（`src/discovery/codex-native-agent-runtime.ts:46-50`）なので、固定sourceの入口索引に実在する entry key だけを取り出して渡す。
- #121 の修正前は子スレッドが4件になると Root の報告ごと `incomplete(policy: child-count-exceeded)` になる（`src/discovery/codex-native-agent-runtime.ts:1354-1362,1426-1434`）。二段目は Root＋最大3子を使うため、#121 の挙動を先に入れて検証する必要がある。

## まだ決められないこと

一段目の Lead のうち「確認または反証に至った数」を台帳から決定する契約がない。現在の発見報告は `findings`、`leads`、`examined`、`unexamined` の4項目だけで、元の Lead ID に対する二段目の判断欄を持たない（`src/discovery/codex-native-agent-runtime.ts:125-147`、`src/profiles/wordpress/discovery/output-contract.ts:9-19`）。台帳の `lead-recorded` にも結果や元Leadとの対応はなく（`src/ledger/index.ts:263-271`）、funnel は Lead を受理数として数えるだけである（`src/ledger/index.ts:1147-1162`）。

二段目が新しい Finding を出しても、それが一段目のどの Lead を確認したのかは機械的に決まらない。二段目が Finding/Lead を出さなくても、元の Lead を反証したのか、未調査のまま終えたのかは区別できない。文字列の類似や候補0件を反証として扱うと、Issue の数字を根拠なく作ることになる。`runtime-confirmed` は別途 Harness 判定器だけが出す状態であり、Lead の source 上の確認とは混同できない。

段別 usage も現行の `ledger usage` では出ない。`src/ledger/index.ts:817-883` は target と UTC 日付で集計し、`src/cli/index.ts:707-727` はその行を表示する。`discovery-run-started.stage` と `discovery-run-finished.runId` を結び、旧 event の段なしを保持したまま段別集計を足す必要がある。`ledger funnel` の表示も現状は段別でない（`src/cli/index.ts:246-292`）。

## 選択肢と次の確認

1. #121、#131 の PR と受入数字を先に完了させる。その上で #132 は、一段目の完了と二段目の起動を同じ Lab の存続中に管理し、段を区別した完了境界を設ける。候補0件、保留のみ、失敗、provider limit では二段目を起動せず、初回の記録が無い場合と Snapshot 不一致を拒否する。これは ADR 0025 の既定経路の実装であり、Issue の条件を変えない。
2. Lead の確認・反証を機械可読にする契約を先に決める。例えば、二段目が元の `leadId` ごとに確認・反証・未解決と根拠を報告し、Harness が同じ Snapshot、出典、根拠の有無を検査して追記専用の結果 event に記録する方式がある。別案は、人間の監査を Private Evidence に残して対応表を台帳に記録する方式である。いずれも何を「確認」「反証」と数えるかを定義する必要がある。既存の設計だけではどちらも選べないため、方式を選ぶ場合は ADR を先行させる。
3. この決定を保留して `deep-dive-v1` の asset と条件付き起動だけを実装することはできるが、Lead の受入数字が出ず #132 の完了・merge 条件は満たさない。その状態を成功として報告しない。

判定に必要な試験は、一段目無し・Snapshot 不一致・候補0件・保留のみ・受理Finding/Leadありの起動境界、未解決の問いの許可項目と禁止項目、子4件時に Root＋3件を保持する動作、段別 `ledger funnel` / `ledger usage` の集計である。開発セットの最低3 Trialでは Trial数、完了数、Finding、Lead、Lead確認・反証数、`runtime-confirmed`、継続回数、wall中央値、usage、失敗理由を台帳から示す。payload、recipe、HTTP本文、画面画像、認証情報、未公開の発見は Git に置かない。

この文書は実装順や Issue の受入条件を変更しない。Lead 解決の数え方が決まるまで #132 のコード変更は進めない。
