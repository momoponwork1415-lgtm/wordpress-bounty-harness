---
status: accepted
supersedes: 0020 for scenario selection priority and victim-side operations
superseded-in-part-by: 0035 for the administrator boundary of a handoff Verifier run
superseded-in-part-by: 0040 for the observer verdict
---

# 検証 Lab は汎用 scenario を主とし、Verifier にブラウザを渡さない

## 決定

WordPress profile の版・digest付き通常機能 scenario catalogue に、plugin に依存しない利用状態を優先して追加する。`incomplete(precondition)` の理由コードを台帳から、次の手の本文をdigestで参照するPrivate Evidenceから集計し、頻出する前提を2〜3件ずつ実装してから同じ Finding を再検証する。scenario は通常機能の有効化と無害なデータ投入だけを行い、対象固有の関数名、option名、URL、画面名、既知経路を含めない。（2026-10-26 改訂: scenario catalogue、precondition 文からの選択、plugin 別 adapter は #353 で削除した。下の 2026-10-26 追記。）

被害者側のブラウザ操作は Harness 所有の Lab 観測器が、型で制限した手順として実行する。Verifier にブラウザ、管理者セッション、scenario の編集権限を渡さない（2026-10-18 改訂: handoff の skill には前提作りのためだけに Lab の設定管理者を渡し、`setup-done` 以後は攻撃者位置のみ。[ADR 0035](0035-verification-as-a-skill.md)。Codex Verifier とブラウザについては本文のまま）。観測器は Finding が宣言した被害者ロールと画面の文脈で canary を観測し、結果を Private Evidence に保存する。必要な操作を catalogue と手順型で表せない場合は `incomplete(precondition)` または `incomplete(observation)` を理由と次の手付きで残す。

## 理由

検証の多数が判定器なし、または Lab の通常利用状態の不足で `incomplete` になった。対象ごとの特別な setup を増やすと探索への答えが混ざり、Verifier に管理者操作を任せると権限境界と判定の独立性を失う。汎用 scenario と Harness 観測器なら、同じ前提を複数対象で使える。

根拠: [完成度レビュー](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/cfef59e/docs/reviews/2026-10-11-harness-completeness-review.md) 第4.3節、[prompt 下書き](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/cfef59e/docs/reviews/2026-10-11-two-stage-prompts-draft.md)。

## 採らなかった選択肢

- Verifier の image にブラウザを入れて被害者を操作させる: 低権限の攻撃手順と被害者の観測が混ざる。
- 公開事例ごとの専用 scenario を増やす: 評価対象の答えを Lab 前提に埋め込む。

## 既存決定との関係と帰結

- [ADR 0020](0020-versioned-feature-scenarios-for-lab.md) の scenario ID、digest、Finding の前提照合、再試行時の Lab Setup 変更条件を維持し、catalogue の追加順と被害者操作の所有者を更新する。過去の対象向け scenario は履歴として残す。
- [ADR 0021](0021-stored-script-judge-victim-context.md) の被害者ロールと画面の宣言、[ADR 0004](0004-harness-owned-judges-decide-runtime-confirmed.md) の nonce 判定は維持する。
- `incomplete` の集計に payload、HTTP本文、recipe を台帳へ持ち込まない。台帳は理由と digest 参照だけを持つ。

## 2026-10-25 注記（#525、所有者決定 2026-10-25）

「観測器は Finding が宣言した被害者ロールと画面の文脈で canary を観測し」は、[ADR 0040](0040-human-lab-observation-replaces-judges.md) で「宣言した画面を開き、数値マーカーの dialog と画面を記録する」に改めた。canary は播種しない。観測器は記録だけを残し、成立を判定しない。「ADR 0004 の nonce 判定は維持する」は ADR 0040 で置き換えた。被害者側の操作を Harness 所有の Lab 観測器が型付きの手順で行うことと、Verifier にブラウザを渡さないことは変えない。

## 2026-10-26 追記: scenario の仕組みの削除（#353）

決定の第 1 段落（版・digest 付きの通常機能 scenario catalogue と、`incomplete(precondition)` の集計から scenario を足す運用）は削除した。#352 は 2026-10-26 に close され、前提は ADR 0035 のとおり handoff の skill が Lab の通常機能で作る。

- 削除したもの: `src/profiles/wordpress/lab/scenarios.ts`（catalogue と `nextWordPressScenario`）、plugin 別 adapter 8 file、Lab 初期化の scenario 分岐、precondition 分類の scenario 選択（`nextScenarioId` と `common-usage-scenario-missing`）、scenario 変更による `review reverify` の再試行。
- campaign 設定の `lab.scenarioId` と、scenario を名指しする Lab Setup は、Lab を立てる前に拒否する。暗黙に scenario なしの Lab へ切り替えない。
- 読み続けるもの: 台帳の `lab-provisioned.scenario` と `verification-finished.result.nextScenarioId`、review export の scenario、対象範囲の評価が過去の Lab の scenario を照合するための digest pin（`retired-scenarios.ts`）。
- 第 2 段落（被害者側の操作は Harness 所有の Lab 観測器が行い、Verifier にブラウザを渡さない）は変えない。
- 削除前の状態は tag `archive/pre-353-deletion` に残る。戻すときは #353 の PR を revert する。
